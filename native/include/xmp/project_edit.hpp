#pragma once
// Editing XMP projects in C++: the C++ port of the project edits in
// packages/core (index.ts, sequencer.ts, performance.ts, mix.ts,
// midi-routing.ts, instruments.ts, drum-kits.ts). Each edit takes a canonical
// version 7 document and returns a new one, or an error; like the TypeScript,
// almost every edit ends by checking the whole project again (ProjectSchema.parse),
// so an edit can never leave a project the browser would refuse.
// tests/parity/project-edit-parity.test.ts applies the same random edits to both.
//
// The typed view (Project, Track, Clip, ...) reads the document in place: the
// document stays the single source, so its canonical order is never lost.
#include "xmp/project.hpp"

namespace xmp::edit {

using json::Value;

struct Edited {
  bool ok = false;
  Value project;
  Str error;
};

// ---- the typed view ----
namespace view {
inline const Value& field(const Value& v, const char* key) {
  static const Value none;
  const Value* p = v.get(key);
  return p ? *p : none;
}
struct Step {
  const Value& v;
  int32_t step() const { return static_cast<int32_t>(field(v, "step").as_number()); }
  int32_t pad() const { return static_cast<int32_t>(field(v, "pad").as_number()); }
  double velocity() const { return field(v, "velocity").as_number(); }
  double probability() const { return field(v, "probability").as_number(); }
  bool has_note() const { return v.has("note"); }
  int32_t note() const { return static_cast<int32_t>(field(v, "note").as_number()); }
  double duration() const { return v.has("duration") ? field(v, "duration").as_number() : 0; }
};
struct Clip {
  const Value& v;
  const Str& id() const { return field(v, "id").as_string(); }
  const Str& name() const { return field(v, "name").as_string(); }
  int32_t length() const { return static_cast<int32_t>(field(v, "length").as_number()); }
  int32_t step_count() const { return field(v, "steps").items().size(); }
  Step step(int32_t i) const { return Step{field(v, "steps").items()[i]}; }
  const Value* sequence() const { return v.get("sequence"); }
};
struct Track {
  const Value& v;
  const Str& id() const { return field(v, "id").as_string(); }
  const Str& name() const { return field(v, "name").as_string(); }
  bool muted() const { return field(v, "muted").as_bool(); }
  double volume() const { return field(v, "volume").as_number(); }
  int32_t clip_count() const { return field(v, "clips").items().size(); }
  Clip clip(int32_t i) const { return Clip{field(v, "clips").items()[i]}; }
  const Value* find_clip(const Str& id) const {
    for (const auto& c : field(v, "clips").items())
      if (field(c, "id").as_string() == id) return &c;
    return nullptr;
  }
  // The machine's ID, "xmp.sampler" when the track has none (machines.ts).
  Str machine_id() const {
    const Value* m = v.get("machine");
    return m ? field(*m, "id").as_string() : Str("xmp.sampler");
  }
};
struct Scene {
  const Value& v;
  const Str& id() const { return field(v, "id").as_string(); }
  const Str& name() const { return field(v, "name").as_string(); }
  // The clip a track plays in this scene, if any.
  const Value* clip_for(const Str& track) const { return field(v, "clips").get(track.c_str()); }
};
struct Project {
  const Value& v;
  const Str& id() const { return field(v, "id").as_string(); }
  const Str& name() const { return field(v, "name").as_string(); }
  double bpm() const { return field(v, "bpm").as_number(); }
  double swing() const { return field(v, "swing").as_number(); }
  double master() const { return field(v, "master").as_number(); }
  uint32_t seed() const { return static_cast<uint32_t>(field(v, "seed").as_number()); }
  int32_t track_count() const { return field(v, "tracks").items().size(); }
  Track track(int32_t i) const { return Track{field(v, "tracks").items()[i]}; }
  int32_t scene_count() const { return field(v, "scenes").items().size(); }
  Scene scene(int32_t i) const { return Scene{field(v, "scenes").items()[i]}; }
  int32_t find_track(const Str& id) const {
    for (int32_t i = 0; i < track_count(); ++i)
      if (track(i).id() == id) return i;
    return -1;
  }
  const Value* performance() const { return v.get("performance"); }
  const Value* mix() const { return v.get("mix"); }
};
}  // namespace view

// ---- helpers over a mutable document ----
namespace detail {
inline Value& member(Value& v, const char* key) {
  Value* p = v.get(key);
  if (!p) return v.set(Str(key), Value());
  return *p;
}
inline Vec<Value>& items(Value& v, const char* key) { return member(v, key).items(); }
inline const Str& text(const Value& v, const char* key) { return view::field(v, key).as_string(); }
inline double number(const Value& v, const char* key) { return view::field(v, key).as_number(); }
inline Value* find(Vec<Value>& list, const Str& id) {
  for (auto& x : list)
    if (text(x, "id") == id) return &x;
  return nullptr;
}
inline Value* track(Value& p, const Str& id) { return find(items(p, "tracks"), id); }
inline Value* clip(Value& p, const Str& track_id, const Str& clip_id) {
  Value* t = track(p, track_id);
  return t ? find(items(*t, "clips"), clip_id) : nullptr;
}
inline Edited fail(const char* message) {
  Edited e;
  e.error = message;
  return e;
}
// ProjectSchema.parse(next)
inline Edited finish(const Value& next) {
  Edited e;
  e.ok = project::canonical(next, e.project, e.error);
  if (!e.ok) e.project = Value();
  return e;
}
inline Value num(double v) { return Value::of(v); }
// Math.round
inline double js_round(double x) {
  const double r = floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}
// emptySequence, emptyPerformance, emptyMix
inline Value empty_sequence() {
  Value s = Value::new_object();
  s.set("version", num(1));
  s.set("notes", Value::new_array()), s.set("locks", Value::new_array());
  s.set("lanes", Value::new_array()), s.set("modulations", Value::new_array());
  return s;
}
inline Value empty_performance() {
  Value p = Value::new_object();
  p.set("version", num(1));
  p.set("chain", Value::new_array());
  p.set("end", Value::of("stop"));
  p.set("macros", Value::new_array());
  p.set("mutes", Value::new_object());
  p.set("solos", Value::new_array());
  p.set("events", Value::new_array());
  Value delay = Value::new_object();
  delay.set("steps", num(1)), delay.set("feedback", num(0.35)), delay.set("wet", num(0));
  delay.set("sends", Value::new_object());
  p.set("delay", xmp::move(delay));
  return p;
}
inline Value empty_mix() {
  Value m = Value::new_object();
  m.set("version", num(1));
  m.set("tracks", Value::new_object());
  Value returns = Value::new_array();
  returns.push(Value::new_array()), returns.push(Value::new_array());
  m.set("returns", xmp::move(returns));
  m.set("tempos", Value::new_array());
  return m;
}
// JavaScript's String.prototype.trim whitespace (ASCII and Unicode spaces, BOM, line terminators).
inline Str js_trim(const Str& s) {
  auto space_at = [&](size_t i, size_t& width) {
    const auto c = static_cast<uint8_t>(s[i]);
    width = 1;
    if (c == ' ' || (c >= 0x09 && c <= 0x0D)) return true;
    uint32_t cp = 0;
    if (c >= 0xE0 && c < 0xF0 && i + 2 < s.size()) {
      cp = ((c & 0x0Fu) << 12) | ((static_cast<uint8_t>(s[i + 1]) & 0x3Fu) << 6) | (static_cast<uint8_t>(s[i + 2]) & 0x3Fu);
      width = 3;
    } else if (c >= 0xC0 && c < 0xE0 && i + 1 < s.size()) {
      cp = ((c & 0x1Fu) << 6) | (static_cast<uint8_t>(s[i + 1]) & 0x3Fu);
      width = 2;
    } else
      return false;
    return cp == 0xA0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp == 0x2028 || cp == 0x2029 ||
           cp == 0x202F || cp == 0x205F || cp == 0x3000 || cp == 0xFEFF;
  };
  size_t from = 0, to = s.size(), w = 0;
  while (from < to && space_at(from, w)) from += w;
  // From the end: find the last character that is not a space.
  size_t last = from;
  for (size_t i = from; i < to;) {
    const bool sp = space_at(i, w);
    i += w;
    if (!sp) last = i;
  }
  return s.slice(from, last);
}
inline bool is_builtin(const Value& track, const char* id) {
  const Value* m = track.get("machine");
  if (!m) return Str(id) == "xmp.sampler";  // machines.get(undefined) is the pad sampler
  const char* base = Str(id) == "xmp.midi" ? "midi" : "audio";
  if (text(*m, "id") != id || text(*m, "base") != base || number(*m, "version") != 1) return false;
  // machines.get also checks the state (always valid in a canonical document).
  return true;
}
}  // namespace detail

// ---- index.ts ----
// toggleStep: no schema pass, as in the TypeScript.
inline Edited toggle_step(const Value& project, const Str& track, const Str& clip, double pad, double step) {
  Value next = project;
  Value* c = detail::clip(next, track, clip);
  if (!c || pad != floor(pad) || pad < 0 || pad >= 16 || step != floor(step) || step < 0 ||
      step >= detail::number(*c, "length"))
    return detail::fail("Invalid step edit");
  auto& steps = detail::items(*c, "steps");
  for (int32_t i = 0; i < steps.size(); ++i)
    if (detail::number(steps[i], "pad") == pad && detail::number(steps[i], "step") == step) {
      steps.erase(i);
      Edited e;
      e.ok = true, e.project = xmp::move(next);
      return e;
    }
  Value s = Value::new_object();
  s.set("step", detail::num(step)), s.set("pad", detail::num(pad));
  s.set("velocity", detail::num(0.8)), s.set("probability", detail::num(1));
  steps.push(xmp::move(s));
  Edited e;
  e.ok = true, e.project = xmp::move(next);
  return e;
}
// expandSong: eight tracks, sixteen scenes, a clip for every track in every scene.
inline Edited expand_song(const Value& project) {
  using detail::items;
  using detail::text;
  Value next = project;
  auto& tracks = items(next, "tracks");
  while (tracks.size() < 8) {
    int32_t index = 1;
    while (detail::find(tracks, Str("track-") + int_text(index))) ++index;
    Value t = Value::new_object();
    t.set("id", Value::of(Str("track-") + int_text(index)));
    t.set("name", Value::of(Str("Track ") + int_text(tracks.size() + 1)));
    t.set("muted", Value::of(false)), t.set("volume", detail::num(0.8)), t.set("clips", Value::new_array());
    tracks.push(xmp::move(t));
  }
  auto& scenes = items(next, "scenes");
  while (scenes.size() < 16) {
    int32_t index = 0;
    while (detail::find(scenes, Str("scene-") + int_text(index))) ++index;
    Value s = Value::new_object();
    s.set("id", Value::of(Str("scene-") + int_text(index)));
    s.set("name", Value::of(Str("Scene ") + int_text(scenes.size() + 1)));
    s.set("clips", Value::new_object());
    scenes.push(xmp::move(s));
  }
  for (auto& track : tracks) {
    const Str tid = text(track, "id");
    auto& clips = items(track, "clips");
    for (int32_t index = 0; index < scenes.size(); ++index) {
      Value& scene_clips = detail::member(scenes[index], "clips");
      if (scene_clips.get(tid.c_str())) continue;
      const Value* unused = nullptr;
      for (const auto& c : clips) {
        bool used = false;
        for (auto& s : scenes) {
          const Value* x = detail::member(s, "clips").get(tid.c_str());
          used = used || (x && x->as_string() == text(c, "id"));
        }
        if (!used) {
          unused = &c;
          break;
        }
      }
      if (unused) {
        scene_clips.set(tid, Value::of(text(*unused, "id")));
        continue;
      }
      Str id = tid.utf16_prefix(40) + "-clip-" + int_text(index);
      int32_t suffix = 0;
      while (detail::find(clips, id)) id = tid.utf16_prefix(40) + "-clip-" + int_text(index) + "-" + int_text(++suffix);
      Value c = Value::new_object();
      c.set("id", Value::of(id)), c.set("name", Value::of(text(scenes[index], "name")));
      c.set("length", detail::num(16)), c.set("steps", Value::new_array());
      clips.push(xmp::move(c));
      detail::member(scenes[index], "clips").set(tid, Value::of(id));
    }
  }
  return detail::finish(next);
}

// ---- sequencer.ts ----
// editSequence: `change(Value& sequence)` edits the clip's sequence (created empty if missing).
template <class Change>
Edited edit_sequence(const Value& project, const Str& track, const Str& clip, Change change) {
  Value next = project;
  Value* c = detail::clip(next, track, clip);
  if (!c) return detail::fail("Missing clip");
  if (!c->get("sequence")) c->set("sequence", detail::empty_sequence());
  change(detail::member(*c, "sequence"));
  return detail::finish(next);
}
inline Edited append_notes(const Value& project, const Str& track, const Str& clip, const Vec<Value>& notes) {
  return edit_sequence(project, track, clip, [&](Value& seq) {
    for (const auto& n : notes) detail::items(seq, "notes").push(n);
  });
}
// A Device pad pass: repeated drum cells merge; pitched notes keep other pitches.
// Validate every input even when it would merge into an existing event.
inline Edited overdub_steps(const Value& project, const Str& track, const Str& clip, const Vec<Value>& hits) {
  if (hits.size() > 1024) return detail::fail("Take exceeds clip note limit");
  Value next = project;
  Value* c = detail::clip(next, track, clip);
  if (!c) return detail::fail("Missing clip");
  const double length = detail::number(*c, "length");
  auto bounded = [](const Value& hit, const char* field, double low, double high, bool integer, bool optional = false) {
    const Value* v = hit.get(field);
    return !v ? optional : v->is_number() && isfinite(v->as_number()) && v->as_number() >= low && v->as_number() <= high &&
                          (!integer || floor(v->as_number()) == v->as_number());
  };
  for (const auto& hit : hits) {
    if (!hit.is_object() || !bounded(hit, "step", 0, length - 1, true) || !bounded(hit, "pad", 0, 15, true) ||
        !bounded(hit, "velocity", 0, 1, false) || !bounded(hit, "probability", 0, 1, false) ||
        !bounded(hit, "note", 0, 127, true, true) || !bounded(hit, "duration", 0.0625, 64, false, true))
      return detail::fail("Invalid recorded hit");
  }
  auto& steps = detail::items(*c, "steps");
  for (const auto& hit : hits) {
    bool merged = false;
    bool used[16] = {};
    const Value* note = hit.get("note");
    for (auto& existing : steps) {
      if (detail::number(existing, "step") != detail::number(hit, "step")) continue;
      used[static_cast<int>(detail::number(existing, "pad"))] = true;
      const Value* pitch = existing.get("note");
      if (note ? (pitch && pitch->as_number() == note->as_number())
               : detail::number(existing, "pad") == detail::number(hit, "pad")) {
        if (!note && detail::number(hit, "velocity") > detail::number(existing, "velocity"))
          existing.set("velocity", *hit.get("velocity"));
        merged = true;
        break;
      }
    }
    if (merged) continue;
    if (steps.size() >= 1024) return detail::fail("Clip note limit reached; take not applied");
    Value added = hit;
    if (note && used[static_cast<int>(detail::number(hit, "pad"))]) {
      int free = 0;
      while (free < 16 && used[free]) ++free;
      if (free == 16) return detail::fail("Step already has sixteen notes; take not applied");
      added.set("pad", detail::num(free));
    }
    steps.push(xmp::move(added));
  }
  return detail::finish(next);
}
inline Edited quantize_notes(const Value& project, const Str& track, const Str& clip, const Vec<Str>& ids, double grid,
                             bool restore = false) {
  if (grid != 0.25 && grid != 0.5 && grid != 1 && grid != 2 && grid != 4)
    return detail::fail("Unsupported quantization grid");
  Value copy = project;
  const Value* c = detail::clip(copy, track, clip);
  if (!c) return detail::fail("Missing clip");
  const double length = detail::number(*c, "length");
  return edit_sequence(project, track, clip, [&](Value& seq) {
    for (auto& n : detail::items(seq, "notes")) {
      bool chosen = false;
      for (const auto& id : ids) chosen = chosen || id == detail::text(n, "id");
      if (!chosen) continue;
      if (!n.get("original")) {
        Value o = Value::new_object();
        o.set("position", detail::num(detail::number(n, "position")));
        o.set("duration", detail::num(detail::number(n, "duration")));
        o.set("velocity", detail::num(detail::number(n, "velocity")));
        o.set("timestamp", detail::num(0));
        n.set("original", xmp::move(o));
      }
      const Value& o = detail::member(n, "original");
      const double position =
          restore ? detail::number(o, "position")
                  : fmin(length - 1.0 / 960, detail::js_round(detail::number(o, "position") / grid) * grid);
      n.set("position", detail::num(position));
      n.set("duration", detail::num(fmin(restore ? detail::number(o, "duration") : detail::number(n, "duration"),
                                         length - position)));
    }
  });
}
inline Edited resize_clip(const Value& project, const Str& track, const Str& clip, double length) {
  Value next = project;
  Value* c = detail::clip(next, track, clip);
  if (!c) return detail::fail("Missing clip");
  c->set("length", detail::num(length));
  Vec<Value> kept;
  for (auto& s : detail::items(*c, "steps")) {
    if (detail::number(s, "step") >= length) continue;
    Value copy = s;
    if (copy.get("duration") && detail::number(copy, "duration"))
      copy.set("duration", detail::num(fmin(detail::number(copy, "duration"), length - detail::number(copy, "step"))));
    kept.push(xmp::move(copy));
  }
  detail::items(*c, "steps") = xmp::move(kept);
  if (Value* seq = c->get("sequence")) {
    Vec<Value> notes;
    for (auto& n : detail::items(*seq, "notes"))
      if (detail::number(n, "position") < length) {
        Value copy = n;
        copy.set("duration", detail::num(fmin(detail::number(n, "duration"), length - detail::number(n, "position"))));
        notes.push(xmp::move(copy));
      }
    detail::items(*seq, "notes") = xmp::move(notes);
    Vec<Value> locks;
    for (auto& l : detail::items(*seq, "locks"))
      if (detail::number(l, "position") < length) locks.push(l);
    detail::items(*seq, "locks") = xmp::move(locks);
    for (auto& lane : detail::items(*seq, "lanes")) {
      Vec<Value> points;
      for (auto& pt : detail::items(lane, "points"))
        if (detail::number(pt, "position") <= length) points.push(pt);
      detail::items(lane, "points") = xmp::move(points);
    }
  }
  return detail::finish(next);
}
inline Edited duplicate_clip(const Value& project, const Str& track_id, const Str& clip_id) {
  Value next = project;
  Value* t = detail::track(next, track_id);
  if (!t || detail::items(*t, "clips").size() >= 16) return detail::fail("Clip budget reached");
  const Value* original = detail::find(detail::items(*t, "clips"), clip_id);
  if (!original) return detail::fail("Missing clip");
  int32_t i = 0;
  while (detail::find(detail::items(*t, "clips"), Str("copy-") + int_text(i))) ++i;
  Value copy = *original;
  copy.set("id", Value::of(Str("copy-") + int_text(i)));
  copy.set("name", Value::of(detail::text(*original, "name").utf16_prefix(30) + " copy"));
  detail::items(*t, "clips").push(xmp::move(copy));
  return detail::finish(next);
}

// ---- performance.ts ----
template <class Change>
Edited edit_performance(const Value& project, Change change) {
  Value next = project;
  if (!next.get("performance")) next.set("performance", detail::empty_performance());
  change(detail::member(next, "performance"));
  return detail::finish(next);
}
inline Edited edit_chain(const Value& project, const Vec<Value>& chain) {
  return edit_performance(project, [&](Value& p) {
    Value list = Value::new_array();
    for (const auto& e : chain) list.push(e);
    p.set("chain", xmp::move(list));
    if (const Value* pos = p.get("position")) {
      bool found = false;
      for (const auto& e : chain) found = found || (e.is_object() && e.get("id") && e.get("id")->is_string() &&
                                                    detail::text(e, "id") == detail::text(*pos, "occurrenceId"));
      if (!found) p.remove("position");
    }
  });
}
inline Edited delete_track(const Value& project, const Str& track_id) {
  Value next = project;
  auto& tracks = detail::items(next, "tracks");
  if (tracks.size() <= 1 || !detail::find(tracks, track_id)) return detail::fail("Keep at least one track");
  for (int32_t i = 0; i < tracks.size(); ++i)
    if (detail::text(tracks[i], "id") == track_id) {
      tracks.erase(i);
      break;
    }
  const Str own = Str("track.") + track_id + ".";
  for (auto& source : tracks)
    if (Value* m = source.get("machine"))
      if (detail::text(*m, "id") == "xmp.midi" && detail::number(*m, "version") == 1 && detail::text(*m, "base") == "midi") {
        Value& state = detail::member(*m, "state");
        if (const Value* d = state.get("destination"))
          if (d->is_string() && d->as_string() == track_id) state.remove("destination");
      }
  {
    Vec<Value> kept;
    for (auto& a : detail::items(next, "parameters"))
      if (!detail::text(a, "id").starts_with(own)) kept.push(a);
    detail::items(next, "parameters") = xmp::move(kept);
  }
  if (Value* mix = next.get("mix")) detail::member(*mix, "tracks").remove(track_id.c_str());
  for (auto& s : detail::items(next, "scenes")) detail::member(s, "clips").remove(track_id.c_str());
  if (Value* p = next.get("performance")) {
    detail::member(*p, "mutes").remove(track_id.c_str());
    detail::member(detail::member(*p, "delay"), "sends").remove(track_id.c_str());
    Vec<Value> solos;
    for (auto& s : detail::items(*p, "solos"))
      if (s.as_string() != track_id) solos.push(s);
    detail::items(*p, "solos") = xmp::move(solos);
    Vec<Value> events;
    for (auto& e : detail::items(*p, "events"))
      if (detail::text(e, "kind") == "macro" || detail::text(e, "trackId") != track_id) events.push(e);
    detail::items(*p, "events") = xmp::move(events);
    for (auto& m : detail::items(*p, "macros")) {
      Vec<Value> kept;
      for (auto& a : detail::items(m, "assignments"))
        if (!detail::text(a, "parameter").starts_with(own)) kept.push(a);
      detail::items(m, "assignments") = xmp::move(kept);
    }
    if (Value* sel = p->get("selection")) detail::member(*sel, "clips").remove(track_id.c_str());
    p->remove("position");
  }
  return detail::finish(next);
}

// ---- mix.ts ----
template <class Change>
Edited edit_mix(const Value& project, Change change) {
  Value next = project;
  if (!next.get("mix")) next.set("mix", detail::empty_mix());
  change(detail::member(next, "mix"));
  return detail::finish(next);
}

// ---- midi-routing.ts ----
// setMidiDestination; an empty `destination` removes the route.
inline Edited set_midi_destination(const Value& project, const Str& source_id, const Str* destination) {
  Value next;
  Str error;
  if (!project::canonical(project, next, error)) {
    Edited e;
    e.error = error;
    return e;
  }
  Value* source = detail::track(next, source_id);
  if (!source || !source->get("machine") || !detail::is_builtin(*source, "xmp.midi"))
    return detail::fail("Choose a built-in MIDI source track");
  if (destination) {
    bool allowed = false;
    for (const auto& t : detail::items(next, "tracks"))
      allowed = allowed || (detail::text(t, "id") != source_id && detail::text(t, "id") == *destination &&
                            (detail::is_builtin(t, "xmp.sampler") || detail::is_builtin(t, "xmp.subtractive")));
    if (!allowed) return detail::fail("Choose another track with the built-in synth or sampler");
  }
  Value& state = detail::member(detail::member(*source, "machine"), "state");
  if (destination)
    state.set("destination", Value::of(*destination));
  else
    state.remove("destination");
  return detail::finish(next);
}

// ---- instruments.ts ----
namespace detail {
// The pads an edit changes (project format 7): the track's own kit, else the project's.
inline Vec<Value>& bank(Value& next, const Str* track_id) {
  if (track_id)
    if (Value* t = track(next, *track_id))
      if (t->get("pads")) return items(*t, "pads");
  return items(next, "pads");
}
// Whether a pad plays a sample: as its own sound or in a layer (format 8).
inline bool pad_plays(const Value& pad, const Str& id) {
  if (project::detail::str(pad, "sampleId") == id) return true;
  if (const Value* layers = pad.get("layers"))
    for (const auto& l : layers->items())
      for (const auto& s : project::detail::list(l, "samples"))
        if (s.as_string() == id) return true;
  return false;
}
inline bool sample_in_use(const Value& project, const Str& id) {
  if (const auto* extensions = project.get("extensions")) for (const auto& e : extensions->members())
    if (!project::extensions::supported(e.key,static_cast<int>(project::detail::num(e.value,"version")))) return true;
  for (const auto& t : project::detail::list(project, "tracks"))
    if (const auto* machine = t.get("machine")) {
      const Str kind = project::detail::str(*machine, "id");
      if (project::detail::num(*machine, "version") != 1 ||
          (kind != "xmp.sampler" && kind != "xmp.subtractive" && kind != "xmp.midi")) return true;
    }
  for (const auto& p : project::detail::list(project, "pads"))
    if (pad_plays(p, id)) return true;
  for (const auto& t : project::detail::list(project, "tracks"))
    if (const Value* own = t.get("pads"))
      for (const auto& p : own->items())
        if (pad_plays(p, id)) return true;
  return false;
}
inline void drop_unused_samples(Value& next) {
  auto& samples = items(next, "samples");
  Vec<Value> used;
  for (auto& s : samples)
    if (sample_in_use(next, project::detail::str(s, "id"))) used.push(s);
  samples = xmp::move(used);
}
}  // namespace detail
inline Edited manual_slices(const Value& project, double pad_index, const Vec<double>& boundaries,
                            const Str* track_id = nullptr) {
  Value next = project;
  auto& pads = detail::bank(next, track_id);
  const bool index_ok = pad_index == floor(pad_index) && pad_index >= 0 && pad_index < pads.size();
  const Value* source = index_ok ? &pads[static_cast<int32_t>(pad_index)] : nullptr;
  const Value* asset = source ? detail::find(detail::items(next, "samples"), detail::text(*source, "sampleId")) : nullptr;
  bool ok = source && asset && boundaries.size() >= 2 && boundaries.size() <= 17 &&
            pad_index + boundaries.size() - 1 <= 16;
  const double frames = asset ? detail::items(const_cast<Value&>(*asset), "pcm").size() : 0;
  for (int32_t i = 0; ok && i < boundaries.size(); ++i) {
    const double b = boundaries[i];
    ok = b == floor(b) && b >= 0 && b <= frames && (i == 0 || b > boundaries[i - 1]);
  }
  if (!ok) return detail::fail("Use increasing slice frames within the asset and available pads");
  const Value source_copy = *source;
  const Str asset_name = detail::text(*asset, "name");
  const int32_t first = static_cast<int32_t>(pad_index);
  for (int32_t i = 0; i + 1 < boundaries.size(); ++i) {
    Value pad = source_copy;
    pad.set("id", Value::of(first + i < pads.size() ? detail::text(pads[first + i], "id")
                                                    : Str("pad-") + int_text(first + i)));
    pad.set("name", Value::of(asset_name.utf16_prefix(32) + " " + int_text(i + 1)));
    Value slice = Value::new_object();
    slice.set("start", detail::num(boundaries[i])), slice.set("end", detail::num(boundaries[i + 1]));
    pad.set("slice", xmp::move(slice));
    pad.remove("layers");  // a slice plays one sound
    if (first + i < pads.size())
      pads[first + i] = xmp::move(pad);
    else
      pads.push(xmp::move(pad));
  }
  return detail::finish(next);
}
// installSample: a recorded take on a pad (pcm values as the Float32Array held them).
inline Edited install_sample(const Value& project, double pad_index, const Str& name, double sample_rate,
                             const Vec<double>& pcm, const Str* track_id = nullptr) {
  Value next = project;
  auto& pads = detail::bank(next, track_id);
  const bool index_ok = pad_index == floor(pad_index) && pad_index >= 0 && pad_index < pads.size();
  bool ok = index_ok && pcm.size() > 0 && pcm.size() <= project_limits::kLoopSampleFrames;
  for (int32_t i = 0; ok && i < pcm.size(); ++i) ok = isfinite(pcm[i]) && fabs(pcm[i]) <= 1;
  if (!ok) return detail::fail("Invalid or oversized take");
  auto& samples = detail::items(next, "samples");
  int32_t n = 0;
  while (detail::find(samples, Str("take-") + int_text(n))) ++n;
  Value sample = Value::new_object();
  const Str sample_name = name.utf16_prefix(120).empty() ? Str("Take") : name.utf16_prefix(120);
  sample.set("id", Value::of(Str("take-") + int_text(n)));
  sample.set("name", Value::of(sample_name));
  sample.set("sampleRate", detail::num(sample_rate));
  Value values = Value::new_array();
  values.items().reserve(pcm.size());
  for (const double v : pcm) values.push(detail::num(v));
  sample.set("pcm", xmp::move(values));
  Value& pad = pads[static_cast<int32_t>(pad_index)];
  pad.set("sampleId", Value::of(Str("take-") + int_text(n)));
  pad.set("name", Value::of(sample_name.utf16_prefix(40)));
  pad.remove("slice");
  pad.remove("edit");
  pad.remove("layers");
  detail::drop_unused_samples(next);
  detail::items(next, "samples").push(xmp::move(sample));
  Str budget_error;
  if (!project_limits::prepare_samples(next, budget_error)) return detail::fail(budget_error.c_str());
  return detail::finish(next);
}
// ownKit: the track gets a copy of the 16 pads it plays now, sharing their samples.
inline Edited own_kit(const Value& project, const Str& track_id) {
  Value next = project;
  Value* t = detail::track(next, track_id);
  if (!t) return detail::fail("Unknown track");
  if (!t->get("pads")) t->set("pads", detail::member(next, "pads"));
  return detail::finish(next);
}
// shareKit: the track plays the project's pads again; samples nothing plays go.
inline Edited share_kit(const Value& project, const Str& track_id) {
  Value next = project;
  Value* t = detail::track(next, track_id);
  if (!t) return detail::fail("Unknown track");
  t->remove("pads");
  detail::drop_unused_samples(next);
  return detail::finish(next);
}

// ---- drum-kits.ts ----
inline bool sampler_plan(const Value& project, int bars, uint32_t& frames, Str& error) {
  if (bars!=1 && bars!=2 && bars!=4) return error="Invalid take length",false;
  const double bpm=project::detail::num(project,"bpm");
  if(!isfinite(bpm)||bpm<30||bpm>300) return error="Invalid recording tempo",false;
  for(const auto& tempo:project::detail::list(project::detail::at(project,"mix"),"tempos"))
    if(project::detail::num(tempo,"bpm")!=bpm) return error="Use a constant tempo for synced input recording",false;
  frames=static_cast<uint32_t>(floor(48000.0*60/bpm*bars*4+0.5));return true;
}

inline Edited sampler_input(const Value& project, const Str& track_id, bool monitor, int bars) {
  Value next = project;
  if (!detail::track(next,track_id) || (bars != 1 && bars != 2 && bars != 4)) return detail::fail("Invalid sampler settings");
  if (!next.get("extensions")) next.set("extensions",Value::new_object());
  auto* extensions = next.get("extensions");
  auto* entry = extensions->get("xmp.sampler-input");
  if (entry && project::detail::num(*entry,"version") != 1) return detail::fail("A newer sampler input setting must be preserved");
  if (!entry) {
    Value e = Value::new_object(), data = Value::new_object();
    e.set("version",Value::of(1.0)),data.set("tracks",Value::new_object()),e.set("data",data);
    extensions->set("xmp.sampler-input",e),entry=extensions->get("xmp.sampler-input");
  }
  Value settings = Value::new_object();
  settings.set("monitor",Value::of(monitor)),settings.set("bars",Value::of(static_cast<double>(bars)));
  entry->get("data")->get("tracks")->set(track_id,settings);
  return detail::finish(next);
}

// Install a timed take on exactly the selected pad and create a loop clip in
// the selected scene. Reuses its current clip; one Undo restores all.
inline Edited record_loop(const Value& project, const Str& track_id, const Str& scene_id, int pad,
                          const Str& name, const Vec<double>& pcm, int bars) {
  if ((bars != 1 && bars != 2 && bars != 4) || pad < 0 || pad > 15) return detail::fail("Invalid loop target");
  uint32_t frames=0;Str plan_error;
  if(!sampler_plan(project,bars,frames,plan_error)) return detail::fail(plan_error.c_str());
  if(pcm.size()!=static_cast<int32_t>(frames)) return detail::fail("Timed take must contain the complete bar length");
  auto e = own_kit(project,track_id);
  if (!e.ok) return e;
  e = install_sample(e.project,pad,name,48000,pcm,&track_id);
  if (!e.ok) return e;
  auto* track = detail::track(e.project,track_id);
  auto* scene = detail::find(detail::items(e.project,"scenes"),scene_id);
  if (!track || !scene || (track->get("machine") && (detail::text(detail::member(*track,"machine"),"id") != "xmp.sampler" || project::detail::num(detail::member(*track,"machine"),"version") != 1 || detail::text(detail::member(*track,"machine"),"base") != "audio"))) return detail::fail("Choose a sampler track and scene");
  if(!track->get("machine")) {
    Value machine=Value::new_object();machine.set("id",Value::of("xmp.sampler")),machine.set("base",Value::of("audio"));
    machine.set("version",Value::of(1.0)),machine.set("state",Value::new_object());track->set("machine",machine);
  }
  auto& clips = detail::items(*track,"clips");
  const Str current_clip = project::detail::str(project::detail::at(*scene,"clips"),track_id.c_str());
  Value* existing = detail::find(clips,current_clip);
  if (clips.size() >= 16 && !existing) return detail::fail("Track has sixteen clips; choose an existing clip to record");
  int n = 0; Str id;
  if (existing) id = current_clip;
  else for (;;) {
    id = Str("recorded-loop-")+int_text(n++); bool used = false;
    for (const auto& t : detail::items(e.project,"tracks")) for (const auto& c : project::detail::list(t,"clips")) if (project::detail::str(c,"id") == id) used = true;
    if (!used) break;
  }
  Value clip = Value::new_object(), steps = Value::new_array(), note = Value::new_object();
  clip.set("id",Value::of(id)), clip.set("name",Value::of(name.utf16_prefix(40)));
  clip.set("length",Value::of(bars*16.0));
  note.set("step",Value::of(0.0)), note.set("pad",Value::of(static_cast<double>(pad)));
  note.set("velocity",Value::of(1.0)), note.set("probability",Value::of(1.0));
  steps.push(note), clip.set("steps",steps);
  if (existing) *existing = clip; else clips.push(clip);
  scene->get("clips")->set(track_id,Value::of(id));
  Value playback = Value::new_object();
  playback.set("mode",Value::of("one-shot")),playback.set("rootNote",Value::of(60.0)),playback.set("chokeGroup",Value::of(0.0));
  detail::bank(e.project,&track_id)[pad].set("playback",playback);
  if (auto* perf = e.project.get("performance")) {
    if (auto* selection = perf->get("selection")) {
      if (detail::text(*selection,"sceneId") == scene_id) selection->get("clips")->set(track_id,Value::of(id));
    }
  }
  const auto& input = project::detail::at(project::detail::at(project::detail::at(project::detail::at(project,"extensions"),"xmp.sampler-input"),"data"),"tracks");
  const auto& descriptor=project::detail::at(project::detail::at(project,"extensions"),"xmp.sampler-input");
  if (descriptor.is_object() && project::detail::num(descriptor,"version") != 1) return detail::finish(e.project);
  const auto* settings = input.get(track_id.c_str());
  const bool monitor = !settings || project::detail::at(*settings,"monitor").as_bool();
  return sampler_input(e.project,track_id,monitor,bars);
}

inline Edited chop_sample_to_kit(const Value& project, const Str& track_id, const Str& name, double rate,
                                 const Vec<double>& pcm, const Vec<double>& boundaries) {
  auto e = own_kit(project, track_id);
  if (!e.ok) return e;
  e = install_sample(e.project, 0, name, rate, pcm, &track_id);
  if (!e.ok) return e;
  e = manual_slices(e.project, 0, boundaries, &track_id);
  if (!e.ok) return e;
  Str silence;
  if (boundaries.size() < 17) {
    Vec<double> empty;
    empty.push(0);
    e = install_sample(e.project, boundaries.size() - 1, Str("Empty"), rate, empty, &track_id);
    if (!e.ok) return e;
    silence = detail::text(detail::bank(e.project, &track_id)[boundaries.size() - 1], "sampleId");
  }
  auto& own = detail::bank(e.project, &track_id);
  for (int32_t i = 0; i < own.size(); ++i) {
    Value playback = Value::new_object();
    playback.set("mode", Value::of("one-shot")), playback.set("rootNote", Value::of(60.0));
    playback.set("chokeGroup", Value::of(0.0)), own[i].set("playback", playback);
    if (i >= boundaries.size() - 1) {
      own[i].set("sampleId", Value::of(silence)), own[i].set("name", Value::of("Empty"));
      own[i].remove("slice"), own[i].remove("layers"), own[i].remove("edit");
    }
  }
  Value machine = Value::new_object();
  machine.set("id", Value::of("xmp.sampler")), machine.set("base", Value::of("audio"));
  machine.set("version", Value::of(1.0)), machine.set("state", Value::new_object());
  detail::track(e.project, track_id)->set("machine", machine);
  return detail::finish(e.project);
}
// validateDrumKit, then applyDrumKit: replaces the pad bank; events and machines stay.
inline Edited apply_drum_kit(const Value& project, const Value& kit, const Str* track_id = nullptr) {
  const Value* samples = kit.is_object() ? kit.get("samples") : nullptr;
  // `!value || typeof value !== "object" || !("samples" in value) || ...`
  if (!samples || !samples->is_array() || samples->items().size() < 1 || samples->items().size() > 16)
    return detail::fail("A drum kit needs 1\xE2\x80\x93" "16 samples");
  double frames = 0, sounds = 0;
  // A take equal to its sound's pcm shares its sample (samePcm).
  const auto same_pcm = [](const Value& a, const Value& b) {
    if (a.items().size() != b.items().size()) return false;
    for (int32_t i = 0; i < a.items().size(); ++i) {
      const Value &x = a.items()[i], &y = b.items()[i];
      if (x.is_number() != y.is_number() || (x.is_number() ? x.as_number() != y.as_number() : !x.is_null() || !y.is_null()))
        return false;
    }
    return true;
  };
  for (const auto& s : samples->items()) {
    const Value* pcm = s.is_object() ? s.get("pcm") : nullptr;
    if (!pcm || !pcm->is_array()) return detail::fail("Invalid drum kit sample");
    Vec<const Value*> sounds_of;
    sounds_of.push(pcm);
    if (const Value* layers = s.get("layers")) {
      if (!layers->is_array()) return detail::fail("Invalid drum kit sample");
      for (const auto& layer : layers->items()) {
        const Value* takes = layer.is_object() ? layer.get("takes") : nullptr;
        if (!takes || !takes->is_array()) return detail::fail("Invalid drum kit sample");
        for (const auto& take : takes->items()) {
          const Value* t = take.is_object() ? take.get("pcm") : nullptr;
          if (!t || !t->is_array()) return detail::fail("Invalid drum kit sample");
          if (!same_pcm(*t, *pcm)) sounds_of.push(t);
        }
      }
    }
    for (const Value* sound : sounds_of) {
      frames += sound->items().size();
      ++sounds;
      if (sound->items().size() > 480000 || frames > 1000000 - (samples->items().size() < 16 ? 1 : 0))
        return detail::fail("Drum kit exceeds the one-million-frame project budget");
    }
  }
  if (sounds > 120) return detail::fail("A drum kit holds at most 120 sounds");
  // KitSchema
  {
    schema::Builder b;
    using schema::field;
    schema::Node& sample = b.object();
    field(sample, "name", b.text(1, 120)), field(sample, "sampleRate", b.integer(8000, 96000));
    field(sample, "pcm", b.array(b.number(-1, 1), 1, 480000)), field(sample, "choke", b.integer(0, 8), true);
    schema::Node& take = b.object();
    field(take, "sampleRate", b.integer(8000, 96000)), field(take, "pcm", b.array(b.number(-1, 1), 1, 480000));
    schema::Node& layer = b.object();
    field(layer, "upTo", b.number(0, 1)), field(layer, "takes", b.array(&take, 1, 8));
    field(sample, "layers", b.array(&layer, 1, 8), true);
    schema::Node& shape = b.object();
    field(shape, "name", b.unknown()), field(shape, "samples", b.array(&sample, 1, 16));
    schema::Checker c;
    Value checked;
    if (!c.check(shape, kit, checked, Str("kit"))) {
      Edited e;
      e.error = c.problem;
      return e;
    }
    // name: z.string().trim().min(1).max(80), checked after trimming
    const Value& name = view::field(kit, "name");
    if (!name.is_string()) return detail::fail("kit.name: expected a string");
    const Str trimmed = detail::js_trim(name.as_string());
    if (trimmed.code_points() < 1 || trimmed.code_points() > 80) return detail::fail("kit.name: text out of bounds");
    for (const auto& s : samples->items()) {
      const Value* layers = s.get("layers");
      if (!layers) continue;
      double top = 0;
      for (const auto& layer : layers->items()) {
        if (!(detail::number(layer, "upTo") > top)) return detail::fail("Drum kit layers must rise in velocity");
        top = detail::number(layer, "upTo");
      }
      if (top != 1) return detail::fail("A drum kit sound's last layer must reach full velocity");
    }
  }
  Value next = project;
  const auto& list = samples->items();
  // The track's own kit when it has one, else the project's pads; samples no
  // pad plays any more go, and the kit's take fresh ids.
  Value* owner = track_id ? detail::track(next, *track_id) : nullptr;
  if (owner && !owner->get("pads")) owner = nullptr;
  auto& old = owner ? detail::items(*owner, "pads") : detail::items(next, "pads");
  Vec<Value> previous = old;
  for (auto& pad : old) {
    pad.set("sampleId", Value::of(""));
    pad.remove("layers");
  }
  detail::drop_unused_samples(next);
  auto& kept = detail::items(next, "samples");
  Vec<Str> taken;
  for (const auto& s : kept) taken.push(detail::text(s, "id"));
  const auto unique = [&](const Str& base) {
    Str id = base;
    for (int32_t n = 1;; ++n) {
      bool used = false;
      for (const auto& t : taken) used = used || t == id;
      if (!used) break;
      id = base + "-" + int_text(n);
    }
    taken.push(id);
    return id;
  };
  Vec<Str> ids;
  for (int32_t i = 0; i < list.size(); ++i) ids.push(unique(Str("kit-") + int_text(i)));
  for (int32_t i = 0; i < list.size(); ++i) {
    Value s = Value::new_object();
    s.set("name", view::field(list[i], "name"));
    s.set("sampleRate", view::field(list[i], "sampleRate"));
    s.set("pcm", view::field(list[i], "pcm"));
    s.set("id", Value::of(ids[i]));
    kept.push(xmp::move(s));
  }
  // Each layered sound's takes, after every sound (ids kit-<pad>-<layer>-<take>).
  Vec<Value> layered;
  for (int32_t i = 0; i < list.size(); ++i) {
    const Value* layers = list[i].get("layers");
    if (!layers) {
      layered.push(Value());
      continue;
    }
    Value out = Value::new_array();
    for (int32_t l = 0; l < layers->items().size(); ++l) {
      const Value& layer = layers->items()[l];
      Value ids_of_layer = Value::new_array();
      const auto& takes = view::field(layer, "takes").items();
      for (int32_t t = 0; t < takes.size(); ++t) {
        if (same_pcm(view::field(takes[t], "pcm"), view::field(list[i], "pcm"))) {
          ids_of_layer.push(Value::of(ids[i]));
          continue;
        }
        const Str id = unique(Str("kit-") + int_text(i) + "-" + int_text(l) + "-" + int_text(t));
        Value s = Value::new_object();
        s.set("id", Value::of(id));
        s.set("name", Value::of((detail::text(list[i], "name") + " " + int_text(l + 1) + "." + int_text(t + 1))
                                    .utf16_prefix(120)));
        s.set("sampleRate", view::field(takes[t], "sampleRate"));
        s.set("pcm", view::field(takes[t], "pcm"));
        kept.push(xmp::move(s));
        ids_of_layer.push(Value::of(id));
      }
      Value entry = Value::new_object();
      entry.set("upTo", view::field(layer, "upTo"));
      entry.set("samples", xmp::move(ids_of_layer));
      out.push(xmp::move(entry));
    }
    layered.push(xmp::move(out));
  }
  Str empty_id;
  if (list.size() < 16) {
    empty_id = unique(Str("kit-empty"));
    Value empty = Value::new_object();
    empty.set("id", Value::of(empty_id)), empty.set("name", Value::of("Empty"));
    empty.set("sampleRate", detail::num(48000));
    Value zero = Value::new_array();
    zero.push(detail::num(0));
    empty.set("pcm", xmp::move(zero));
    kept.push(xmp::move(empty));
  }
  auto& pads = owner ? detail::items(*owner, "pads") : detail::items(next, "pads");
  for (int32_t i = 0; i < pads.size(); ++i) {
    Value pad = Value::new_object();
    pad.set("id", view::field(previous[i], "id"));
    pad.set("name", Value::of(i < list.size() ? detail::text(list[i], "name").utf16_prefix(40) : Str("Empty")));
    pad.set("sampleId", Value::of(i < list.size() ? ids[i] : empty_id));
    Value playback = Value::new_object();
    playback.set("mode", Value::of("one-shot")), playback.set("rootNote", detail::num(60));
    const Value* choke = i < list.size() ? list[i].get("choke") : nullptr;
    playback.set("chokeGroup", detail::num(choke ? choke->as_number() : 0));
    pad.set("playback", xmp::move(playback));
    if (i < layered.size() && !layered[i].is_null()) pad.set("layers", layered[i]);
    pads[i] = xmp::move(pad);
  }
  if (kept.size() > project::kMaxSamples)
    return detail::fail("Project already uses too many sounds. Free sample slots before loading this kit.");
  return detail::finish(next);
}

}  // namespace xmp::edit
