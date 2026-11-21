#pragma once
// The Live session's sound: XMP's engine (rack.hpp, the same C++ the browser
// runs as WebAssembly) on the device's real-time audio thread.
//
// - Every sound is prepared before playback: each take of each velocity layer
//   of the three synthesized kits and of every sampler track's pads is one
//   engine pad, pointing at the session's banks (never copied, never freed).
//   Switching a track's kit or type picks other pads; nothing is reconfigured.
// - Each Live track is one engine track: the pad sampler for kit and sampler
//   tracks, the subtractive synth for synth tracks.
// - The main thread queues commands with an exact start frame through a
//   single-producer, single-consumer queue; the audio thread applies them on
//   that frame, rendering the runs between them. Nothing allocates, locks or
//   does I/O once playing.
//
// What the main thread decides, as the Live's own sampler did: the velocity
// layer, the round-robin take, and the level (track level x velocity curve x
// pad trim). What the engine decides, as in the browser: the voices, choke
// groups (a 5 ms fade), the synth and its release, and the 10 ms smoothed
// tone (cutoff) on sounding synth notes, smoothed only while it moves.
#include "xmp/live_sampler.hpp"
#include "xmp/live_synth.hpp"
#include "xmp/rack.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

namespace xmp::live {

constexpr int kLiveTracks = 8, kKitBanks = 3, kBanks = kKitBanks + kLiveTracks;
// Every take of every layer of every pad of every bank.
constexpr int32_t kEnginePads = kBanks * 16 * static_cast<int32_t>(kMaxLayers * kMaxTakes);
constexpr int32_t kEngineVoices = 64;
using LiveRack = rack::BasicRack<kEnginePads, kEngineVoices>;

inline rack::Patch engine_patch(const SynthPatch& p) {
  rack::Patch out;
  out.oscillator = p.oscillator == SynthPatch::sine ? rack::sine : p.oscillator == SynthPatch::square ? rack::square
                                                                                                        : rack::saw;
  out.attack = p.attack, out.decay = p.decay, out.sustain = p.sustain, out.release = p.release, out.cutoff = p.cutoff;
  out.resonance = p.resonance, out.env_amount = p.env_amount, out.env_decay = p.env_decay, out.detune = p.detune;
  out.glide = p.glide;
  return out;
}
inline double cutoff_value(double hz) {  // the engine's normalized cutoff
  return (std::clamp(hz, rack::kPatchMin[4], rack::kPatchMax[4]) - rack::kPatchMin[4]) /
         (rack::kPatchMax[4] - rack::kPatchMin[4]);
}

class LiveEngine {
 public:
  // Same loudness as the Live's own sampler: one kit hit at full velocity peaks near -18 dBFS.
  static constexpr float kSamplerMaster = 0.125f;
  static constexpr std::size_t kQueue = 512;

  struct TrackSound {
    bool synth = false;
    SynthPatch patch{};
  };

  explicit LiveEngine(int32_t rate = 48000) : rack_(std::make_unique<LiveRack>(rate)) {}

  // Before the audio thread starts: banks 0-2 are the kits, 3-10 the sampler
  // tracks' own banks (each may be null or empty). They must outlive the engine.
  // The kits are always present, so the engine has pads (its synth notes name pad 0).
  bool prepare(const std::array<const SampleBank*, kBanks>& banks, const std::array<TrackSound, kLiveTracks>& tracks) {
    for (int b = 0; b < kBanks; ++b)
      for (std::size_t pad = 0; pad < 16; ++pad)
        bank_pad_[static_cast<std::size_t>(b)][pad] =
            banks[static_cast<std::size_t>(b)] ? &banks[static_cast<std::size_t>(b)]->pads[pad] : nullptr;
    int32_t count = 0;
    for (int b = 0; b < kBanks; ++b)
      for (std::size_t pad = 0; pad < 16; ++pad) {
        auto& first = first_[static_cast<std::size_t>(b)][pad];
        first.fill(-1);
        if (!banks[static_cast<std::size_t>(b)]) continue;
        const auto& p = banks[static_cast<std::size_t>(b)]->pads[pad];
        for (std::size_t l = 0; l < p.layers.size() && l < kMaxLayers; ++l) {
          first[l] = count;
          count += static_cast<int32_t>(std::min(p.layers[l].takes.size(), kMaxTakes));
        }
      }
    rack_->stage_begin(kLiveTracks, count);
    int32_t at = 0;
    for (int b = 0; b < kBanks; ++b) {
      if (!banks[static_cast<std::size_t>(b)]) continue;
      for (const auto& p : banks[static_cast<std::size_t>(b)]->pads)
        for (std::size_t l = 0; l < p.layers.size() && l < kMaxLayers; ++l)
          for (std::size_t k = 0; k < p.layers[l].takes.size() && k < kMaxTakes; ++k) {
            const auto& take = p.layers[l].takes[k];
            // An empty take stays an empty pad: silent, like the Live's sampler.
            if (!take.empty())
              rack_->stage_pad_external(at, take.data(), static_cast<uint32_t>(take.size()), rack_->rate(),
                                        rack::one_shot, 60, p.choke);
            ++at;
          }
    }
    for (int t = 0; t < kLiveTracks; ++t) {
      rack::Track* track = rack_->stage_track(t);
      if (!track) return false;
      const auto& sound = tracks[static_cast<std::size_t>(t)];
      track->uid = t;
      track->key = t;
      track->kind = sound.synth ? rack::subtractive : rack::sampler;
      track->gain = 1;  // levels travel with each note, as on the Live
      track->patch = engine_patch(sound.patch);
      track->patch_index[4] = t;  // parameter t: the track's tone, smoothed only while it moves
      kinds_[static_cast<std::size_t>(t)] = track->kind;
      patches_[static_cast<std::size_t>(t)] = track->patch;
      cutoff_[static_cast<std::size_t>(t)] = cutoff_value(sound.patch.cutoff);
    }
    rack_->commit();
    return true;
  }

  // ---- main thread: one producer ----
  // A pad of a bank on a track, at velocity 1..127 and track level 0..1.
  // False only for bad arguments or a full queue.
  bool play_pad(std::uint64_t frame, int track, int bank, int pad, int velocity, float level) {
    if (track < 0 || track >= kLiveTracks || bank < 0 || bank >= kBanks || pad < 0 || pad > 15 || velocity < 1)
      return false;
    // Nothing to play (silent level, empty pad) is not a failure: true, as the Live's sampler did.
    if (level <= 0 || !banks_known(bank, pad)) return true;
    const auto& p = *bank_pad_[static_cast<std::size_t>(bank)][static_cast<std::size_t>(pad)];
    const std::size_t layer = layer_for(p, std::min(velocity, 127));
    const auto takes = std::min(p.layers[layer].takes.size(), kMaxTakes);
    if (!takes) return true;
    auto& turn = turn_[static_cast<std::size_t>(track)][static_cast<std::size_t>(pad)][std::min(layer, kMaxLayers - 1)];
    const std::size_t take = turn % takes;
    turn = static_cast<std::uint8_t>((take + 1) % takes);
    if (p.layers[layer].takes[take].empty()) return true;
    last_layer_ = static_cast<std::uint8_t>(layer), last_take_ = static_cast<std::uint8_t>(take);
    const float gain = std::clamp(level, 0.0f, 1.0f) * velocity_gain(p.layers.size(), velocity) *
                       (p.trim > 0 ? p.trim : 1.0f) * kSamplerMaster;
    Command c{};
    c.frame = frame, c.kind = Command::pad_on, c.track = track;
    c.pad = first_[static_cast<std::size_t>(bank)][static_cast<std::size_t>(pad)][layer] + static_cast<int32_t>(take);
    c.value = gain;
    return push(c);
  }
  // A synth note at `gain` 0..1, held `gate` frames (0: until note_off).
  bool play_note(std::uint64_t frame, int track, int note, float gain, std::uint32_t gate) {
    if (track < 0 || track >= kLiveTracks) return false;
    Command c{};
    c.frame = frame, c.kind = Command::note_on, c.track = track, c.note = std::clamp(note, 0, 127);
    c.value = std::clamp(gain, 0.0f, 1.0f), c.gate = gate;
    return push(c);
  }
  bool note_off(int track, int note) {
    Command c{};
    c.kind = Command::off, c.track = track, c.note = std::clamp(note, 0, 127);
    return push(c);
  }
  // The track's instrument for notes from now on; its tone glides to the patch's.
  bool set_sound(int track, const TrackSound& sound) {
    Command c{};
    c.kind = Command::sound, c.track = track, c.synth = sound.synth, c.patch = engine_patch(sound.patch);
    return push(c);
  }
  // The track's tone (cutoff, Hz) on sounding and new synth notes.
  bool set_cutoff(int track, float hz) {
    Command c{};
    c.kind = Command::cutoff, c.track = track, c.value = hz;
    return push(c);
  }
  // Releases sounding synth notes of a track, or of all tracks (-1).
  bool release_synths(int track = -1) {
    Command c{};
    c.kind = Command::release, c.track = track;
    return push(c);
  }
  // Which layer and take the most recent pad used (tests and the log).
  std::uint8_t last_layer() const noexcept { return last_layer_; }
  std::uint8_t last_take() const noexcept { return last_take_; }
  // Counters the audio thread updates once per block.
  std::uint32_t active_voices() const noexcept { return active_.load(std::memory_order_relaxed); }
  std::uint64_t refused() const noexcept { return refused_.load(std::memory_order_relaxed); }

  // ---- audio thread ----
  // Adds `frames` samples starting at session frame `start` into left and right.
  void process(float* left, float* right, std::uint32_t frames, std::uint64_t start) noexcept {
    drain();
    std::uint32_t done = 0;
    while (done < frames) {
      const std::uint64_t now = start + done;
      apply_due(now);
      std::uint64_t next = start + frames;
      for (std::size_t i = 0; i < pending_size_; ++i)
        if (pending_[i].frame > now && pending_[i].frame < next) next = pending_[i].frame;
      const auto n = static_cast<std::uint32_t>(std::min<std::uint64_t>(next - now, rack::kBlock));
      rack_->process(static_cast<int32_t>(n));
      for (std::uint32_t i = 0; i < n; ++i) {
        left[done + i] += rack_->left[i];
        right[done + i] += rack_->right[i];
      }
      done += n;
    }
    settle_tone();
    active_.store(static_cast<std::uint32_t>(rack_->active()), std::memory_order_relaxed);
    refused_.store(static_cast<std::uint64_t>(rack_->refused), std::memory_order_relaxed);
  }

 private:
  struct Command {
    enum Kind : std::uint8_t { pad_on, note_on, off, sound, cutoff, release } kind = pad_on;
    std::uint64_t frame = 0;
    int32_t track = 0, pad = 0, note = 60;
    double value = 0;
    std::uint32_t gate = 0;
    bool synth = false;
    rack::Patch patch{};
  };

  bool banks_known(int bank, int pad) const {
    return bank_pad_[static_cast<std::size_t>(bank)][static_cast<std::size_t>(pad)] != nullptr &&
           !bank_pad_[static_cast<std::size_t>(bank)][static_cast<std::size_t>(pad)]->layers.empty();
  }
  bool push(const Command& c) {
    const auto head = head_.load(std::memory_order_relaxed), next = (head + 1) % (kQueue + 1);
    if (next == tail_.load(std::memory_order_acquire)) return false;
    queue_[head] = c;
    head_.store(next, std::memory_order_release);
    return true;
  }
  void drain() noexcept {
    for (;;) {
      const auto tail = tail_.load(std::memory_order_relaxed);
      if (tail == head_.load(std::memory_order_acquire) || pending_size_ == pending_.size()) break;
      pending_[pending_size_++] = queue_[tail];
      tail_.store((tail + 1) % (kQueue + 1), std::memory_order_release);
    }
  }
  // Applies what is due by `now`, in the order it was queued.
  void apply_due(std::uint64_t now) noexcept {
    std::size_t kept = 0;
    for (std::size_t i = 0; i < pending_size_; ++i) {
      if (pending_[i].frame > now)
        pending_[kept++] = pending_[i];
      else
        apply(pending_[i]);
    }
    pending_size_ = kept;
  }
  void apply(const Command& c) noexcept {
    switch (c.kind) {
      case Command::pad_on:
        rack_->note_on(++id_, c.pad, c.track, 60, c.value, 0);
        break;
      case Command::note_on:
        // The pad index is unused by the synth; any staged pad will do (0, or none at all).
        rack_->note_on(++id_, 0, c.track, c.note, c.value, c.gate);
        break;
      case Command::off:
        rack_->note_off_note(c.track, c.note);
        break;
      case Command::sound:
        if (c.track < 0 || c.track >= kLiveTracks) break;
        kinds_[static_cast<std::size_t>(c.track)] = c.synth ? rack::subtractive : rack::sampler;
        patches_[static_cast<std::size_t>(c.track)] = c.patch;
        rack_->set_track_sound(c.track, kinds_[static_cast<std::size_t>(c.track)], c.patch);
        set_tone(c.track, cutoff_value(c.patch.cutoff));
        break;
      case Command::cutoff:
        if (c.track < 0 || c.track >= kLiveTracks) break;
        // New notes start at the new tone; sounding ones glide to it.
        patches_[static_cast<std::size_t>(c.track)].cutoff = std::clamp(c.value, rack::kPatchMin[4], rack::kPatchMax[4]);
        rack_->set_track_sound(c.track, kinds_[static_cast<std::size_t>(c.track)],
                               patches_[static_cast<std::size_t>(c.track)]);
        set_tone(c.track, cutoff_value(c.value));
        break;
      case Command::release:
        rack_->release_patches(c.track);
        break;
    }
  }
  // The engine smooths parameters every frame while it has targets: the tones
  // are targets only while one glides, then the engine runs without them.
  void set_tone(int32_t track, double value) noexcept {
    if (track < 0 || track >= kLiveTracks) return;
    cutoff_[static_cast<std::size_t>(track)] = value;
    rack_->targets_begin();
    for (int t = 0; t < kLiveTracks; ++t) rack_->targets_add(t, cutoff_[static_cast<std::size_t>(t)]);
    rack_->targets_commit();
    gliding_ = true;
  }
  void settle_tone() noexcept {
    if (!gliding_) return;
    for (int t = 0; t < kLiveTracks; ++t)
      if (std::fabs(rack_->value(t) - cutoff_[static_cast<std::size_t>(t)]) > 1e-9) return;
    rack_->targets_begin();
    rack_->targets_commit();
    gliding_ = false;
  }

 private:
  std::unique_ptr<LiveRack> rack_;
  std::array<std::array<std::array<int32_t, kMaxLayers>, 16>, kBanks> first_{};
  std::array<std::array<const SamplePad*, 16>, kBanks> bank_pad_{};
  std::array<std::array<std::array<std::uint8_t, kMaxLayers>, 16>, kLiveTracks> turn_{};
  std::array<double, kLiveTracks> cutoff_{};
  std::array<int32_t, kLiveTracks> kinds_{};
  std::array<rack::Patch, kLiveTracks> patches_{};
  bool gliding_ = false;
  std::uint8_t last_layer_ = 0, last_take_ = 0;
  std::array<Command, kQueue + 1> queue_{};
  std::atomic<std::size_t> head_{0}, tail_{0};
  std::array<Command, 256> pending_{};
  std::size_t pending_size_ = 0;
  double id_ = 0;
  std::atomic<std::uint32_t> active_{0};
  std::atomic<std::uint64_t> refused_{0};
};

}  // namespace xmp::live
