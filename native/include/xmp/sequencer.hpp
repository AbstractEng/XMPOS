#pragma once
// XMP's sequencer: which notes a scene plays and when, and the automated
// parameter values at any position. It is the C++ port of packages/core
// sequencer.ts (groovePosition, notesInWindow, timeline, parameterFrame) and
// index.ts (stepTime, deterministicRandom, eventsAtStep), following them
// operation for operation in double precision. It compiles to WebAssembly
// (native/src/sequencer_wasm.cpp); the parity tests run both.
//
// A plan is one scene of one project, laid out by the TypeScript binding:
// for each audible track its clip, the clip's step notes ("legacy") and
// sequence notes, and for every track with a sequence its automation lanes,
// step locks and modulations, plus every parameter's static sources. IDs are
// UTF-16, as in JavaScript, because note probability hashes them.
//
// Only C headers are used, so the same file builds for wasm32-wasi and for the
// device. Planning is bounded by fixed tables; nothing here runs in an audio callback.
#include <math.h>
#include <stdint.h>
#include <string.h>

namespace xmp::sequencer {

constexpr int kTracks = 8, kNotes = 16384, kPool = 1 << 18, kResults = 8192, kParams = 4096, kLanes = 256,
              kPoints = 65536, kLocks = 2048, kMods = 128;
constexpr double kPi = 3.14159265358979323846, kTick = 1.0 / 960;

enum Condition : int32_t { always = 0, first = 1, not_first = 2, fill_only = 3, not_fill = 4, every_2 = 5, every_4 = 6 };
enum Error : int32_t { ok = 0, budget = 1, invalid = 2, pool = 3 };

// Math.round
inline double js_round(double x) {
  const double r = floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}
inline double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

inline double groove_position(double position, double swing) {
  const double pair = floor(position / 2) * 2, local = position - pair;
  return pair + (local <= 1 ? local * (1 + swing) : 1 + swing + (local - 1) * (1 - swing));
}
inline double step_time(double step, double bpm, double swing) {
  return ((step + (fmod(step, 2) != 0 ? swing : 0)) * 60) / bpm / 4;
}
inline bool condition_pass(int32_t condition, int64_t cycle, bool fill) {
  return condition == always || (condition == first && cycle == 0) || (condition == not_first && cycle > 0) ||
         (condition == fill_only && fill) || (condition == not_fill && !fill) ||
         (condition == every_2 && cycle % 2 == 0) || (condition == every_4 && cycle % 4 == 0);
}

struct Text {
  int32_t at = 0, length = 0;
};

// A key or ID being built, in UTF-16.
struct Builder {
  uint16_t units[1024];
  int32_t length = 0;
  void clear() { length = 0; }
  void ascii(const char* s) {
    while (*s && length < 1024) units[length++] = static_cast<uint8_t>(*s++);
  }
  void text(const uint16_t* pool, Text t) {
    for (int32_t i = 0; i < t.length && length < 1024; ++i) units[length++] = pool[t.at + i];
  }
  void number(int64_t n) {  // non-negative integers, as JavaScript prints them
    char digits[24];
    int32_t count = 0;
    if (n < 0) {
      ascii("-");
      n = -n;
    }
    do digits[count++] = static_cast<char>('0' + n % 10), n /= 10;
    while (n);
    while (count && length < 1024) units[length++] = static_cast<uint8_t>(digits[--count]);
  }
  // deterministicRandom: FNV-1a over each code point's first UTF-16 unit.
  double random() const {
    uint32_t hash = 2166136261u;
    for (int32_t i = 0; i < length; ++i) {
      const uint16_t c = units[i];
      hash = (hash ^ c) * 16777619u;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff) ++i;
    }
    return hash / 4294967296.0;
  }
};

struct Note {
  bool legacy = false;
  Text id{};
  int32_t pad = 0, note = 60, condition = always;
  double position = 0, duration = 1, velocity = 1, probability = 1, microtiming = 0;
};

struct Track {
  Text id{}, clip{};
  double length = 16;
  int32_t first = 0, count = 0;  // notes[first .. first + count), step notes first
};

struct Result {
  int32_t track, note;
  int64_t cycle;
  double position, duration, frame, duration_frames;
};

// parameterFrame: a parameter's static sources (parameterSources).
struct Sources {
  double value[5] = {0, 0, 0, 0, 0};  // base, automation, stepLock, macro, lfo
  uint8_t has[5] = {1, 0, 0, 0, 0};
};
struct Lane {
  int32_t track, parameter, first, count;
};
struct Lock {
  int32_t track, parameter, position;
  double value;
};
struct Mod {
  int32_t track, parameter, kind;  // kind 0 macro, 1 lfo
  double amount, cycles, phase;
};

class Plan {
 public:
  // ---- layout ----
  void reset(uint32_t seed) {
    seed_ = seed;
    pool_used_ = 0;
    track_count_ = note_count_ = 0;
    param_count_ = lane_count_ = point_count_ = lock_count_ = mod_count_ = 0;
    clip_track_count_ = 0;
    error = ok;
  }
  // The binding writes a UTF-16 string at pool_tail() and then commits it.
  uint16_t* pool_tail() { return pool_ + pool_used_; }
  int32_t pool_room() const { return kPool - pool_used_; }
  Text commit_text(int32_t length) {
    if (length < 0 || length > pool_room()) {
      error = pool;
      return {};
    }
    Text t{pool_used_, length};
    pool_used_ += length;
    return t;
  }
  void set_project(Text id) { project_ = id; }
  int32_t add_track(Text id, Text clip, double length) {
    if (track_count_ >= kTracks) return error = budget, -1;
    tracks_[track_count_] = {id, clip, length, note_count_, 0};
    return track_count_++;
  }
  bool add_note(int32_t track, const Note& n) {
    if (track != track_count_ - 1 || note_count_ >= kNotes) return error = budget, false;
    notes_[note_count_++] = n;
    ++tracks_[track].count;
    return true;
  }
  // parameterFrame tracks: every track with a clip that has a sequence, muted or not.
  int32_t add_clip_track(double length) {
    if (clip_track_count_ >= kTracks) return error = budget, -1;
    clip_length_[clip_track_count_] = length;
    return clip_track_count_++;
  }
  bool add_parameter(const Sources& s) {
    if (param_count_ >= kParams) return error = budget, false;
    sources_[param_count_++] = s;
    return true;
  }
  bool add_lane(int32_t track, int32_t parameter, const double* positions, const double* values, int32_t count) {
    if (lane_count_ >= kLanes || point_count_ + count > kPoints || count < 0) return error = budget, false;
    lanes_[lane_count_++] = {track, parameter, point_count_, count};
    for (int32_t i = 0; i < count; ++i) {
      point_position_[point_count_ + i] = positions[i];
      point_value_[point_count_ + i] = values[i];
    }
    point_count_ += count;
    return true;
  }
  bool add_lock(int32_t track, int32_t parameter, int32_t position, double value) {
    if (lock_count_ >= kLocks) return error = budget, false;
    locks_[lock_count_++] = {track, parameter, position, value};
    return true;
  }
  bool add_mod(int32_t track, int32_t parameter, int32_t kind, double amount, double cycles, double phase) {
    if (mod_count_ >= kMods) return error = budget, false;
    mods_[mod_count_++] = {track, parameter, kind, amount, cycles, phase};
    return true;
  }

  // ---- notesInWindow / timeline ----
  // Fills results (sorted by position, then ID). Returns the count, or -1 past the event budget.
  int32_t window(double from, double to, bool fill) {
    result_count = 0;
    for (int32_t t = 0; t < track_count_; ++t) {
      const Track& track = tracks_[t];
      const int64_t last = static_cast<int64_t>(floor(to / track.length));
      for (int64_t cycle = static_cast<int64_t>(floor(from / track.length)); cycle <= last; ++cycle)
        for (int32_t k = 0; k < track.count; ++k) {
          const Note& n = notes_[track.first + k];
          const double local = fmax(0, fmin(track.length - kTick, n.position + n.microtiming)),
                       position = static_cast<double>(cycle) * track.length + local;
          if (!(position >= from && position < to) || !condition_pass(n.condition, cycle, fill)) continue;
          if (n.legacy)
            legacy_key(track, n.pad, static_cast<int64_t>(static_cast<double>(cycle) * track.length + n.position));
          else {
            key_.clear();
            key_.number(cycle);
            key_.ascii(":");
            key_.number(seed_);
            key_.ascii(":");
            key_.text(pool_, project_);
            key_.ascii(":");
            key_.text(pool_, track.id);
            key_.ascii(":");
            key_.text(pool_, track.clip);
            key_.ascii(":");
            key_.text(pool_, n.id);
          }
          if (!(key_.random() < n.probability)) continue;
          if (result_count >= kResults + 1) return -1;
          if (result_count < kResults + 1)
            results[result_count++] = {t, track.first + k, cycle, position,
                                       fmax(kTick, fmin(n.duration, track.length - local)), 0, 0};
        }
    }
    if (result_count > kResults) return -1;
    sort();
    return result_count;
  }
  void timeline(double swing, double bpm, double rate) {
    for (int32_t i = 0; i < result_count; ++i) {
      Result& r = results[i];
      const double start = groove_position(r.position, swing);
      r.frame = js_round(((start * 60) / bpm / 4) * rate);
      r.duration_frames =
          fmax(1, js_round((((groove_position(r.position + r.duration, swing) - start) * 60) / bpm / 4) * rate));
    }
  }

  // ---- eventsAtStep: the step notes due on an absolute step ----
  int32_t step_events(int64_t step) {
    result_count = 0;
    for (int32_t t = 0; t < track_count_; ++t) {
      const Track& track = tracks_[t];
      const double due = fmod(static_cast<double>(step), track.length);
      for (int32_t k = 0; k < track.count; ++k) {
        const Note& n = notes_[track.first + k];
        if (!n.legacy || n.position != due) continue;
        legacy_key(track, n.pad, step);
        if (key_.random() < n.probability && result_count < kResults)
          results[result_count++] = {t, track.first + k, 0, n.position, n.duration, 0, 0};
      }
    }
    return result_count;
  }

  // ---- parameterFrame ----
  // Resolves every parameter at `position`. offsets[i] is a macro offset, NaN for none.
  // Returns 0, or -(1 + parameter * 5 + source) for a source out of range.
  // `only`: the one clip track whose sequence applies, -1 for none, -2 for all.
  int32_t parameter_frame(double position, const double* offsets, double* out, int32_t only = -2) {
    for (int32_t p = 0; p < param_count_; ++p) {
      Sources s = sources_[p];
      for (int32_t t = 0; t < clip_track_count_; ++t) {
        if (only != -2 && t != only) continue;
        const double length = clip_length_[t], local = fmod(position, length);
        for (int32_t l = 0; l < lane_count_; ++l)
          if (lanes_[l].track == t && lanes_[l].parameter == p) {
            double value = s.has[1] ? s.value[1] : s.value[0];
            for (int32_t i = 0; i < lanes_[l].count; ++i) {
              if (point_position_[lanes_[l].first + i] > local) break;
              value = point_value_[lanes_[l].first + i];
            }
            s.value[1] = value, s.has[1] = 1;
            break;
          }
        for (int32_t l = 0; l < lock_count_; ++l)
          if (locks_[l].track == t && locks_[l].parameter == p && locks_[l].position == floor(local)) {
            s.value[2] = locks_[l].value, s.has[2] = 1;
            break;
          }
        for (int32_t kind = 0; kind < 2; ++kind) {
          double sum = 0;
          bool any = false;
          for (int32_t m = 0; m < mod_count_; ++m) {
            const Mod& mod = mods_[m];
            if (mod.track != t || mod.parameter != p || mod.kind != kind) continue;
            any = true;
            sum += mod.amount * (kind == 0 ? 1 : sin(2 * kPi * ((local / length) * mod.cycles + mod.phase)));
          }
          if (any) s.value[3 + kind] = clampd(sum, -1, 1), s.has[3 + kind] = 1;
        }
      }
      if (offsets && !isnan(offsets[p])) s.value[3] = clampd((s.has[3] ? s.value[3] : 0) + offsets[p], -1, 1), s.has[3] = 1;
      for (int32_t k = 0; k < 5; ++k) {
        if (!s.has[k] && k != 0) continue;
        const double v = s.value[k];
        if (!isfinite(v) || v < (k >= 3 ? -1 : 0) || v > 1) return -(1 + p * 5 + k);
      }
      const double replacement = s.has[2] ? s.value[2] : s.has[1] ? s.value[1] : s.value[0];
      out[p] = clampd(replacement + (s.has[3] ? s.value[3] : 0) + (s.has[4] ? s.value[4] : 0), 0, 1);
    }
    return 0;
  }
  int32_t parameter_count() const { return param_count_; }

  Result results[kResults + 1];
  int32_t result_count = 0;
  int32_t error = ok;

 private:
  void legacy_key(const Track& track, int32_t pad, int64_t absolute) {
    key_.clear();
    if (seed_) {
      key_.number(seed_);
      key_.ascii(":");
    }
    key_.text(pool_, project_);
    key_.ascii(":");
    key_.text(pool_, track.id);
    key_.ascii(":");
    key_.text(pool_, track.clip);
    key_.ascii(":");
    key_.number(pad);
    key_.ascii(":");
    key_.number(absolute);
  }
  // The note's ID: `${track}:${clip}:${legacy ? "legacy:" : ""}${id}:${cycle}`.
  void id_of(const Result& r, Builder& b) const {
    const Track& t = tracks_[r.track];
    const Note& n = notes_[r.note];
    b.clear();
    b.text(pool_, t.id);
    b.ascii(":");
    b.text(pool_, t.clip);
    b.ascii(n.legacy ? ":legacy:" : ":");
    b.text(pool_, n.id);
    b.ascii(":");
    b.number(r.cycle);
  }
  int compare(const Result& a, const Result& b) {
    if (a.position != b.position) return a.position < b.position ? -1 : 1;
    id_of(a, id_a_);
    id_of(b, id_b_);
    const int32_t n = id_a_.length < id_b_.length ? id_a_.length : id_b_.length;
    for (int32_t i = 0; i < n; ++i)
      if (id_a_.units[i] != id_b_.units[i]) return id_a_.units[i] < id_b_.units[i] ? -1 : 1;
    return id_a_.length == id_b_.length ? 0 : id_a_.length < id_b_.length ? -1 : 1;
  }
  // Stable merge sort, as Array.prototype.sort is stable.
  void sort() {
    for (int32_t width = 1; width < result_count; width *= 2) {
      for (int32_t lo = 0; lo < result_count; lo += 2 * width) {
        const int32_t mid = lo + width < result_count ? lo + width : result_count,
                      hi = lo + 2 * width < result_count ? lo + 2 * width : result_count;
        int32_t i = lo, j = mid, k = lo;
        while (i < mid && j < hi) scratch_[k++] = compare(results[j], results[i]) < 0 ? results[j++] : results[i++];
        while (i < mid) scratch_[k++] = results[i++];
        while (j < hi) scratch_[k++] = results[j++];
      }
      memcpy(results, scratch_, sizeof(Result) * static_cast<size_t>(result_count));
    }
  }

  uint32_t seed_ = 0;
  Text project_{};
  uint16_t pool_[kPool];
  int32_t pool_used_ = 0;
  Track tracks_[kTracks];
  int32_t track_count_ = 0;
  Note notes_[kNotes];
  int32_t note_count_ = 0;
  Builder key_, id_a_, id_b_;
  Result scratch_[kResults + 1];
  Sources sources_[kParams];
  int32_t param_count_ = 0;
  double clip_length_[kTracks] = {};
  int32_t clip_track_count_ = 0;
  Lane lanes_[kLanes];
  int32_t lane_count_ = 0;
  double point_position_[kPoints], point_value_[kPoints];
  int32_t point_count_ = 0;
  Lock locks_[kLocks];
  int32_t lock_count_ = 0;
  Mod mods_[kMods];
  int32_t mod_count_ = 0;
};

}  // namespace xmp::sequencer
