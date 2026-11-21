// WebAssembly exports of XMP's sequencer (xmp/sequencer.hpp) for the browser.
// packages/core/src/sequencer-engine.ts is the only caller: it lays a scene's
// plan out in this module's memory and reads notes and parameter values back.
#include "xmp/sequencer.hpp"

using namespace xmp::sequencer;

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static Plan plan;
static double scratch_a[256], scratch_b[256], offsets[kParams], values[kParams];

EXPORT(seq_scratch_a) double* seq_scratch_a() { return scratch_a; }
EXPORT(seq_scratch_b) double* seq_scratch_b() { return scratch_b; }
EXPORT(seq_offsets) double* seq_offsets() { return offsets; }
EXPORT(seq_values) double* seq_values() { return values; }
EXPORT(seq_results) Result* seq_results() { return plan.results; }
EXPORT(seq_result_size) int32_t seq_result_size() { return sizeof(Result); }
EXPORT(seq_error) int32_t seq_error() { return plan.error; }

EXPORT(seq_groove_position) double seq_groove_position(double position, double swing) {
  return groove_position(position, swing);
}
EXPORT(seq_step_time) double seq_step_time(double step, double bpm, double swing) {
  return step_time(step, bpm, swing);
}

// ---- plan layout ----
// Each string: write it at seq_pool_tail(), then commit its length; returns a handle.
static Text texts[1 << 14];
static int32_t text_count = 0;
EXPORT(seq_reset) void seq_reset(double seed) {
  plan.reset(static_cast<uint32_t>(seed));
  text_count = 0;
}
EXPORT(seq_pool_tail) uint16_t* seq_pool_tail() { return plan.pool_tail(); }
EXPORT(seq_pool_room) int32_t seq_pool_room() { return plan.pool_room(); }
EXPORT(seq_text) int32_t seq_text(int32_t length) {
  if (text_count >= (1 << 14)) return plan.error = budget, -1;
  texts[text_count] = plan.commit_text(length);
  return text_count++;
}
static Text text(int32_t handle) { return handle >= 0 && handle < text_count ? texts[handle] : Text{}; }
EXPORT(seq_project) void seq_project(int32_t id) { plan.set_project(text(id)); }
EXPORT(seq_track) int32_t seq_track(int32_t id, int32_t clip, double length) {
  return plan.add_track(text(id), text(clip), length);
}
EXPORT(seq_note)
int32_t seq_note(int32_t track, int32_t legacy, int32_t id, int32_t pad, int32_t note, double position,
                 double duration, double velocity, double probability, double microtiming, int32_t condition) {
  Note n;
  n.legacy = legacy != 0;
  n.id = text(id);
  n.pad = pad;
  n.note = note;
  n.position = position;
  n.duration = duration;
  n.velocity = velocity;
  n.probability = probability;
  n.microtiming = microtiming;
  n.condition = condition;
  return plan.add_note(track, n);
}
EXPORT(seq_clip_track) int32_t seq_clip_track(double length) { return plan.add_clip_track(length); }
// Sources: values in scratch_a[0..4], which are present as bit flags.
EXPORT(seq_parameter) int32_t seq_parameter(int32_t present) {
  Sources s;
  for (int k = 0; k < 5; ++k) {
    s.value[k] = scratch_a[k];
    s.has[k] = (present >> k) & 1;
  }
  return plan.add_parameter(s);
}
// Lane points: positions in scratch_a, values in scratch_b (at most 256).
EXPORT(seq_lane) int32_t seq_lane(int32_t track, int32_t parameter, int32_t count) {
  return count >= 0 && count <= 256 && plan.add_lane(track, parameter, scratch_a, scratch_b, count);
}
EXPORT(seq_lock) int32_t seq_lock(int32_t track, int32_t parameter, int32_t position, double value) {
  return plan.add_lock(track, parameter, position, value);
}
EXPORT(seq_mod)
int32_t seq_mod(int32_t track, int32_t parameter, int32_t kind, double amount, double cycles, double phase) {
  return plan.add_mod(track, parameter, kind, amount, cycles, phase);
}

// ---- queries ----
EXPORT(seq_window) int32_t seq_window(double from, double to, int32_t fill) { return plan.window(from, to, fill); }
EXPORT(seq_timeline) void seq_timeline(double swing, double bpm, double rate) { plan.timeline(swing, bpm, rate); }
EXPORT(seq_step_events) int32_t seq_step_events(double step) {
  return plan.step_events(static_cast<int64_t>(step));
}
EXPORT(seq_parameter_frame) int32_t seq_parameter_frame(double position) {
  return plan.parameter_frame(position, offsets, values);
}
// The same with only clip track `only` (-1: none) applied, for the performance
// window's per-track automation over one shared parameter table.
EXPORT(seq_parameter_frame_track) int32_t seq_parameter_frame_track(double position, int32_t only) {
  return plan.parameter_frame(position, offsets, values, only < 0 ? -1 : only);
}
