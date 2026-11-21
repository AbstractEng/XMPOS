#pragma once
// Playing a full XMP project on the Live in real time: the project's engine
// (rack.hpp, set up from the project by voices.hpp) on the audio thread, and
// the performance (performance.hpp) stepped on the main thread.
//
// - Main thread (one producer): ProjectPlayer computes each performance window
//   a little ahead of the audio clock, turns it into plain numeric commands
//   (note on, releases, silenced tracks, parameter values, effect clock) with
//   their session frame, and queues them. Every ID is resolved to a number
//   here; everything that allocates or validates text stays on this side.
// - Audio thread (one consumer): ProjectSound applies each command on its
//   exact frame and has the engine render the runs between them. It calls only
//   the engine's allocation-free functions: no allocation, locks or I/O.
//
// Played this way, a project sounds exactly as render.hpp's renderPerformance
// renders it offline; native/tests/live_player_test.cpp compares them sample
// for sample.
#include <atomic>
#include <algorithm>

#include "xmp/render.hpp"
#include "xmp/live_loop.hpp"

namespace xmp::live {

using json::Value;

struct PlayerCommand {
  enum Kind : uint8_t { note_on, release, gates_begin, gate, gates_commit, params_begin, param, params_commit, clock, panic, cancel_after, note_off, swap, retime, cancel_track };
  Kind kind = note_on;
  uint64_t frame = 0;
  int32_t a = 0, b = 0, c = 0;  // note_on: pad, track, note; release/gate: track uid; param: index; note_off: uid, -, note
  double x = 0, y = 0, z = 0;   // note_on: id, velocity, duration; param: value; clock: step, bpm
};

class ProjectSound {
 public:
  static constexpr size_t kQueue = 16384;
  static constexpr size_t kPending = 8192;

  ProjectSound() : queue_(static_cast<PlayerCommand*>(checked_alloc(sizeof(PlayerCommand) * (kQueue + 1)))),
                   pending_(static_cast<PlayerCommand*>(checked_alloc(sizeof(PlayerCommand) * kPending))) {}
  ~ProjectSound() {
    if (rack_) rack_->~Rack(), free(rack_);
    voices::Rack* left[2] = {staged_.exchange(nullptr), retired_.exchange(nullptr)};
    for (auto* r : left)
      if (r) r->~Rack(), free(r);
    free(queue_);
    free(pending_);
  }
  ProjectSound(const ProjectSound&) = delete;
  ProjectSound& operator=(const ProjectSound&) = delete;

  // Before the audio thread runs (or while it is not calling process).
  bool prepare(const Value& project, Str& error) {
    rack_ = main_ = build(project, error);
    return rack_ != nullptr;
  }
  // Main thread, while the audio thread runs: a new engine for `project` (a
  // track's sound changed), handed over at the next audio block. Compatible
  // voices and unchanged effect histories continue through the handover. The old
  // engine is freed on the main thread later (collect), never on the audio thread.
  bool reload(const Value& project, Str& error, uint64_t at = 0, bool seamless = false) {
    collect();
    if (staged_.load(std::memory_order_acquire) || retired_.load(std::memory_order_acquire))
      return error = "The last sound change is still being applied", false;
    voices::Rack* next = build(project, error, main_);
    if (!next) return false;
    next->prepare_handover(*main_);
    staged_.store(next, std::memory_order_release);
    PlayerCommand c;
    c.kind = PlayerCommand::swap, c.frame = at;
    (void)seamless;
    if (!push(c)) {
      staged_.store(nullptr, std::memory_order_relaxed);
      next->~Rack(), free(next);
      return error = "Command queue full", false;
    }
    main_ = next;  // lookups (track uids, parameter indices) from now on
    return true;
  }
  // Main thread: frees an engine the audio thread has let go of.
  void collect() {
    if (voices::Rack* old = retired_.exchange(nullptr, std::memory_order_acq_rel)) old->~Rack(), free(old);
  }
  // Main thread: the engine as the main thread knows it (for lookups).
  voices::Rack& rack() { return *main_; }
  bool ready() const { return main_ != nullptr; }

  // ---- main thread ----
  bool push(const PlayerCommand& c) {
    const size_t head = head_.load(std::memory_order_relaxed), next = (head + 1) % (kQueue + 1);
    if (next == tail_.load(std::memory_order_acquire)) return dropped_.fetch_add(1, std::memory_order_relaxed), false;
    queue_[head] = c;
    head_.store(next, std::memory_order_release);
    return true;
  }
  // A note played live from the pads (frame 0: as soon as the audio thread
  // runs), on track `index` of the project. Held until note_off for a synth;
  // a kit's one-shot plays out.
  bool play_live(int32_t index, int32_t pad, int32_t note, double velocity) {
    if (!main_) return false;
    PlayerCommand c;
    c.kind = PlayerCommand::note_on, c.a = pad, c.b = index, c.c = note;
    c.x = kLiveIds + static_cast<double>(live_id_++), c.y = velocity, c.z = 48000.0 * 60;
    return push(c);
  }
  bool release_live(const Str& track, int32_t note) {
    if (!main_) return false;
    PlayerCommand c;
    c.kind = PlayerCommand::note_off, c.a = main_->uid_of(track), c.c = note;
    return c.a >= 0 && push(c);
  }
  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }
  // Scheduled notes that played late, and the worst lateness in frames.
  uint64_t late() const { return late_.load(std::memory_order_relaxed); }
  uint64_t worst_late_frames() const { return worst_late_.load(std::memory_order_relaxed); }
  uint32_t active_voices() const { return active_.load(std::memory_order_relaxed); }

  // ---- audio thread ----
  // Adds `frames` samples starting at session frame `start` into left and right.
  void process(float* left, float* right, uint32_t frames, uint64_t start,
               sample::LoopTake* loop = nullptr, const float* input = nullptr, const uint8_t* valid = nullptr) noexcept {
    if (!rack_) return;
    drain();
    uint32_t done = 0;
    while (done < frames) {
      const uint64_t now = start + done;
      apply_due(now);
      rack::Rack& e = rack_->engine();  // after any swap
      uint64_t next = start + frames;
      for (size_t i = 0; i < pending_size_; ++i)
        if (pending_[i].frame > now && pending_[i].frame < next) next = pending_[i].frame;
      const auto n = static_cast<uint32_t>(next - now < rack::kBlock ? next - now : rack::kBlock);
      const bool sampling = loop && input && valid && loop->busy();
      // Publishing during process() lets the control thread queue another track.
      const int32_t sample_track = sampling ? loop->track() : -1;
      if (sampling) {
        std::fill_n(loop_audio_.data(), n, 0.f);
        std::fill_n(loop_other_.data(), n, 0.f);
        loop->process(now, input + done, valid + done, n, loop_audio_.data(), loop_other_.data(), 1.f);
      }
      e.process(static_cast<int32_t>(n), sampling ? loop_audio_.data() : nullptr, sample_track);
      e.midi_count = 0, e.midi_overflow = 0;  // MIDI out is not wired on the Live yet
      for (uint32_t i = 0; i < n; ++i) left[done + i] += e.left[i], right[done + i] += e.right[i];
      done += n;
    }
    active_.store(static_cast<uint32_t>(rack_->engine().active()), std::memory_order_relaxed);
  }

 private:
  void drain() noexcept {
    for (;;) {
      const size_t tail = tail_.load(std::memory_order_relaxed);
      if (tail == head_.load(std::memory_order_acquire) || pending_size_ == kPending) break;
      pending_[pending_size_++] = queue_[tail];
      tail_.store((tail + 1) % (kQueue + 1), std::memory_order_release);
    }
  }
  // Applies what is due by `now`, in queue order. A cancel drops everything
  // still pending after its frame (queued before it) and silences the engine;
  // what was queued after the cancel (a restart) carries on.
  void apply_due(uint64_t now) noexcept {
    size_t kept = 0;
    for (size_t i = 0; i < pending_size_; ++i) {
      const PlayerCommand c = pending_[i];
      if (c.frame > now) {
        pending_[kept++] = c;
        continue;
      }
      if (c.kind == PlayerCommand::cancel_after) {
        kept = 0;
        rack_->engine().panic();
        continue;
      }
      if (c.kind == PlayerCommand::cancel_track) {
        size_t remaining = 0;
        for (size_t j = 0; j < kept; ++j)
          if (pending_[j].kind != PlayerCommand::note_on || pending_[j].b != c.b)
            pending_[remaining++] = pending_[j];
        kept = remaining;
        rack_->engine().release_track(c.a);
        continue;
      }
      if (c.kind == PlayerCommand::retime) {
        for (size_t j = 0; j < kept; ++j) {
          auto& queued = pending_[j];
          queued.frame = c.frame + static_cast<uint64_t>(rack::jsround((queued.frame - c.frame) * c.x));
          if (queued.kind == PlayerCommand::note_on) queued.z *= c.x;
          if (queued.kind == PlayerCommand::clock) queued.y = c.y;
        }
        rack_->engine().retime_gates(c.x);
        continue;
      }
      // A scheduled note that reaches the engine a block or more after its
      // frame was queued too late (the main thread fell behind): counted, with
      // the worst lateness. Live notes (frame 0) play as soon as they arrive.
      if (c.kind == PlayerCommand::note_on && c.frame != 0 && now > c.frame + kLateFrames) {
        late_.fetch_add(1, std::memory_order_relaxed);
        const uint64_t by = now - c.frame;
        if (by > worst_late_.load(std::memory_order_relaxed)) worst_late_.store(by, std::memory_order_relaxed);
      }
      apply(c);
    }
    pending_size_ = kept;
  }
  void apply(const PlayerCommand& c) noexcept {
    if (c.kind == PlayerCommand::swap) {
      if (voices::Rack* next = staged_.exchange(nullptr, std::memory_order_acq_rel)) {
        next->inherit(*rack_);
        retired_.store(rack_, std::memory_order_release);
        rack_ = next;
      }
      return;
    }
    rack::Rack& e = rack_->engine();
    switch (c.kind) {
      case PlayerCommand::note_on:
        e.note_on(c.x, c.a, c.b, c.c, c.y, static_cast<int64_t>(c.z));
        break;
      case PlayerCommand::release: e.release_track(c.a); break;
      case PlayerCommand::gates_begin: e.blocked_begin(); break;
      case PlayerCommand::gate: e.blocked_add(c.a); break;
      case PlayerCommand::gates_commit: e.blocked_commit(); break;
      case PlayerCommand::params_begin: e.targets_begin(); break;
      case PlayerCommand::param: e.targets_add(c.a, c.x); break;
      case PlayerCommand::params_commit: e.targets_commit(); break;
      case PlayerCommand::clock: e.clock(c.x, c.y); break;
      case PlayerCommand::panic: e.panic(); break;
      case PlayerCommand::cancel_after: break;
      case PlayerCommand::note_off: e.note_off_note(c.a, c.c); break;
      case PlayerCommand::swap: break;
      case PlayerCommand::retime: break;
      case PlayerCommand::cancel_track: break;
    }
  }
  static voices::Rack* build(const Value& project, Str& error, const voices::Rack* previous = nullptr) {
    voices::Palette palette;
    if (!voices::prepare_instruments(project, palette, error)) return nullptr;
    palette.has_master = true;
    if (!parameters::value(project, Str("master.gain"), palette.sequence_master, error)) return nullptr;
    auto* rack = new (checked_alloc(sizeof(voices::Rack))) voices::Rack(48000, previous);
    bool ok = rack->configure(palette, error);
    if (ok) {
      for (const auto& d : parameters::registry(project)) rack->register_parameter(d.id);
      for (const auto& t : project::detail::list(project, "tracks")) rack->register_track(project::detail::str(t, "id"));
    } else {
      rack->~Rack(), free(rack);
      rack = nullptr;
    }
    return rack;
  }

  static constexpr double kLiveIds = 1e12;  // live notes never share an id with the player's
  uint64_t live_id_ = 0;
  voices::Rack* rack_ = nullptr;  // the audio thread's
  voices::Rack* main_ = nullptr;  // the main thread's (the same, or the one handed over next)
  std::atomic<voices::Rack*> staged_{nullptr}, retired_{nullptr};  // reload's hand-over
  PlayerCommand* queue_;
  PlayerCommand* pending_;
  size_t pending_size_ = 0;
  std::array<float, rack::kBlock> loop_audio_{}, loop_other_{};
  std::atomic<size_t> head_{0}, tail_{0};
  std::atomic<uint64_t> dropped_{0};
  static constexpr uint64_t kLateFrames = 256;  // one audio block
  std::atomic<uint64_t> late_{0}, worst_late_{0};
  std::atomic<uint32_t> active_{0};
};

// A project without its samples' audio: everything the performance and the
// player read (playback never touches the samples; ProjectSound has its own
// copy). Copying it is quick, where a full project is megabytes of numbers.
inline Value lean(const Value& project) {
  Value out = Value::new_object();
  for (const auto& m : project.members())
    out.set(m.key, m.key == "samples" ? Value::new_array() : m.value);
  return out;
}

// The performance stepped on the main thread, a little ahead of the audio clock.
class ProjectPlayer {
 public:
  bool fill_held = false;
  // `steps`: stop after this many steps (0: run until the performance stops).
  // `resume`: a song starts from the project's saved position.
  bool start(const Value& project, ProjectSound& sound, const Str& scene, bool song, uint64_t origin_frame, double steps,
             Str& error, bool resume = false) {
    release();
    project_ = lean(project);
    sound_ = &sound;
    perf_ = new (checked_alloc(sizeof(play::Performance))) play::Performance(project_);
    if (!perf_->ok()) return error = perf_->error(), false;
    if (!perf_->start(scene, song, resume, error)) return false;
    origin_ = origin_frame, next_step_ = 0, limit_ = steps, playing_ = true, id_ = 1;
    heard_count_ = 0, heard_next_ = 0;
    clock_origin_ = perf_->clock_origin();
    return true;
  }
  ~ProjectPlayer() { release(); }
  bool playing() const { return playing_; }
  double step() const { return next_step_; }
  const play::Performance* performance() const { return perf_; }

  // A project changed while playing (a recorded clip, an undo): the
  // performance keeps its place and plays the new project from the next window.
  bool set_project(const Value& project, Str& error, uint64_t frame = 0) {
    if (!perf_) return error = "Not playing", false;
    const double before = project::detail::num(project_, "bpm");
    const double after = project::detail::num(project, "bpm");
    const double at = playing_ && before != after ? audible_step(frame) : 0;
    Value next = lean(project);
    if (!perf_->set_project(next, error)) return false;
    project_ = xmp::move(next);
    if (playing_ && before != after) {
      double seconds = 0;
      if (!step_seconds(at, seconds, error)) return false;
      origin_ = static_cast<int64_t>(frame) - static_cast<int64_t>(render::detail::js_round(seconds * 48000));
      const double ratio = before / after;
      for (int i = 0; i < heard_count_; ++i) if (heard_[i].frame > frame)
        heard_[i].frame = frame + static_cast<uint64_t>(render::detail::js_round((heard_[i].frame - frame) * ratio));
      heard_[heard_next_] = {at, frame};
      heard_next_ = (heard_next_ + 1) % kHeard, heard_count_ = std::min(kHeard, heard_count_ + 1);
      PlayerCommand c;
      c.kind = PlayerCommand::retime, c.frame = frame, c.x = ratio, c.y = after;
      sound_->push(c);
    }
    return true;
  }
  bool preview_tempo(double bpm, uint64_t frame, Str& error) {
    if (!playing_ || project::detail::num(project_, "bpm") == bpm) return true;
    Value next = project_; next.set("bpm", Value::of(bpm));
    return set_project(next, error, frame);
  }

  // A clip edited while playing (live_edit.hpp): from the next window on.
  bool replace_clip(int32_t track, int32_t clip, const Value& value) {
    if (!perf_) return false;
    Value* tracks = project_.get("tracks");
    if (!tracks || track < 0 || track >= tracks->items().size()) return false;
    Value* clips = tracks->items()[track].get("clips");
    if (!clips || clip < 0 || clip >= clips->items().size()) return false;
    if (!perf_->replace_clip(track, clip, value)) return false;
    clips->items()[clip] = value;
    return true;
  }

  // Launches from the interface, on the next bar of the performance. The
  // performance runs up to 100 ms ahead of what is heard, so a press in the
  // last moments of a bar lands on the bar after.
  bool launch_clip(const Str& track, const Str* clip, Str& error) {
    if (!playing_) return error = "Not playing", false;
    return perf_->queue_clip(track, clip, error);
  }
  // Delete is immediate: silence this track and discard only its scheduled notes.
  bool stop_clip_now(const Str& track, uint64_t frame, Str& error) {
    if (!playing_ || !perf_) return error = "Not playing", false;
    const auto& tracks = project::detail::list(project_, "tracks");
    int32_t index = -1;
    for (int32_t i = 0; i < tracks.size(); ++i)
      if (project::detail::str(tracks[i], "id") == track) index = i;
    const auto uid = sound_->rack().uid_of(track);
    if (index < 0 || uid < 0) return error = "Unknown track", false;
    PlayerCommand c;
    c.kind = PlayerCommand::cancel_track, c.frame = frame, c.a = uid, c.b = index;
    if (!sound_->push(c)) return error = "Audio command queue full", false;
    return perf_->stop_clip_now(track);
  }
  void cancel_clip_launch(const Str& track) { if (perf_) perf_->cancel_clip_launch(track); }
  bool stop_for_recording(const Str& track, double at, Str& error) { return playing_ && perf_->queue_recorded_loop(track,nullptr,at,error); }
  bool launch_recorded_loop(const Str& track, const Str& clip, double at, Str& error) {
    return playing_ && perf_->queue_recorded_loop(track,&clip,at,error);
  }
  bool launch_scene(const Str& scene, Str& error) {
    if (!playing_) return error = "Not playing", false;
    return perf_->queue_scene(scene, error);
  }
  // The step being heard at session frame `frame` (with its fraction), from
  // the frames the steps were scheduled on.
  double audible_step(uint64_t frame) const {
    if (!playing_ && heard_count_ == 0) return 0;
    double best = 0;
    uint64_t best_frame = origin_;
    bool found = false;
    for (int i = 0; i < heard_count_; ++i) {
      const auto& h = heard_[i];
      if (h.frame <= frame && (!found || h.step > best)) best = h.step, best_frame = h.frame, found = true;
    }
    if (!found) return 0;
    double seconds = 0, next = 0;
    Str error;
    const double span = step_seconds(best + 1, next, error) && step_seconds(best, seconds, error) ? next - seconds : 0;
    const double fraction = span > 0 ? static_cast<double>(frame - best_frame) / (span * 48000) : 0;
    return best + fmin(0.999, fmax(0, fraction));
  }

  uint64_t frame_at_step(double step) const {
    double seconds = 0; Str error;
    return step_seconds(step,seconds,error) ? origin_ + static_cast<uint64_t>(render::detail::js_round(seconds * 48000)) : UINT64_MAX;
  }

  // Queues every window whose step starts before `horizon` (a session frame).
  bool fill(uint64_t horizon, Str& error) {
    while (playing_) {
      double seconds = 0;
      if (!step_seconds(next_step_, seconds, error)) return false;
      const uint64_t step_frame = static_cast<uint64_t>(std::max<int64_t>(0, origin_ + static_cast<int64_t>(render::detail::js_round(seconds * 48000))));
      if (step_frame >= horizon) break;
      if (limit_ > 0 && next_step_ >= limit_) {
        end_at(step_frame);
        break;
      }
      Value w;
      if (!play::performance_window(*perf_, next_step_, fill_held, project::detail::num(project_, "swing"), 48000, w, error))
        return false;
      if (!queue(w, error)) return false;
      heard_[heard_next_] = {next_step_, step_frame};
      heard_next_ = (heard_next_ + 1) % kHeard, heard_count_ = heard_count_ < kHeard ? heard_count_ + 1 : kHeard;
      if (!project::detail::at(project::detail::at(w, "snapshot"), "running").as_bool()) {
        end_at(step_frame);
        break;
      }
      ++next_step_;
    }
    return true;
  }
  // Stop now: what was scheduled after `frame` is cancelled and every voice silenced.
  void stop(uint64_t frame) {
    if (!sound_) return;
    PlayerCommand c;
    c.kind = PlayerCommand::cancel_after, c.frame = frame;
    sound_->push(c);
    playing_ = false;
  }

 private:
  bool step_seconds(double step, double& out, Str& error) const {
    double a = 0, b = 0;
    if (!render::detail::musical_seconds(project_, clock_origin_ + step, a, error) ||
        !render::detail::musical_seconds(project_, clock_origin_, b, error))
      return false;
    out = a - b;
    return true;
  }
  void end_at(uint64_t frame) {
    PlayerCommand c;
    c.kind = PlayerCommand::panic, c.frame = frame;
    sound_->push(c);
    playing_ = false;
  }
  bool queue(const Value& window, Str& error) {
    Vec<render::Command> commands;
    if (!render::performance_commands(window, project_, 48000, commands, error)) return false;
    voices::Rack& rack = sound_->rack();
    const auto& tracks = project::detail::list(project_, "tracks");
    for (const auto& c : commands) {
      PlayerCommand p;
      p.frame = static_cast<uint64_t>(std::max<int64_t>(0, origin_ + static_cast<int64_t>(c.frame)));
      switch (c.kind) {
        case render::Command::clock:
          if (!rack.engine().has_mixer()) break;
          p.kind = PlayerCommand::clock, p.x = c.position, p.y = c.bpm;
          sound_->push(p);
          break;
        case render::Command::release:
          for (const auto& t : c.tracks) {
            p.kind = PlayerCommand::release, p.a = rack.uid_of(t);
            if (p.a >= 0) sound_->push(p);
          }
          break;
        case render::Command::gates: {
          p.kind = PlayerCommand::gates_begin;
          sound_->push(p);
          Vec<Str> seen;
          for (const auto& t : c.tracks) {
            bool dup = false;
            for (const auto& s : seen) dup = dup || s == t;
            if (dup) continue;
            seen.push(t);
            p.kind = PlayerCommand::gate, p.a = rack.uid_of(t);
            if (p.a >= 0) sound_->push(p);
          }
          p.kind = PlayerCommand::gates_commit;
          sound_->push(p);
          blocked_ = c.tracks;
          break;
        }
        case render::Command::parameters: {
          p.kind = PlayerCommand::params_begin;
          sound_->push(p);
          for (const auto& m : c.values.members()) {
            p.kind = PlayerCommand::param, p.a = rack.index_of(m.key), p.x = m.value.as_number();
            if (p.a >= 0) sound_->push(p);
          }
          p.kind = PlayerCommand::params_commit;
          sound_->push(p);
          break;
        }
        case render::Command::on: {
          const Str& track = project::detail::str(c.note, "trackId");
          bool silenced = false;
          for (const auto& b : blocked_) silenced = silenced || b == track;
          if (silenced) break;
          int32_t index = -1;
          for (int32_t i = 0; i < tracks.size(); ++i)
            if (project::detail::str(tracks[i], "id") == track) index = i;
          p.kind = PlayerCommand::note_on;
          p.a = static_cast<int32_t>(project::detail::num(c.note, "pad")), p.b = index;
          p.c = static_cast<int32_t>(project::detail::num(c.note, "note"));
          p.x = id_++, p.y = project::detail::num(c.note, "velocity"), p.z = project::detail::num(c.note, "durationFrames");
          sound_->push(p);
          break;
        }
      }
    }
    return true;
  }
  void release() {
    if (perf_) perf_->~Performance(), free(perf_), perf_ = nullptr;
  }

  Value project_;
  ProjectSound* sound_ = nullptr;
  play::Performance* perf_ = nullptr;
  int64_t origin_ = 0;
  double next_step_ = 0, limit_ = 0, clock_origin_ = 0, id_ = 1;
  bool playing_ = false;
  Vec<Str> blocked_;
  // The frames the last steps were scheduled on, for audible_step.
  struct Heard {
    double step;
    uint64_t frame;
  };
  static constexpr int kHeard = 64;
  Heard heard_[kHeard] = {};
  int heard_count_ = 0, heard_next_ = 0;
};

}  // namespace xmp::live
