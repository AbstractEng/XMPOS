// WebAssembly exports of XMP's performance controls (xmp/controls.hpp).
// packages/core/src/controls-engine.ts is the only caller; one shared instance.
#include "xmp/controls.hpp"

using namespace xmp::controls;

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static Controls controls;
static int32_t window_error = 0;

// ---- the setup ----
EXPORT(ctl_begin) void ctl_begin(double bpm) {
  Setup& s = controls.setup;
  s.track_count = s.mute_count = s.solo_count = s.macro_count = 0;
  s.total_assignments = s.event_count = s.override_count = s.tempo_count = 0;
  s.bpm = bpm;
}
EXPORT(ctl_track) int32_t ctl_track(int32_t uid, int32_t muted, int32_t destination) {
  Setup& s = controls.setup;
  if (s.track_count >= kTracks) return 0;
  s.track[s.track_count] = uid;
  s.muted[s.track_count] = muted;
  s.destination[s.track_count++] = destination;
  return 1;
}
// Destinations name track indices; checked once all tracks are in.
EXPORT(ctl_tracks_done) int32_t ctl_tracks_done() {
  Setup& s = controls.setup;
  for (int32_t t = 0; t < s.track_count; ++t)
    if (s.destination[t] < -1 || s.destination[t] >= s.track_count) return 0;
  return 1;
}
EXPORT(ctl_mute) int32_t ctl_mute(int32_t uid, int32_t value) {
  Setup& s = controls.setup;
  if (s.mute_count >= kKeys) return 0;
  s.mutes[s.mute_count++] = {uid, value ? 1.0 : 0.0};
  return 1;
}
EXPORT(ctl_solo) int32_t ctl_solo(int32_t uid) {
  Setup& s = controls.setup;
  if (s.solo_count >= kKeys) return 0;
  s.solos[s.solo_count++] = uid;
  return 1;
}
EXPORT(ctl_macro) int32_t ctl_macro(int32_t uid, double value) {
  Setup& s = controls.setup;
  if (s.macro_count >= kMacros) return 0;
  s.macro[s.macro_count] = uid;
  s.macro_value[s.macro_count] = value;
  s.assignment_start[s.macro_count] = s.total_assignments;
  s.assignment_count[s.macro_count++] = 0;
  return 1;
}
// An assignment of the last macro.
EXPORT(ctl_assignment) int32_t ctl_assignment(int32_t parameter, double amount, int32_t valid) {
  Setup& s = controls.setup;
  if (!s.macro_count || s.total_assignments >= kAssignments) return 0;
  s.assignments[s.total_assignments++] = {parameter, amount, valid != 0};
  ++s.assignment_count[s.macro_count - 1];
  return 1;
}
EXPORT(ctl_event) int32_t ctl_event(int32_t kind, int32_t target, double value, double at) {
  Setup& s = controls.setup;
  if (s.event_count >= kEvents || kind < mute || kind > macro) return 0;
  s.events[s.event_count++] = {kind, target, value, at};
  return 1;
}
EXPORT(ctl_override) int32_t ctl_override(int32_t kind, int32_t target, double value) {
  Setup& s = controls.setup;
  if (s.override_count >= kOverrides || kind < mute || kind > macro) return 0;
  s.overrides[s.override_count++] = {kind, target, value, 0};
  return 1;
}
EXPORT(ctl_clear_overrides) void ctl_clear_overrides() { controls.setup.override_count = 0; }
EXPORT(ctl_tempo) int32_t ctl_tempo(double step, double bpm) {
  Setup& s = controls.setup;
  if (s.tempo_count >= kTempos) return 0;
  s.tempo_step[s.tempo_count] = step;
  s.tempo_bpm[s.tempo_count++] = bpm;
  return 1;
}

// ---- answers ----
EXPORT(ctl_evaluate) void ctl_evaluate(double position, int32_t with_offsets) {
  controls.evaluate(position, with_offsets);
}
EXPORT(ctl_is_blocked) int32_t ctl_is_blocked(int32_t track, double position) {
  return controls.is_blocked(track, position);
}
EXPORT(ctl_mute_count) int32_t ctl_mute_count() { return controls.mutes.count; }
EXPORT(ctl_mute_key) int32_t ctl_mute_key(int32_t i) { return controls.mutes.items[i].key; }
EXPORT(ctl_mute_value) int32_t ctl_mute_value(int32_t i) { return controls.mutes.items[i].value != 0; }
EXPORT(ctl_solo_count) int32_t ctl_solo_count() { return controls.solos.count; }
EXPORT(ctl_solo_key) int32_t ctl_solo_key(int32_t i) { return controls.solos.items[i].key; }
EXPORT(ctl_macro_count) int32_t ctl_macro_count() { return controls.macros.count; }
EXPORT(ctl_macro_key) int32_t ctl_macro_key(int32_t i) { return controls.macros.items[i].key; }
EXPORT(ctl_macro_value) double ctl_macro_value(int32_t i) { return controls.macros.items[i].value; }
EXPORT(ctl_offset_count) int32_t ctl_offset_count() { return controls.offsets.count; }
EXPORT(ctl_offset_key) int32_t ctl_offset_key(int32_t i) { return controls.offsets.items[i].key; }
EXPORT(ctl_offset_value) double ctl_offset_value(int32_t i) { return controls.offsets.items[i].value; }
EXPORT(ctl_unavailable_count) int32_t ctl_unavailable_count() { return controls.unavailable_count; }
EXPORT(ctl_unavailable) int32_t ctl_unavailable(int32_t i) { return controls.unavailable[i]; }
EXPORT(ctl_blocked_count) int32_t ctl_blocked_count() { return controls.blocked_count; }
EXPORT(ctl_blocked) int32_t ctl_blocked(int32_t i) { return controls.blocked[i]; }

// ---- timing ----
EXPORT(ctl_tempo_at) double ctl_tempo_at(double step) { return controls.tempo_at(step); }
EXPORT(ctl_seconds) double ctl_seconds(double position, double origin) {
  return controls.window_seconds(position, origin, window_error);
}
EXPORT(ctl_frame) double ctl_frame(double position, double swing, double rate, double origin) {
  return controls.window_frame(position, swing, rate, origin, window_error);
}
EXPORT(ctl_duration)
double ctl_duration(double position, double duration, double swing, double rate, double origin) {
  return controls.window_duration(position, duration, swing, rate, origin, window_error);
}
// The first timing error since the last call (Error), then cleared.
EXPORT(ctl_error) int32_t ctl_error() {
  const int32_t e = window_error;
  window_error = 0;
  return e;
}
