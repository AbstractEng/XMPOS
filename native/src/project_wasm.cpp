// WebAssembly exports of XMP's project core for the browser (phase 9 of
// docs/cpp-port.md): opening any project file (a plain project, a version 1
// bundle or a song, with a sample library for songs saved without their
// audio), checking a project, and saving it as a song or a legacy bundle.
//
// A project lives here, by handle. Its sample audio crosses to and from
// JavaScript as Float64 arrays and everything else as compact JSON ("lean":
// the project with each sample's pcm empty), so no sample is ever written or
// parsed as JSON text on the way. packages/core/src/project-io.ts is the only caller.
#include <stdlib.h>
#include <string.h>

#include "xmp/commands.hpp"
#include "xmp/render.hpp"
#include "xmp/portable.hpp"
#include "xmp/song_snapshot.hpp"
#include "xmp/project.hpp"

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

using xmp::Str;
using xmp::Vec;
using xmp::json::Value;

namespace {
Vec<Value*> projects;  // handle = index + 1
Str result, error_text;
xmp::portable::Library library;
Vec<xmp::portable::Missing> missing;

int32_t store(Value v) {
  Value* p = static_cast<Value*>(xmp::checked_alloc(sizeof(Value)));
  new (p) Value(xmp::move(v));
  for (int32_t i = 0; i < projects.size(); ++i)
    if (!projects[i]) return projects[i] = p, i + 1;
  projects.push(p);
  return projects.size();
}
Value* get(int32_t handle) {
  return handle >= 1 && handle <= projects.size() ? projects[handle - 1] : nullptr;
}
Value* samples_of(int32_t handle) {
  Value* p = get(handle);
  Value* s = p && p->is_object() ? p->get("samples") : nullptr;
  return s && s->is_array() ? s : nullptr;
}
int32_t fail(const Str& message) {
  error_text = message;
  return 0;
}
xmp::Str text_of_op(const Value& c) {
  const Value* op = c.get("op");
  return op && op->is_string() ? op->as_string() : xmp::Str();
}
double num_arg(const Value& a, int32_t i) {
  return a.is_array() && i < a.items().size() && a.items()[i].is_number() ? a.items()[i].as_number() : NAN;
}
}  // namespace

// ---- memory and results ----
EXPORT(xp_alloc) void* xp_alloc(int32_t bytes) { return malloc(bytes > 0 ? static_cast<size_t>(bytes) : 1); }
EXPORT(xp_free) void xp_free(void* p) { free(p); }
EXPORT(xp_result) const char* xp_result() { return result.c_str(); }
EXPORT(xp_result_size) int32_t xp_result_size() { return static_cast<int32_t>(result.size()); }
EXPORT(xp_error) const char* xp_error() { return error_text.c_str(); }
EXPORT(xp_error_size) int32_t xp_error_size() { return static_cast<int32_t>(error_text.size()); }

// ---- the sample library for songs saved without their audio ----
EXPORT(xp_library_clear) void xp_library_clear() { library.assets.clear(); }
EXPORT(xp_library_add)
int32_t xp_library_add(const char* hash, int32_t hash_size, double rate, const double* pcm, int32_t frames) {
  if (hash_size <= 0 || hash_size > 128 || frames < 0 || frames > xmp::project_limits::kLoopSampleFrames) return 0;
  xmp::portable::Library::Asset a;
  a.hash = Str(hash, static_cast<size_t>(hash_size));
  a.rate = rate;
  a.pcm.reserve(frames);
  for (int32_t i = 0; i < frames; ++i) a.pcm.push(pcm[i]);
  library.assets.push(xmp::move(a));
  return 1;
}

// ---- opening ----
// Opens a file's text; 0 on failure (xp_error says why; xp_missing lists the
// samples a song still needs).
EXPORT(xp_open) int32_t xp_open(const char* text, int32_t size) {
  missing.clear();
  if (size < 0) return fail("Invalid project text");
  auto opened = xmp::portable::open(text, static_cast<size_t>(size), &library, &missing);
  if (!opened.ok) return fail(opened.error);
  return store(xmp::move(opened.project));
}
// The samples the last open lacked, as JSON: [{id, name, assetHash, sampleRate, frames}].
EXPORT(xp_missing) int32_t xp_missing() {
  Value list = Value::new_array();
  for (const auto& m : missing) {
    Value s = Value::new_object();
    s.set("id", Value::of(m.id)), s.set("name", Value::of(m.name)), s.set("assetHash", Value::of(m.hash));
    s.set("sampleRate", Value::of(m.rate)), s.set("frames", Value::of(m.frames));
    list.push(xmp::move(s));
  }
  result = xmp::json::stringify(list);
  return static_cast<int32_t>(result.size());
}

EXPORT(xp_open_snapshot)
int32_t xp_open_snapshot(const char* base, int32_t size, const char* edits, int32_t edits_size) {
  if (size < 0 || edits_size < 0) return fail("Invalid song snapshot");
  const auto opened = xmp::song_snapshot::open(base, static_cast<size_t>(size), edits, static_cast<size_t>(edits_size));
  if (!opened.ok) return fail(opened.error);
  return store(opened.project);
}

// ---- reading a project: its lean JSON and each sample's audio ----
EXPORT(xp_lean) int32_t xp_lean(int32_t handle) {
  const Value* p = get(handle);
  if (!p) return -1;
  Value lean = Value::new_object();
  for (const auto& m : p->members()) {
    if (m.key != "samples") {
      lean.set(m.key, m.value);
      continue;
    }
    Value samples = Value::new_array();
    for (const auto& s : m.value.items()) {
      Value copy = Value::new_object();
      for (const auto& f : s.members()) copy.set(f.key, f.key == "pcm" ? Value::new_array() : f.value);
      samples.push(xmp::move(copy));
    }
    lean.set(m.key, xmp::move(samples));
  }
  result = xmp::json::stringify(lean);
  return static_cast<int32_t>(result.size());
}
EXPORT(xp_sample_count) int32_t xp_sample_count(int32_t handle) {
  const Value* s = samples_of(handle);
  return s ? s->items().size() : -1;
}
EXPORT(xp_sample_frames) int32_t xp_sample_frames(int32_t handle, int32_t index) {
  const Value* s = samples_of(handle);
  if (!s || index < 0 || index >= s->items().size()) return -1;
  const Value* pcm = s->items()[index].get("pcm");
  return pcm && pcm->is_array() ? pcm->items().size() : -1;
}
// Copies sample `index`'s audio into `out` (frames doubles).
EXPORT(xp_sample_pcm) int32_t xp_sample_pcm(int32_t handle, int32_t index, double* out) {
  const int32_t frames = xp_sample_frames(handle, index);
  if (frames < 0) return 0;
  const auto& pcm = samples_of(handle)->items()[index].get("pcm")->items();
  for (int32_t i = 0; i < frames; ++i) out[i] = pcm[i].as_number();
  return 1;
}

// ---- building a project from the browser's: lean JSON, then each sample's audio, then a check ----
EXPORT(xp_build) int32_t xp_build(const char* text, int32_t size) {
  if (size < 0) return fail("Invalid project text");
  auto parsed = xmp::json::parse(text, static_cast<size_t>(size));
  if (!parsed.ok) return fail(parsed.error);
  return store(xmp::move(parsed.value));
}
EXPORT(xp_set_pcm) int32_t xp_set_pcm(int32_t handle, int32_t index, const double* pcm, int32_t frames) {
  Value* s = samples_of(handle);
  if (!s || index < 0 || index >= s->items().size() || frames < 0 || frames > xmp::project_limits::kLoopSampleFrames) return 0;
  Value values = Value::new_array();
  values.items().reserve(frames);
  for (int32_t i = 0; i < frames; ++i) values.push(Value::of(pcm[i]));
  s->items()[index].set("pcm", xmp::move(values));
  return 1;
}
// Validates the project and puts it in canonical form (the TypeScript's
// ProjectSchema.parse); 0 if it is not a valid project.
EXPORT(xp_check) int32_t xp_check(int32_t handle) {
  Value* p = get(handle);
  if (!p) return fail("No project");
  Value canonical;
  Str error;
  if (!xmp::project::migrate(*p, canonical, error)) return fail(error);
  *p = xmp::move(canonical);
  return 1;
}

// ---- saving ----
EXPORT(xp_save_song) int32_t xp_save_song(int32_t handle, int32_t package_samples) {
  const Value* p = get(handle);
  if (!p) return fail("No project") - 1;
  Str error;
  if (!xmp::portable::save_song(*p, result, error, package_samples != 0)) return fail(error) - 1;
  return static_cast<int32_t>(result.size());
}
EXPORT(xp_save_bundle) int32_t xp_save_bundle(int32_t handle) {
  const Value* p = get(handle);
  if (!p) return fail("No project") - 1;
  Str error;
  if (!xmp::portable::save_bundle(*p, result, error)) return fail(error) - 1;
  return static_cast<int32_t>(result.size());
}

// ---- edits and questions (commands.hpp) ----
// Sample `index` of `handle` takes the audio of sample `from` of `base`, shared, not copied.
EXPORT(xp_reuse_pcm) int32_t xp_reuse_pcm(int32_t handle, int32_t index, int32_t base, int32_t from) {
  Value* s = samples_of(handle);
  const Value* b = samples_of(base);
  if (!s || !b || index < 0 || index >= s->items().size() || from < 0 || from >= b->items().size()) return 0;
  const Value* pcm = b->items()[from].get("pcm");
  if (!pcm) return 0;
  s->items()[index].set("pcm", *pcm);
  return 1;
}
// Whether sample `i` of `a` and sample `j` of `b` share their audio (an edit left it alone).
EXPORT(xp_shares_pcm) int32_t xp_shares_pcm(int32_t a, int32_t i, int32_t b, int32_t j) {
  const Value* x = samples_of(a);
  const Value* y = samples_of(b);
  if (!x || !y || i < 0 || j < 0 || i >= x->items().size() || j >= y->items().size()) return 0;
  const Value* p = x->items()[i].get("pcm");
  const Value* q = y->items()[j].get("pcm");
  return p && q && p->shares_items(*q);
}
// An edit of `handle`'s project: the new project's handle, or 0 (xp_error says why).
EXPORT(xp_edit) int32_t xp_edit(int32_t handle, const char* text, int32_t size) {
  const Value* p = get(handle);
  if (!p || size < 0) return fail("No project");
  const auto command = xmp::json::parse(text, static_cast<size_t>(size));
  if (!command.ok) return fail(command.error);
  auto r = xmp::commands::run(*p, command.value);
  if (!r.ok) return fail(r.error);
  if (!r.edited) return fail("Not an edit");
  return store(xmp::move(r.value));
}
// A question about `handle`'s project: 1 and the answer as JSON in xp_result, or 0.
EXPORT(xp_query) int32_t xp_query(int32_t handle, const char* text, int32_t size) {
  const Value* p = get(handle);
  if (!p || size < 0) return fail("No project");
  const auto command = xmp::json::parse(text, static_cast<size_t>(size));
  if (!command.ok) return fail(command.error);
  const auto r = xmp::commands::run(*p, command.value);
  if (!r.ok) return fail(r.error);
  result = xmp::json::stringify(r.value);
  return 1;
}
// An SDK machine definition, so the registry and edits know its parameters.
EXPORT(xp_register_machine) int32_t xp_register_machine(const char* text, int32_t size) {
  const auto d = xmp::json::parse(text, static_cast<size_t>(size < 0 ? 0 : size));
  if (!d.ok) return fail(d.error);
  const auto r = xmp::commands::register_machine(d.value);
  return r.ok ? 1 : fail(r.error);
}

EXPORT(xp_close) void xp_close(int32_t handle) {
  Value* p = get(handle);
  if (!p) return;
  p->~Value();
  free(p);
  projects[handle - 1] = nullptr;
}
// Frees the last result's memory (results can be megabytes).
EXPORT(xp_release) void xp_release() { result = Str(), error_text = Str(); }

// ---- files and rendering: binary results as blobs, the rest as JSON ----
namespace {
Vec<Str> blobs;
void blob(const void* data, size_t bytes) {
  Str b;
  b.append(static_cast<const char*>(data), bytes);
  blobs.push(xmp::move(b));
}
void blob_floats(const Vec<float>& v) { blob(v.begin(), static_cast<size_t>(v.size()) * sizeof(float)); }
void blob_bytes(const xmp::files::Bytes& b) { blob(b.begin(), static_cast<size_t>(b.size())); }
const Value& arg(const Value& a, int32_t i) {
  static const Value none;
  return a.is_array() && i < a.items().size() ? a.items()[i] : none;
}
double num(const Value& o, const char* k) { return o.get(k) && o.get(k)->is_number() ? o.get(k)->as_number() : NAN; }
Str str_of(const Value& v) { return v.is_string() ? v.as_string() : Str(); }
xmp::files::MidiDocument document_of(const Value& v) {
  xmp::files::MidiDocument d;
  d.ppq = num(v, "ppq"), d.end_tick = num(v, "endTick"), d.ignored_events = num(v, "ignoredEvents");
  if (const Value* notes = v.get("notes"))
    for (const auto& n : notes->items())
      d.notes.push(xmp::files::MidiNote{num(n, "track"), num(n, "channel"), num(n, "note"), num(n, "velocity"),
                                        num(n, "tick"), num(n, "duration")});
  if (const Value* tempos = v.get("tempos"))
    for (const auto& t : tempos->items()) d.tempos.push(xmp::files::MidiTempo{num(t, "tick"), num(t, "micros")});
  return d;
}
Value document_json(const xmp::files::MidiDocument& d) {
  Value o = Value::new_object();
  o.set("ppq", Value::of(d.ppq));
  Value notes = Value::new_array();
  for (const auto& n : d.notes) {
    Value x = Value::new_object();
    x.set("track", Value::of(n.track)), x.set("channel", Value::of(n.channel)), x.set("note", Value::of(n.note));
    x.set("velocity", Value::of(n.velocity)), x.set("tick", Value::of(n.tick)), x.set("duration", Value::of(n.duration));
    notes.push(xmp::move(x));
  }
  o.set("notes", xmp::move(notes));
  Value tempos = Value::new_array();
  for (const auto& t : d.tempos) {
    Value x = Value::new_object();
    x.set("tick", Value::of(t.tick)), x.set("micros", Value::of(t.micros));
    tempos.push(xmp::move(x));
  }
  o.set("tempos", xmp::move(tempos));
  o.set("endTick", Value::of(d.end_tick)), o.set("ignoredEvents", Value::of(d.ignored_events));
  return o;
}
Value midi_json(const Vec<xmp::voices::MidiEvent>& midi) {
  Value out = Value::new_array();
  for (const auto& e : midi) {
    Value o = Value::new_object();
    o.set("kind", Value::of(e.on ? "on" : "off")), o.set("id", Value::of(e.id));
    o.set("note", Value::of(static_cast<double>(e.note))), o.set("velocity", Value::of(e.velocity));
    o.set("channel", Value::of(static_cast<double>(e.channel)));
    out.push(xmp::move(o));
  }
  return out;
}
// A rendered performance: its JSON, its audio (blobs 0 and 1) and its WAV (blob 2).
Value commands_json(const Vec<xmp::render::Command>& list);
bool performance_out(xmp::render::Performance& p, Value& o, Str& error) {
  o = Value::new_object();
  o.set("meter", p.meter);
  Value trace = Value::new_array();
  for (const auto& t : p.trace) {
    Value x = Value::new_object();
    x.set("frame", Value::of(t.frame)), x.set("note", Value::of(static_cast<double>(t.note))), x.set("trackId", Value::of(t.track));
    trace.push(xmp::move(x));
  }
  o.set("trace", xmp::move(trace));
  Value transitions = Value::new_array();
  for (const auto& t : p.transitions) {
    Value x = Value::new_object();
    x.set("step", Value::of(t.step)), x.set("sceneId", Value::of(t.scene));
    if (t.has_occurrence) x.set("occurrenceId", Value::of(t.occurrence));
    transitions.push(xmp::move(x));
  }
  o.set("transitions", xmp::move(transitions));
  o.set("bodySteps", Value::of(p.body_steps));
  o.set("midi", midi_json(p.midi));
  o.set("snapshot", p.snapshot);
  o.set("commands", commands_json(p.commands));
  blob_floats(p.left), blob_floats(p.right);
  Vec<Vec<float>> channels;
  channels.push(p.left), channels.push(p.right);
  xmp::files::Bytes wav;
  if (!xmp::files::encode_wav(channels, 48000, wav, error)) return false;
  blob_bytes(wav);
  return true;
}
int32_t answer(const Value& v) {
  result = xmp::json::stringify(v);
  return 1;
}
}  // namespace

EXPORT(xp_blob_count) int32_t xp_blob_count() { return blobs.size(); }
EXPORT(xp_blob) const char* xp_blob(int32_t i) { return i >= 0 && i < blobs.size() ? blobs[i].c_str() : nullptr; }
EXPORT(xp_blob_size) int32_t xp_blob_size(int32_t i) {
  return i >= 0 && i < blobs.size() ? static_cast<int32_t>(blobs[i].size()) : 0;
}
EXPORT(xp_blobs_release) void xp_blobs_release() { blobs.clear(); }

// Files without a project: decodeWav (data: the file), encodeWav (args [rate,
// frames, channels]; data: the channels' float32 audio one after another),
// encodeMidi (args [document]) and decodeMidi (data: the file). 1 or 0.
EXPORT(xp_files) int32_t xp_files(const char* text, int32_t size, const uint8_t* data, int32_t data_size) {
  blobs.clear();
  const auto c = xmp::json::parse(text, static_cast<size_t>(size < 0 ? 0 : size));
  if (!c.ok) return fail(c.error);
  const Str op = text_of_op(c.value);
  const Value& a = c.value.get("args") ? *c.value.get("args") : Value();
  Str error;
  const size_t n = static_cast<size_t>(data_size < 0 ? 0 : data_size);
  if (op == "decodeWav") {
    xmp::files::Sample s;
    if (!xmp::files::decode_sample_wav(data, n, s, error)) return fail(error);
    blob_floats(s.pcm);
    Value o = Value::new_object();
    o.set("sampleRate", Value::of(static_cast<double>(s.rate)));
    return answer(o);
  }
  if (op == "encodeWav") {
    const int32_t frames = static_cast<int32_t>(num_arg(a, 1)), count = static_cast<int32_t>(num_arg(a, 2));
    if (frames < 0 || count < 0 || count > 2 || static_cast<size_t>(frames) * static_cast<size_t>(count) * 4 > n)
      return fail("Invalid WAV channels");
    Vec<Vec<float>> channels;
    const float* f = reinterpret_cast<const float*>(data);
    for (int32_t ch = 0; ch < count; ++ch) {
      Vec<float> v;
      v.reserve(frames);
      for (int32_t i = 0; i < frames; ++i) v.push(f[static_cast<size_t>(ch) * static_cast<size_t>(frames) + static_cast<size_t>(i)]);
      channels.push(xmp::move(v));
    }
    xmp::files::Bytes wav;
    if (!xmp::files::encode_wav(channels, static_cast<uint32_t>(num_arg(a, 0)), wav, error)) return fail(error);
    blob_bytes(wav);
    return answer(Value());
  }
  if (op == "encodeMidi") {
    xmp::files::Bytes b;
    if (!xmp::files::encode_midi(document_of(arg(a, 0)), b, error)) return fail(error);
    blob_bytes(b);
    return answer(Value());
  }
  if (op == "decodeMidi") {
    xmp::files::MidiDocument d;
    if (!xmp::files::decode_midi(data, n, d, error)) return fail(error);
    return answer(document_json(d));
  }
  return fail(Str("Unknown command ") + op);
}

// Files and renders of a project: exchangePlan [mode, scene], renderPerformance
// [scene, mode, steps, tail, resume], renderProjectScene [scene] (blob 0: WAV),
// renderInstrumentScene [scene, exactSteps] (blob 0: mono audio),
// renderExchange [mode, scene, tail] (performance blobs, then blob 3: the MIDI file). 1 or 0.
EXPORT(xp_project_files) int32_t xp_project_files(int32_t handle, const char* text, int32_t size) {
  blobs.clear();
  const Value* p = get(handle);
  if (!p) return fail("No project");
  const auto c = xmp::json::parse(text, static_cast<size_t>(size < 0 ? 0 : size));
  if (!c.ok) return fail(c.error);
  const Str op = text_of_op(c.value);
  const Value& a = c.value.get("args") ? *c.value.get("args") : Value();
  Str error;
  if (op == "exchangePlan") {
    xmp::files::MidiDocument d;
    double steps = 0;
    if (!xmp::files::exchange_plan(*p, str_of(arg(a, 0)), str_of(arg(a, 1)), d, steps, error)) return fail(error);
    Value o = Value::new_object();
    o.set("document", document_json(d)), o.set("steps", Value::of(steps));
    return answer(o);
  }
  if (op == "renderPerformance") {
    xmp::render::Performance r;
    if (!xmp::render::render_performance(*p, str_of(arg(a, 0)), str_of(arg(a, 1)), num_arg(a, 2), num_arg(a, 3),
                                         arg(a, 4).is_bool() && arg(a, 4).as_bool(), r, error))
      return fail(error);
    Value o;
    if (!performance_out(r, o, error)) return fail(error);
    return answer(o);
  }
  if (op == "renderProjectScene") {
    xmp::files::Bytes wav;
    if (!xmp::render::render_project_scene(*p, str_of(arg(a, 0)), wav, error)) return fail(error);
    blob_bytes(wav);
    return answer(Value());
  }
  if (op == "renderInstrumentScene") {
    xmp::render::Mono m;
    if (!xmp::render::render_instrument_scene(*p, str_of(arg(a, 0)), num_arg(a, 1), m, error)) return fail(error);
    xmp::files::Bytes wav;
    Vec<Vec<float>> channels;
    channels.push(m.pcm), channels.push(m.pcm);
    if (!xmp::files::encode_wav(channels, 48000, wav, error)) return fail(error);
    blob_floats(m.pcm);
    blob_bytes(wav);
    Value events = Value::new_array();
    for (const auto& e : m.hits) {
      Value h = Value::new_object();
      h.set("frame", Value::of(e.frame)), h.set("id", Value::of(e.id));
      h.set("pad", Value::of(static_cast<double>(e.pad))), h.set("track", Value::of(static_cast<double>(e.track)));
      h.set("note", Value::of(static_cast<double>(e.note))), h.set("velocity", Value::of(e.velocity));
      h.set("duration", Value::of(e.duration));
      events.push(xmp::move(h));
    }
    Value o = Value::new_object();
    o.set("midi", midi_json(m.midi)), o.set("events", xmp::move(events)), o.set("refused", Value::of(m.refused));
    return answer(o);
  }
  if (op == "prepareScene") {
    // The pad-sampler plan: each distinct sound as blob i, the events and length as JSON.
    xmp::render::ScenePlan plan;
    if (!xmp::render::prepare_scene(*p, str_of(arg(a, 0)), plan, error)) return fail(error);
    for (const auto& sound : plan.samples) blob_floats(sound);
    Value events = Value::new_array();
    for (const auto& e : plan.events) {
      Value o = Value::new_object();
      o.set("frame", Value::of(e.frame)), o.set("sample", Value::of(static_cast<double>(e.sample)));
      o.set("velocity", Value::of(e.velocity)), o.set("trackId", Value::of(e.track));
      o.set("pad", Value::of(static_cast<double>(e.pad))), o.set("step", Value::of(e.step));
      events.push(xmp::move(o));
    }
    Value o = Value::new_object();
    o.set("sampleRate", Value::of(48000.0)), o.set("frames", Value::of(plan.frames));
    o.set("events", xmp::move(events));
    return answer(o);
  }
  if (op == "renderScenePlan") {
    // prepareScene then renderPlan: blob 0, the stereo WAV.
    Vec<float> mono;
    if (!xmp::render::render_plan_scene(*p, str_of(arg(a, 0)), mono, error)) return fail(error);
    xmp::files::Bytes wav;
    Vec<Vec<float>> channels;
    channels.push(mono), channels.push(xmp::move(mono));
    if (!xmp::files::encode_wav(channels, 48000, wav, error)) return fail(error);
    blob_bytes(wav);
    return answer(Value());
  }
  if (op == "renderSequence") {
    // [scene, steps, fill, tail]: blob 0 the mono audio, blob 1 its stereo WAV; the
    // timeline's notes, the MIDI the engine emitted and the refused voices as JSON.
    const double steps = num_arg(a, 1);
    const bool fill = arg(a, 2).is_bool() && arg(a, 2).as_bool(), tail = !arg(a, 3).is_bool() || arg(a, 3).as_bool();
    xmp::render::Mono m;
    if (!xmp::render::render_sequence(*p, str_of(arg(a, 0)), steps, fill, tail, m, error)) return fail(error);
    Vec<xmp::play::Note> notes;
    if (!xmp::play::timeline(*p, str_of(arg(a, 0)), 0, steps, fill, xmp::project::detail::num(*p, "swing"), 48000, notes,
                             error))
      return fail(error);
    xmp::files::Bytes wav;
    Vec<Vec<float>> channels;
    channels.push(m.pcm), channels.push(m.pcm);
    if (!xmp::files::encode_wav(channels, 48000, wav, error)) return fail(error);
    blob_floats(m.pcm);
    blob_bytes(wav);
    Value o = Value::new_object();
    o.set("midi", midi_json(m.midi)), o.set("events", xmp::commands::detail::notes_json(notes));
    o.set("refused", Value::of(m.refused));
    return answer(o);
  }
  if (op == "renderExchange") {
    xmp::render::Performance r;
    xmp::files::Bytes midi;
    xmp::files::MidiDocument d;
    if (!xmp::render::render_exchange(*p, str_of(arg(a, 0)), str_of(arg(a, 1)), num_arg(a, 2), r, midi, d, error))
      return fail(error);
    Value o;
    if (!performance_out(r, o, error)) return fail(error);
    blob_bytes(midi);
    o.set("document", document_json(d));
    return answer(o);
  }
  return fail(Str("Unknown command ") + op);
}

// importMidiClip [fileTrack, trackId, clipId], data: the MIDI file: the new project's handle, or 0.
EXPORT(xp_import_midi) int32_t xp_import_midi(int32_t handle, const char* text, int32_t size, const uint8_t* data,
                                              int32_t data_size) {
  const Value* p = get(handle);
  if (!p) return fail("No project");
  const auto c = xmp::json::parse(text, static_cast<size_t>(size < 0 ? 0 : size));
  if (!c.ok) return fail(c.error);
  const Value& a = c.value.get("args") ? *c.value.get("args") : Value();
  auto e = xmp::files::import_midi_clip(*p, data, static_cast<size_t>(data_size < 0 ? 0 : data_size), num_arg(a, 0),
                                        str_of(arg(a, 1)), str_of(arg(a, 2)));
  if (!e.ok) return fail(e.error);
  return store(xmp::move(e.project));
}

// ---- playback: performances (play::Performance), by id ----
namespace {
Vec<xmp::play::Performance*> performances;  // id = index + 1
xmp::play::Performance* perf_of(int32_t id) {
  return id >= 1 && id <= performances.size() ? performances[id - 1] : nullptr;
}
Value perf_state(const xmp::play::Performance& p) {
  Value o = Value::new_object();
  o.set("sceneId", Value::of(p.scene_id()));
  o.set("running", Value::of(p.running()));
  o.set("mode", Value::of(p.song() ? "song" : "scene"));
  o.set("step", Value::of(p.step()));
  o.set("songOffset", Value::of(p.song_offset()));
  o.set("clockOrigin", Value::of(p.clock_origin()));
  Value slots = Value::new_array();
  for (const auto& s : p.slots()) {
    Value x = Value::new_array();
    x.push(Value::of(s.track));
    x.push(s.has_clip ? Value::of(s.clip) : Value());
    x.push(Value::of(s.anchor));
    slots.push(xmp::move(x));
  }
  o.set("slots", xmp::move(slots));
  Value queued = Value::new_array();
  for (const auto& q : p.queued()) {
    Value x = Value::new_array();
    x.push(Value::of(q.track));
    x.push(q.has_clip ? Value::of(q.clip) : Value());
    x.push(Value::of(q.at));
    queued.push(xmp::move(x));
  }
  o.set("queuedClips", xmp::move(queued));
  Str scene;
  if (p.queued_scene(scene)) {
    Value q = Value::new_object();
    q.set("id", Value::of(scene)), q.set("at", Value::of(p.queued_scene_at()));
    o.set("queuedScene", xmp::move(q));
  }
  Value overrides = Value::new_array();
  for (const auto& e : p.overrides.entries) {
    Value x = Value::new_array();
    x.push(Value::of(e.key)), x.push(e.value);
    overrides.push(xmp::move(x));
  }
  o.set("overrides", xmp::move(overrides));
  return o;
}
Value commands_json(const Vec<xmp::render::Command>& list) {
  Value out = Value::new_array();
  static const char* kKinds[] = {"clock", "release", "gates", "parameters", "on"};
  for (const auto& c : list) {
    Value o = Value::new_object();
    o.set("frame", Value::of(c.frame));
    o.set("kind", Value::of(kKinds[c.kind + 1]));
    if (c.kind == xmp::render::Command::clock) o.set("position", Value::of(c.position)), o.set("bpm", Value::of(c.bpm));
    if (c.kind == xmp::render::Command::release || c.kind == xmp::render::Command::gates) {
      Value t = Value::new_array();
      for (const auto& x : c.tracks) t.push(Value::of(x));
      o.set("tracks", xmp::move(t));
    }
    if (c.kind == xmp::render::Command::parameters) o.set("values", c.values);
    if (c.kind == xmp::render::Command::on) o.set("note", c.note);
    out.push(xmp::move(o));
  }
  return out;
}
}  // namespace

// A performance (transport) for project `handle`: its id, or 0.
EXPORT(xp_perf_new) int32_t xp_perf_new(int32_t handle) {
  const Value* p = get(handle);
  if (!p) return fail("No project");
  auto* perf = new (xmp::checked_alloc(sizeof(xmp::play::Performance))) xmp::play::Performance(*p);
  if (!perf->ok()) {
    const Str message = perf->error();
    perf->~Performance(), free(perf);
    return fail(message);
  }
  for (int32_t i = 0; i < performances.size(); ++i)
    if (!performances[i]) return performances[i] = perf, i + 1;
  performances.push(perf);
  return performances.size();
}
EXPORT(xp_perf_close) void xp_perf_close(int32_t id) {
  if (auto* p = perf_of(id)) p->~Performance(), free(p), performances[id - 1] = nullptr;
}
EXPORT(xp_perf_set_project) int32_t xp_perf_set_project(int32_t id, int32_t handle) {
  auto* perf = perf_of(id);
  const Value* p = get(handle);
  if (!perf || !p) return fail("No performance");
  Str error;
  return perf->set_project(*p, error) ? 1 : fail(error);
}
// A command to performance `id` (performance_tool.cpp's): its answer as JSON in xp_result, or 0.
//   start [scene|null, mode, resume], queueScene [scene], queueClip [track, clip|null],
//   cancel, stop, control [event], advance [step] -> {snapshot, releases},
//   window [step, fill, swing, rate] -> {window, commands}, values [position], state
EXPORT(xp_perf) int32_t xp_perf(int32_t id, const char* text, int32_t size) {
  auto* perf = perf_of(id);
  if (!perf) return fail("No performance");
  const auto c = xmp::json::parse(text, static_cast<size_t>(size < 0 ? 0 : size));
  if (!c.ok) return fail(c.error);
  const Str op = text_of_op(c.value);
  const Value& a = c.value.get("args") ? *c.value.get("args") : Value();
  const auto flag = [](const Value& v) { return v.is_bool() && v.as_bool(); };
  Str error;
  bool ok = true;
  if (op == "start")
    ok = perf->start(arg(a, 0).is_null() ? perf->scene_id() : str_of(arg(a, 0)), str_of(arg(a, 1)) == "song", flag(arg(a, 2)),
                     error);
  else if (op == "queueScene")
    ok = perf->queue_scene(str_of(arg(a, 0)), error);
  else if (op == "queueClip") {
    const Str clip = str_of(arg(a, 1));
    ok = perf->queue_clip(str_of(arg(a, 0)), arg(a, 1).is_null() ? nullptr : &clip, error);
  } else if (op == "queueClipAt") {
    const Str clip = str_of(arg(a,1));
    ok = perf->queue_recorded_loop(str_of(arg(a,0)),arg(a,1).is_null() ? nullptr : &clip,num_arg(a,2),error);
  } else if (op == "cancel")
    return answer(Value::of(perf->cancel_launch()));
  else if (op == "stop")
    perf->stop();
  else if (op == "control")
    ok = perf->control(arg(a, 0), error);
  else if (op == "advance") {
    Vec<Str> releases;
    if (!perf->advance(num_arg(a, 0), releases, error)) return fail(error);
    Value o = Value::new_object();
    o.set("snapshot", perf->snapshot());
    Value r = Value::new_array();
    for (const auto& x : releases) r.push(Value::of(x));
    o.set("releases", xmp::move(r));
    return answer(o);
  } else if (op == "window") {
    Value window;
    if (!xmp::play::performance_window(*perf, num_arg(a, 0), flag(arg(a, 1)), num_arg(a, 2), num_arg(a, 3), window, error))
      return fail(error);
    Vec<xmp::render::Command> list;
    if (!xmp::render::performance_commands(window, perf->project(), num_arg(a, 3), list, error)) return fail(error);
    Value o = Value::new_object();
    o.set("window", xmp::move(window)), o.set("commands", commands_json(list));
    return answer(o);
  } else if (op == "snapshot") {
    return answer(perf->snapshot());
  } else if (op == "values") {
    Value out;
    if (!xmp::play::performance_values(*perf, num_arg(a, 0), out, error)) return fail(error);
    return answer(out);
  } else if (op != "state")
    return fail(Str("Unknown command ") + op);
  if (!ok) return fail(error);
  return answer(perf_state(*perf));
}
// performanceControls [position, overrides as [key, value] pairs] of project `handle` (stateless).
EXPORT(xp_controls) int32_t xp_controls(int32_t handle, const char* text, int32_t size) {
  const Value* p = get(handle);
  if (!p) return fail("No project");
  const auto c = xmp::json::parse(text, static_cast<size_t>(size < 0 ? 0 : size));
  if (!c.ok) return fail(c.error);
  const Value& a = c.value.get("args") ? *c.value.get("args") : Value();
  xmp::play::Overrides o;
  for (const auto& e : arg(a, 1).items())
    if (e.is_array() && e.items().size() == 2) o.set(str_of(e.items()[0]), e.items()[1]);
  Value out;
  Str error;
  if (!xmp::play::performance_controls(*p, num_arg(a, 0), o, out, error)) return fail(error);
  return answer(out);
}
