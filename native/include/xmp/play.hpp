#pragma once
// Playing XMP projects in C++, part 1: the sequencer reading the project
// document directly. The C++ port of the layout in packages/core
// sequencer-engine.ts and the public functions of sequencer.ts and index.ts
// built on it: notesInWindow, timeline, eventsAtStep and parameterFrame (and
// the parameter table the performance window uses). The sequencer itself is
// sequencer.hpp, the same code the browser runs as WebAssembly.
// tests/parity/play-parity.test.ts compares these with the TypeScript.
//
// One sequencer plan per process (it is large: notes, text, results), used by
// one caller at a time, as in the browser.
#include "xmp/parameters.hpp"
#include "xmp/sequencer.hpp"

namespace xmp::play {

using json::Value;
namespace seq = xmp::sequencer;

inline seq::Plan& plan() {
  static seq::Plan p;
  return p;
}

struct Note {  // SequencedNote, and TimelineNote with frames
  Str id, track_id;
  int32_t pad = 0, note = 0;
  double position = 0, duration = 0, velocity = 0;
  int64_t cycle = 0;
  double frame = 0, duration_frames = 0;
};

namespace detail {
using project::detail::at;
using project::detail::list;
using project::detail::num;
using project::detail::str;

// The project's text as UTF-16 units in the plan's pool (WTF-8 decoded).
inline bool text(seq::Plan& p, const Str& s, seq::Text& out, Str& error) {
  uint16_t* tail = p.pool_tail();
  const int32_t room = p.pool_room();
  int32_t n = 0;
  for (size_t i = 0; i < s.size();) {
    const auto c = static_cast<uint8_t>(s[i]);
    uint32_t cp = c;
    size_t width = 1;
    if (c >= 0xF0)
      cp = ((c & 0x07u) << 18) | ((static_cast<uint8_t>(s[i + 1]) & 0x3Fu) << 12) |
           ((static_cast<uint8_t>(s[i + 2]) & 0x3Fu) << 6) | (static_cast<uint8_t>(s[i + 3]) & 0x3Fu),
      width = 4;
    else if (c >= 0xE0)
      cp = ((c & 0x0Fu) << 12) | ((static_cast<uint8_t>(s[i + 1]) & 0x3Fu) << 6) | (static_cast<uint8_t>(s[i + 2]) & 0x3Fu),
      width = 3;
    else if (c >= 0xC0)
      cp = ((c & 0x1Fu) << 6) | (static_cast<uint8_t>(s[i + 1]) & 0x3Fu), width = 2;
    i += width;
    if (cp >= 0x10000) {
      if (n + 2 > room) return error = "Sequence plan exceeds its text budget", false;
      tail[n++] = static_cast<uint16_t>(0xD800 + ((cp - 0x10000) >> 10));
      tail[n++] = static_cast<uint16_t>(0xDC00 + ((cp - 0x10000) & 0x3FF));
    } else {
      if (n + 1 > room) return error = "Sequence plan exceeds its text budget", false;
      tail[n++] = static_cast<uint16_t>(cp);
    }
  }
  out = p.commit_text(n);
  return true;
}
inline bool checked(const seq::Plan& p, bool ok, Str& error) {
  if (!ok || p.error) return error = "Sequence plan exceeds the sequencer budget", false;
  return true;
}
inline int32_t condition(const Str& c) {
  static const char* kNames[] = {"always", "first", "not-first", "fill", "not-fill", "every-2", "every-4"};
  for (int32_t i = 0; i < 7; ++i)
    if (c == kNames[i]) return i;
  return 0;
}

struct PlannedNote {
  bool legacy = false;
  Str id;
  const Value* step = nullptr;  // the clip step, for legacy notes
  int32_t pad = 0, note = 0;
  double velocity = 0;
};
struct ScenePlan {
  Vec<const Value*> tracks, clips;
  Vec<PlannedNote> notes;
};

// planNotes: the audible tracks of a scene and their notes (step notes first).
inline bool plan_notes(const Value& project, const Str& scene_id, ScenePlan& out, bool& missing, Str& error) {
  const Value* scene = nullptr;
  for (const auto& s : list(project, "scenes"))
    if (str(s, "id") == scene_id) scene = &s;
  missing = !scene;
  if (!scene) return false;
  seq::Plan& p = plan();
  p.reset(static_cast<uint32_t>(num(project, "seed")));
  seq::Text t;
  if (!text(p, str(project, "id"), t, error)) return false;
  p.set_project(t);
  for (const auto& track : list(project, "tracks")) {
    const Value* clip_id = at(*scene, "clips").get(str(track, "id").c_str());
    const Value* clip = nullptr;
    if (clip_id)
      for (const auto& c : list(track, "clips"))
        if (str(c, "id") == clip_id->as_string()) clip = &c;
    if (!clip || at(track, "muted").as_bool()) continue;
    seq::Text tid, cid;
    if (!text(p, str(track, "id"), tid, error) || !text(p, str(*clip, "id"), cid, error)) return false;
    const int32_t index = p.add_track(tid, cid, num(*clip, "length"));
    if (index < 0) return checked(p, false, error);
    out.tracks.push(&track), out.clips.push(clip);
    const Value* machine = track.get("machine");
    const bool synth = machine && str(*machine, "id") == "xmp.subtractive";
    for (const auto& step : list(*clip, "steps")) {
      const int32_t pad = static_cast<int32_t>(num(step, "pad"));
      int32_t note = 60;
      if (const Value* n = step.get("note"))
        note = static_cast<int32_t>(n->as_number());
      else if (synth)
        note = 48 + pad;
      else if (const Value* pb = project::detail::track_pads(project, &track)[pad].get("playback"))
        note = static_cast<int32_t>(num(*pb, "rootNote"));
      PlannedNote planned;
      planned.legacy = true;
      planned.id = Str("step-") + int_text(pad) + "-" + json::number_text(num(step, "step"));
      planned.step = &step, planned.pad = pad, planned.note = note, planned.velocity = num(step, "velocity");
      seq::Text nid;
      if (!text(p, planned.id, nid, error)) return false;
      seq::Note n;
      n.legacy = true, n.id = nid, n.pad = pad, n.note = note, n.position = num(step, "step");
      n.duration = step.get("duration") ? num(step, "duration") : 1;
      n.velocity = planned.velocity, n.probability = num(step, "probability"), n.microtiming = 0, n.condition = 0;
      if (!checked(p, p.add_note(index, n), error)) return false;
      out.notes.push(xmp::move(planned));
    }
    if (const Value* sequence = clip->get("sequence"))
      for (const auto& sn : list(*sequence, "notes")) {
        PlannedNote planned;
        planned.id = str(sn, "id");
        planned.pad = static_cast<int32_t>(num(sn, "pad")), planned.note = static_cast<int32_t>(num(sn, "note"));
        planned.velocity = num(sn, "velocity");
        seq::Text nid;
        if (!text(p, planned.id, nid, error)) return false;
        seq::Note n;
        n.legacy = false, n.id = nid, n.pad = planned.pad, n.note = planned.note, n.position = num(sn, "position");
        n.duration = num(sn, "duration"), n.velocity = planned.velocity, n.probability = num(sn, "probability");
        n.microtiming = num(sn, "microtiming"), n.condition = condition(str(sn, "condition"));
        if (!checked(p, p.add_note(index, n), error)) return false;
        out.notes.push(xmp::move(planned));
      }
  }
  return checked(p, true, error);
}

inline bool read_results(const ScenePlan& sp, int32_t count, bool frames, Vec<Note>& out, Str& error) {
  const seq::Plan& p = plan();
  for (int32_t i = 0; i < count; ++i) {
    const seq::Result& r = p.results[i];
    if (r.track < 0 || r.track >= sp.tracks.size() || r.note < 0 || r.note >= sp.notes.size())
      return error = "Sequencer result out of range", false;
    const PlannedNote& n = sp.notes[r.note];
    Note note;
    note.track_id = str(*sp.tracks[r.track], "id");
    note.id = note.track_id + ":" + str(*sp.clips[r.track], "id") + ":" + (n.legacy ? "legacy:" : "") + n.id + ":" +
              int_text(r.cycle);
    note.pad = n.pad, note.note = n.note, note.velocity = n.velocity, note.cycle = r.cycle;
    note.position = r.position, note.duration = r.duration;
    if (frames) note.frame = r.frame, note.duration_frames = r.duration_frames;
    out.push(xmp::move(note));
  }
  return true;
}
inline bool valid_window(double from, double to) {
  return isfinite(from) && isfinite(to) && from >= 0 && to > from && to - from <= 64 && to <= 1000000;
}
// windowNotes
inline bool window_notes(const Value& project, const Str& scene, double from, double to, bool fill, bool timing,
                         double swing, double bpm, double rate, Vec<Note>& out, Str& error) {
  ScenePlan sp;
  bool missing = false;
  if (!plan_notes(project, scene, sp, missing, error)) {
    if (missing) error = "Missing scene";
    return false;
  }
  seq::Plan& p = plan();
  const int32_t count = p.window(from, to, fill);
  if (count < 0) return error = "Sequence event budget exceeded", false;
  if (timing) p.timeline(swing, bpm, rate);
  return read_results(sp, count, timing, out, error);
}
}  // namespace detail

// notesInWindow
inline bool notes_in_window(const Value& project, const Str& scene, double from, double to, bool fill, Vec<Note>& out,
                            Str& error) {
  if (!detail::valid_window(from, to)) return error = "Invalid sequence window", false;
  return detail::window_notes(project, scene, from, to, fill, false, 0, 0, 0, out, error);
}
// timeline: the notes with their frames under swing.
inline bool timeline(const Value& project, const Str& scene, double from, double to, bool fill, double swing,
                     double rate, Vec<Note>& out, Str& error) {
  if (!detail::valid_window(from, to)) return error = "Invalid sequence window", false;
  if (!detail::window_notes(project, scene, from, to, fill, true, swing, detail::num(project, "bpm"), rate, out, error))
    return false;
  if (out.size() && (!isfinite(swing) || swing < 0 || swing > 0.5)) return error = "Invalid groove", false;
  return true;
}

// eventsAtStep: the step notes due on an absolute step, with the track's gains applied.
struct StepEvent {
  Value step;  // the step, its velocity scaled, with trackId added
};
inline bool events_at_step(const Value& project, const Str& scene, double step, Vec<Value>& out, Str& error) {
  if (!(step == floor(step) && fabs(step) <= 9007199254740991.0) || step < 0) return true;
  detail::ScenePlan sp;
  bool missing = false;
  if (!detail::plan_notes(project, scene, sp, missing, error)) return missing ? (error = Str(), true) : false;
  seq::Plan& p = plan();
  const int32_t count = p.step_events(static_cast<int64_t>(step));
  // Collect first: parameter values below do not use the plan, but keep the order clear.
  Vec<const Value*> tracks, steps;
  for (int32_t i = 0; i < count; ++i) {
    const seq::Result& r = p.results[i];
    if (r.track < 0 || r.track >= sp.tracks.size() || r.note < 0 || r.note >= sp.notes.size()) continue;
    if (!sp.notes[r.note].step) continue;
    tracks.push(sp.tracks[r.track]), steps.push(sp.notes[r.note].step);
  }
  for (int32_t i = 0; i < steps.size(); ++i) {
    const Str& tid = detail::str(*tracks[i], "id");
    double gain = 0, effect = 0;
    if (!parameters::value(project, Str("track.") + tid + ".gain", gain, error) ||
        !parameters::value(project, Str("track.") + tid + ".effect.gain", effect, error))
      return false;
    Value e = *steps[i];
    e.set("velocity", Value::of(detail::num(*steps[i], "velocity") * gain * effect * 2));
    e.set("trackId", Value::of(tid));
    out.push(xmp::move(e));
  }
  return true;
}

// ---- parameter frames (frameParameters, parameterTable) ----
namespace detail {
// Every parameter's sources, then the sequences of `clips` as clip tracks
// (in order; a clip without a sequence gets none, -1).
// A project's parameters, worked out once: the registry and each parameter's
// sources. They depend on the project alone, so whoever plays a project step
// after step (the performance) keeps them instead of deriving them per step.
struct Prepared {
  Vec<parameters::Definition> registry;
  Vec<seq::Sources> sources;
};
inline bool prepare_parameters(const Value& project, Prepared& out, Str& error) {
  static const char* kSources[] = {"base", "automation", "stepLock", "macro", "lfo"};
  out.registry = parameters::registry(project);
  out.sources.clear();
  for (const auto& d : out.registry) {
    Value s;
    if (!parameters::sources(project, d.id, s, error, machine::machines(), &out.registry)) return false;
    seq::Sources src;
    for (int32_t k = 0; k < 5; ++k) {
      const Value* v = s.get(kSources[k]);
      src.has[k] = v || k == 0;
      src.value[k] = v && v->is_number() ? v->as_number() : NAN;
    }
    out.sources.push(src);
  }
  return true;
}
inline bool load_parameters(const Value& project, const Vec<parameters::Definition>& registry,
                            const Vec<const Value*>& clips, Vec<int32_t>& tracks, Str& error,
                            const Vec<seq::Sources>* ready = nullptr) {
  seq::Plan& p = plan();
  p.reset(static_cast<uint32_t>(num(project, "seed")));
  static const char* kSources[] = {"base", "automation", "stepLock", "macro", "lfo"};
  auto index = [&](const Str& id) {
    for (int32_t i = 0; i < registry.size(); ++i)
      if (registry[i].id == id) return i;
    return -1;
  };
  if (ready) {
    for (const auto& src : *ready)
      if (!checked(p, p.add_parameter(src), error)) return false;
  } else {
    for (const auto& d : registry) {
      Value s;
      if (!parameters::sources(project, d.id, s, error, machine::machines(), &registry)) return false;
      seq::Sources src;
      for (int32_t k = 0; k < 5; ++k) {
        const Value* v = s.get(kSources[k]);
        src.has[k] = v || k == 0;
        src.value[k] = v && v->is_number() ? v->as_number() : NAN;
      }
      if (!checked(p, p.add_parameter(src), error)) return false;
    }
  }
  for (const Value* clip : clips) {
    const Value* sequence = clip ? clip->get("sequence") : nullptr;
    if (!sequence) {
      tracks.push(-1);
      continue;
    }
    const int32_t t = p.add_clip_track(num(*clip, "length"));
    if (t < 0) return checked(p, false, error);
    for (const auto& lane : list(*sequence, "lanes")) {
      const int32_t k = index(str(lane, "parameter"));
      if (k < 0) continue;
      const auto& points = list(lane, "points");
      double positions[256], values[256];
      for (int32_t i = 0; i < points.size() && i < 256; ++i)
        positions[i] = num(points[i], "position"), values[i] = num(points[i], "value");
      if (!checked(p, points.size() <= 256 && p.add_lane(t, k, positions, values, points.size()), error)) return false;
    }
    for (const auto& lock : list(*sequence, "locks")) {
      const int32_t k = index(str(lock, "parameter"));
      if (k >= 0 && !checked(p, p.add_lock(t, k, static_cast<int32_t>(num(lock, "position")), num(lock, "value")), error))
        return false;
    }
    for (const auto& mod : list(*sequence, "modulations")) {
      const int32_t k = index(str(mod, "parameter"));
      if (k >= 0 && !checked(p,
                             p.add_mod(t, k, str(mod, "kind") == "macro" ? 0 : 1, num(mod, "amount"),
                                       num(mod, "cycles"), num(mod, "phase")),
                             error))
        return false;
    }
    tracks.push(t);
  }
  return true;
}
inline bool frame_checked(int32_t code, Str& error) {
  static const char* kSources[] = {"base", "automation", "stepLock", "macro", "lfo"};
  if (code < 0) return error = Str("Invalid ") + kSources[(-code - 1) % 5] + " parameter value", false;
  return true;
}
}  // namespace detail

// A parameter value by ID, in registry order (parameterFrame's record).
struct Frame {
  Vec<parameters::Definition> registry;
  Vec<double> values;
};

// parameterFrame: every registered parameter's value at `position` in the
// scene; `offsets` are macro offsets by registry index (NaN: none).
inline bool parameter_frame(const Value& project, const Str& scene_id, double position, const Value& macro_offsets,
                            Frame& out, Str& error) {
  using namespace detail;
  if (!isfinite(position) || position < 0) return error = "Invalid parameter position", false;
  const Value* scene = nullptr;
  for (const auto& s : list(project, "scenes"))
    if (str(s, "id") == scene_id) scene = &s;
  if (!scene) return error = "Missing scene", false;
  out.registry = parameters::registry(project);
  Vec<const Value*> clips;
  for (const auto& track : list(project, "tracks")) {
    const Value* clip_id = at(*scene, "clips").get(str(track, "id").c_str());
    const Value* clip = nullptr;
    if (clip_id)
      for (const auto& c : list(track, "clips"))
        if (str(c, "id") == clip_id->as_string()) clip = &c;
    clips.push(clip);
  }
  Vec<int32_t> tracks;
  if (!load_parameters(project, out.registry, clips, tracks, error)) return false;
  static double offsets[seq::kParams], values[seq::kParams];
  const int32_t n = out.registry.size();
  if (n > seq::kParams) return error = "Sequence plan exceeds the sequencer budget", false;
  for (int32_t i = 0; i < n; ++i) {
    const Value* o = macro_offsets.is_object() ? macro_offsets.get(out.registry[i].id.c_str()) : nullptr;
    offsets[i] = o && o->is_number() ? o->as_number() : NAN;
  }
  if (!frame_checked(plan().parameter_frame(position, offsets, values), error)) return false;
  out.values.clear();
  for (int32_t i = 0; i < n; ++i) out.values.push(values[i]);
  return true;
}

// parameterTable: the sources and clip sequences laid out once, for many frames.
class ParameterTable {
 public:
  Vec<parameters::Definition> registry;
  Vec<int32_t> tracks;  // clip track of each of `clips`, or -1

  bool load(const Value& project, Vec<parameters::Definition> reg, const Vec<const Value*>& clips, Str& error,
            const Vec<seq::Sources>* ready = nullptr) {
    registry = xmp::move(reg);
    tracks.clear();
    return detail::load_parameters(project, registry, clips, tracks, error, ready);
  }
  // Values (registry order) at `position` with `offsets` (NaN: none) and only clip track `only` (-1: none).
  bool frame(double position, const double* offsets, int32_t only, const double*& values, Str& error) {
    static double scratch[seq::kParams], out[seq::kParams];
    const int32_t n = registry.size();
    for (int32_t i = 0; i < n; ++i) scratch[i] = offsets[i];
    if (!detail::frame_checked(plan().parameter_frame(position, scratch, out, only < 0 ? -1 : only), error))
      return false;
    values = out;
    return true;
  }
};

}  // namespace xmp::play
