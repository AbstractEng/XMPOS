#pragma once
// XMP's project model in C++: opening a project file as packages/core does
// (index.ts parseProject): the import preflight (input.ts), the schemas of
// every project version (1 to 8) with XMP's own reference and budget checks,
// the built-in machines' state checks, and migration to version 8. The result
// is the canonical project document, with the same keys, order and numbers as
// the TypeScript's ProjectSchema.parse output, so JSON.stringify of either is
// byte-identical. tests/parity/project-parity.test.ts runs both.
//
// Decisions match the TypeScript exactly. Messages: the preflight, version and
// XMP's own checks use the TypeScript's words; for structural problems (zod's
// messages, which list every issue) the C++ names the first problem instead.
//
// Machines added through the SDK are JavaScript and unknown here: like the
// TypeScript when such a machine is not installed, their state is checked only
// against the generic bounds.
#include "xmp/project_schema.hpp"
#include "xmp/project_extensions.hpp"
#include "xmp/project_limits.hpp"

namespace xmp::project {

using json::Value;
using schema::Builder;
using schema::Node;
using schema::Text;

constexpr int32_t kMaxSamples = 256;
constexpr int32_t kMaxSampleFrames = 2000000;
constexpr size_t kMaxProjectBytes = 24 * 1024 * 1024;

struct Result {
  bool ok = false;
  Value project;   // canonical version 8 document
  Str error;       // the message, as parseProject's
  bool migrated = false;
};

// ---- the import preflight (input.ts preflightProjectText), over UTF-16 units ----
inline bool preflight(const char* text, size_t bytes, Str& error, size_t max_bytes = kMaxProjectBytes) {
  // JavaScript's text.length first (UTF-16 units), then the UTF-8 size.
  size_t units = 0;
  for (size_t i = 0; i < bytes; ++i) {
    const auto c = static_cast<uint8_t>(text[i]);
    if ((c & 0xC0) != 0x80) units += c >= 0xF0 ? 2 : 1;
  }
  if (units > max_bytes) return error = max_bytes == kMaxProjectBytes ? "Project exceeds 24 MiB" : "Song exceeds 96 MiB", false;
  bool quoted = false, escaped = false;
  int64_t string_length = 0, depth = 0, objects = 0, arrays = 0, separators = 0, properties = 0, word = 0;
  for (size_t i = 0; i < bytes; ++i) {
    const auto c = static_cast<uint8_t>(text[i]);
    if ((c & 0xC0) == 0x80) continue;  // continuation bytes belong to the unit counted at the lead byte
    const int64_t width = c >= 0xF0 ? 2 : 1;
    if (quoted) {
      for (int64_t k = 0; k < width; ++k) {
        if (++string_length > 1024) return error = "Project string budget exceeded", false;
        if (k == 0) {
          if (escaped)
            escaped = false;
          else if (c == '\\')
            escaped = true;
          else if (c == '"')
            quoted = false;
        } else if (escaped)
          escaped = false;
      }
      continue;
    }
    if (c == '"') {
      quoted = true;
      string_length = 0;
      word = 0;
      continue;
    }
    if (c == '{' || c == '[') {
      ++depth;
      if (c == '{')
        ++objects;
      else
        ++arrays;
    }
    if (c == '}' || c == ']') --depth;
    if (c == ',') ++separators;
    if (c == ':') ++properties;
    const bool word_char =
        c < 0x80 && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.' ||
                     c == '+' || c == '-');
    // A 4-byte character is two units, neither a word character.
    word = word_char ? word + 1 : 0;
    if (depth > 32 || objects > 150000 || arrays > 1024 || separators > kMaxSampleFrames + 1000000 || properties > 800000 || word > 128)
      return error = "Project structure exceeds import budget", false;
  }
  if (bytes > max_bytes) return error = max_bytes == kMaxProjectBytes ? "Project exceeds 24 MiB" : "Song exceeds 96 MiB", false;
  return true;
}

// ---- the schemas ----
struct Schemas {
  Builder b;
  const Node *v1, *v2, *v3, *v4, *v5, *v6, *v7, *v8;
  const Node *synth_patch, *midi_state, *sampler_state;

  Schemas() {
    const Node* id = b.pattern(Text::id);
    const Node* unit = b.unit();
    const Node* signed_unit = b.number(-1, 1);
    const Node* parameter = b.pattern(Text::parameter_id);
    auto name = [&](int64_t max) { return b.text(1, max); };
    auto strict = [&]() -> Node& { return b.object(); };
    using schema::field;

    // StepSchema
    Node& step = strict();
    field(step, "step", b.integer(0, 63));
    field(step, "pad", b.integer(0, 15));
    field(step, "velocity", unit);
    field(step, "probability", unit);
    // The legacy shape (version 1)
    Node& pad1 = strict();
    field(pad1, "id", id), field(pad1, "name", name(40)), field(pad1, "sampleId", id);
    Node& sample = strict();
    field(sample, "id", id), field(sample, "name", name(120)), field(sample, "sampleRate", b.integer(8000, 96000));
    field(sample, "pcm", b.array(b.number(-1, 1), 1, 480000));
    static const double kLengths[] = {16, 32, 64};
    Node& clip1 = strict();
    field(clip1, "id", id), field(clip1, "name", name(40)), field(clip1, "length", b.number_choice(kLengths, 3));
    field(clip1, "steps", b.array(&step, 0, 1024));
    Node& track1 = strict();
    field(track1, "id", id), field(track1, "name", name(40)), field(track1, "muted", b.boolean());
    field(track1, "volume", unit), field(track1, "clips", b.array(&clip1, 1, 16));
    Node& scene = strict();
    field(scene, "id", id), field(scene, "name", name(40)), field(scene, "clips", b.record(id, id));
    Node& legacy = strict();
    field(legacy, "format", b.literal("xmp-project"));
    field(legacy, "version", b.literal(1));
    field(legacy, "id", id);
    field(legacy, "name", name(80));
    field(legacy, "bpm", b.number(30, 300));
    field(legacy, "swing", b.number(0, 0.5));
    field(legacy, "master", unit);
    field(legacy, "pads", b.array(&pad1, 16, 16));
    field(legacy, "samples", b.array(&sample, 1, 16));
    field(legacy, "tracks", b.array(&track1, 1, 8));
    field(legacy, "scenes", b.array(&scene, 1, 16));
    v1 = &legacy;

    // Version 2
    Node& assignment = strict();
    field(assignment, "id", parameter), field(assignment, "base", unit);
    field(assignment, "automation", unit, true), field(assignment, "stepLock", unit, true);
    field(assignment, "macro", signed_unit, true), field(assignment, "lfo", signed_unit, true);
    Node& slice = strict();
    {
      Node& start = b.make(Node::number);
      start.integer = true, start.has_min = true, start.min = 0;
      Node& end = b.make(Node::number);
      end.integer = true, end.has_min = true, end.min = 1;
      field(slice, "start", &start), field(slice, "end", &end);
    }
    Node& pad2 = strict();
    field(pad2, "id", id), field(pad2, "name", name(40)), field(pad2, "sampleId", id), field(pad2, "slice", &slice, true);
    Node& shape2 = b.extend(legacy);
    field(shape2, "version", b.literal(2));
    field(shape2, "seed", b.integer(0, 4294967295.0));
    field(shape2, "parameterVersion", b.literal(1));
    field(shape2, "parameters", b.array(&assignment, 0, 145));
    field(shape2, "pads", b.array(&pad2, 16, 16));
    v2 = &shape2;

    // Version 3: instruments on pads, machines on tracks, notes on steps.
    static const char* kModes[] = {"one-shot", "gate", "loop", "chromatic"};
    Node& playback = strict();
    field(playback, "mode", b.choice(kModes, 4)), field(playback, "rootNote", b.integer(0, 127));
    field(playback, "chokeGroup", b.integer(0, 8));
    Node& edit = strict();
    field(edit, "reverse", b.boolean()), field(edit, "normalize", b.boolean());
    Node& pad3 = b.extend(pad2);
    field(pad3, "playback", &playback, true), field(pad3, "edit", &edit, true);
    static const char* kBases[] = {"audio", "midi"};
    Node& machine = strict();
    field(machine, "id", b.pattern(Text::machine_id)), field(machine, "base", b.choice(kBases, 2));
    field(machine, "version", b.integer(1, 1000)), field(machine, "state", b.record(nullptr, b.unknown()));
    machine_node = &machine;
    Node& step3 = b.extend(step);
    field(step3, "step", b.integer(0, 1023));
    field(step3, "note", b.integer(0, 127), true), field(step3, "duration", b.number(0.0625, 64), true);
    Node& clip3 = b.extend(clip1);
    field(clip3, "length", b.integer(1, 1024));
    field(clip3, "steps", b.array(&step3, 0, 1024));
    Node& track3 = b.extend(track1);
    field(track3, "machine", &machine, true), field(track3, "clips", b.array(&clip3, 0, 16));
    Node& shape3 = b.extend(shape2);
    field(shape3, "version", b.literal(3));
    field(shape3, "pads", b.array(&pad3, 16, 16));
    field(shape3, "tracks", b.array(&track3, 1, 8));
    v3 = &shape3;

    // Version 4: clip sequences.
    const Node* position = b.number(0, 1024);
    const Node* duration = b.number(1.0 / 960, 64);
    static const char* kConditions[] = {"always", "first", "not-first", "fill", "not-fill", "every-2", "every-4"};
    Node& original = strict();
    field(original, "position", position), field(original, "duration", duration), field(original, "velocity", unit);
    field(original, "timestamp", b.number(0, 86400));
    Node& note = strict();
    field(note, "id", id), field(note, "pad", b.integer(0, 15)), field(note, "note", b.integer(0, 127));
    field(note, "position", position), field(note, "duration", duration), field(note, "velocity", unit);
    field(note, "probability", unit), field(note, "microtiming", b.number(-0.49, 0.49));
    field(note, "condition", b.choice(kConditions, 7)), field(note, "original", &original, true);
    Node& lock = strict();
    field(lock, "position", b.integer(0, 1023)), field(lock, "parameter", parameter), field(lock, "value", unit);
    Node& point = strict();
    field(point, "position", position), field(point, "value", unit);
    Node& lane = strict();
    field(lane, "parameter", parameter), field(lane, "points", b.array(&point, 0, 256));
    static const char* kModKinds[] = {"macro", "lfo"};
    Node& mod = strict();
    field(mod, "id", b.pattern(Text::id32)), field(mod, "parameter", parameter), field(mod, "kind", b.choice(kModKinds, 2));
    field(mod, "amount", signed_unit), field(mod, "cycles", b.number(0.0625, 16)), field(mod, "phase", unit);
    Node& sequence = strict();
    field(sequence, "version", b.literal(1));
    field(sequence, "notes", b.array(&note, 0, 1024));
    field(sequence, "locks", b.array(&lock, 0, 256));
    field(sequence, "lanes", b.array(&lane, 0, 32));
    field(sequence, "modulations", b.array(&mod, 0, 16));
    Node& clip4 = b.extend(clip3);
    field(clip4, "sequence", &sequence, true);
    Node& track4 = b.extend(track3);
    field(track4, "clips", b.array(&clip4, 0, 16));
    Node& shape4 = b.extend(shape3);
    field(shape4, "version", b.literal(4));
    field(shape4, "tracks", b.array(&track4, 1, 8));
    v4 = &shape4;

    // Version 5: the performance.
    const Node* at = b.number(0, 65535);
    Node& chain = strict();
    field(chain, "id", id), field(chain, "sceneId", id), field(chain, "repeats", b.integer(1, 16));
    static const char* kEnds[] = {"stop", "loop"};
    Node& macro_assignment = strict();
    field(macro_assignment, "parameter", parameter), field(macro_assignment, "amount", signed_unit);
    Node& macro = strict();
    field(macro, "id", id), field(macro, "name", name(40)), field(macro, "value", unit);
    field(macro, "assignments", b.array(&macro_assignment, 0, 16));
    Node& mute = strict();
    field(mute, "id", id), field(mute, "at", at), field(mute, "kind", b.literal("mute")), field(mute, "trackId", id);
    field(mute, "value", b.boolean());
    Node& solo = b.extend(mute);
    field(solo, "kind", b.literal("solo"));
    Node& macro_event = strict();
    field(macro_event, "id", id), field(macro_event, "at", at), field(macro_event, "kind", b.literal("macro"));
    field(macro_event, "macroId", id), field(macro_event, "value", unit);
    Node& event = b.variant("kind");
    event.options.push(Value::of("mute")), event.items.push(&mute);
    event.options.push(Value::of("solo")), event.items.push(&solo);
    event.options.push(Value::of("macro")), event.items.push(&macro_event);
    performance_event = &event;
    Node& selection = strict();
    field(selection, "sceneId", id), field(selection, "clips", b.record(id, id));
    Node& song_position = strict();
    field(song_position, "occurrenceId", id), field(song_position, "offset", b.integer(0, 1023));
    Node& delay = strict();
    field(delay, "steps", b.number(0.25, 8)), field(delay, "feedback", b.number(0, 0.75)), field(delay, "wet", unit);
    field(delay, "sends", b.record(id, unit));
    Node& performance = strict();
    field(performance, "version", b.literal(1));
    field(performance, "chain", b.array(&chain, 0, 64));
    field(performance, "end", b.choice(kEnds, 2));
    field(performance, "launchQuantize", b.number(0, 64), true);
    field(performance, "macros", b.array(&macro, 0, 8));
    field(performance, "mutes", b.record(id, b.boolean()));
    field(performance, "solos", b.array(id, 0, 8));
    field(performance, "events", b.array(&event, 0, 2048));
    field(performance, "selection", &selection, true);
    field(performance, "position", &song_position, true);
    field(performance, "delay", &delay);
    Node& shape5 = b.extend(shape4);
    field(shape5, "version", b.literal(5));
    field(shape5, "performance", &performance, true);
    v5 = &shape5;

    // Version 6: the mix.
    static const char* kEffects[] = {"eq", "filter", "delay", "reverb", "distortion", "compressor"};
    Node& sync = strict();
    field(sync, "division", b.number(0.25, 8)), field(sync, "sequence", b.array(unit, 1, 16));
    field(sync, "phase", b.literal("transport")), field(sync, "loss", b.literal("hold-last-tempo"));
    Node& effect = strict();
    field(effect, "id", id), field(effect, "kind", b.choice(kEffects, 6)), field(effect, "bypass", b.boolean());
    field(effect, "params", b.record(b.text(0, 16), unit)), field(effect, "sync", &sync, true);
    const Node* inserts = b.array(&effect, 0, 2);
    Node& strip = strict();
    field(strip, "pan", unit), field(strip, "sends", b.tuple2(unit, unit)), field(strip, "inserts", inserts);
    Node& tempo = strict();
    {
      Node& s = b.make(Node::number);
      s.integer = true, s.has_min = s.has_max = true, s.min = 16, s.max = 65520, s.multiple = 16;
      field(tempo, "step", &s), field(tempo, "bpm", b.number(30, 300));
    }
    Node& mix = strict();
    field(mix, "version", b.literal(1));
    field(mix, "tracks", b.record(id, &strip));
    field(mix, "returns", b.tuple2(inserts, inserts));
    field(mix, "tempos", b.array(&tempo, 0, 64));
    Node& shape6 = b.extend(shape5);
    field(shape6, "version", b.literal(6));
    field(shape6, "parameters", b.array(&assignment, 0, 512));
    field(shape6, "mix", &mix, true);
    v6 = &shape6;

    // Version 7: a track may hold its own kit of 16 pads.
    Node& track7 = b.extend(track4);
    field(track7, "pads", b.array(&pad3, 16, 16), true);
    Node& shape7 = b.extend(shape6);
    field(shape7, "version", b.literal(7));
    field(shape7, "samples", b.array(&sample, 1, kMaxSamples));
    field(shape7, "tracks", b.array(&track7, 1, 8));
    v7 = &shape7;

    // Version 8: a pad may be multi-sampled, with velocity layers of round-robin takes.
    Node& layer = strict();
    field(layer, "upTo", unit), field(layer, "samples", b.array(id, 1, 8));
    Node& pad8 = b.extend(pad3);
    field(pad8, "layers", b.array(&layer, 1, 8), true);
    Node& track8 = b.extend(track7);
    field(track8, "pads", b.array(&pad8, 16, 16), true);
    Node& shape8 = b.extend(shape7);
    field(shape8, "version", b.literal(8));
    field(shape8, "extensions", b.unknown(), true);
    Node& sample8 = b.extend(sample);
    field(sample8, "pcm", b.array(b.number(-1, 1), 1, project_limits::kLoopSampleFrames));
    field(shape8, "samples", b.array(&sample8, 1, kMaxSamples));
    field(shape8, "pads", b.array(&pad8, 16, 16));
    field(shape8, "tracks", b.array(&track8, 1, 8));
    v8 = &shape8;

    // The built-in machines' states (machines.ts).
    static const char* kOscillators[] = {"sine", "saw", "square"};
    Node& patch = strict();
    field(patch, "name", name(80)), field(patch, "oscillator", b.choice(kOscillators, 3));
    field(patch, "attack", b.number(0.001, 2)), field(patch, "decay", b.number(0.001, 2));
    field(patch, "sustain", unit), field(patch, "release", b.number(0.005, 2)), field(patch, "cutoff", b.number(30, 16000));
    // Later, optional: resonance, the filter envelope, a detuned second oscillator and glide.
    field(patch, "resonance", unit, true), field(patch, "env-amount", b.number(0, 6), true);
    field(patch, "env-decay", b.number(0.01, 2), true), field(patch, "detune", b.number(0, 50), true);
    field(patch, "glide", b.number(0, 1), true);
    synth_patch = &patch;
    Node& midi = strict();
    field(midi, "channel", b.integer(1, 16)), field(midi, "destination", id, true);
    midi_state = &midi;
    // A Kit has no state; a Sampler says how its sample plays: across the pads
    // as notes ("keys") or chopped into slices on the pads ("slices").
    static const char* kSamplerModes[] = {"keys", "slices"};
    Node& sampler = strict();
    field(sampler, "mode", b.choice(kSamplerModes, 2), true);
    sampler_state = &sampler;
  }
  const Node* machine_node = nullptr;
  const Node* performance_event = nullptr;  // PerformanceEventSchema
};

inline const Schemas& schemas() {
  static const Schemas s;
  return s;
}

// ---- helpers over the document ----
namespace detail {
inline const Value& at(const Value& v, const char* key) {
  static const Value none;
  const Value* p = v.get(key);
  return p ? *p : none;
}
inline const Str& str(const Value& v, const char* key) { return at(v, key).as_string(); }
inline double num(const Value& v, const char* key) { return at(v, key).as_number(); }
inline const Vec<Value>& list(const Value& v, const char* key) { return at(v, key).items(); }
// Project format 7: the 16 pads a track plays, its own kit else the project's.
inline const Vec<Value>& track_pads(const Value& project, const Value* track) {
  if (track)
    if (const Value* own = track->get("pads")) return own->items();
  return list(project, "pads");
}
inline const Value* track_by_id(const Value& project, const Str& id) {
  for (const auto& t : list(project, "tracks"))
    if (str(t, "id") == id) return &t;
  return nullptr;
}
inline bool contains(const Vec<Str>& set, const Str& s) {
  for (const auto& x : set)
    if (x == s) return true;
  return false;
}
inline bool all_unique(const Vec<Str>& keys) {
  for (int32_t i = 0; i < keys.size(); ++i)
    for (int32_t k = i + 1; k < keys.size(); ++k)
      if (keys[i] == keys[k]) return false;
  return true;
}
inline Vec<Str> ids_of(const Vec<Value>& items, const char* key = "id") {
  Vec<Str> out;
  for (const auto& i : items) out.push(str(i, key));
  return out;
}
inline const Value* find_by_id(const Vec<Value>& items, const Str& id) {
  for (const auto& i : items)
    if (str(i, "id") == id) return &i;
  return nullptr;
}

// mix.ts mixParameterBase: the base value of a mix parameter, if `id` is one.
inline bool mix_parameter_base(const Value& project, const Str& id, double& out) {
  const Value* mix = project.get("mix");
  if (!mix) return false;
  const Value& tracks = at(*mix, "tracks");
  for (const auto& t : list(project, "tracks")) {
    const Str& tid = str(t, "id");
    const Value* strip = tracks.get(tid.c_str());
    if (id == Str("track.") + tid + ".pan") return out = strip ? num(*strip, "pan") : 0.5, true;
    for (int32_t i = 0; i < 2; ++i)
      if (id == Str("track.") + tid + ".send." + int_text(i))
        return out = strip ? list(*strip, "sends")[i].as_number() : 0, true;
  }
  // mixEffects: the strips' inserts in record order, then the returns'.
  auto effects = [&](const Str& prefix, const Value& effect) {
    if (id == prefix + "." + str(effect, "id") + ".bypass") return out = at(effect, "bypass").as_bool() ? 1 : 0, true;
    for (const auto& p : at(effect, "params").members())
      if (id == prefix + "." + str(effect, "id") + "." + p.key) return out = p.value.as_number(), true;
    return false;
  };
  for (const auto& strip : tracks.members())
    for (const auto& e : list(strip.value, "inserts"))
      if (effects(Str("track.") + strip.key + ".insert", e)) return true;
  const auto& returns = list(*mix, "returns");
  for (int32_t r = 0; r < returns.size(); ++r)
    for (const auto& e : returns[r].items())
      if (effects(Str("return.") + int_text(r) + ".insert", e)) return true;
  return false;
}

// machines.ts boundedState over the JSON values a project can hold.
inline bool bounded(const Value& v, int32_t depth, int32_t& nodes) {
  if (++nodes > 512 || depth > 5) return false;
  switch (v.kind()) {
    case Value::null:
    case Value::boolean: return true;
    case Value::number: return isfinite(v.as_number());
    case Value::string: return v.as_string().utf16_length() <= 256;
    case Value::array:
      if (v.items().size() > 64) return false;
      for (const auto& i : v.items())
        if (!bounded(i, depth + 1, nodes)) return false;
      return true;
    case Value::object:
      if (v.members().size() > 32) return false;
      for (const auto& m : v.members())
        if (m.key.utf16_length() > 64 || m.key == "__proto__" || m.key == "constructor" || m.key == "prototype" ||
            !bounded(m.value, depth + 1, nodes))
          return false;
      return true;
  }
  return false;
}
}  // namespace detail

// XMP's own checks (the superRefine functions), collected as messages.
class Rules {
 public:
  Vec<Str> issues;
  Str thrown;  // a machine state that its machine refused (thrown in the TypeScript)

  void issue(const char* message) { issues.push(Str(message)); }
  void issue(const Str& message) { issues.push(message); }

  // validateReferences (version 1 onwards)
  void references(const Value& p) {
    using namespace detail;
    auto unique = [&](const Vec<Value>& items, const char* label) {
      if (!all_unique(ids_of(items))) issue(Str("Duplicate ") + label + " id");
    };
    unique(list(p, "pads"), "pad");
    unique(list(p, "samples"), "sample");
    unique(list(p, "tracks"), "track");
    unique(list(p, "scenes"), "scene");
    double frames = 0;
    for (const auto& s : list(p, "samples")) frames += list(s, "pcm").size();
    if (frames > project_limits::total_frames(p)) issue(project_limits::extended(p) ?
        "Sample budget exceeds extended profile" : "Project audio exceeds two million mono frames");
    for (const auto& s : list(p, "samples"))
      if (list(s, "pcm").size() > project_limits::sample_frames(p)) issue("Sample exceeds portable profile bounds");
    const Vec<Str> samples = ids_of(list(p, "samples"));
    for (const auto& pad : list(p, "pads"))
      if (!contains(samples, str(pad, "sampleId"))) issue(Str("Missing sample ") + str(pad, "sampleId"));
    for (const auto& track : list(p, "tracks")) {
      unique(list(track, "clips"), "clip");
      for (const auto& clip : list(track, "clips")) {
        Vec<Str> keys;
        for (const auto& step : list(clip, "steps")) {
          if (num(step, "step") >= num(clip, "length")) issue("Step exceeds clip length");
          const Str key = json::number_text(num(step, "pad")) + ":" + json::number_text(num(step, "step"));
          if (contains(keys, key)) issue("Duplicate pad event at step");
          keys.push(key);
        }
      }
    }
    for (const auto& scene : list(p, "scenes"))
      for (const auto& m : at(scene, "clips").members()) {
        const Value* track = find_by_id(list(p, "tracks"), m.key);
        if (!track || !find_by_id(list(*track, "clips"), m.value.as_string()))
          issue("Scene references a missing track or clip");
      }
  }
  // validateV2
  void v2(const Value& p) {
    using namespace detail;
    references(p);
    Vec<Str> seen;
    for (const auto& a : list(p, "parameters")) {
      const Str& id = str(a, "id");
      if (contains(seen, id)) issue("Duplicate parameter assignment");
      seen.push(id);
      const Value* track = nullptr;
      for (const auto& t : list(p, "tracks"))
        if (id == Str("track.") + str(t, "id") + ".gain" || id == Str("track.") + str(t, "id") + ".effect.gain") {
          track = &t;
          break;
        }
      bool machine = false;
      for (const auto& t : list(p, "tracks")) machine = machine || id.starts_with(Str("track.") + str(t, "id") + ".machine.");
      double base = 0;
      if (id != "master.gain" && !track && !machine && !mix_parameter_base(p, id, base))
        issue(Str("Unknown parameter ") + id);
      if (id == "master.gain" && num(a, "base") != num(p, "master")) issue("Master parameter base differs from master gain");
      if (track && id == Str("track.") + str(*track, "id") + ".gain" && num(a, "base") != num(*track, "volume"))
        issue("Track parameter base differs from volume");
    }
    double events = 0;
    for (const auto& t : list(p, "tracks"))
      for (const auto& c : list(t, "clips")) events += list(c, "steps").size();
    if (events > 8192) issue("Project exceeds 131072 events");
    for (const auto& pad : list(p, "pads")) {
      const Value* slice = pad.get("slice");
      if (!slice) continue;
      const Value* sample = find_by_id(list(p, "samples"), str(pad, "sampleId"));
      if (!sample || num(*slice, "start") >= num(*slice, "end") || num(*slice, "end") > list(*sample, "pcm").size())
        issue("Sample slice lies outside its asset");
    }
  }
  // validateV3: plus each track's machine (its generic bounds, then its own checks).
  void v3(const Value& p) {
    using namespace detail;
    v2(p);
    for (const auto& t : list(p, "tracks")) {
      const Value* m = t.get("machine");
      if (!m || !thrown.empty()) continue;
      const Str& id = str(*m, "id");
      const Str& base = str(*m, "base");
      const double version = num(*m, "version");
      const Node* state = nullptr;
      if (id == "xmp.sampler" && base == "audio" && version == 1) state = schemas().sampler_state;
      if (id == "xmp.subtractive" && base == "audio" && version == 1) state = schemas().synth_patch;
      if (id == "xmp.midi" && base == "midi" && version == 1) state = schemas().midi_state;
      if (!state) continue;  // not installed (or another version): accepted, as in the TypeScript
      schema::Checker c;
      Value ignored;
      if (!c.check(*state, at(*m, "state"), ignored, Str("machine state"))) thrown = c.problem;
    }
  }
  // validateV4
  void v4(const Value& p) {
    using namespace detail;
    v3(p);
    double count = 0;
    for (const auto& t : list(p, "tracks"))
      for (const auto& clip : list(t, "clips")) {
        const Value* seq = clip.get("sequence");
        if (!seq) continue;
        const double length = num(clip, "length");
        count += list(*seq, "notes").size();
        bool outside = false;
        for (const auto& n : list(*seq, "notes"))
          outside = outside || num(n, "position") >= length || num(n, "position") + num(n, "duration") > length + 1e-8;
        for (const auto& l : list(*seq, "locks")) outside = outside || num(l, "position") >= length;
        for (const auto& l : list(*seq, "lanes"))
          for (const auto& pt : list(l, "points")) outside = outside || num(pt, "position") > length;
        if (outside) issue("Sequence event exceeds clip boundary");
        const Str own = Str("track.") + str(t, "id") + ".";
        static const char* kGroups[] = {"locks", "lanes", "modulations"};
        for (const char* group : kGroups)
          for (const auto& target : list(*seq, group)) {
            const Str& parameter = str(target, "parameter");
            if (parameter != "master.gain" && !parameter.starts_with("return.") && !parameter.starts_with(own))
              issue("Sequence parameter belongs to another track");
          }
      }
    if (count > 8192) issue("Sequence note budget exceeded");
  }
  // validateV5
  void v5(const Value& p) {
    using namespace detail;
    v4(p);
    const Value* perf = p.get("performance");
    if (!perf) return;
    const Vec<Str> tracks = ids_of(list(p, "tracks")), scenes = ids_of(list(p, "scenes"));
    for (const auto& e : list(*perf, "chain"))
      if (!contains(scenes, str(e, "sceneId"))) issue("Song occurrence references a missing scene");
    bool missing = false;
    for (const auto& m : at(*perf, "mutes").members()) missing = missing || !contains(tracks, m.key);
    for (const auto& s : list(*perf, "solos")) missing = missing || !contains(tracks, s.as_string());
    for (const auto& m : at(at(*perf, "delay"), "sends").members()) missing = missing || !contains(tracks, m.key);
    if (missing) issue("Performance references a missing track");
    for (const auto& m : list(*perf, "macros"))
      for (const auto& a : list(m, "assignments")) {
        const Str& parameter = str(a, "parameter");
        bool track = false;
        for (const auto& t : tracks) track = track || parameter.starts_with(Str("track.") + t + ".");
        if (parameter != "master.gain" && !parameter.starts_with("return.") && !track)
          issue("Macro references a missing track");
      }
    for (const auto& e : list(*perf, "events")) {
      const bool ok = str(e, "kind") == "macro" ? find_by_id(list(*perf, "macros"), str(e, "macroId")) != nullptr
                                                 : contains(tracks, str(e, "trackId"));
      if (!ok) issue("Performance event references a missing target");
    }
    if (const Value* sel = perf->get("selection")) {
      if (!contains(scenes, str(*sel, "sceneId"))) issue("Missing performance scene");
      for (const auto& m : at(*sel, "clips").members()) {
        const Value* t = find_by_id(list(p, "tracks"), m.key);
        if (!t || !find_by_id(list(*t, "clips"), m.value.as_string())) issue("Missing selected performance clip");
      }
    }
    if (const Value* pos = perf->get("position")) {
      const Value* e = find_by_id(list(*perf, "chain"), str(*pos, "occurrenceId"));
      if (!e)
        issue("Missing song position occurrence");
      else {
        const Value* scene = find_by_id(list(p, "scenes"), str(*e, "sceneId"));
        double length = 16;
        for (const auto& t : list(p, "tracks")) {
          double l = 16;
          if (scene)
            if (const Value* cid = at(*scene, "clips").get(str(t, "id").c_str()))
              if (const Value* c = find_by_id(list(t, "clips"), cid->as_string())) l = num(*c, "length");
          length = fmax(length, l);
        }
        if (num(*pos, "offset") >= length * num(*e, "repeats")) issue("Song position exceeds occurrence");
      }
    }
  }
  // ProjectSchema's own check, after validateV5
  void v6(const Value& p) {
    using namespace detail;
    v5(p);
    if (const Value* mix = p.get("mix")) {
      const Vec<Str> tracks = ids_of(list(p, "tracks"));
      for (const auto& m : at(*mix, "tracks").members())
        if (!contains(tracks, m.key)) issue("Mix references missing track");
    }
  }
  // ProjectSchema's own check (version 7): each track's own kit.
  void v7(const Value& p) {
    using namespace detail;
    v6(p);
    for (const auto& t : list(p, "tracks")) {
      const Value* pads = t.get("pads");
      if (!pads) continue;
      if (!all_unique(ids_of(pads->items()))) issue("Duplicate pad id");
      for (const auto& pad : pads->items()) {
        const Value* sample = find_by_id(list(p, "samples"), str(pad, "sampleId"));
        const Value* slice = pad.get("slice");
        if (!sample)
          issue(Str("Missing sample ") + str(pad, "sampleId"));
        else if (slice &&
                 (num(*slice, "start") >= num(*slice, "end") || num(*slice, "end") > list(*sample, "pcm").size()))
          issue("Sample slice lies outside its asset");
      }
    }
  }
  // ProjectSchema's own check (version 8): each layered pad's layers.
  void v8(const Value& p) {
    using namespace detail;
    v7(p);
    const Vec<Str> samples = ids_of(list(p, "samples"));
    auto check = [&](const Value& pad) {
      const Value* layers = pad.get("layers");
      if (!layers) return;
      if (pad.get("slice")) issue("A layered pad has no slice");
      double top = 0;
      for (const auto& layer : layers->items()) {
        if (!(num(layer, "upTo") > top)) issue("Pad layers must rise in velocity");
        top = num(layer, "upTo");
        for (const auto& id : list(layer, "samples"))
          if (!contains(samples, id.as_string())) issue(Str("Missing sample ") + id.as_string());
      }
      if (top != 1) issue("A pad's last layer must reach full velocity");
    };
    for (const auto& pad : list(p, "pads")) check(pad);
    for (const auto& t : list(p, "tracks"))
      if (const Value* pads = t.get("pads"))
        for (const auto& pad : pads->items()) check(pad);
  }
  // The nested schemas' own checks (sequence, performance, mix, effects, machine bounds).
  void nested(const Value& p) {
    using namespace detail;
    for (const auto& t : list(p, "tracks")) {
      if (const Value* m = t.get("machine")) {
        int32_t nodes = 0;
        if (!bounded(at(*m, "state"), 0, nodes)) issue("Machine state exceeds JSON limits");
      }
      for (const auto& clip : list(t, "clips")) {
        const Value* seq = clip.get("sequence");
        if (!seq) continue;
        if (!all_unique(ids_of(list(*seq, "notes")))) issue("Duplicate note ID");
        if (!all_unique(ids_of(list(*seq, "lanes"), "parameter"))) issue("Duplicate automation lane");
        Vec<Str> locks;
        for (const auto& l : list(*seq, "locks"))
          locks.push(json::number_text(num(l, "position")) + ":" + str(l, "parameter"));
        if (!all_unique(locks)) issue("Duplicate lock");
        if (!all_unique(ids_of(list(*seq, "modulations")))) issue("Duplicate modulation ID");
        for (const auto& lane : list(*seq, "lanes")) {
          const auto& pts = list(lane, "points");
          for (int32_t i = 1; i < pts.size(); ++i)
            if (num(pts[i], "position") <= num(pts[i - 1], "position")) {
              issue("Automation points must be strictly ordered");
              break;
            }
        }
      }
    }
    if (const Value* perf = p.get("performance")) {
      if (const Value* q = perf->get("launchQuantize")) {
        const double v = q->as_number();
        if (v != 0 && v != 4 && v != 16 && v != 32 && v != 64) issue("Invalid launch quantize");
      }
      if (!all_unique(ids_of(list(*perf, "chain")))) issue("Duplicate song occurrence");
      if (!all_unique(ids_of(list(*perf, "macros")))) issue("Duplicate macro");
      if (!all_unique(ids_of(list(*perf, "events")))) issue("Duplicate performance event");
      Vec<Str> solos;
      for (const auto& s : list(*perf, "solos")) solos.push(s.as_string());
      if (!all_unique(solos)) issue("Duplicate solo track");
      for (const auto& m : list(*perf, "macros"))
        if (!all_unique(ids_of(list(m, "assignments"), "parameter"))) issue("Duplicate macro assignment");
      if (at(*perf, "mutes").members().size() > 8 || at(at(*perf, "delay"), "sends").members().size() > 8)
        issue("Performance track budget exceeded");
      const auto& events = list(*perf, "events");
      for (int32_t i = 1; i < events.size(); ++i)
        if (num(events[i], "at") < num(events[i - 1], "at")) {
          issue("Performance events must be ordered");
          break;
        }
    }
    if (const Value* mix = p.get("mix")) {
      if (at(*mix, "tracks").members().size() > 8) issue("Invalid input");  // zod's words for that refine
      Vec<Str> effect_ids;
      auto effect = [&](const Value& e) {
        effect_ids.push(str(e, "id"));
        static const char* kKeys[6][3] = {{"tone", "gain", nullptr},     {"cutoff", nullptr, nullptr},
                                          {"time", "feedback", "wet"},   {"decay", "wet", nullptr},
                                          {"drive", "wet", nullptr},     {"threshold", "ratio", "makeup"}};
        static const char* kKinds[6] = {"eq", "filter", "delay", "reverb", "distortion", "compressor"};
        int32_t k = 0;
        while (k < 6 && str(e, "kind") != kKinds[k]) ++k;
        const Value& params = at(e, "params");
        int32_t expected = 0;
        bool all = true;
        for (int32_t i = 0; i < 3 && kKeys[k][i]; ++i, ++expected) all = all && params.has(kKeys[k][i]);
        if (params.members().size() != expected || !all) issue("Effect parameter set does not match its kind");
        if (e.has("sync") && k != 1 && k != 2) issue("Only filter and delay support clock sync");
      };
      for (const auto& strip : at(*mix, "tracks").members())
        for (const auto& e : list(strip.value, "inserts")) effect(e);
      for (const auto& r : list(*mix, "returns"))
        for (const auto& e : r.items()) effect(e);
      if (!all_unique(effect_ids)) issue("Effect IDs must be unique");
      const auto& tempos = list(*mix, "tempos");
      for (int32_t i = 1; i < tempos.size(); ++i)
        if (num(tempos[i], "step") <= num(tempos[i - 1], "step")) {
          issue("Tempo map must be strictly increasing");
          break;
        }
    }
  }
};

namespace detail {
// String(value), for the unsupported-version message.
inline Str js_string(const Value* v) {
  if (!v) return Str("undefined");
  switch (v->kind()) {
    case Value::null: return Str("null");
    case Value::boolean: return Str(v->as_bool() ? "true" : "false");
    case Value::number: {
      const double x = v->as_number();
      return isfinite(x) ? json::number_text(x) : Str(isnan(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity");
    }
    case Value::string: return v->as_string();
    case Value::array: {
      Str out;
      for (int32_t i = 0; i < v->items().size(); ++i) {
        if (i) out.push(',');
        const Value& item = v->items()[i];
        if (!item.is_null()) out += js_string(&item);
      }
      return out;
    }
    case Value::object: return Str("[object Object]");
  }
  return Str();
}
// One version's schema and checks: the canonical document or the first problem.
inline bool check_version(const Node& shape, int32_t version, const Value& input, Value& out, Str& error) {
  if (version == 8 && input.is_object())
    if (const Value* extra = input.get("extensions"))
      if (!extensions::validate(*extra, error)) return false;
  schema::Checker c;
  if (!c.check(shape, input, out, Str("project"))) return error = c.problem, false;
  Rules rules;
  // zod assigns a record's "__proto__" key: an object there becomes the machine
  // state's prototype, which the state's bounds then refuse.
  if (c.proto_objects) rules.issue("Machine state exceeds JSON limits");
  rules.nested(out);
  switch (version) {
    case 1: rules.references(out); break;
    case 2: rules.v2(out); break;
    case 3: rules.v3(out); break;
    case 4: rules.v4(out); break;
    case 5: rules.v5(out); break;
    case 6: rules.v6(out); break;
    case 7: rules.v7(out); break;
    default: rules.v8(out); break;
  }
  if (!rules.thrown.empty()) return error = rules.thrown, false;
  if (!rules.issues.empty()) return error = rules.issues[0], false;
  return true;
}
}  // namespace detail

constexpr int32_t kVersion = 8;

// ProjectSchema.parse of a current (version 8) document: true with its
// canonical form, or the first problem.
inline bool canonical(const Value& input, Value& out, Str& error) {
  return detail::check_version(*schemas().v8, kVersion, input, out, error);
}

// migrateProject: a parsed document of any supported version to version 8.
inline bool migrate(const Value& input, Value& out, Str& error) {
  const Schemas& s = schemas();
  if (!input.is_object() && !input.is_array()) return error = "Expected an XMP project object", false;
  const Value* version = input.is_object() ? input.get("version") : nullptr;
  const double v = version && version->is_number() ? version->as_number() : -1;
  if (v == kVersion) return detail::check_version(*s.v8, kVersion, input, out, error);
  const Node* shapes[] = {nullptr, s.v1, s.v2, s.v3, s.v4, s.v5, s.v6, s.v7};
  if (v >= 1 && v <= 7 && v == floor(v)) {
    Value older;
    if (!detail::check_version(*shapes[static_cast<int32_t>(v)], static_cast<int32_t>(v), input, older, error))
      return false;
    older.set("version", Value::of(static_cast<double>(kVersion)));
    if (v == 1) {
      older.set("seed", Value::of(0.0));
      older.set("parameterVersion", Value::of(1.0));
      older.set("parameters", Value::new_array());
    }
    return detail::check_version(*s.v8, kVersion, older, out, error);
  }
  return error = Str("Unsupported project version ") + detail::js_string(version) +
                 "; use a compatible XMP release. Current edits are unchanged.",
         false;
}

// parseProject / openProject: project text to the canonical version 8 document.
inline Result open(const char* text, size_t bytes) {
  Result r;
  if (!preflight(text, bytes, r.error, project_limits::kSongBytes)) return r;
  const auto parsed = json::parse(text, bytes);
  if (!parsed.ok) return r.error = Str("Could not open project: ") + parsed.error, r;
  if (bytes > kMaxProjectBytes && !project_limits::extended(parsed.value)) return r.error = "Project exceeds 24 MiB", r;
  Str error;
  if (!migrate(parsed.value, r.project, error)) return r.error = Str("Could not open project: ") + error, r;
  const Value* version = parsed.value.get("version");
  r.migrated = !(version && version->is_number() && version->as_number() == kVersion);
  r.ok = true;
  return r;
}
inline Result open(const Str& text) { return open(text.data(), text.size()); }

}  // namespace xmp::project
