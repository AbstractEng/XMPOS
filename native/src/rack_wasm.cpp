// WebAssembly exports of XMP's instrument engine (xmp/rack.hpp) for the
// browser. packages/core/src/engine.ts is the only caller: it lays the
// palette out in this module's memory, drives notes and parameters, and reads
// the audio, meters and MIDI events back. One rack per instance.
#include "xmp/rack.hpp"

using xmp::rack::Rack;
using xmp::rack::Track;

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static Rack instance;
static Rack* const rack = &instance;
static int32_t scratch_index[16];
static double scratch_value[16];
static double scratch_sequence[16];
static float custom_audio[xmp::rack::kBlock];

// Once per instance, before anything else.
EXPORT(xmp_create) int32_t xmp_create(int32_t rate) {
  if (rate < 8000 || rate > 96000) return 0;
  rack->set_rate(rate);
  return 1;
}
// Scratch areas the binding fills before a call.
EXPORT(xmp_scratch_index) int32_t* xmp_scratch_index() { return scratch_index; }
EXPORT(xmp_scratch_value) double* xmp_scratch_value() { return scratch_value; }
EXPORT(xmp_scratch_sequence) double* xmp_scratch_sequence() { return scratch_sequence; }
EXPORT(xmp_custom_audio) float* xmp_custom_audio() { return custom_audio; }
EXPORT(xmp_left) float* xmp_left() { return rack->left; }
EXPORT(xmp_right) float* xmp_right() { return rack->right; }
EXPORT(xmp_meter_out) double* xmp_meter_out() { return rack->meter_out; }
EXPORT(xmp_midi) void* xmp_midi() { return rack->midi; }
EXPORT(xmp_midi_count) int32_t xmp_midi_count() { return rack->midi_count; }
EXPORT(xmp_midi_overflow) int32_t xmp_midi_overflow() { return rack->midi_overflow; }
EXPORT(xmp_midi_clear) void xmp_midi_clear() { rack->midi_count = rack->midi_overflow = 0; }
EXPORT(xmp_midi_event_size) int32_t xmp_midi_event_size() { return sizeof(xmp::rack::MidiEvent); }

// ---- configure ----
EXPORT(xmp_stage_begin) void xmp_stage_begin(int32_t tracks, int32_t pads) { rack->stage_begin(tracks, pads); }
// flags: 1 base midi, 2 muted, 4 silent route, 8 the xmp.midi machine, 16 custom audio
EXPORT(xmp_stage_track)
int32_t xmp_stage_track(int32_t i, int32_t uid, int32_t kind, int32_t key, int32_t route, int32_t flags, double gain,
                        double channel_state, double delay_send, int32_t gain_index, int32_t effect_gain_index,
                        int32_t channel_index) {
  Track* t = rack->stage_track(i);
  if (!t) return 0;
  t->uid = uid;
  t->kind = kind;
  t->key = key;
  t->route = route;
  t->base_midi = flags & 1;
  t->muted = flags & 2;
  t->silent_route = flags & 4;
  t->midi_machine = flags & 8;
  t->custom_audio = flags & 16;
  t->gain = gain;
  t->channel_state = channel_state;
  t->delay_send = delay_send;
  t->gain_index = gain_index;
  t->effect_gain_index = effect_gain_index;
  t->channel_index = channel_index;
  return 1;
}
// Where a track's 16 pads start in the staged pads (project format 7's kits).
EXPORT(xmp_stage_pad_base) int32_t xmp_stage_pad_base(int32_t i, int32_t base) {
  Track* t = rack->stage_track(i);
  if (!t || base < 0) return 0;
  t->pad_base = base;
  return 1;
}
// Patch fields in scratch_value[0..9] (attack, decay, sustain, release, cutoff,
// resonance, filter envelope amount and decay, detune, glide), their parameter
// indices in scratch_index[0..9].
EXPORT(xmp_stage_patch) int32_t xmp_stage_patch(int32_t i, int32_t oscillator) {
  Track* t = rack->stage_track(i);
  if (!t) return 0;
  t->patch.oscillator = oscillator;
  for (int p = 0; p < xmp::rack::kPatchFields; ++p) {
    xmp::rack::patch_field(t->patch, p) = scratch_value[p];
    t->patch_index[p] = scratch_index[p];
  }
  return 1;
}
EXPORT(xmp_stage_pad)
float* xmp_stage_pad(int32_t i, uint32_t length, double rate, int32_t mode, int32_t root, int32_t choke) {
  return rack->stage_pad(i, length, rate, mode, root, choke);
}
// One take of a multi-sampled pad (project format 8).
EXPORT(xmp_stage_pad_take)
float* xmp_stage_pad_take(int32_t i, int32_t layer, int32_t take, uint32_t length, double rate, double up_to) {
  return rack->stage_pad_take(i, layer, take, length, rate, up_to);
}
EXPORT(xmp_stage_delay) void xmp_stage_delay(int32_t present, double seconds, double feedback, double wet) {
  rack->stage_delay(present, seconds, feedback, wet);
}
EXPORT(xmp_stage_base) void xmp_stage_base(int32_t index, double value) { rack->stage_base(index, value); }
EXPORT(xmp_stage_master) void xmp_stage_master(double master) { rack->stage_master(master); }
EXPORT(xmp_stage_mixer) int32_t xmp_stage_mixer(int32_t mode, double bpm) {
  return rack->stage_mixer(mode, bpm) != nullptr || mode != 2;
}
EXPORT(xmp_stage_strip)
int32_t xmp_stage_strip(int32_t i, double pan, double send0, double send1, int32_t pan_index, int32_t send0_index,
                        int32_t send1_index) {
  return rack->stage_strip(i, pan, send0, send1, pan_index, send0_index, send1_index);
}
EXPORT(xmp_stage_tempo) int32_t xmp_stage_tempo(double step, double bpm) { return rack->stage_tempo(step, bpm); }
// Slot parameter indices in scratch_index[0..2], defaults in scratch_value[0..2],
// the sync sequence in scratch_sequence.
EXPORT(xmp_stage_effect)
int32_t xmp_stage_effect(int32_t chain, int32_t kind, int32_t bypass, int32_t bypass_index, double cutoff_raw,
                         int32_t sync, double division, int32_t sequence_length) {
  return rack->stage_effect(chain, kind, bypass, bypass_index, scratch_index, scratch_value, cutoff_raw, sync,
                            division, scratch_sequence, sequence_length);
}
EXPORT(xmp_commit) void xmp_commit() { rack->commit(); }
EXPORT(xmp_set_master_index) void xmp_set_master_index(int32_t i) { rack->master_index_ = i; }
EXPORT(xmp_set_bypass_flag) void xmp_set_bypass_flag(int32_t i, int32_t bypass) { rack->set_bypass_flag(i, bypass); }

// ---- parameters ----
EXPORT(xmp_targets_begin) void xmp_targets_begin() { rack->targets_begin(); }
EXPORT(xmp_targets_add) void xmp_targets_add(int32_t index, double value) { rack->targets_add(index, value); }
EXPORT(xmp_targets_commit) void xmp_targets_commit() { rack->targets_commit(); }
EXPORT(xmp_reset_parameters) void xmp_reset_parameters() { rack->reset_parameters(); }
EXPORT(xmp_has_value) int32_t xmp_has_value(int32_t i) { return rack->has_value(i); }
EXPORT(xmp_value) double xmp_value(int32_t i) { return rack->value(i); }

// ---- tracks and notes ----
EXPORT(xmp_blocked_begin) void xmp_blocked_begin() { rack->blocked_begin(); }
EXPORT(xmp_blocked_add) void xmp_blocked_add(int32_t uid) { rack->blocked_add(uid); }
EXPORT(xmp_blocked_commit) void xmp_blocked_commit() { rack->blocked_commit(); }
EXPORT(xmp_track_blocked) int32_t xmp_track_blocked(int32_t index) { return rack->track_blocked(index); }
EXPORT(xmp_note_on)
int32_t xmp_note_on(double id, int32_t pad, int32_t track, int32_t note, double velocity, double duration) {
  return rack->note_on(id, pad, track, note, velocity, static_cast<int64_t>(duration));
}
EXPORT(xmp_note_off) void xmp_note_off(double id) { rack->note_off(id); }
EXPORT(xmp_release_track) void xmp_release_track(int32_t uid) { rack->release_track(uid); }
EXPORT(xmp_remove_track) void xmp_remove_track(int32_t uid) { rack->remove_track(uid); }
EXPORT(xmp_panic) void xmp_panic() { rack->panic(); }
EXPORT(xmp_clear_tail) void xmp_clear_tail() { rack->clear_tail(); }
EXPORT(xmp_clock) void xmp_clock(double step, double bpm) { rack->clock(step, bpm); }
EXPORT(xmp_active) int32_t xmp_active() { return rack->active(); }
EXPORT(xmp_refused) double xmp_refused() { return rack->refused; }
EXPORT(xmp_frame) double xmp_frame() { return rack->frame; }
EXPORT(xmp_master_gain) double xmp_master_gain() { return rack->master_gain; }
EXPORT(xmp_set_master_gain) void xmp_set_master_gain(double gain) { rack->master_gain = gain; }
EXPORT(xmp_has_mixer) int32_t xmp_has_mixer() { return rack->has_mixer(); }
EXPORT(xmp_meter) int32_t xmp_meter(int32_t reset) { return rack->meter(reset); }
EXPORT(xmp_track_gain) double xmp_track_gain(int32_t index) { return rack->track_gain(index); }
EXPORT(xmp_advanced) int32_t xmp_advanced() { return rack->advanced; }

// ---- processing ----
EXPORT(xmp_process) void xmp_process(int32_t frames) { rack->process(frames); }
EXPORT(xmp_voices_block) void xmp_voices_block(int32_t frames) {
  rack->advanced = false;
  rack->voices_block(frames);
}
EXPORT(xmp_custom_add) void xmp_custom_add(int32_t track, int32_t frames) {
  rack->custom_add(track, custom_audio, frames);
}
EXPORT(xmp_finish) void xmp_finish(int32_t frames) { rack->finish(frames); }
EXPORT(xmp_frame_voices) void xmp_frame_voices(int32_t i) {
  rack->advanced = false;
  rack->frame_voices(i);
}
EXPORT(xmp_frame_custom) void xmp_frame_custom(int32_t track, double value) { rack->frame_custom(track, value); }
EXPORT(xmp_frame_mix) void xmp_frame_mix(int32_t i) { rack->frame_mix(i); }

// ---- standalone effects and mixers (packages/core/src/mixer.ts) ----
// The engine's own Effect and Mixer, outside any rack, for tests and tools
// that run one effect or one mixer sample by sample. Each object owns its
// parameter values: an effect takes its four (three slots and bypass) with
// every sample; a mixer reads them from its own table, which JavaScript fills.
using xmp::rack::Effect;
using xmp::rack::Mixer;

struct Unit {
  Effect effect;
  Mixer* mixer = nullptr;
  double inputs[xmp::rack::kTracks] = {};
  double cur[256] = {};
  uint8_t has[256] = {};
};
static void free_unit(Unit* u) {
  if (!u) return;
  free(u->effect.ring);
  if (u->mixer) {
    u->mixer->free_rings();
    free(u->mixer);
  }
  free(u);
}
static Unit* new_unit() {
  Unit* u = static_cast<Unit*>(calloc(1, sizeof(Unit)));
  if (u) *u = Unit{};
  return u;
}

// An effect: slot defaults in scratch_value[0..2], the sync sequence in scratch_sequence.
EXPORT(xmp_fx_new)
Unit* xmp_fx_new(int32_t kind, int32_t bypass, double cutoff_raw, int32_t sync, double division,
                 int32_t sequence_length, int32_t rate) {
  Unit* u = new_unit();
  if (!u) return nullptr;
  static const int32_t slots[3] = {0, 1, 2};
  if (!xmp::rack::init_effect(u->effect, kind, bypass, 3, slots, scratch_value, cutoff_raw, sync, division,
                              scratch_sequence, sequence_length, rate)) {
    free_unit(u);
    return nullptr;
  }
  return u;
}
// One sample. `mask` bit i: value i given (slots 0..2, bypass 3).
EXPORT(xmp_fx_process)
double xmp_fx_process(Unit* u, double input, double step, double bpm, int32_t mask, double v0, double v1, double v2,
                      double bypass) {
  const double values[4] = {v0, v1, v2, bypass};
  for (int i = 0; i < 4; ++i) u->cur[i] = values[i], u->has[i] = (mask >> i) & 1;
  return u->effect.process(input, step, bpm, u->cur, u->has);
}
EXPORT(xmp_fx_clear) void xmp_fx_clear(Unit* u) { u->effect.clear(); }
EXPORT(xmp_unit_free) void xmp_unit_free(Unit* u) { free_unit(u); }

// A mixer; then its strips, tempos and effects (as the rack stages them).
EXPORT(xmp_mix_new) Unit* xmp_mix_new(int32_t rate, double bpm) {
  Unit* u = new_unit();
  if (!u) return nullptr;
  u->mixer = static_cast<Mixer*>(calloc(1, sizeof(Mixer)));
  if (!u->mixer) {
    free_unit(u);
    return nullptr;
  }
  *u->mixer = Mixer{};
  u->mixer->rate = rate, u->mixer->bpm = bpm;
  return u;
}
EXPORT(xmp_mix_strip)
int32_t xmp_mix_strip(Unit* u, int32_t i, double pan, double send0, double send1, int32_t pan_index,
                      int32_t send0_index, int32_t send1_index) {
  Mixer* m = u->mixer;
  if (!m || i < 0 || i >= xmp::rack::kTracks) return 0;
  Mixer::Strip& s = m->strips[i];
  s.pan = pan, s.sends[0] = send0, s.sends[1] = send1;
  s.pan_index = pan_index, s.send_index[0] = send0_index, s.send_index[1] = send1_index;
  if (m->strip_count < i + 1) m->strip_count = i + 1;
  return 1;
}
EXPORT(xmp_mix_tempo) int32_t xmp_mix_tempo(Unit* u, double step, double bpm) {
  Mixer* m = u->mixer;
  if (!m || m->tempo_count >= xmp::rack::kTempos) return 0;
  m->tempo_step[m->tempo_count] = step, m->tempo_bpm[m->tempo_count++] = bpm;
  return 1;
}
// chain 0..7 a strip, 8 and 9 the returns; slot indices in scratch_index, defaults in scratch_value.
EXPORT(xmp_mix_effect)
int32_t xmp_mix_effect(Unit* u, int32_t chain, int32_t kind, int32_t bypass, int32_t bypass_index, double cutoff_raw,
                       int32_t sync, double division, int32_t sequence_length) {
  Mixer* m = u->mixer;
  if (!m) return 0;
  xmp::rack::Chain* c = chain >= 0 && chain < xmp::rack::kTracks ? &m->strips[chain].chain
                        : chain == 8                              ? &m->returns[0]
                        : chain == 9                              ? &m->returns[1]
                                                                  : nullptr;
  if (!c || c->count >= 2) return 0;
  Effect* pair[2] = {&c->left[c->count], &c->right[c->count]};
  for (Effect* e : pair)
    if (!xmp::rack::init_effect(*e, kind, bypass, bypass_index, scratch_index, scratch_value, cutoff_raw, sync,
                                division, scratch_sequence, sequence_length, m->rate))
      return 0;
  ++c->count;
  return 1;
}
EXPORT(xmp_mix_inputs) double* xmp_mix_inputs(Unit* u) { return u->inputs; }
EXPORT(xmp_mix_values) double* xmp_mix_values(Unit* u) { return u->cur; }
EXPORT(xmp_mix_given) uint8_t* xmp_mix_given(Unit* u) { return u->has; }
EXPORT(xmp_mix_clock) void xmp_mix_clock(Unit* u, double step, double bpm) { u->mixer->step = step, u->mixer->bpm = bpm; }
EXPORT(xmp_mix_process) void xmp_mix_process(Unit* u, double master) {
  u->mixer->process(u->inputs, master, u->cur, u->has);
}
EXPORT(xmp_mix_clear) void xmp_mix_clear(Unit* u) { u->mixer->clear(); }
// The mixer's state, in scratch_value: left, right, peak left, peak right,
// sum of squares, samples, clipped, step, bpm.
EXPORT(xmp_mix_state) void xmp_mix_state(Unit* u) {
  const Mixer* m = u->mixer;
  const double out[9] = {m->left,
                         m->right,
                         m->peak_l,
                         m->peak_r,
                         m->sum_squares,
                         static_cast<double>(m->samples),
                         static_cast<double>(m->clipped),
                         m->step,
                         m->bpm};
  for (int i = 0; i < 9; ++i) scratch_value[i] = out[i];
}
EXPORT(xmp_mix_reset_meter) void xmp_mix_reset_meter(Unit* u) {
  Mixer* m = u->mixer;
  m->peak_l = m->peak_r = m->sum_squares = 0;
  m->samples = m->clipped = 0;
}
