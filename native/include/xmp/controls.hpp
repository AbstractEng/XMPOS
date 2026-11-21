#pragma once
// XMP's performance controls: which tracks are muted or soloed and where each
// macro stands at a song position, from the saved mutes, solos and macros, the
// recorded control events up to that position, and live overrides; the macro
// offsets on their parameters; and which tracks are silenced (with a soloed
// MIDI source or instrument keeping its partner audible). Also the tempo map's
// timing for the performance window. It is the C++ port of performanceControls
// and the window timing in packages/core performance.ts and mix.ts;
// tests/controls-parity.test.ts runs both.
//
// Tracks, macros, parameters and other IDs are numbers the binding assigns per
// load. Lists keep JavaScript's insertion order, so the binding rebuilds the
// same objects. Only C headers are used; fixed tables, no allocation.
#include <math.h>
#include <stdint.h>

namespace xmp::controls {

constexpr int kTracks = 16, kMacros = 8, kAssignments = 128, kEvents = 2048, kOverrides = 256, kKeys = 4096,
              kTempos = 64;
enum Kind : int32_t { mute = 0, solo = 1, macro = 2 };
enum Error : int32_t { ok = 0, invalid_groove = 1, invalid_position = 2 };

// Math.round
inline double js_round(double x) {
  const double r = floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}

struct Change {
  int32_t kind = 0, target = 0;
  double value = 0, at = 0;
};
struct Assignment {
  int32_t parameter = 0;
  double amount = 0;
  bool valid = false;
};
struct Pair {
  int32_t key = 0;
  double value = 0;
};

// A list of keys in first-insertion order (a JavaScript object or Set).
struct Ordered {
  Pair items[kKeys];
  int32_t count = 0;

  int32_t find(int32_t key) const {
    for (int32_t i = 0; i < count; ++i)
      if (items[i].key == key) return i;
    return -1;
  }
  void set(int32_t key, double value) {
    const int32_t i = find(key);
    if (i >= 0)
      items[i].value = value;
    else if (count < kKeys)
      items[count++] = {key, value};
  }
  void remove(int32_t key) {
    const int32_t i = find(key);
    if (i < 0) return;
    for (int32_t k = i; k + 1 < count; ++k) items[k] = items[k + 1];
    --count;
  }
};

struct Setup {
  int32_t track_count = 0, track[kTracks] = {}, destination[kTracks] = {};  // destination: track index or -1
  bool muted[kTracks] = {};
  int32_t mute_count = 0, solo_count = 0, macro_count = 0;
  Pair mutes[kKeys];
  int32_t solos[kKeys] = {};
  int32_t macro[kMacros] = {}, assignment_start[kMacros] = {}, assignment_count[kMacros] = {};
  double macro_value[kMacros] = {};
  Assignment assignments[kAssignments];
  int32_t total_assignments = 0;
  Change events[kEvents];
  int32_t event_count = 0;
  Change overrides[kOverrides];
  int32_t override_count = 0;
  double bpm = 0;  // zero defaults keep the tables out of the module's data
  int32_t tempo_count = 0;
  double tempo_step[kTempos] = {}, tempo_bpm[kTempos] = {};
};

class Controls {
 public:
  Setup setup{};
  // The answer of the last evaluate.
  Ordered mutes{}, solos{}, macros{}, offsets{};
  int32_t unavailable[kAssignments] = {}, unavailable_count = 0;
  int32_t blocked[kTracks] = {}, blocked_count = 0;

  // performanceControls at `position`; `with_offsets` also resolves the macro
  // assignments (the window's note checks need only the blocked tracks).
  void evaluate(double position, bool with_offsets) {
    const Setup& s = setup;
    mutes.count = solos.count = macros.count = offsets.count = 0;
    unavailable_count = blocked_count = 0;
    for (int32_t i = 0; i < s.mute_count; ++i) mutes.set(s.mutes[i].key, s.mutes[i].value);
    for (int32_t i = 0; i < s.solo_count; ++i) solos.set(s.solos[i], 1);
    for (int32_t i = 0; i < s.macro_count; ++i) macros.set(s.macro[i], s.macro_value[i]);
    for (int32_t i = 0; i < s.event_count; ++i) {
      if (s.events[i].at > position) break;
      apply(s.events[i]);
    }
    for (int32_t i = 0; i < s.override_count; ++i) apply(s.overrides[i]);
    if (with_offsets) {
      for (int32_t m = 0; m < s.macro_count; ++m) {
        const int32_t at = macros.find(s.macro[m]);
        const double value = at >= 0 ? macros.items[at].value : 0.5;
        for (int32_t k = 0; k < s.assignment_count[m]; ++k) {
          const Assignment& a = s.assignments[s.assignment_start[m] + k];
          if (!a.valid) {
            if (unavailable_count < kAssignments) unavailable[unavailable_count++] = a.parameter;
            continue;
          }
          const int32_t o = offsets.find(a.parameter);
          offsets.set(a.parameter, (o >= 0 ? offsets.items[o].value : 0) + (value * 2 - 1) * a.amount);
        }
      }
      for (int32_t i = 0; i < offsets.count; ++i) {
        const double v = offsets.items[i].value;
        offsets.items[i].value = v < -1 ? -1 : v > 1 ? 1 : v;
      }
    }
    // Solo the selected source plus its instrument, or an instrument plus its
    // incoming MIDI sources; nothing transitively.
    bool audible[kTracks] = {};
    for (int32_t t = 0; t < s.track_count; ++t) audible[t] = solos.find(s.track[t]) >= 0;
    for (int32_t t = 0; t < s.track_count; ++t) {
      const int32_t d = s.destination[t];
      if (d < 0) continue;
      if (solos.find(s.track[t]) >= 0) audible[d] = true;
      if (solos.find(s.track[d]) >= 0) audible[t] = true;
    }
    for (int32_t t = 0; t < s.track_count; ++t) {
      const int32_t m = mutes.find(s.track[t]);
      if (s.muted[t] || (m >= 0 && mutes.items[m].value != 0) || (solos.count > 0 && !audible[t]))
        blocked[blocked_count++] = t;
    }
  }
  bool is_blocked(int32_t track, double position) {
    evaluate(position, false);
    for (int32_t i = 0; i < blocked_count; ++i)
      if (blocked[i] == track) return true;
    return false;
  }

  // mix.ts tempoAt and musicalSeconds.
  double tempo_at(double step) const {
    double bpm = setup.bpm;
    for (int32_t i = 0; i < setup.tempo_count; ++i) {
      if (step < setup.tempo_step[i]) break;
      bpm = setup.tempo_bpm[i];
    }
    return bpm;
  }
  // NaN for a position musicalSeconds refuses.
  double musical_seconds(double step) const {
    if (!isfinite(step) || step < 0 || step > 1000100) return NAN;
    double seconds = 0, previous = 0, bpm = setup.bpm;
    for (int32_t i = 0; i < setup.tempo_count; ++i) {
      if (setup.tempo_step[i] > step) break;
      seconds += ((setup.tempo_step[i] - previous) * 15) / bpm;
      previous = setup.tempo_step[i];
      bpm = setup.tempo_bpm[i];
    }
    return seconds + ((step - previous) * 15) / bpm;
  }
  // The window's seconds(position): seconds from the clock origin.
  double window_seconds(double position, double origin, int32_t& error) const {
    const double a = musical_seconds(position + origin), b = musical_seconds(origin);
    if (isnan(a) || isnan(b)) error = invalid_position;
    return a - b;
  }
  // Math.round(seconds(groovePosition(position, swing)) * rate).
  double window_frame(double position, double swing, double rate, double origin, int32_t& error) const {
    if (!isfinite(position) || position < 0 || !isfinite(swing) || swing < 0 || swing > 0.5) {
      error = invalid_groove;
      return NAN;
    }
    return js_round(window_seconds(groove(position, swing), origin, error) * rate);
  }
  // Math.max(1, Math.round((seconds(groove(position + duration)) - seconds(groove(position))) * rate)).
  double window_duration(double position, double duration, double swing, double rate, double origin,
                         int32_t& error) const {
    const double end = position + duration;
    if (!isfinite(position) || position < 0 || !isfinite(end) || end < 0 || !isfinite(swing) || swing < 0 ||
        swing > 0.5) {
      error = invalid_groove;
      return NAN;
    }
    const double a = window_seconds(groove(end, swing), origin, error),
                 b = window_seconds(groove(position, swing), origin, error);
    return fmax(1, js_round((a - b) * rate));
  }

 private:
  static double groove(double position, double swing) {
    const double pair = floor(position / 2) * 2, local = position - pair;
    return pair + (local <= 1 ? local * (1 + swing) : 1 + swing + (local - 1) * (1 - swing));
  }
  void apply(const Change& c) {
    if (c.kind == macro) macros.set(c.target, c.value);
    if (c.kind == mute) mutes.set(c.target, c.value != 0 ? 1 : 0);
    if (c.kind == solo) {
      if (c.value != 0)
        solos.set(c.target, 1);
      else
        solos.remove(c.target);
    }
  }
};

}  // namespace xmp::controls
