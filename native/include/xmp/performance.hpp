#pragma once
// Playing XMP projects in C++, part 2: the performance, reading the project
// document directly. The C++ port of packages/core performance.ts and the
// layout in controls-engine.ts: the performance transport (scenes, clips,
// launches, song mode, live control overrides), performanceControls,
// performanceValues and performanceWindow, the step-by-step work of playing a
// project. The engines are transport.hpp, controls.hpp and sequencer.hpp (via
// play.hpp), the same code the browser runs as WebAssembly.
// tests/parity/performance-play-parity.test.ts compares these with the TypeScript.
#include "xmp/controls.hpp"
#include "xmp/play.hpp"
#include "xmp/transport.hpp"

namespace xmp::play {

using json::Value;

namespace detail {
// sceneLength
inline double scene_length(const Value& project, const Value& scene) {
  double length = 16;
  for (const auto& t : list(project, "tracks")) {
    double l = 16;
    if (const Value* cid = at(scene, "clips").get(str(t, "id").c_str()))
      for (const auto& c : list(t, "clips"))
        if (str(c, "id") == cid->as_string()) l = num(c, "length");
    length = fmax(length, l);
  }
  return length;
}
// midiDestination: the index of the track a MIDI source plays, or -1.
inline int32_t midi_destination(const Value& project, int32_t source) {
  const auto& tracks = list(project, "tracks");
  const auto& m = machine::machines();
  const machine::Definition* d = m.get(tracks[source].get("machine"));
  if (!d || d->id != "xmp.midi") return -1;
  const Value* dest = at(at(tracks[source], "machine"), "state").get("destination");
  if (!dest || !dest->is_string()) return -1;
  for (int32_t t = 0; t < tracks.size(); ++t) {
    if (t == source || str(tracks[t], "id") == str(tracks[source], "id")) continue;
    const machine::Definition* target = m.get(tracks[t].get("machine"));
    if (target && (target->id == "xmp.sampler" || target->id == "xmp.subtractive") &&
        str(tracks[t], "id") == dest->as_string())
      return t;
  }
  return -1;
}
// IDs as numbers, for the engines.
struct Names {
  Vec<Str> names;
  int32_t uid(const Str& id) {
    for (int32_t i = 0; i < names.size(); ++i)
      if (names[i] == id) return i;
    names.push(id);
    return names.size() - 1;
  }
  Str name(int32_t n) const { return n >= 0 && n < names.size() ? names[n] : Str(); }
};
inline controls::Controls& controls_engine() {
  static controls::Controls* c = new (checked_alloc(sizeof(controls::Controls))) controls::Controls();
  return *c;
}
}  // namespace detail

// Live control overrides: "mute:<track>", "solo:<track>", "macro:<macro>" in
// insertion order (a JavaScript Map).
struct Overrides {
  Vec<json::Member> entries;
  void set(const Str& key, Value v) {
    for (auto& e : entries)
      if (e.key == key) return void(e.value = xmp::move(v));
    entries.push(json::Member{key, xmp::move(v)});
  }
  void clear() { entries.clear(); }
};

// loadControls: a project's controls laid out in the C++ controls.
// `valid`: the registry's IDs (macro assignments to other IDs are
// unavailable), or null to accept every assignment.
inline bool load_controls(const Value& project, const Overrides& overrides, const Vec<Str>* valid,
                          detail::Names& names, Str& error) {
  using namespace detail;
  controls::Controls& c = controls_engine();
  controls::Setup& s = c.setup;
  auto fail = [&]() { return error = "Performance controls budget exceeded", false; };
  s.track_count = s.mute_count = s.solo_count = s.macro_count = 0;
  s.total_assignments = s.event_count = s.override_count = s.tempo_count = 0;
  s.bpm = num(project, "bpm");
  const auto& tracks = list(project, "tracks");
  for (int32_t t = 0; t < tracks.size(); ++t) {
    if (s.track_count >= controls::kTracks) return fail();
    s.track[s.track_count] = names.uid(str(tracks[t], "id"));
    s.muted[s.track_count] = at(tracks[t], "muted").as_bool();
    s.destination[s.track_count++] = midi_destination(project, t);
  }
  auto kind_of = [](const Str& k) { return k == "mute" ? 0 : k == "solo" ? 1 : k == "macro" ? 2 : -1; };
  if (const Value* p = project.get("performance")) {
    for (const auto& m : at(*p, "mutes").members()) {
      if (s.mute_count >= controls::kKeys) return fail();
      s.mutes[s.mute_count++] = {names.uid(m.key), m.value.as_bool() ? 1.0 : 0.0};
    }
    for (const auto& solo : list(*p, "solos")) {
      if (s.solo_count >= controls::kKeys) return fail();
      s.solos[s.solo_count++] = names.uid(solo.as_string());
    }
    for (const auto& m : list(*p, "macros")) {
      if (s.macro_count >= controls::kMacros) return fail();
      s.macro[s.macro_count] = names.uid(str(m, "id"));
      s.macro_value[s.macro_count] = num(m, "value");
      s.assignment_start[s.macro_count] = s.total_assignments;
      s.assignment_count[s.macro_count++] = 0;
      for (const auto& a : list(m, "assignments")) {
        if (s.total_assignments >= controls::kAssignments) return fail();
        bool ok = !valid;
        for (int32_t i = 0; valid && !ok && i < valid->size(); ++i) ok = (*valid)[i] == str(a, "parameter");
        s.assignments[s.total_assignments++] = {names.uid(str(a, "parameter")), num(a, "amount"), ok};
        ++s.assignment_count[s.macro_count - 1];
      }
    }
    for (const auto& e : list(*p, "events")) {
      if (s.event_count >= controls::kEvents) return fail();
      const Str& kind = str(e, "kind");
      const Value& v = at(e, "value");
      s.events[s.event_count++] = {kind_of(kind), names.uid(kind == "macro" ? str(e, "macroId") : str(e, "trackId")),
                                   v.is_bool() ? (v.as_bool() ? 1.0 : 0.0) : v.as_number(), num(e, "at")};
    }
  }
  for (const auto& o : overrides.entries) {
    const char* colon = strchr(o.key.c_str(), ':');
    if (!colon) continue;
    const int32_t kind = kind_of(o.key.slice(0, static_cast<size_t>(colon - o.key.c_str())));
    if (kind < 0) continue;
    if (s.override_count >= controls::kOverrides) return fail();
    const Value& v = o.value;
    s.overrides[s.override_count++] = {kind, names.uid(Str(colon + 1)),
                                       v.is_bool() ? (v.as_bool() ? 1.0 : 0.0) : v.as_number(), 0};
  }
  if (const Value* mix = project.get("mix"))
    for (const auto& t : list(*mix, "tempos")) {
      if (s.tempo_count >= controls::kTempos) return fail();
      s.tempo_step[s.tempo_count] = num(t, "step");
      s.tempo_bpm[s.tempo_count++] = num(t, "bpm");
    }
  return true;
}

// performanceControls' answer, as JSON in the TypeScript's shape.
inline Value read_controls(const Value& project, const detail::Names& names) {
  const controls::Controls& c = detail::controls_engine();
  Value mutes = Value::new_object(), solos = Value::new_array(), macros = Value::new_object(),
        offsets = Value::new_object(), blocked = Value::new_array(), unavailable = Value::new_array();
  for (int32_t i = 0; i < c.mutes.count; ++i)
    mutes.set(names.name(c.mutes.items[i].key), Value::of(c.mutes.items[i].value != 0));
  for (int32_t i = 0; i < c.solos.count; ++i) solos.push(Value::of(names.name(c.solos.items[i].key)));
  for (int32_t i = 0; i < c.macros.count; ++i) macros.set(names.name(c.macros.items[i].key), Value::of(c.macros.items[i].value));
  for (int32_t i = 0; i < c.offsets.count; ++i)
    offsets.set(names.name(c.offsets.items[i].key), Value::of(c.offsets.items[i].value));
  const auto& tracks = detail::list(project, "tracks");
  for (int32_t i = 0; i < c.blocked_count; ++i)
    blocked.push(Value::of(c.blocked[i] < tracks.size() ? detail::str(tracks[c.blocked[i]], "id") : Str()));
  for (int32_t i = 0; i < c.unavailable_count; ++i) unavailable.push(Value::of(names.name(c.unavailable[i])));
  Value out = Value::new_object();
  out.set("mutes", xmp::move(mutes)), out.set("solos", xmp::move(solos)), out.set("macros", xmp::move(macros));
  out.set("offsets", xmp::move(offsets)), out.set("blocked", xmp::move(blocked));
  out.set("unavailable", xmp::move(unavailable));
  return out;
}

// performanceControls
inline bool performance_controls(const Value& project, double position, const Overrides& overrides, Value& out,
                                 Str& error) {
  if (!isfinite(position) || position < 0 || position > 1000000) return error = "Invalid control position", false;
  Vec<Str> ids;
  for (const auto& d : parameters::registry(project)) ids.push(d.id);
  detail::Names names;
  if (!load_controls(project, overrides, &ids, names, error)) return false;
  detail::controls_engine().evaluate(position, true);
  out = read_controls(project, names);
  return true;
}

// ---- the performance transport ----
class Performance {
 public:
  Overrides overrides;

  explicit Performance(const Value& project) : transport_(new (checked_alloc(sizeof(transport::Transport))) transport::Transport()) {
    transport_->init();
    project_ = project;
    ok_ = load(project, true, error_);
    const auto& scenes = detail::list(project, "scenes");
    default_scene_ = scenes.size() ? detail::str(scenes[0], "id") : Str();
  }
  ~Performance() {
    transport_->~Transport();
    free(transport_);
  }
  Performance(const Performance&) = delete;
  Performance& operator=(const Performance&) = delete;

  // false (with the message) when the constructor's project exceeded the transport.
  bool ok() const { return ok_; }
  const Str& error() const { return error_; }
  const Value& project() const { return project_; }

  Str scene_id() const { return transport_->has_scene ? names_.name(transport_->scene) : default_scene_; }
  bool running() const { return transport_->running; }
  bool song() const { return transport_->song; }
  double step() const { return transport_->step; }
  double song_offset() const { return transport_->song_offset; }
  double clock_origin() const { return transport_->clock_origin; }
  // The clip each track plays (none: stopped) and where it started.
  struct Slot {
    Str track, clip;
    bool has_clip = false;
    double anchor = 0;
  };
  Vec<Slot> slots() const {
    Vec<Slot> out;
    for (int32_t i = 0; i < transport_->slot_count; ++i) {
      const auto& s = transport_->slots[i];
      Slot slot;
      slot.track = names_.name(s.track), slot.has_clip = s.clip >= 0;
      if (slot.has_clip) slot.clip = names_.name(s.clip);
      slot.anchor = s.anchor;
      out.push(xmp::move(slot));
    }
    return out;
  }
  const Slot* slot(const Vec<Slot>& all, const Str& track) const {
    for (const auto& s : all)
      if (s.track == track) return &s;
    return nullptr;
  }

  // An edited clip (same track, index, id and length, so the transport's
  // tables still hold): the next window plays it.
  bool replace_clip(int32_t track, int32_t clip, const Value& value) {
    Value* tracks = project_.get("tracks");
    if (!tracks || track < 0 || track >= tracks->items().size()) return false;
    Value* clips = tracks->items()[track].get("clips");
    if (!clips || clip < 0 || clip >= clips->items().size()) return false;
    Value& old = clips->items()[clip];
    if (detail::str(old, "id") != detail::str(value, "id") || detail::num(old, "length") != detail::num(value, "length"))
      return false;
    old = value;
    return true;
  }
  bool set_project(const Value& project, Str& error) {
    if (!load(project, false, error)) return false;
    project_ = project;
    prepared_ok_ = false;
    return true;
  }
  // The project's parameters (registry and sources), worked out on first use
  // and kept until the project changes: every window needs them.
  const detail::Prepared* prepared(Str& error) const {
    if (!prepared_ok_) {
      if (!detail::prepare_parameters(project_, prepared_, error)) return nullptr;
      prepared_ok_ = true;
    }
    return &prepared_;
  }
  bool start(const Str& scene, bool song_mode, bool resume, Str& error) {
    overrides.clear();
    return fail(transport_->start(names_.uid(scene), song_mode, resume), error);
  }
  bool start(Str& error) { return start(scene_id(), false, false, error); }
  bool queue_scene(const Str& scene, Str& error) {
    bool known = false;
    for (const auto& s : detail::list(project_, "scenes")) known = known || detail::str(s, "id") == scene;
    if (!known) return error = "Unknown scene", false;
    transport_->queue_scene(names_.uid(scene));
    return true;
  }
  bool queue_clip(const Str& track, const Str* clip, Str& error) {
    const Value* t = nullptr;
    for (const auto& x : detail::list(project_, "tracks"))
      if (detail::str(x, "id") == track) t = &x;
    bool has = !clip;
    if (t && clip)
      for (const auto& c : detail::list(*t, "clips")) has = has || detail::str(c, "id") == *clip;
    if (!t || !has) return error = "Unknown clip or track", false;
    transport_->queue_clip(names_.uid(track), clip ? names_.uid(*clip) : -1);
    return true;
  }
  bool queue_recorded_loop(const Str& track, const Str* clip, double at, Str& error) {
    if (!isfinite(at) || at < transport_->step || !queue_clip(track,clip,error)) return false;
    return transport_->queue_clip_at(names_.uid(track),clip ? names_.uid(*clip) : -1,at);
  }
  bool stop_clip_now(const Str& track) { return transport_->stop_clip_now(names_.uid(track)); }
  void cancel_clip_launch(const Str& track) { transport_->cancel_clip(names_.uid(track)); }
  bool cancel_launch() { return transport_->cancel(); }
  // Launches waiting for the next bar: a scene, or clips (no clip: the track stops).
  struct Queued {
    Str track, clip;
    bool has_clip = false;
    double at = 0;  // the step it lands on
  };
  Vec<Queued> queued() const {
    Vec<Queued> out;
    for (int32_t i = 0; i < transport_->queued_count; ++i) {
      Queued q;
      q.track = names_.name(transport_->queued[i].track), q.has_clip = transport_->queued[i].clip >= 0;
      q.at = transport_->queued[i].at;
      if (q.has_clip) q.clip = names_.name(transport_->queued[i].clip);
      out.push(xmp::move(q));
    }
    return out;
  }
  // The song block (chain occurrence) the performance is in, while it plays a song.
  bool occurrence(Str& id) const {
    if (!transport_->has_occurrence) return false;
    id = names_.name(transport_->occurrence.id);
    return true;
  }
  double queued_scene_at() const { return transport_->queued_scene_at; }
  bool queued_scene(Str& scene) const {
    if (!transport_->has_queued_scene) return false;
    scene = names_.name(transport_->queued_scene);
    return true;
  }
  void stop() {
    transport_->stop();
    overrides.clear();
  }
  // control: a live mute, solo or macro change (a performance event).
  bool control(const Value& event, Str& error) {
    schema::Checker c;
    Value e;
    if (!c.check(*project::schemas().performance_event, event, e, Str("event"))) return error = c.problem, false;
    const Str& kind = detail::str(e, "kind");
    bool known = false;
    if (kind == "macro") {
      if (const Value* p = project_.get("performance"))
        for (const auto& m : detail::list(*p, "macros")) known = known || detail::str(m, "id") == detail::str(e, "macroId");
    } else
      for (const auto& t : detail::list(project_, "tracks")) known = known || detail::str(t, "id") == detail::str(e, "trackId");
    if (!known) return error = "Control target unavailable", false;
    overrides.set(kind == "macro" ? Str("macro:") + detail::str(e, "macroId") : kind + ":" + detail::str(e, "trackId"),
                  detail::at(e, "value"));
    return true;
  }
  // advance: the clock to `to`; the tracks released on the way.
  bool advance(double to, Vec<Str>& releases, Str& error) {
    const double s = transport_->step;
    if (to != floor(to) || to < fmax(0, s) || to > 1000000 || to - s > 4096)
      return error = "Invalid performance clock advance", false;
    if (!fail(transport_->advance(to), error)) return false;
    for (int32_t i = 0; i < transport_->release_count; ++i) releases.push(names_.name(transport_->releases[i]));
    transport_->clear_releases();
    return true;
  }
  Value snapshot() const {
    Value clips = Value::new_object(), anchors = Value::new_object();
    for (const auto& s : slots()) {
      if (s.has_clip) clips.set(s.track, Value::of(s.clip));
      anchors.set(s.track, Value::of(s.anchor));
    }
    const double st = transport_->step;
    Value out = Value::new_object();
    out.set("sceneId", Value::of(scene_id()));
    out.set("clips", xmp::move(clips));
    out.set("anchors", xmp::move(anchors));
    out.set("running", Value::of(transport_->running));
    out.set("step", Value::of(fmax(0, st)));
    if (transport_->has_occurrence) {
      Value position = Value::new_object();
      position.set("occurrenceId", Value::of(names_.name(transport_->occurrence.id)));
      const double span = transport_->occurrence_length * transport_->occurrence.repeats;
      position.set("offset", Value::of(fmin(span - 1, fmax(0, st - transport_->occurrence_start))));
      out.set("position", xmp::move(position));
    }
    return out;
  }

 private:
  static bool fail(int32_t code, Str& error) {
    if (code == 1) return error = "Add a song occurrence first", false;
    if (code == 2) return error = "Scene unavailable", false;
    if (code == 3) return error = "Missing scene", false;
    return true;
  }
  bool load(const Value& project, bool first, Str& error) {
    using namespace detail;
    const Value* p = project.get("performance");
    const auto& tracks = list(project, "tracks");
    const auto& scenes = list(project, "scenes");
    const int32_t chain = p ? list(*p, "chain").size() : 0;
    if (tracks.size() > transport::kTracks || scenes.size() > transport::kScenes || chain > transport::kChain)
      return error = "Project exceeds the transport budget", false;
    transport::Project& n = transport_->next;
    const Value* launch = detail::at(project, "performance").get("launchQuantize");
    n = transport::Project{};
    n.launch_grid = launch && launch->is_number() ? launch->as_number() : 16;
    n.track_count = tracks.size(), n.scene_count = scenes.size();
    n.loop = p && str(*p, "end") == "loop";
    const Value* position = p ? p->get("position") : nullptr;
    const Value* selection = p ? p->get("selection") : nullptr;
    n.has_position = position != nullptr;
    n.position_occurrence = position ? names_.uid(str(*position, "occurrenceId")) : 0;
    n.position_offset = position ? num(*position, "offset") : 0;
    n.has_selection = selection != nullptr;
    n.selection_scene = selection ? names_.uid(str(*selection, "sceneId")) : 0;
    for (int32_t i = 0; i < tracks.size(); ++i) {
      const auto& clips = list(tracks[i], "clips");
      if (clips.size() > transport::kClips) return error = "Project exceeds the transport budget", false;
      n.track[i] = names_.uid(str(tracks[i], "id"));
      n.clip_count[i] = clips.size();
      for (int32_t k = 0; k < clips.size(); ++k) n.clips[i][k] = names_.uid(str(clips[k], "id"));
      const Value* selected = selection ? at(*selection, "clips").get(str(tracks[i], "id").c_str()) : nullptr;
      n.selection_clip[i] = selected ? names_.uid(selected->as_string()) : -1;
    }
    for (int32_t i = 0; i < scenes.size(); ++i) {
      n.scene[i] = names_.uid(str(scenes[i], "id"));
      n.scene_length[i] = scene_length(project, scenes[i]);
      for (int32_t t = 0; t < tracks.size(); ++t) {
        const Value* clip = at(scenes[i], "clips").get(str(tracks[t], "id").c_str());
        n.scene_clip[i][t] = clip ? names_.uid(clip->as_string()) : -1;
      }
    }
    if (p)
      for (const auto& e : list(*p, "chain"))
        n.chain[n.chain_count++] = {names_.uid(str(e, "id")), names_.uid(str(e, "sceneId")),
                                    static_cast<int32_t>(num(e, "repeats"))};
    transport_->commit_project(first);
    return true;
  }

  transport::Transport* transport_;
  detail::Names names_;
  Value project_;
  Str default_scene_, error_;
  bool ok_ = false;
  mutable detail::Prepared prepared_;
  mutable bool prepared_ok_ = false;
};

// ---- values and the window ----
namespace detail {
inline bool timing(int32_t error, Str& message) {
  if (error == controls::invalid_groove) return message = "Invalid groove", false;
  if (error == controls::invalid_position) return message = "Invalid musical position", false;
  return true;
}
}  // namespace detail

// performanceEvaluator: every parameter's value at song positions of the
// transport's playing clips, laid out once (the registry and sources in the
// sequencer, the controls in the controls engine).
class Evaluator {
 public:
  bool load(const Performance& perf, Str& error) {
    using namespace detail;
    perf_ = &perf;
    const Value& project = perf.project();
    const detail::Prepared* prepared = perf.prepared(error);
    if (!prepared) return false;
    Vec<parameters::Definition> registry = prepared->registry;
    ids_.clear();
    for (const auto& d : registry) ids_.push(d.id);
    names_ = Names{};
    if (!load_controls(project, perf.overrides, &ids_, names_, error)) return false;
    const auto slots = perf.slots();
    playing_.clear();
    Vec<const Value*> clips;
    for (const auto& track : list(project, "tracks")) {
      const Performance::Slot* slot = perf.slot(slots, str(track, "id"));
      if (!slot || !slot->has_clip) continue;
      const Value* clip = nullptr;
      for (const auto& c : list(track, "clips"))
        if (str(c, "id") == slot->clip) clip = &c;
      if (!clip) continue;
      Playing p;
      p.anchor = slot->anchor;
      Vec<Str> named;
      if (const Value* seq = clip->get("sequence")) {
        static const char* kGroups[] = {"lanes", "locks", "modulations"};
        for (const char* g : kGroups)
          for (const auto& x : list(*seq, g)) named.push(str(x, "parameter"));
      }
      const Str own = Str("track.") + str(track, "id") + ".";
      for (int32_t i = 0; i < ids_.size(); ++i) {
        bool by_name = false;
        for (const auto& n : named) by_name = by_name || n == ids_[i];
        if (ids_[i].starts_with(own) || ((ids_[i] == "master.gain" || ids_[i].starts_with("return.")) && by_name))
          p.sets.push(i);
      }
      playing_.push(xmp::move(p));
      clips.push(clip);
    }
    return table_.load(project, xmp::move(registry), clips, error, &prepared->sources);
  }
  // performanceValues at `position`: {values, blocked, unavailable}.
  bool at(double position, Value& out, Str& error) {
    using namespace detail;
    const Value& project = perf_->project();
    const double where = fmax(0, position + perf_->song_offset());
    if (!isfinite(where) || where > 1000000) return error = "Invalid control position", false;
    controls_engine().evaluate(where, true);
    const Value control = read_controls(project, names_);
    const int32_t n = ids_.size();
    Vec<double> offsets;
    for (int32_t i = 0; i < n; ++i) offsets.push(NAN);
    for (const auto& m : project::detail::at(control, "offsets").members())
      for (int32_t i = 0; i < n; ++i)
        if (ids_[i] == m.key) offsets[i] = m.value.as_number();
    const double* base = nullptr;
    if (!table_.frame(0, offsets.begin(), -1, base, error)) return false;
    Vec<double> values;
    for (int32_t i = 0; i < n; ++i) values.push(base[i]);
    for (int32_t k = 0; k < playing_.size(); ++k) {
      const int32_t only = table_.tracks[k];
      if (only < 0) continue;
      const double* frame = nullptr;
      if (!table_.frame(fmax(0, position - playing_[k].anchor), offsets.begin(), only, frame, error)) return false;
      for (const int32_t i : playing_[k].sets) values[i] = frame[i];
    }
    Value record = Value::new_object();
    for (int32_t i = 0; i < n; ++i) record.set(ids_[i], Value::of(values[i]));
    for (const auto& b : project::detail::list(control, "blocked"))
      record.set(Str("track.") + b.as_string() + ".gain", Value::of(0.0));
    out = Value::new_object();
    out.set("values", xmp::move(record));
    out.set("blocked", project::detail::at(control, "blocked"));
    out.set("unavailable", project::detail::at(control, "unavailable"));
    return true;
  }

 private:
  struct Playing {
    double anchor = 0;
    Vec<int32_t> sets;
  };
  const Performance* perf_ = nullptr;
  Vec<Str> ids_;
  detail::Names names_;
  Vec<Playing> playing_;
  ParameterTable table_;
};

inline bool performance_values(const Performance& perf, double position, Value& out, Str& error) {
  Evaluator e;
  return e.load(perf, error) && e.at(position, out, error);
}

// performanceWindow: advance to `step`, then everything due in [step, step + 1):
// the notes (unless silenced), their frames, and the control values at each
// change, as JSON in the TypeScript's shape.
inline bool performance_window(Performance& perf, double step, bool fill, double swing, double rate, Value& out,
                               Str& error) {
  using namespace detail;
  Vec<Str> releases;
  if (!perf.advance(step, releases, error)) return false;
  const Value snapshot = perf.snapshot();
  const Value& project = perf.project();
  Vec<double> positions;
  auto add = [&](double x) {
    for (const double p : positions)
      if (p == x) return;
    positions.push(x);
  };
  add(step), add(step + 0.25), add(step + 0.5), add(step + 0.75);
  const double origin = perf.clock_origin();
  Names names;
  if (!load_controls(project, perf.overrides, nullptr, names, error)) return false;
  controls::Controls& c = controls_engine();
  auto frame = [&](double position, double& f) {
    int32_t e = 0;
    f = c.window_frame(position, swing, rate, origin, e);
    return timing(e, error);
  };
  Value releases_json = Value::new_array();
  for (const auto& r : releases) releases_json.push(Value::of(r));
  out = Value::new_object();
  if (project.get("mix")) {
    int32_t e = 0;
    const double seconds = c.window_seconds(step, origin, e);
    if (!timing(e, error)) return false;
    out.set("startFrame", Value::of(edit::detail::js_round(seconds * rate)));
    Value clock = Value::new_object();
    clock.set("step", Value::of(step + origin));
    clock.set("bpm", Value::of(c.tempo_at(step + origin)));
    out.set("clock", xmp::move(clock));
  }
  out.set("snapshot", snapshot);
  out.set("releases", xmp::move(releases_json));
  if (!at(snapshot, "running").as_bool()) {
    out.set("notes", Value::new_array());
    out.set("controls", Value::new_array());
    return true;
  }
  Vec<Note> notes;
  const auto slots = perf.slots();
  const auto& tracks = list(project, "tracks");
  for (int32_t t = 0; t < tracks.size(); ++t) {
    const Value& track = tracks[t];
    const Performance::Slot* slot = perf.slot(slots, str(track, "id"));
    if (!slot || !slot->has_clip) continue;
    const Value* clip = nullptr;
    for (const auto& cl : list(track, "clips"))
      if (str(cl, "id") == slot->clip) clip = &cl;
    if (!clip) continue;
    // A one-track project playing this clip as its only scene.
    Value context = Value::new_object();
    context.set("id", at(project, "id"));
    context.set("bpm", at(project, "bpm"));
    context.set("seed", at(project, "seed"));
    context.set("pads", at(project, "pads"));
    Value one = Value::new_array();
    one.push(track);
    context.set("tracks", xmp::move(one));
    Value scene = Value::new_object();
    scene.set("id", Value::of("performance")), scene.set("name", Value::of("Performance"));
    Value sc = Value::new_object();
    sc.set(str(track, "id"), Value::of(slot->clip));
    scene.set("clips", xmp::move(sc));
    Value scenes = Value::new_array();
    scenes.push(xmp::move(scene));
    context.set("scenes", xmp::move(scenes));
    const double local = step - slot->anchor;
    Vec<Note> found;
    if (!timeline(context, Str("performance"), local, local + 1, fill, swing, rate, found, error)) return false;
    for (auto& n : found) {
      const double absolute = slot->anchor + n.position, where = fmax(0, absolute + perf.song_offset());
      if (!isfinite(where) || where > 1000000) return error = "Invalid control position", false;
      if (c.is_blocked(t, where)) continue;
      Note note = n;
      note.id = json::number_text(slot->anchor) + ":" + n.id;
      note.position = absolute;
      if (!frame(absolute, note.frame)) return false;
      int32_t e = 0;
      note.duration_frames = c.window_duration(absolute, n.duration, swing, rate, origin, e);
      if (!timing(e, error)) return false;
      notes.push(xmp::move(note));
    }
    if (const Value* seq = clip->get("sequence"))
      for (const auto& lane : list(*seq, "lanes"))
        for (const auto& pt : list(lane, "points")) {
          const double length = num(*clip, "length");
          const double abs = slot->anchor + floor(local / length) * length + num(pt, "position");
          if (abs >= step && abs < step + 1) add(abs);
        }
  }
  if (const Value* p = project.get("performance"))
    for (const auto& e : list(*p, "events")) {
      const double x = num(e, "at") - perf.song_offset();
      if (x >= step && x < step + 1) add(x);
    }
  // Positions in order (insertion sort: a handful), then their frames.
  for (int32_t i = 1; i < positions.size(); ++i)
    for (int32_t k = i; k > 0 && positions[k] < positions[k - 1]; --k) {
      const double tmp = positions[k];
      positions[k] = positions[k - 1], positions[k - 1] = tmp;
    }
  Vec<double> frames;
  for (const double x : positions) {
    double f = 0;
    if (!frame(x, f)) return false;
    frames.push(f);
  }
  // The evaluator reloads the shared controls and sequencer, so it runs last.
  Evaluator values;
  if (!values.load(perf, error)) return false;
  Value controls_json = Value::new_array();
  for (int32_t i = 0; i < positions.size(); ++i) {
    Value v;
    if (!values.at(positions[i], v, error)) return false;
    Value entry = Value::new_object();
    entry.set("position", Value::of(positions[i]));
    entry.set("frame", Value::of(frames[i]));
    for (const auto& m : v.members()) entry.set(m.key, m.value);
    controls_json.push(xmp::move(entry));
  }
  // Notes by frame, then plain code-unit ID order (stable).
  for (int32_t i = 1; i < notes.size(); ++i)
    for (int32_t k = i; k > 0; --k) {
      const Note &a = notes[k - 1], &b = notes[k];
      const bool after = a.frame > b.frame || (a.frame == b.frame && strcmp(a.id.c_str(), b.id.c_str()) > 0);
      if (!after) break;
      Note tmp = xmp::move(notes[k]);
      notes[k] = xmp::move(notes[k - 1]);
      notes[k - 1] = xmp::move(tmp);
    }
  Value notes_json = Value::new_array();
  for (const auto& n : notes) {
    Value o = Value::new_object();
    o.set("id", Value::of(n.id)), o.set("trackId", Value::of(n.track_id));
    o.set("pad", Value::of(static_cast<double>(n.pad))), o.set("note", Value::of(static_cast<double>(n.note)));
    o.set("position", Value::of(n.position)), o.set("duration", Value::of(n.duration));
    o.set("velocity", Value::of(n.velocity)), o.set("cycle", Value::of(static_cast<double>(n.cycle)));
    o.set("frame", Value::of(n.frame)), o.set("durationFrames", Value::of(n.duration_frames));
    notes_json.push(xmp::move(o));
  }
  out.set("notes", xmp::move(notes_json));
  out.set("controls", xmp::move(controls_json));
  return true;
}

}  // namespace xmp::play
