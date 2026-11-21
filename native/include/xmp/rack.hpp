#pragma once
// XMP's instrument engine: the voice rack behind every track in the browser
// (and, next, on the Live). It plays the pad sampler (one-shot, gate, loop and
// chromatic pads with choke groups), the subtractive synth (sine and polyBLEP
// saw and square, two one-pole low-pass stages, attack/decay/sustain and a
// linear release), MIDI voices, per-frame parameter smoothing, the stereo
// mixer with its six original effects, and the shared performance delay.
//
// It began as the C++ port of packages/core's TypeScript rack, mixer and
// shared delay, written to follow them operation for operation in double
// precision (those originals were retired in phase 9; tests/golden.json keeps
// fingerprints of what this produced while it matched them). It compiles to
// WebAssembly (native/src/rack_wasm.cpp) for the browser, which also gives
// JavaScript standalone effects and mixers (packages/core/src/mixer.ts).
//
// Only C headers are used so the same file builds for wasm32-wasi without a
// C++ runtime. Real-time rules: process() and everything it calls use fixed
// buffers prepared in configure(); no allocation, no locks, no I/O.
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace xmp::rack {

constexpr int kVoices = 32, kTracks = 8, kPads = 16 * 9, kBlock = 4096, kParams = 4096,
              kMidiEvents = 2048, kRetired = 256, kTempos = 64;
constexpr double kPi = 3.14159265358979323846, kPanicSeconds = 0.005;

enum Kind : int32_t { none = 0, sampler = 1, subtractive = 2, midi = 3, custom = 4 };
enum PadMode : int32_t { one_shot = 0, gate = 1, loop = 2, chromatic = 3 };
enum Osc : int32_t { sine = 0, saw = 1, square = 2 };
enum Fx : int32_t { eq = 0, filter = 1, delay = 2, reverb = 3, distortion = 4, compressor = 5 };

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
inline double finite16(double n) { return isfinite(n) ? clampd(n, -16, 16) : 0; }
inline double jsmod(double a, double b) { return fmod(a, b); }  // JavaScript % on doubles
inline double jsround(double v) { return floor(v + 0.5); }      // Math.round
// Audio taper belongs to the control, not the saved linear-amplitude gain.
inline double fader_gain(double position) { const double p = clampd(position, 0, 1); return p * p * p; }
inline double fader_position(double gain) { return cbrt(clampd(gain, 0, 1)); }
inline double blep(double t, double dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// The subtractive synth's patch. The fields after cutoff came later; at their
// defaults (all but filter decay zero) the synth plays exactly as before.
// resonance: the filter's peak, 0..1. env_amount: how far, in octaves, the
// filter envelope opens the cutoff at the attack (scaled by velocity, so
// accents open it further); env_decay: how fast it closes, in seconds.
// detune: a second oscillator this many cents above the first. glide: how
// long, in seconds, a note slides from the track's previous note.
// One oscillator sample (polyBLEP saw and square; the sine only when it is heard).
inline double wave(int32_t oscillator, double phase, double increment) {
  if (oscillator == square)
    return (phase < 0.5 ? 1 : -1) + blep(phase, increment) - blep(jsmod(phase + 0.5, 1), increment);
  if (oscillator == saw) return 2 * phase - 1 - blep(phase, increment);
  return sin(phase * 2 * kPi);
}
// How often (in frames) a synth voice's filter envelope, detune and glide
// coefficients are computed again.
constexpr int64_t kControl = 16;

struct Patch {
  int32_t oscillator = saw;
  double attack = 0.005, decay = 0.12, sustain = 0.45, release = 0.12, cutoff = 750;
  double resonance = 0, env_amount = 0, env_decay = 0.3, detune = 0, glide = 0;
};
// Subtractive parameters in definition order, with their ranges (machines.ts).
constexpr int kPatchFields = 10;
constexpr double kPatchMin[kPatchFields] = {0.001, 0.001, 0, 0.005, 30, 0, 0, 0.01, 0, 0},
                 kPatchMax[kPatchFields] = {2, 2, 1, 2, 16000, 1, 6, 2, 50, 1};
inline double& patch_field(Patch& p, int i) {
  switch (i) {
    case 0: return p.attack;
    case 1: return p.decay;
    case 2: return p.sustain;
    case 3: return p.release;
    case 4: return p.cutoff;
    case 5: return p.resonance;
    case 6: return p.env_amount;
    case 7: return p.env_decay;
    case 8: return p.detune;
    default: return p.glide;
  }
}

// A multi-sampled pad's sounds (project format 8): velocity layers, softest
// first, each covering velocities up to `up_to`, of round-robin takes that
// repeated hits rotate through. Owned by the rack, like a pad's own sound.
constexpr int kLayers = 8, kTakes = 8;
struct Take {
  float* pcm = nullptr;
  uint32_t length = 0;
  double rate = 48000;
};
struct Layers {
  int32_t count = 0;
  double up_to[kLayers] = {};
  int32_t takes[kLayers] = {}, next[kLayers] = {};
  Take take[kLayers][kTakes] = {};
};

struct Pad {
  float* pcm = nullptr;
  uint32_t length = 0;
  double rate = 48000;
  int32_t mode = one_shot, root = 60, choke = 0;
  bool owned = true;  // false: the caller's sound, never freed here (the Live's banks)
  Layers* layers = nullptr;  // a multi-sampled pad's layers, or none
};

struct Track {
  int32_t uid = -1, kind = none, key = 0, route = -1;
  bool base_midi = false, muted = false, silent_route = false, midi_machine = false, custom_audio = false;
  double gain = 0, channel_state = 1, delay_send = 0;
  int32_t gain_index = -1, effect_gain_index = -1, channel_index = -1;
  int32_t pad_base = 0;  // where this track's 16 pads start (project format 7's kits; 0: the project's)
  Patch patch{};
  int32_t patch_index[kPatchFields] = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
  double last_increment = 0;  // the track's last synth note, where a glide starts
};

// A value kept until its input changes: the coefficients below come from exp,
// pow, sin and cos of numbers that rarely move (a rate, a cutoff, a pan), and
// were computed again for every sample. The same arithmetic on the same input
// gives the same bits, so what the engine plays is unchanged.
struct Kept {
  double in = 0, out = 0;
  bool set = false;
  template <class F>
  double of(double x, F&& f) {
    if (!set || x != in) in = x, out = f(x), set = true;
    return out;
  }
};

struct Voice {
  bool active = false, has_pad = false, has_patch = false, midi = false, midi_active = false, audio_done = false;
  double id = 0;
  int32_t owner = -1, destination = -1;
  Pad pad{};
  Patch patch{};
  double cursor = 0, increment = 1, gain = 0, velocity = 0, phase = 0, filter1 = 0, filter2 = 0, level = 0,
         release_level = 0;
  // The later patch fields: the second oscillator, the glide's goal, and the
  // resonant filter's state and coefficients (updated every kControl frames).
  double phase2 = 0, ratio2 = 1, glide_to = 0, glide_keep = 0, svf_a1 = 0, svf_a2 = 0, svf_a3 = 0;
  int64_t age = 0, gate = 0, release_age = -1, release_frames = 0;
  int32_t channel = 1, note = 60;
  Kept filter_coefficient{};
};

struct MidiEvent {
  double id, velocity;
  int32_t kind, note, channel, pad_;  // kind 1 on, 0 off
};

// Prepared on the control thread. Audio uses a sorted pointer lookup only;
// sustained sample voices must never refer to a retired rack's PCM.
struct SampleBinding { const float* from = nullptr; float* to = nullptr; };

// One effect in a mixer chain (EffectProcessor).
struct Effect {
  int32_t kind = eq, slots = 0, bypass_index = -1, slot_index[3] = {-1, -1, -1};
  double slot_default[3] = {0, 0, 0}, bypass_default = 0, bypass = 0, cutoff_raw = 0.7, rate = 48000;
  bool sync = false;
  double division = 1, sequence[16] = {};
  int32_t sequence_length = 0;
  float* ring = nullptr;
  uint32_t ring_length = 1, cursor = 0;
  double low = 0, envelope = 0;
  Kept bypass_step{}, low_step{}, eq_gain{}, drive_scale{}, attack_step{}, release_step{};
  // Parameter slot order per kind: eq tone,gain; filter cutoff; delay time,feedback,wet;
  // reverb decay,wet; distortion drive,wet; compressor threshold,ratio,makeup.
  double value(int slot, const double* cur, const uint8_t* has) const {
    const int32_t i = slot_index[slot];
    return i >= 0 && has[i] ? cur[i] : slot_default[slot];
  }
  void clear() {
    if (ring) memset(ring, 0, sizeof(float) * ring_length);
    cursor = 0;
    low = envelope = 0;
  }
  double process(double input, double step, double bpm, const double* cur, const uint8_t* has) {
    input = finite16(input);
    const double target = bypass_index >= 0 && has[bypass_index] ? cur[bypass_index] : bypass_default;
    bypass += bypass_step.of(rate, [](double r) { return 1 - exp(-1 / (r * 0.01)); }) * (target - bypass);
    double out = input;
    if (kind == filter || kind == eq) {
      double cutoff;
      if (kind == filter) {
        if (sync) {
          const int32_t at = static_cast<int32_t>(jsmod(floor((step + 1e-8) / division), sequence_length));
          cutoff = clampd(sequence[at] + value(0, cur, has) - cutoff_raw, 0, 1);
        } else
          cutoff = value(0, cur, has);
      } else
        cutoff = value(0, cur, has);
      const double r = rate;
      low += low_step.of(cutoff, [r](double c) {
        const double hz = fmin(r * 0.45, 20 * pow(1000, c));
        return 1 - exp((-2 * kPi * hz) / r);
      }) * (input - low);
      out = kind == filter ? low
                           : input + low * eq_gain.of(value(1, cur, has), [](double g) {
                               return pow(10, (g * 24 - 12) / 20) - 1;
                             });
    } else if (kind == delay || kind == reverb) {
      const double seconds = kind == reverb ? 0.137
                             : sync         ? fmin(4, (division * 15) / bpm)
                                            : fmax(1 / rate, value(0, cur, has) * 4);
      const double wanted = jsround(seconds * rate);
      const uint32_t length =
          static_cast<uint32_t>(fmax(1, fmin(static_cast<double>(ring_length), wanted)));
      const uint32_t read = (cursor + ring_length - length) % ring_length;
      const double wet = ring[read];
      const double feedback = kind == reverb ? 0.2 + value(0, cur, has) * 0.65 : value(1, cur, has) * 0.75;
      // Reverb is a damped, original feedback comb, not a convolution or vendor model.
      low += 0.2 * (wet - low);
      ring[cursor] = static_cast<float>(finite16(input + (kind == reverb ? low : wet) * feedback));
      cursor = (cursor + 1) % ring_length;
      const double mix = value(kind == reverb ? 1 : 2, cur, has);
      out = input * (1 - mix) + wet * mix;
    } else if (kind == distortion) {
      const double drive = 1 + value(0, cur, has) * 19, mix = value(1, cur, has);
      out = input * (1 - mix) + (tanh(input * drive) / drive_scale.of(drive, [](double d) { return tanh(d); })) * mix;
    } else {
      const double amplitude = fabs(input),
                   coefficient = amplitude > envelope
                                     ? attack_step.of(rate, [](double r) { return 1 - exp(-1 / (r * 0.005)); })
                                     : release_step.of(rate, [](double r) { return 1 - exp(-1 / (r * 0.05)); });
      envelope += coefficient * (amplitude - envelope);
      const double db = 20 * log10(fmax(1e-12, envelope)), threshold = -48 + value(0, cur, has) * 48,
                   ratio = 1 + value(1, cur, has) * 19;
      out = input * pow(10, (fmax(0, db - threshold) * (1 / ratio - 1) + value(2, cur, has) * 12) / 20);
    }
    return finite16(out * (1 - bypass) + input * bypass);
  }
};

struct Chain {
  Effect left[2], right[2];
  int32_t count = 0;
};

struct Mixer {
  struct Strip {
    double pan = 0.5, sends[2] = {0, 0};
    int32_t pan_index = -1, send_index[2] = {-1, -1};
    Chain chain;
    Kept pan_left{}, pan_right{};
  };
  Strip strips[kTracks];
  int32_t strip_count = 0;
  Chain returns[2];
  double send_l[2] = {0, 0}, send_r[2] = {0, 0}, left = 0, right = 0, peak_l = 0, peak_r = 0, sum_squares = 0,
         step = 0, bpm = 120, rate = 48000;
  int64_t samples = 0, clipped = 0;
  double tempo_step[kTempos] = {}, tempo_bpm[kTempos] = {};
  int32_t tempo_count = 0;

  void run(Chain& c, double l, double r, const double* cur, const uint8_t* has) {
    for (int32_t i = 0; i < c.count; ++i) {
      l = c.left[i].process(l, step, bpm, cur, has);
      r = c.right[i].process(r, step, bpm, cur, has);
    }
    left = l;
    right = r;
  }
  void process(const double* inputs, double master, const double* cur, const uint8_t* has) {
    send_l[0] = send_l[1] = send_r[0] = send_r[1] = 0;
    double l = 0, r = 0;
    for (int32_t i = 0; i < strip_count; ++i) {
      Strip& s = strips[i];
      const double pan = s.pan_index >= 0 && has[s.pan_index] ? cur[s.pan_index] : s.pan;
      const double angle = (clampd(pan, 0, 1) * kPi) / 2, input = finite16(inputs[i]);
      run(s.chain, input * s.pan_left.of(angle, [](double a) { return cos(a); }),
          input * s.pan_right.of(angle, [](double a) { return sin(a); }), cur, has);
      l += left;
      r += right;
      for (int j = 0; j < 2; ++j) {
        const int32_t k = s.send_index[j];
        const double send = k >= 0 && has[k] ? cur[k] : s.sends[j];
        send_l[j] += left * send;
        send_r[j] += right * send;
      }
    }
    for (int j = 0; j < 2; ++j) {
      run(returns[j], send_l[j], send_r[j], cur, has);
      l += left;
      r += right;
    }
    l = finite16(l * master);
    r = finite16(r * master);
    if (fabs(l) > 1 || fabs(r) > 1) ++clipped;
    left = clampd(l, -1, 1);
    right = clampd(r, -1, 1);
    peak_l = fmax(peak_l, fabs(left));
    peak_r = fmax(peak_r, fabs(right));
    sum_squares += (left * left + right * right) / 2;
    ++samples;
    step += bpm / 15 / rate;
    for (int32_t t = 0; t < tempo_count; ++t)
      if (fabs(step - tempo_step[t]) < 1e-7 || (step >= tempo_step[t] && step - bpm / 15 / rate < tempo_step[t])) {
        step = tempo_step[t];
        bpm = tempo_bpm[t];
      }
  }
  void clear() {
    for (int32_t i = 0; i < strip_count; ++i)
      for (int32_t k = 0; k < strips[i].chain.count; ++k) {
        strips[i].chain.left[k].clear();
        strips[i].chain.right[k].clear();
      }
    for (auto& c : returns)
      for (int32_t k = 0; k < c.count; ++k) {
        c.left[k].clear();
        c.right[k].clear();
      }
  }
  void free_rings() {
    auto drop = [](Chain& c) {
      for (int32_t k = 0; k < c.count; ++k) {
        free(c.left[k].ring);
        free(c.right[k].ring);
        c.left[k].ring = c.right[k].ring = nullptr;
      }
    };
    for (int32_t i = 0; i < strip_count; ++i) drop(strips[i].chain);
    for (auto& c : returns) drop(c);
  }
};

// Sets up one effect of `kind` (eq .. compressor) with its parameter slots
// and, for delay and reverb, its ring. False when the ring cannot be allocated.
inline bool init_effect(Effect& e, int32_t kind, int32_t bypass, int32_t bypass_index, const int32_t* slot_index,
                        const double* slot_default, double cutoff_raw, int32_t sync, double division,
                        const double* sequence, int32_t sequence_length, double rate) {
  if (kind < eq || kind > compressor) return false;
  const int32_t slots = kind == eq ? 2 : kind == filter ? 1 : kind == delay ? 3 : kind == compressor ? 3 : 2;
  const uint32_t ring = kind == delay ? static_cast<uint32_t>(rate) * 4
                        : kind == reverb ? static_cast<uint32_t>(jsround(rate * 0.137))
                                         : 1;
  e = Effect{};
  e.kind = kind;
  e.slots = slots;
  e.rate = rate;
  e.bypass_default = e.bypass = bypass ? 1 : 0;
  e.bypass_index = bypass_index;
  for (int32_t s = 0; s < slots; ++s) {
    e.slot_index[s] = slot_index[s];
    e.slot_default[s] = slot_default[s];
  }
  e.cutoff_raw = cutoff_raw;
  e.sync = sync != 0;
  e.division = division;
  e.sequence_length = sequence_length < 1 ? 1 : sequence_length > 16 ? 16 : sequence_length;
  for (int32_t s = 0; s < e.sequence_length; ++s) e.sequence[s] = sequence ? sequence[s] : 0.5;
  e.ring_length = ring;
  e.ring = static_cast<float*>(calloc(ring, sizeof(float)));
  return e.ring != nullptr;
}

// The shared performance delay (SharedDelay).
struct Delay {
  float* ring = nullptr;
  uint32_t frames = 0, cursor = 0;
  double feedback = 0, wet = 0;
  double process(double input) {
    const double value = ring[cursor];
    ring[cursor] = static_cast<float>(clampd((isfinite(input) ? input : 0) + value * feedback, -1, 1));
    cursor = (cursor + 1) % frames;
    return value * wet;
  }
  void clear() {
    if (ring) memset(ring, 0, sizeof(float) * frames);
    cursor = 0;
  }
};

// Pads and Voices are the browser's limits by default (Rack); the Live uses a
// larger instance (live_engine.hpp) with every kit and sample take as a pad.
template <int32_t Pads = kPads, int32_t Voices = kVoices>
class BasicRack {
 public:
  // ---- state the TypeScript binding reads and writes directly ----
  float left[kBlock] = {}, right[kBlock] = {};
  MidiEvent midi[kMidiEvents] = {};
  int32_t midi_count = 0, midi_overflow = 0;
  double frame = 0, refused = 0, master_gain = 1;
  bool advanced = false;  // parameters advanced during the last process call
  double meter_out[4] = {};

  explicit BasicRack(int32_t rate = 48000) { set_rate(rate); }
  // Before first use only.
  void set_rate(int32_t rate) {
    rate_ = rate;
    alpha_ = 1 - exp(-1 / (rate_ * 0.01));
    for (int32_t i = 0; i < kParams; ++i) cur_[i] = 0, has_[i] = 0;
  }
  int32_t rate() const { return rate_; }

  void inherit(BasicRack& old, const SampleBinding* bindings, int binding_count, const int* chains) noexcept {
    frame = old.frame;
    for (int i = 0; i < kParams; ++i)
      if (has_[i] && old.has_[i]) cur_[i] = old.cur_[i];
    blocked_count_ = old.blocked_count_;
    for (int i = 0; i < blocked_count_; ++i) blocked_[i] = old.blocked_[i];
    for (auto& track : tracks_)
      if (const Track* previous = find(old.tracks_, old.count_, track.uid)) {
        track.last_increment = previous->last_increment;
        if (track.key == previous->key) track.gain = previous->gain;
      }
    int slot = 0;
    for (const auto& voice : old.voices_) {
      if (!voice.active || slot == Voices) continue;
      const Track* owner = find(tracks_, count_, voice.owner);
      const Track* old_owner = find(old.tracks_, old.count_, voice.owner);
      const Track* destination = find(tracks_, count_, voice.destination);
      const Track* before = find(old.tracks_, old.count_, voice.destination);
      if (!owner || !old_owner || !destination || !before || owner->key != old_owner->key || owner->route != old_owner->route ||
          destination->key != before->key || owner->muted || destination->muted) continue;
      Voice copy = voice;
      if (copy.has_patch) copy.patch.oscillator = destination->patch.oscillator;
      if (copy.has_pad) {
        int lo = 0, hi = binding_count;
        const auto wanted = reinterpret_cast<uintptr_t>(copy.pad.pcm);
        while (lo < hi) { const int mid = (lo + hi) / 2;
          if (reinterpret_cast<uintptr_t>(bindings[mid].from) < wanted) lo = mid + 1; else hi = mid;
        }
        if (lo == binding_count || bindings[lo].from != copy.pad.pcm) continue;
        copy.pad.pcm = bindings[lo].to;
      }
      voices_[slot++] = copy;
    }
    if (mixer_ && old.mixer_) {
      mixer_->step = old.mixer_->step;
      auto chain = [](Mixer& m, int i) -> Chain& { return i < kTracks ? m.strips[i].chain : m.returns[i - kTracks]; };
      for (int i = 0; i < kTracks + 2; ++i) if (chains[i] >= 0) {
        Chain saved = chain(*mixer_, i);
        chain(*mixer_, i) = chain(*old.mixer_, chains[i]);
        chain(*old.mixer_, chains[i]) = saved;
      }
    }
    if (delay_present_ && old.delay_present_ && delay_.frames == old.delay_.frames &&
        delay_.feedback == old.delay_.feedback && delay_.wet == old.delay_.wet) {
      const Delay saved = delay_; delay_ = old.delay_; old.delay_ = saved;
    }
  }
  void retime_gates(double ratio) noexcept {
    for (auto& v : voices_) if (v.active && v.id < 1e12 && v.gate > v.age)
      v.gate = v.age + static_cast<int64_t>(jsround((v.gate - v.age) * ratio));
  }

  // ---- configure (InstrumentPalette), staged then committed ----
  void stage_begin(int32_t tracks, int32_t pads) {
    next_count_ = tracks < 0 ? 0 : tracks > kTracks ? kTracks : tracks;
    next_pad_count_ = pads < 0 ? 0 : pads > Pads ? Pads : pads;
    for (auto& t : next_) t = Track{};
    for (int32_t i = 0; i < Pads; ++i) next_pads_[i] = Pad{};
    next_base_count_ = 0;
    stage_mixer_ = 0;
    if (staged_mixer_) {
      staged_mixer_->free_rings();
      free(staged_mixer_);
      staged_mixer_ = nullptr;
    }
  }
  Track* stage_track(int32_t i) { return i >= 0 && i < next_count_ ? &next_[i] : nullptr; }
  float* stage_pad(int32_t i, uint32_t length, double rate, int32_t mode, int32_t root, int32_t choke) {
    if (i < 0 || i >= next_pad_count_ || length > 4000000) return nullptr;
    Pad& p = next_pads_[i];
    p.pcm = static_cast<float*>(calloc(length ? length : 1, sizeof(float)));
    if (!p.pcm) return nullptr;
    p.length = length;
    p.rate = rate;
    p.mode = mode;
    p.root = root;
    p.choke = choke;
    return p.pcm;
  }
  // One take of a multi-sampled pad's layer: the buffer to fill, or nullptr.
  // Layers are staged softest first; `up_to` is the layer's highest velocity.
  float* stage_pad_take(int32_t i, int32_t layer, int32_t take, uint32_t length, double rate, double up_to) {
    if (i < 0 || i >= next_pad_count_ || layer < 0 || layer >= kLayers || take < 0 || take >= kTakes ||
        !length || length > 4000000)
      return nullptr;
    Pad& p = next_pads_[i];
    if (!p.layers) {
      p.layers = static_cast<Layers*>(calloc(1, sizeof(Layers)));
      if (!p.layers) return nullptr;
    }
    Layers& l = *p.layers;
    if (layer > l.count) return nullptr;  // in order
    if (layer == l.count) l.count = layer + 1;
    l.up_to[layer] = up_to;
    Take& t = l.take[layer][take];
    if (t.pcm) return nullptr;
    t.pcm = static_cast<float*>(calloc(length, sizeof(float)));
    if (!t.pcm) return nullptr;
    t.length = length, t.rate = rate;
    if (take + 1 > l.takes[layer]) l.takes[layer] = take + 1;
    return t.pcm;
  }
  // A pad playing the caller's sound, which must outlive every voice (the Live's banks).
  bool stage_pad_external(int32_t i, const float* pcm, uint32_t length, double rate, int32_t mode, int32_t root,
                          int32_t choke) {
    if (i < 0 || i >= next_pad_count_ || !pcm || !length) return false;
    next_pads_[i] = Pad{const_cast<float*>(pcm), length, rate, mode, root, choke, false};
    return true;
  }
  void stage_delay(int32_t present, double seconds, double feedback, double wet) {
    next_delay_present_ = present != 0;
    next_delay_seconds_ = seconds;
    next_delay_feedback_ = feedback;
    next_delay_wet_ = wet;
  }
  void stage_base(int32_t index, double value) {
    if (index < 0 || index >= kParams || next_base_count_ >= kParams) return;
    next_base_index_[next_base_count_] = index;
    next_base_value_[next_base_count_++] = value;
  }
  void stage_master(double master) { next_master_ = master; }
  // mixer: 0 none, 1 keep the current mixer, 2 a new one (staged below)
  Mixer* stage_mixer(int32_t mode, double bpm) {
    stage_mixer_ = mode;
    if (mode != 2) return nullptr;
    staged_mixer_ = static_cast<Mixer*>(calloc(1, sizeof(Mixer)));
    if (!staged_mixer_) return nullptr;
    *staged_mixer_ = Mixer{};
    staged_mixer_->rate = rate_;
    staged_mixer_->bpm = bpm;
    return staged_mixer_;
  }
  bool stage_strip(int32_t i, double pan, double send0, double send1, int32_t pan_index, int32_t send0_index,
                   int32_t send1_index) {
    Mixer* m = staged_mixer_;
    if (!m || i < 0 || i >= kTracks) return false;
    Mixer::Strip& s = m->strips[i];
    s.pan = pan;
    s.sends[0] = send0;
    s.sends[1] = send1;
    s.pan_index = pan_index;
    s.send_index[0] = send0_index;
    s.send_index[1] = send1_index;
    if (m->strip_count < i + 1) m->strip_count = i + 1;
    return true;
  }
  bool stage_tempo(double step, double bpm) {
    Mixer* m = staged_mixer_;
    if (!m || m->tempo_count >= kTempos) return false;
    m->tempo_step[m->tempo_count] = step;
    m->tempo_bpm[m->tempo_count++] = bpm;
    return true;
  }
  // chain: 0..7 a track strip, 8 and 9 the two returns. Returns false when full.
  bool stage_effect(int32_t chain, int32_t kind, int32_t bypass, int32_t bypass_index, const int32_t* slot_index,
                    const double* slot_default, double cutoff_raw, int32_t sync, double division,
                    const double* sequence, int32_t sequence_length) {
    Mixer* m = staged_mixer_;
    if (!m) return false;
    Chain* c = chain >= 0 && chain < kTracks ? &m->strips[chain].chain
               : chain == 8                  ? &m->returns[0]
               : chain == 9                  ? &m->returns[1]
                                             : nullptr;
    if (!c || c->count >= 2 || kind < eq || kind > compressor) return false;
    Effect* pair[2] = {&c->left[c->count], &c->right[c->count]};
    for (Effect* e : pair)
      if (!init_effect(*e, kind, bypass, bypass_index, slot_index, slot_default, cutoff_raw, sync, division, sequence,
                       sequence_length, rate_))
        return false;
    ++c->count;
    return true;
  }

  // Main thread: match immutable pad allocations before a live sound update.
  // At hand-over, unchanged buffers and their ownership move together. No
  // sounding voice ever borrows memory from an engine retired on the main thread.
  bool prepare_continuation(const BasicRack& old) {
    if (rate_ != old.rate_ || count_ != old.count_ || delay_present_ != old.delay_present_ ||
        delay_.frames != old.delay_.frames) return false;
    for (int i = 0; i < count_; ++i) {
      const auto& a = tracks_[i]; const auto& b = old.tracks_[i];
      if (a.uid != b.uid || a.kind != b.kind || a.key != b.key || a.route != b.route ||
          a.gain_index != b.gain_index || a.channel_index != b.channel_index) return false;
    }
    bool used[Pads] = {};
    auto audio_equal = [](const float* a, uint32_t n, const float* b, uint32_t m) {
      return n == m && (n == 0 || (a && b && memcmp(a,b,sizeof(float)*n) == 0));
    };
    for (int i = 0; i < pad_count_; ++i) {
      continuation_[i] = -1;
      for (int j = 0; j < old.pad_count_; ++j) {
        if (used[j]) continue;
        const Pad& a = pads_[i]; const Pad& b = old.pads_[j];
        if (a.rate != b.rate || a.mode != b.mode || a.root != b.root || a.choke != b.choke ||
            !audio_equal(a.pcm,a.length,b.pcm,b.length) || bool(a.layers) != bool(b.layers)) continue;
        bool same = true;
        if (a.layers) {
          const Layers& x = *a.layers; const Layers& y = *b.layers;
          same = x.count == y.count;
          for (int l = 0; same && l < x.count; ++l) {
            same = x.up_to[l] == y.up_to[l] && x.takes[l] == y.takes[l];
            for (int t = 0; same && t < x.takes[l]; ++t)
              same = x.take[l][t].rate == y.take[l][t].rate && audio_equal(x.take[l][t].pcm,x.take[l][t].length,y.take[l][t].pcm,y.take[l][t].length);
          }
        }
        if (same) { continuation_[i] = j; used[j] = true; break; }
      }
    }
    return true;
  }
  // Audio thread: only bounded POD copies and pointer swaps. Unchanged pads,
  // round-robin positions, voices, smoothers and effect tails keep their state.
  void continue_from(BasicRack& old) noexcept {
    for (int i = 0; i < pad_count_; ++i) if (continuation_[i] >= 0) {
      Pad temp = pads_[i]; pads_[i] = old.pads_[continuation_[i]]; old.pads_[continuation_[i]] = temp;
    }
    for (int i = 0; i < Voices; ++i) {
      voices_[i] = old.voices_[i];
      Voice& v = voices_[i];
      if (!v.active || !v.has_pad) continue;
      bool owned = false;
      for (int p = 0; !owned && p < pad_count_; ++p) {
        owned = pads_[p].pcm == v.pad.pcm;
        if (const Layers* l = pads_[p].layers)
          for (int k = 0; !owned && k < l->count; ++k)
            for (int t = 0; !owned && t < l->takes[k]; ++t) owned = l->take[k][t].pcm == v.pad.pcm;
      }
      if (!owned) v.active = false;
    }
    for (int i = 0; i < count_; ++i) tracks_[i].last_increment = old.tracks_[i].last_increment;
    memcpy(cur_,old.cur_,sizeof(cur_)); memcpy(has_,old.has_,sizeof(has_));
    memcpy(target_index_,old.target_index_,sizeof(target_index_));
    memcpy(target_value_,old.target_value_,sizeof(target_value_)); target_count_ = old.target_count_;
    memcpy(blocked_,old.blocked_,sizeof(blocked_)); blocked_count_ = old.blocked_count_;
    Mixer* m = mixer_; mixer_ = old.mixer_; old.mixer_ = m;
    Delay d = delay_; delay_ = old.delay_; old.delay_ = d;
  }

  void commit() {
    // Voices: keep, re-gain or fast-release against the replacement (VoiceRack.configure).
    for (auto& v : voices_)
      if (v.active) {
        const Track *old = find(tracks_, count_, v.owner), *next = find(next_, next_count_, v.owner),
                    *old_target = find(tracks_, count_, v.destination),
                    *next_target = find(next_, next_count_, v.destination);
        const int32_t old_route = old ? old->route : -1, next_route = next ? next->route : -1;
        if (!next || !next->gain || !old || old->key != next->key || old_route != next_route ||
            (v.destination != v.owner &&
             (!next_target || !next_target->gain || !old_target || old_target->key != next_target->key)))
          release(v, true);
        else
          v.gain = fmin(1, v.velocity * next->gain * (v.destination == v.owner ? 1 : next_target->gain));
      }
    // Pads: voices keep the sound they started with; free what nothing plays.
    for (int32_t i = 0; i < pad_count_; ++i)
      if (pads_[i].owned) {
        retire(pads_[i].pcm);
        if (Layers* l = pads_[i].layers) {
          for (int32_t k = 0; k < l->count; ++k)
            for (int32_t t = 0; t < l->takes[k]; ++t) retire(l->take[k][t].pcm);
          free(l);
        }
      }
    for (int32_t i = 0; i < Pads; ++i) pads_[i] = next_pads_[i], next_pads_[i] = Pad{};
    pad_count_ = next_pad_count_;
    collect();
    for (int32_t i = 0; i < kTracks; ++i) tracks_[i] = next_[i];
    count_ = next_count_;
    if (stage_mixer_ == 0 || stage_mixer_ == 2) {
      if (mixer_) {
        mixer_->free_rings();
        free(mixer_);
      }
      mixer_ = stage_mixer_ == 2 ? staged_mixer_ : nullptr;
      staged_mixer_ = nullptr;
    }
    if (next_delay_present_) {
      const double frames_wanted = fmax(1, jsround(next_delay_seconds_ * rate_));
      const uint32_t frames = static_cast<uint32_t>(frames_wanted);
      if (!delay_present_ || delay_.frames != frames) {
        free(delay_.ring);
        delay_ = Delay{};
        delay_.frames = frames;
        delay_.ring = static_cast<float*>(calloc(frames, sizeof(float)));
      }
      delay_.feedback = next_delay_feedback_;
      delay_.wet = next_delay_wet_;
      delay_present_ = delay_.ring != nullptr;
    } else {
      free(delay_.ring);
      delay_ = Delay{};
      delay_present_ = false;
    }
    master_gain = next_master_;
    // Current values: only the base's parameters, keeping values already reached.
    static double previous[kParams];
    static uint8_t had[kParams];
    memcpy(previous, cur_, sizeof(cur_));
    memcpy(had, has_, sizeof(has_));
    memset(has_, 0, sizeof(has_));
    for (int32_t i = 0; i < next_base_count_; ++i) {
      const int32_t k = next_base_index_[i];
      cur_[k] = had[k] ? previous[k] : next_base_value_[i];
      has_[k] = 1;
    }
    target_count_ = 0;
    for (int32_t i = 0; i < next_base_count_; ++i) {
      target_index_[target_count_] = next_base_index_[i];
      target_value_[target_count_++] = next_base_value_[i];
    }
    for (int32_t i = 0; i < next_base_count_; ++i) {
      base_index_[i] = next_base_index_[i];
      base_value_[i] = next_base_value_[i];
    }
    base_count_ = next_base_count_;
  }

  // ---- parameters (applyParameters / resetParameters) ----
  void targets_begin() { pending_count_ = 0; }
  void targets_add(int32_t index, double value) {
    if (index < 0 || index >= kParams || pending_count_ >= kParams) return;
    pending_index_[pending_count_] = index;
    pending_value_[pending_count_++] = value;
  }
  void targets_commit() {
    target_count_ = pending_count_;
    for (int32_t i = 0; i < pending_count_; ++i) {
      target_index_[i] = pending_index_[i];
      target_value_[i] = pending_value_[i];
      if (!has_[pending_index_[i]]) {
        cur_[pending_index_[i]] = pending_value_[i];
        has_[pending_index_[i]] = 1;
      }
    }
  }
  void reset_parameters() {
    targets_begin();
    for (int32_t i = 0; i < base_count_; ++i) targets_add(base_index_[i], base_value_[i]);
    targets_commit();
  }
  bool has_value(int32_t i) const { return i >= 0 && i < kParams && has_[i]; }
  double value(int32_t i) const { return has_value(i) ? cur_[i] : 0; }
  void set_bypass_flag(int32_t i, bool bypass) {
    if (i >= 0 && i < kParams) bypass_param_[i] = bypass;
  }

  // ---- blocked tracks (setBlockedTracks) ----
  void blocked_begin() { pending_blocked_count_ = 0; }
  void blocked_add(int32_t uid) {
    if (pending_blocked_count_ < kTracks) pending_blocked_[pending_blocked_count_++] = uid;
  }
  void blocked_commit() {
    int32_t previous[kTracks], previous_count = blocked_count_;
    for (int32_t i = 0; i < blocked_count_; ++i) previous[i] = blocked_[i];
    blocked_count_ = pending_blocked_count_;
    for (int32_t i = 0; i < blocked_count_; ++i) blocked_[i] = pending_blocked_[i];
    auto was = [&](int32_t uid) {
      for (int32_t i = 0; i < previous_count; ++i)
        if (previous[i] == uid) return true;
      return false;
    };
    for (auto& v : voices_)
      if (v.active && (blocked(v.owner) || blocked(v.destination)) && !was(v.owner) && !was(v.destination))
        release(v, true);
  }
  bool blocked(int32_t uid) const {
    for (int32_t i = 0; i < blocked_count_; ++i)
      if (blocked_[i] == uid) return true;
    return false;
  }
  bool track_blocked(int32_t index) const {
    if (index < 0 || index >= count_) return true;
    const Track& t = tracks_[index];
    return blocked(t.uid) || blocked(t.route >= 0 ? t.route : t.uid);
  }

  // ---- notes ----
  // 0 refused, 1 played, 2 a custom (JavaScript) machine plays it.
  int32_t note_on(double id, int32_t pad_index, int32_t track_index, int32_t note, double velocity,
                  int64_t duration) {
    if (track_index < 0 || track_index >= count_ || pad_index < 0 || pad_index >= pad_count_) return 0;
    Track& track = tracks_[track_index];
    if (blocked(track.uid) || track.muted || (!track.gain && !target_of(track.gain_index))) return 0;
    if (track.kind == none) return 0;
    if (track.kind == custom) return 2;
    if (track.midi_machine && track.silent_route) return 0;
    Track* target = track.route >= 0 ? find(tracks_, count_, track.route) : &track;
    if (!target || target->muted || blocked(target->uid) || (!target->gain && !target_of(target->gain_index)))
      return 0;
    // The sounding track's kit: a MIDI track routed to a kit plays that kit's pads.
    const int32_t slot = target->pad_base + pad_index;
    if (slot < 0 || slot >= pad_count_) return 0;
    // A multi-sampled pad: the velocity picks the layer, and the layer's takes
    // play in turn. Its recordings carry the dynamics, so velocity scales the
    // level only gently inside the layer.
    Pad pad = pads_[slot];
    double level = velocity;
    if (Layers* l = pad.layers) {
      int32_t at = 0;
      while (at < l->count - 1 && velocity > l->up_to[at]) ++at;
      const int32_t takes = l->takes[at] > 0 ? l->takes[at] : 1;
      const Take& t = l->take[at][l->next[at] % takes];
      l->next[at] = (l->next[at] + 1) % takes;
      if (t.pcm) pad.pcm = t.pcm, pad.length = t.length, pad.rate = t.rate;
      pad.layers = nullptr;
      level = velocity > 0 ? 0.6 + 0.4 * velocity : 0;
    }
    const bool sampler_sound = target->kind == sampler, synth_sound = target->kind == subtractive;
    for (auto& v : voices_)
      if (v.active && (v.id == id || (sampler_sound && v.destination == target->uid && pad.choke > 0 &&
                                      v.has_pad && v.pad.choke == pad.choke)))
        release(v, true);
    Voice* v = nullptr;
    for (auto& candidate : voices_)
      if (!candidate.active) {
        v = &candidate;
        break;
      }
    if (!v) {
      ++refused;
      return 0;
    }
    *v = Voice{};
    v->active = true;
    v->id = id;
    v->owner = track.uid;
    v->destination = target->uid;
    if (sampler_sound) v->has_pad = true, v->pad = pad;
    if (synth_sound) v->has_patch = true, v->patch = target->patch;
    v->note = note;
    v->gain = fmin(1, level * track.gain * (target == &track ? 1 : target->gain));
    v->velocity = level;
    v->gate = duration;
    v->midi = v->midi_active = track.base_midi;
    v->channel = track.midi_machine
                     ? static_cast<int32_t>(jsround(
                           1 + 15 * (has_value(track.channel_index) ? cur_[track.channel_index]
                                                                    : (track.channel_state - 1) / 15)))
                     : 1;
    v->increment = v->has_patch ? fmin(0.45, (440 * pow(2, (note - 69) / 12.0)) / rate_)
                                : (pad.rate / rate_) * (pad.mode == chromatic ? pow(2, (note - pad.root) / 12.0) : 1);
    if (v->has_patch) {
      // A glide starts from the track's previous note.
      if (v->patch.glide > 0 && target->last_increment > 0 && target->last_increment != v->increment)
        v->glide_to = v->increment, v->increment = target->last_increment;
      target->last_increment = v->glide_to > 0 ? v->glide_to : v->increment;
    }
    if (v->midi) emit(1, id, note, fmin(1, velocity * track.gain), v->channel);
    return 1;
  }
  void note_off(double id) {
    for (auto& v : voices_)
      if (v.active && v.id == id && (v.has_patch || v.midi || !v.has_pad || v.pad.mode != one_shot))
        release(v, false);
  }
  void release_track(int32_t uid) {
    for (auto& v : voices_)
      if (v.active && v.owner == uid) release(v, true);
  }
  void remove_track(int32_t uid) {
    for (auto& v : voices_)
      if (v.active && (v.owner == uid || v.destination == uid)) release(v, true);
  }
  void panic() {
    for (auto& v : voices_)
      if (v.active) release(v, true);
  }
  // ---- for the Live (live_engine.hpp), without reconfiguring ----
  // A track's instrument for the notes that start from now on.
  void set_track_sound(int32_t index, int32_t kind, const Patch& patch) {
    if (index < 0 || index >= count_) return;
    tracks_[index].kind = kind;
    tracks_[index].patch = patch;
  }
  // Releases a track's held synth notes of one pitch (a pad let go).
  void note_off_note(int32_t uid, int32_t note) {
    for (auto& v : voices_)
      if (v.active && v.owner == uid && v.has_patch && v.note == note) release(v, false);
  }
  // Releases sounding synth notes (Stop), of one track or of all (uid -1).
  void release_patches(int32_t uid) {
    for (auto& v : voices_)
      if (v.active && v.has_patch && (uid < 0 || v.owner == uid)) release(v, false);
  }
  void clear_tail() {
    if (delay_present_) delay_.clear();
    if (mixer_) mixer_->clear();
  }
  void clock(double step, double bpm) {
    if (mixer_) mixer_->step = step, mixer_->bpm = bpm;
  }
  int32_t active() const {
    int32_t n = 0;
    for (const auto& v : voices_) n += v.active;
    return n;
  }
  bool has_mixer() const { return mixer_ != nullptr; }
  bool meter(bool reset) {
    if (!mixer_) return false;
    Mixer& m = *mixer_;
    meter_out[0] = m.peak_l;
    meter_out[1] = m.peak_r;
    meter_out[2] = m.samples ? sqrt(m.sum_squares / static_cast<double>(m.samples)) : 0;
    meter_out[3] = static_cast<double>(m.clipped);
    if (reset) m.peak_l = m.peak_r = m.sum_squares = 0, m.samples = m.clipped = 0;
    return true;
  }
  double track_gain(int32_t index) const { return index >= 0 && index < count_ ? tracks_[index].gain : 0; }

  // ---- processing ----
  // Whole block without custom machines (VoiceRack.process).
  void process(int32_t frames, const float* sample = nullptr, int32_t sample_track = -1) {
    advanced = false;
    if (mixer_) {
      for (int32_t i = 0; i < frames; ++i) {
        frame_voices(i, sample ? sample[i] : 0, sample_track);
        frame_mix(i);
      }
      return;
    }
    if (sample) {
      for (int32_t i = 0; i < frames; ++i) {
        frame_voices(i, sample[i], sample_track);
      }
    } else voices_block(frames);
    finish(frames);
  }
  // Without a mixer: the voices for a block, then custom audio, then finish().
  void voices_block(int32_t frames) {
    for (int32_t i = 0; i < frames; ++i) frame_voices(i);
  }
  void custom_add(int32_t track_index, const float* audio, int32_t frames) {
    const double gain = track_index >= 0 && track_index < count_ ? tracks_[track_index].gain : 0,
                 send = track_index >= 0 && track_index < count_ ? tracks_[track_index].delay_send : 0;
    for (int32_t i = 0; i < frames; ++i) {
      const double value = audio[i], add = isfinite(value) ? value * gain : 0;
      send_frames_[i] = static_cast<float>(send_frames_[i] + add * (delay_present_ ? send : 0));
      left[i] = right[i] = static_cast<float>(clampd(left[i] + add, -1, 1));
    }
  }
  void finish(int32_t frames) {
    for (int32_t i = 0; i < frames; ++i) {
      const double wet = delay_present_ ? delay_.process(send_frames_[i]) : 0;
      left[i] = static_cast<float>(clampd(left[i] + wet, -1, 1) * master_frames_[i]);
      right[i] = static_cast<float>(clampd(right[i] + wet, -1, 1) * master_frames_[i]);
    }
  }
  // With a mixer: frame_voices(i), then custom audio into the strips, then frame_mix(i).
  void frame_custom(int32_t track_index, double value) {
    if (track_index >= 0 && track_index < count_)
      mix_inputs_[track_index] += (isfinite(value) ? value : 0) * tracks_[track_index].gain;
  }
  void frame_mix(int32_t i) {
    mixer_->process(mix_inputs_, master_gain, cur_, has_);
    left[i] = static_cast<float>(mixer_->left);
    right[i] = static_cast<float>(mixer_->right);
    ++frame;
  }
  // A synth voice's coefficients from its patch at `seconds` into the note:
  // the resonant filter's cutoff (opened by the filter envelope, further for
  // harder hits), the second oscillator's ratio and the glide's pace.
  void control(Voice& v, double seconds) {
    const Patch& p = v.patch;
    if (p.detune > 0) v.ratio2 = pow(2, p.detune / 1200);
    if (v.glide_to > 0) v.glide_keep = exp(-4 / (fmax(p.glide, 0.001) * rate_));
    if (p.resonance > 0 || p.env_amount > 0) {
      const double accent = 0.35 + 0.65 * fmin(1, v.velocity),
                   opened = p.env_amount * accent * exp(-seconds / fmax(p.env_decay, 0.01));
      const double hz = fmin(p.cutoff * pow(2, opened), rate_ * 0.45);
      const double g = tan(kPi * hz / rate_), k = 2 - 1.94 * clampd(p.resonance, 0, 1);
      v.svf_a1 = 1 / (1 + g * (g + k));
      v.svf_a2 = g * v.svf_a1;
      v.svf_a3 = g * v.svf_a2;
    }
  }
  // A newly captured loop is a full-velocity sampler voice until its clip
  // takes over. Feed the same strip before pan, inserts, sends and master.
  void frame_voices(int32_t i, double sample = 0, int32_t sample_track = -1) {
    if (target_count_) advance_parameters(), advanced = true;
    master_frames_[i] = static_cast<float>(master_gain);
    double mixed = 0;
    send_frames_[i] = 0;
    if (mixer_)
      for (auto& m : mix_inputs_) m = 0;
    for (auto& v : voices_) {
      if (!v.active) continue;
      if (v.gate && v.age >= v.gate && v.release_age < 0 &&
          (v.has_patch || v.midi || !v.has_pad || v.pad.mode != one_shot))
        release(v, false);
      if (!v.active) continue;
      double value = 0;
      if (v.has_patch) {
        const Patch& p = v.patch;
        const bool shaped = p.resonance > 0 || p.env_amount > 0, moving = p.detune > 0 || v.glide_to > 0;
        const double seconds = static_cast<double>(v.age) / rate_;
        if ((shaped || moving) && (v.age % kControl == 0 || (shaped && v.svf_a1 == 0))) control(v, seconds);
        if (v.glide_to > 0) {
          v.increment = v.glide_to + (v.increment - v.glide_to) * v.glide_keep;
          if (fabs(v.increment - v.glide_to) < 1e-9) v.increment = v.glide_to, v.glide_to = 0;
        }
        double oscillator = wave(p.oscillator, v.phase, v.increment);
        v.phase = jsmod(v.phase + v.increment, 1);
        if (p.detune > 0) {
          const double increment2 = fmin(0.45, v.increment * v.ratio2);
          oscillator = 0.5 * (oscillator + wave(p.oscillator, v.phase2, increment2));
          v.phase2 = jsmod(v.phase2 + increment2, 1);
        }
        if (shaped) {
          // A resonant two-pole low-pass (a state-variable filter); at no
          // resonance its slope matches the plain filter below. Resonance
          // takes a little level off the input, and its peak is softly limited.
          const double x = oscillator * (1 - 0.45 * p.resonance), v3 = x - v.filter2;
          const double v1 = v.svf_a1 * v.filter1 + v.svf_a2 * v3, v2 = v.filter2 + v.svf_a2 * v.filter1 + v.svf_a3 * v3;
          v.filter1 = 2 * v1 - v.filter1, v.filter2 = 2 * v2 - v.filter2;
          value = 0.4 * v2 / (1 + 0.25 * fabs(v2));
        } else {
          const double rate = rate_;
          const double coefficient = v.filter_coefficient.of(
              p.cutoff, [rate](double c) { return 1 - exp((-2 * kPi * fmin(c, rate * 0.45)) / rate); });
          v.filter1 += coefficient * (oscillator - v.filter1);
          v.filter2 += coefficient * (v.filter1 - v.filter2);
          value = v.filter2 * 0.4;
        }
        v.level = seconds < p.attack                ? seconds / p.attack
                  : seconds < p.attack + p.decay ? 1 - ((1 - p.sustain) * (seconds - p.attack)) / p.decay
                                                 : p.sustain;
      } else if (v.has_pad && !v.audio_done) {
        const Pad& p = v.pad;
        const double index = floor(v.cursor), fraction = v.cursor - index;
        const uint32_t at = static_cast<uint32_t>(index);
        if (p.length) {
          const double a = at < p.length ? p.pcm[at] : 0;
          const uint32_t next = at + 1 < p.length - 1 ? at + 1 : p.length - 1;
          value = a * (1 - fraction) + static_cast<double>(p.pcm[next]) * fraction;
        }
        v.cursor += v.increment;
        v.level = 1;
        if (v.cursor >= p.length) {
          if (p.mode == loop)
            v.cursor = jsmod(v.cursor, p.length);
          else {
            v.audio_done = true;
            if (!v.midi_active) v.active = false;
          }
        }
      }
      if (v.release_age >= 0) {
        v.level = v.release_level * fmax(0, 1 - static_cast<double>(v.release_age) / v.release_frames);
        ++v.release_age;
        if (v.release_age >= v.release_frames) {
          v.audio_done = true;
          v.active = false;
        }
      }
      const double contribution = value * v.gain * v.level;
      mixed += contribution;
      const int32_t index = index_of(v.destination);
      if (mixer_ && index >= 0) mix_inputs_[index] += contribution;
      const double send = delay_present_ && index >= 0 ? tracks_[index].delay_send : 0;
      send_frames_[i] = static_cast<float>(send_frames_[i] + contribution * send);
      ++v.age;
    }
    if (sample_track >= 0 && sample_track < count_ && isfinite(sample) && sample != 0) {
      const Track& track = tracks_[sample_track];
      if (!track.muted && !blocked(track.uid)) {
        const double contribution = sample * fmin(1, track.gain);
        mixed += contribution;
        if (mixer_) mix_inputs_[sample_track] += contribution;
        send_frames_[i] += static_cast<float>(contribution * (delay_present_ ? track.delay_send : 0));
      }
    }
    left[i] = right[i] = static_cast<float>(clampd(isfinite(mixed) ? mixed : 0, -1, 1));
    if (!mixer_) ++frame;
  }

 private:
  static const Track* find(const Track* list, int32_t count, int32_t uid) {
    for (int32_t i = 0; i < count; ++i)
      if (list[i].uid == uid) return &list[i];
    return nullptr;
  }
  static Track* find(Track* list, int32_t count, int32_t uid) {
    for (int32_t i = 0; i < count; ++i)
      if (list[i].uid == uid) return &list[i];
    return nullptr;
  }
  int32_t index_of(int32_t uid) const {
    for (int32_t i = 0; i < count_; ++i)
      if (tracks_[i].uid == uid) return i;
    return -1;
  }
  // The target value of a parameter if it is being smoothed (its first entry).
  double target_of(int32_t index) const {
    if (index < 0) return 0;
    for (int32_t i = 0; i < target_count_; ++i)
      if (target_index_[i] == index) return target_value_[i];
    return 0;
  }
  void emit(int32_t kind, double id, int32_t note, double velocity, int32_t channel) {
    if (midi_count >= kMidiEvents) {
      ++midi_overflow;
      return;
    }
    midi[midi_count++] = {id, velocity, kind, note, channel, 0};
  }
  void release(Voice& v, bool fast) {
    if (v.release_age >= 0 && !fast) return;
    if (v.midi_active) {
      emit(0, v.id, v.note, 0, v.channel);
      v.midi_active = false;
    }
    if (v.midi && ((!v.has_patch && !v.has_pad) || v.audio_done)) {
      v.active = false;
      return;
    }
    if (!fast && v.midi && v.has_pad && v.pad.mode == one_shot) return;
    v.release_age = 0;
    v.release_frames = static_cast<int64_t>(
        fmax(1, jsround((fast ? kPanicSeconds : (v.has_patch ? v.patch.release : kPanicSeconds)) * rate_)));
    v.release_level = v.has_patch ? v.level : 1;
  }
  void advance_parameters() {
    for (int32_t i = 0; i < target_count_; ++i) {
      const int32_t k = target_index_[i];
      const double target = target_value_[i], c = has_[k] ? cur_[k] : target;
      cur_[k] = bypass_param_[k] ? target : c + alpha_ * (target - c);
      has_[k] = 1;
    }
    if (master_index_ >= 0 && has_[master_index_]) master_gain = cur_[master_index_];
    for (int32_t t = 0; t < count_; ++t) {
      Track& track = tracks_[t];
      const double g = track.gain_index >= 0 && has_[track.gain_index] ? cur_[track.gain_index] : 0.8,
                   e = track.effect_gain_index >= 0 && has_[track.effect_gain_index] ? cur_[track.effect_gain_index]
                                                                                     : 0.5;
      const double gain = track.muted ? 0 : g * e * 2;
      if (track.gain_index >= 0 && has_[track.gain_index]) track.gain = gain;
      if (track.kind == subtractive)
        for (int p = 0; p < kPatchFields; ++p) {
          const int32_t k = track.patch_index[p];
          if (k < 0 || !has_[k]) continue;
          const double value = kPatchMin[p] + cur_[k] * (kPatchMax[p] - kPatchMin[p]);
          for (auto& v : voices_)
            if (v.active && v.destination == track.uid && v.has_patch) patch_field(v.patch, p) = value;
        }
    }
    for (auto& v : voices_)
      if (v.active) {
        const Track *source = find(tracks_, count_, v.owner), *target = find(tracks_, count_, v.destination);
        v.gain = fmin(1, v.velocity * (source ? source->gain : 0) *
                             (v.destination == v.owner ? 1 : (target ? target->gain : 0)));
      }
  }
  // A sound leaving the rack: freed now unless a voice still plays it.
  void retire(float* pcm) {
    if (!pcm) return;
    for (const auto& v : voices_)
      if (v.active && v.has_pad && v.pad.pcm == pcm) {
        if (retired_count_ < kRetired) retired_[retired_count_++] = pcm;
        return;
      }
    free(pcm);
  }
  void collect() {
    int32_t kept = 0;
    for (int32_t i = 0; i < retired_count_; ++i) {
      bool used = false;
      for (const auto& v : voices_)
        if (v.active && v.has_pad && v.pad.pcm == retired_[i]) used = true;
      for (int32_t p = 0; p < pad_count_; ++p)
        if (pads_[p].pcm == retired_[i]) used = true;
      if (used)
        retired_[kept++] = retired_[i];
      else
        free(retired_[i]);
    }
    retired_count_ = kept;
  }

 public:
  int32_t master_index_ = -1;  // "master.gain"

 private:
  int32_t continuation_[Pads] = {};
  int32_t rate_;
  double alpha_;
  Voice voices_[Voices];
  Track tracks_[kTracks], next_[kTracks];
  int32_t count_ = 0, next_count_ = 0;
  Pad pads_[Pads], next_pads_[Pads];
  int32_t pad_count_ = 0, next_pad_count_ = 0;
  float* retired_[kRetired] = {};
  int32_t retired_count_ = 0;
  double cur_[kParams];
  uint8_t has_[kParams];
  uint8_t bypass_param_[kParams] = {};
  int32_t target_index_[kParams] = {}, pending_index_[kParams] = {}, base_index_[kParams] = {},
          next_base_index_[kParams] = {};
  double target_value_[kParams] = {}, pending_value_[kParams] = {}, base_value_[kParams] = {},
         next_base_value_[kParams] = {};
  int32_t target_count_ = 0, pending_count_ = 0, base_count_ = 0, next_base_count_ = 0;
  int32_t blocked_[kTracks] = {}, blocked_count_ = 0, pending_blocked_[kTracks] = {}, pending_blocked_count_ = 0;
  Mixer* mixer_ = nullptr;
  Mixer* staged_mixer_ = nullptr;
  int32_t stage_mixer_ = 0;
  Delay delay_{};
  bool delay_present_ = false, next_delay_present_ = false;
  double next_delay_seconds_ = 0, next_delay_feedback_ = 0, next_delay_wet_ = 0, next_master_ = 1;
  float send_frames_[kBlock] = {}, master_frames_[kBlock] = {};
  double mix_inputs_[kTracks] = {};
};

using Rack = BasicRack<>;

}  // namespace xmp::rack
