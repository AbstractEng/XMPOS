#pragma once
// Clip edits from the Live's Steps view (phase 8 of docs/cpp-port.md), with
// undo and redo. Edits change one clip of the open project in place: copying
// a whole project (its samples are megabytes of numbers) for every step would
// be far too slow on the Live. Each edit keeps a copy of the clip as it was,
// so undo and redo swap clips back. Everything here runs on the session's main
// thread; the session then hands the changed clip to the player.
//
// The edits match the browser's: a kit step is a step entry for a pad (as
// toggleStep makes it: velocity 0.8, probability 1); a synth step is a step
// entry with its own note, on a pad number no other entry uses at that step,
// so chords keep the rule that a pad plays once per step. Removing a synth
// note also removes a sequence note of that pitch starting on that step.
#include "xmp/chop.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

#include "xmp/json.hpp"
#include "xmp/project.hpp"
#include "xmp/parameters.hpp"
#include "xmp/performance.hpp"
#include "xmp/project_edit.hpp"
#include "xmp/rack.hpp"
#include "xmp/synth_presets.hpp"

namespace xmp::live::edit {

using json::Value;

constexpr int kMaxSteps = 1024;  // StepSchema: a clip holds at most 1024 step entries
constexpr int kHistory = 64;     // undo depth

// Where a clip is: its track's and its own index in the project.
struct Place {
  int track = -1, clip = -1;
  bool ok() const { return track >= 0 && clip >= 0; }
};

inline Place find(const Value& project, const Str& track, const Str& clip) {
  using project::detail::list;
  using project::detail::str;
  const auto& tracks = list(project, "tracks");
  for (int t = 0; t < tracks.size(); ++t) {
    if (str(tracks[t], "id") != track) continue;
    const auto& clips = list(tracks[t], "clips");
    for (int c = 0; c < clips.size(); ++c)
      if (str(clips[c], "id") == clip) return {t, c};
  }
  return {};
}
inline Value& clip_at(Value& project, Place p) {
  return project.get("tracks")->items()[p.track].get("clips")->items()[p.clip];
}
inline const Value& clip_at(const Value& project, Place p) {
  return project.get("tracks")->items()[p.track].get("clips")->items()[p.clip];
}

inline bool is_synth(const Value& project, Place p) {
  const Value* machine = project.get("tracks")->items()[p.track].get("machine");
  return machine && project::detail::str(*machine, "id") == "xmp.subtractive";
}
// Synth and MIDI clips are edited by pitch (each entry keeps its own note);
// kit clips by pad.
inline bool is_melodic(const Value& project, Place p) {
  const Value* machine = project.get("tracks")->items()[p.track].get("machine");
  if (!machine) return false;
  const Str& id = project::detail::str(*machine, "id");
  if(id == "xmp.subtractive" || id == "xmp.midi")return true;
  const auto& pads=project::detail::track_pads(project,&project::detail::list(project,"tracks")[p.track]);
  return id=="xmp.sampler"&&!pads.empty()&&project::detail::str(project::detail::at(pads[0],"playback"),"mode")=="chromatic";
}

// The note a step entry plays (play.hpp's rule): its own, else 48 + pad on a
// synth, else the root note of the track's pad (its own kit, else the project's).
inline int step_note(const Value& project, const Value& step, bool synth, Place p) {
  using project::detail::num;
  if (const Value* n = step.get("note")) return static_cast<int>(n->as_number());
  const int pad = static_cast<int>(num(step, "pad"));
  if (synth) return 48 + pad;
  const auto& tracks = project::detail::list(project, "tracks");
  const auto& pads =
      project::detail::track_pads(project, p.track >= 0 && p.track < tracks.size() ? &tracks[p.track] : nullptr);
  if (pad < pads.size())
    if (const Value* pb = pads[pad].get("playback"))
      if (const Value* root = pb->get("rootNote")) return static_cast<int>(root->as_number());
  return 60;
}

// One row of a clip for the Steps view: velocity 0..1 on every step (0: off),
// for a kit's pad or a synth's note.
struct Row {
  int length = 0;
  std::array<float, kMaxSteps> velocity{};
  std::array<bool,kMaxSteps> locked{};
};

inline Row row(const Value& project, Place p, int pad, int note) {
  using project::detail::list;
  using project::detail::num;
  Row r;
  if (!p.ok()) return r;
  const Value& clip = clip_at(project, p);
  const bool synth = is_melodic(project, p), plain = is_synth(project, p);
  r.length = static_cast<int>(num(clip, "length"));
  for (const auto& s : list(clip, "steps")) {
    const int step = static_cast<int>(num(s, "step"));
    const bool match = synth ? step_note(project, s, plain, p) == note : static_cast<int>(num(s, "pad")) == pad;
    if (match && step >= 0 && step < kMaxSteps) r.velocity[step] = std::fmax(r.velocity[step], static_cast<float>(num(s, "velocity")));
  }
    if (const Value* seq = clip.get("sequence")) {
      for (const auto& n : list(*seq, "notes")) {
        const int step = static_cast<int>(std::floor(num(n, "position")));
        if ((synth?static_cast<int>(num(n,"note"))==note:static_cast<int>(num(n,"pad"))==pad) && step >= 0 && step < kMaxSteps)
          r.velocity[step] = std::fmax(r.velocity[step], static_cast<float>(num(n, "velocity")));
      }
      for(const auto& l:list(*seq,"locks")){const int step=static_cast<int>(num(l,"position"));if(step>=0&&step<kMaxSteps)r.locked[step]=true;}
    }
  return r;
}

// A melodic clip's notes for the piano roll: where each starts (steps), how
// long it lasts, its pitch and velocity; `sequence` for the browser's
// sequence notes (the roll shows them; the Live edits step entries).
struct RollNote {
  double at = 0, length = 1;
  int note = 60;
  float velocity = 0.8f;
  bool sequence = false;
};
struct Roll {
  int length = 0;
  std::vector<RollNote> notes;
};
inline Roll roll(const Value& project, Place p) {
  using project::detail::list;
  using project::detail::num;
  Roll r;
  if (!p.ok() || !is_melodic(project, p)) return r;
  const Value& clip = clip_at(project, p);
  const bool plain = is_synth(project, p);
  r.length = static_cast<int>(num(clip, "length"));
  for (const auto& s : list(clip, "steps")) {
    RollNote n;
    n.at = num(s, "step"), n.note = step_note(project, s, plain, p), n.velocity = static_cast<float>(num(s, "velocity"));
    if (const Value* d = s.get("duration")) n.length = d->as_number();
    r.notes.push_back(n);
  }
  if (const Value* seq = clip.get("sequence"))
    for (const auto& q : list(*seq, "notes")) {
      RollNote n;
      n.at = num(q, "position"), n.length = num(q, "duration"), n.note = static_cast<int>(num(q, "note"));
      n.velocity = static_cast<float>(num(q, "velocity")), n.sequence = true;
      r.notes.push_back(n);
    }
  return r;
}

inline Value& track_at(Value& project, int t) { return project.get("tracks")->items()[t]; }
inline Value& scene_at(Value& project, int s) { return project.get("scenes")->items()[s]; }

class History {
 public:
  // Before changing a clip: keeps it as it was, and forgets what could be redone.
  void before(const Value& project, Place p) {
    Change c;
    c.place = p, c.clip = clip_at(project, p);
    push(xmp::move(c));
  }
  // Before adding a clip to a track and a scene (a recording): keeps both.
  void before_structure(Value& project, int track, int scene) {
    Change c;
    c.structure = true, c.place = {track, -1}, c.scene = scene;
    c.clip = track_at(project, track), c.scene_value = scene_at(project, scene);
    push(xmp::move(c));
  }
  // Before a knob changes a track's level, pan or sends: keeps the track, its
  // mix strip and the parameter assignments that mirror them.
  void before_track(const Value& project, int track) {
    Change c;
    c.structure = true, c.mix = true, c.place = {track, -1};
    c.clip = project.get("tracks")->items()[track];
    if (const Value* mix = project.get("mix"))
      if (const Value* strip = mix->get("tracks")->get(project::detail::str(c.clip, "id").c_str()))
        c.scene_value = *strip, c.had_strip = true;
    c.parameters = *project.get("parameters");
    if (const Value* perf = project.get("performance")) c.performance = *perf, c.had_performance = true;
    push(xmp::move(c));
  }
  // Before a song edit: keeps the performance (its chain, end and position).
  void before_song(const Value& project) {
    Change c;
    c.structure = true, c.song = true;
    c.clip = *project.get("performance");
    push(xmp::move(c));
  }
  // Before a change to sounds (a kept sample): keeps the whole project, which
  // costs little, since documents share their unchanged parts.
  void before_project(const Value& project) {
    Change c;
    c.structure = true, c.whole = true;
    c.clip = project;
    push(xmp::move(c));
  }
  bool can_undo() const { return !undo_.empty(); }
  bool can_redo() const { return !redo_.empty(); }
  // Whether the last undo or redo changed the project's clips or scenes (then
  // the player needs the whole project), or one clip's notes (`p`).
  bool structural() const { return structural_; }
  // Swaps the last change back; `p` is the clip (or, structural, the track) that changed.
  bool undo(Value& project, Place& p) { return swap(project, undo_, redo_, p); }
  bool redo(Value& project, Place& p) { return swap(project, redo_, undo_, p); }

 private:
  struct Change {
    bool structure = false, mix = false, had_strip = false, song = false, whole = false;
    Place place;
    Value clip;  // the clip, or (structure, mix) the whole track
    int scene = -1;
    Value scene_value;  // the scene, or (mix) the track's mix strip
    Value parameters;   // (mix) the parameter assignments
    Value performance;  // (mix) the performance: its mutes and solos
    bool had_performance = false;
  };
  void push(Change c) {
    undo_.push_back(xmp::move(c));
    if (static_cast<int>(undo_.size()) > kHistory) undo_.erase(undo_.begin());
    redo_.clear();
  }
  bool swap(Value& project, std::vector<Change>& from, std::vector<Change>& to, Place& p) {
    if (from.empty()) return false;
    Change c = xmp::move(from.back());
    from.pop_back();
    Change back;
    back.structure = c.structure, back.mix = c.mix, back.song = c.song, back.whole = c.whole, back.place = c.place,
    back.scene = c.scene;
    if (c.whole) {
      back.clip = project;
      project = xmp::move(c.clip);
    } else if (c.song) {
      Value& perf = *project.get("performance");
      back.clip = perf;
      perf = xmp::move(c.clip);
    } else if (c.mix) {
      Value& track = track_at(project, c.place.track);
      const Str id = project::detail::str(track, "id");
      back.clip = track, back.parameters = *project.get("parameters");
      if (Value* mix = project.get("mix")) {
        Value* strips = mix->get("tracks");
        if (const Value* strip = strips->get(id.c_str())) back.scene_value = *strip, back.had_strip = true;
        if (c.had_strip)
          strips->set(id, xmp::move(c.scene_value));
        else
          strips->remove(id.c_str());
      }
      track = xmp::move(c.clip);
      *project.get("parameters") = xmp::move(c.parameters);
      if (c.had_performance && project.get("performance")) {
        back.performance = *project.get("performance"), back.had_performance = true;
        *project.get("performance") = xmp::move(c.performance);
      }
    } else if (c.structure) {
      Value& track = track_at(project, c.place.track);
      Value& scene = scene_at(project, c.scene);
      back.clip = track, back.scene_value = scene;
      track = xmp::move(c.clip), scene = xmp::move(c.scene_value);
    } else {
      Value& live = clip_at(project, c.place);
      back.clip = live;
      live = xmp::move(c.clip);
    }
    to.push_back(xmp::move(back));
    p = c.place;
    structural_ = c.structure;
    return true;
  }
  std::vector<Change> undo_, redo_;
  bool structural_ = false;
};

inline bool load_track_kit(Value& project, const Str& id, const Value& kit, History& history,
                           std::string& error) {
  const auto owned = xmp::edit::own_kit(project, id);
  if (!owned.ok) return error = owned.error.c_str(), false;
  auto loaded = xmp::edit::apply_drum_kit(owned.project, kit, &id);
  if (!loaded.ok) return error = loaded.error.c_str(), false;
  history.before_project(project);
  project = xmp::move(loaded.project);
  return true;
}

// ---- sampling (the Sample view) ----

// Keeps a recorded sound on pad `pad` of track `track`, sliced across `slices`
// pads from there. A track that plays the shared pads gets its own kit first
// (a copy of them, project format 7), so no other track's sounds change. One
// undo step brings everything back.
inline bool keep_sample(Value& project, int track, int pad, const std::vector<float>& pcm, int slices,
                        const std::string& name, History& history, std::string& error, const std::vector<int>* marked = nullptr) {
  const auto& tracks = project::detail::list(project, "tracks");
  if (track < 0 || track >= tracks.size()) return error = "No track here", false;
  if (pad < 0 || pad > 15) return error = "No pad here", false;
  if (pcm.empty()) return error = "Nothing recorded", false;
  const Str id = project::detail::str(tracks[track], "id");
  xmp::edit::Edited e;
  e.ok = true, e.project = project;
  if (!tracks[track].get("pads")) e = xmp::edit::own_kit(project, id);
  if (!e.ok) return error = e.error.c_str(), false;
  Vec<double> values;
  values.reserve(static_cast<int32_t>(pcm.size()));
  for (const float v : pcm) values.push(static_cast<double>(v));
  e = xmp::edit::install_sample(e.project, pad, Str(name.c_str()), 48000, values, &id);
  if (!e.ok) return error = e.error.c_str(), false;
  const int count = std::clamp(std::min(slices, 16 - pad), 1, std::max(1, static_cast<int>(pcm.size())));
  if (count > 1) {
    Vec<double> points;
    if (marked) {
      for (int i = 0; i < count; ++i) points.push((*marked)[static_cast<size_t>(i)]);
      points.push(static_cast<double>(pcm.size()));
    } else for (int i = 0; i <= count; ++i)
      points.push(std::floor(static_cast<double>(pcm.size()) * i / count));
    e = xmp::edit::manual_slices(e.project, pad, points, &id);
    if (!e.ok) return error = e.error.c_str(), false;
  }

  history.before_project(project);
  project = xmp::move(e.project);
  return true;
}

// A Sampler's take: the whole sample, played across the pads as notes (keys),
// or chopped at `points` (frame starts, from xmp::chop) into slices on pads
// 1..n. Sets the machine's mode. Main-thread only.
inline bool keep_sampler(Value& project, int track, const std::vector<float>& pcm, std::vector<int> points, bool slices,
                         const std::string& name, History& history, std::string& error) {
  const auto& tracks = project::detail::list(project, "tracks");
  if (track < 0 || track >= tracks.size()) return error = "No track here", false;
  if (pcm.empty()) return error = "Nothing recorded", false;
  const Value* machine = tracks[track].get("machine");
  if (machine && project::detail::str(*machine, "id") != "xmp.sampler") return error = "Not a Sampler track", false;
  const Str id = project::detail::str(tracks[track], "id");
  xmp::edit::Edited e;
  e.ok = true, e.project = project;
  if (!tracks[track].get("pads")) e = xmp::edit::own_kit(project, id);
  if (!e.ok) return error = e.error.c_str(), false;
  Vec<double> values;
  values.reserve(static_cast<int32_t>(pcm.size()));
  for (const float v : pcm) values.push(static_cast<double>(v));
  e = xmp::edit::install_sample(e.project, 0, Str(name.c_str()), 48000, values, &id);
  if (!e.ok) return error = e.error.c_str(), false;
  auto& pads = track_at(e.project, track).get("pads")->items();
  const Value source = pads[0];
  if (slices) {
    points = chop::clean(xmp::move(points), static_cast<int>(pcm.size()));
    Vec<double> bounds;
    for (const int p : points) bounds.push(p);
    bounds.push(static_cast<double>(pcm.size()));
    if (points.size() > 1) {
      e = xmp::edit::manual_slices(e.project, 0, bounds, &id);
      if (!e.ok) return error = e.error.c_str(), false;
    }
  }
  auto& after = track_at(e.project, track).get("pads")->items();
  for (int i = 0; i < after.size(); ++i) {
    // Keys: every pad is the whole sample; slices: pads past the last slice too.
    if (!slices || i >= static_cast<int>(points.size())) {
      const Value pad_id = *after[i].get("id");
      after[i] = source;
      after[i].set("id", pad_id);
      if (slices) after[i].remove("slice");
    }
    Value playback = Value::new_object();
    playback.set("mode", Value::of(slices ? "one-shot" : "chromatic"));
    playback.set("rootNote", Value::of(48.0));
    playback.set("chokeGroup", Value::of(0.0));
    after[i].set("playback", xmp::move(playback));
  }
  Value m = machine ? *machine : Value::new_object();
  if (!machine) {
    Str why;
    if (!machine::machines().instantiate(Str("xmp.sampler"), m, why)) return error = why.c_str(), false;
  }
  m.get("state")->set("mode", Value::of(slices ? "slices" : "keys"));
  track_at(e.project, track).set("machine", xmp::move(m));
  Value checked;
  Str why;
  if (!project::canonical(e.project, checked, why)) return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}

// Copy into one scene slot, leaving every existing clip and reference intact.
// Main-thread only. Canonical validation bounds clip counts and imported note data.
inline bool copy_slot(Value& project, int source_track, const Str& source_clip, int track, int scene,
                      History& history, std::string& error) {
  const auto& tracks = project::detail::list(project, "tracks");
  const auto& scenes = project::detail::list(project, "scenes");
  if (source_track < 0 || source_track >= tracks.size() || track < 0 || track >= tracks.size() ||
      scene < 0 || scene >= scenes.size()) return error = "No such slot", false;
  const Place source = find(project, project::detail::str(tracks[source_track], "id"), source_clip);
  if (!source.ok()) return error = "Copy source unavailable", false;
  if (project::detail::list(tracks[track], "clips").size() >= 16) return error = "Track has sixteen clips", false;
  int n = 0;
  auto used = [&](const Str& id) {
    for (const auto& t : tracks)
      for (const auto& c : project::detail::list(t, "clips"))
        if (project::detail::str(c, "id") == id) return true;
    return false;
  };
  while (used(Str("device-copy-") + int_text(n))) ++n;
  const Str id = Str("device-copy-") + int_text(n);
  Value copy = clip_at(project, source);
  copy.set("id", Value::of(id));
  copy.set("name", Value::of(project::detail::str(copy, "name").utf16_prefix(30) + " copy"));
  Value next = project;
  track_at(next, track).get("clips")->items().push(xmp::move(copy));
  scene_at(next, scene).get("clips")->set(project::detail::str(tracks[track], "id"), Value::of(id));
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why)) return error = why.c_str(), false;
  history.before_structure(project, track, scene);
  project = xmp::move(checked);
  return true;
}

inline bool unlink_slot(Value& project, int track, int scene, History& history, std::string& error) {
  const auto& tracks = project::detail::list(project, "tracks");
  const auto& scenes = project::detail::list(project, "scenes");
  if (track < 0 || track >= tracks.size() || scene < 0 || scene >= scenes.size()) return error = "No such slot", false;
  const Str id = project::detail::str(tracks[track], "id");
  if (!project::detail::at(scenes[scene], "clips").get(id.c_str())) return error = "Empty slot", false;
  history.before_structure(project, track, scene);
  scene_at(project, scene).get("clips")->remove(id.c_str());
  return true;
}

// ---- project sample browsing ----
// Reuse a sound already in the project's sample pool; isolate the target kit.
inline bool assign_pool_sample(Value& project, int track, int pad, const Str& sample_id,
                               History& history, std::string& error) {
  const auto& tracks = project::detail::list(project, "tracks");
  if (track < 0 || track >= tracks.size() || pad < 0 || pad >= 16) return error = "No such pad", false;
  const Value* sample = nullptr;
  for (const auto& s : project::detail::list(project, "samples"))
    if (project::detail::str(s, "id") == sample_id) sample = &s;
  if (!sample) return error = "Sample unavailable", false;
  if (const Value* machine = tracks[track].get("machine"); machine && project::detail::str(*machine, "id") != "xmp.sampler")
    return error = "Choose a kit track", false;
  const Str name = project::detail::str(*sample, "name");
  Value next = project;
  if (!tracks[track].get("pads")) {
    auto e = xmp::edit::own_kit(project, project::detail::str(tracks[track], "id"));
    if (!e.ok) return error = e.error.c_str(), false;
    next = xmp::move(e.project);
  }
  auto& target = track_at(next, track).get("pads")->items()[pad];
  target.set("sampleId", Value::of(sample_id));
  target.set("name", Value::of(name.utf16_prefix(40)));
  target.remove("slice");target.remove("edit");target.remove("layers");
  const auto &old=project::detail::track_pads(project,&tracks[track]);
  if(!old.empty()&&project::detail::str(project::detail::at(old[0],"playback"),"mode")=="chromatic"){target.set("playback",project::detail::at(old[0],"playback"));const Value source=target;for(auto &p:track_at(next,track).get("pads")->items()){const Value id=*p.get("id");p=source;p.set("id",id);}}
  else target.remove("playback");
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why)) return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}

// Main-thread preview at the session rate. No file or device access.
inline std::vector<float> preview_pool_sample(const Value& project, const Str& sample_id) {
  for (const auto& s : project::detail::list(project, "samples")) {
    if (project::detail::str(s, "id") != sample_id) continue;
    const auto& pcm = project::detail::list(s, "pcm");
    const double rate = project::detail::num(s, "sampleRate");
    if (pcm.size() == 0 || !std::isfinite(rate) || rate < 8000 || rate > 192000) return {};
    const int count = static_cast<int>(std::min(480000.0, std::ceil(pcm.size() * 48000.0 / rate)));
    std::vector<float> out(static_cast<std::size_t>(count));
    for (int i = 0; i < count; ++i) {
      const double at = std::min(static_cast<double>(pcm.size() - 1), i * rate / 48000.0);
      const int a = static_cast<int>(at), b = std::min(a + 1, pcm.size() - 1);
      const double v = pcm[a].as_number() + (pcm[b].as_number() - pcm[a].as_number()) * (at - a);
      out[i] = std::isfinite(v) ? static_cast<float>(std::clamp(v, -1.0, 1.0)) : 0;
    }
    return out;
  }
  return {};
}

// ---- recording ----

// A pad hit in a take: where (in steps from the clip's start, not yet
// quantized), which pad or note, how hard (0..1) and, on a synth, how long (steps).
struct Hit {
  double at = 0;
  int pad = 0, note = 60;
  double velocity = 1, length = 1;
  double quantize = 1;
};

// Quantizes `hit` to the nearest step of a clip `length` steps long (a hit
// just before the end lands on step 1) and adds it: a kit hit as a pad's
// step (a second hit on the same step keeps the louder), a synth note with
// its own note and length on a free pad (the same note twice on a step plays once).
inline bool add_hit(Value& clip, bool synth, const Hit& hit) {
  using project::detail::num;
  const int length = static_cast<int>(num(clip, "length"));
  if (hit.quantize < 1) {
    if (!std::isfinite(hit.at) || !std::isfinite(hit.quantize) || hit.quantize < 0)
      return false;
    double at = std::fmod(std::max(0.0, hit.at), length);
    at += (std::round(at) - at) * hit.quantize;
    if (at >= length)
      at = 0;
    if (!clip.get("sequence")) {
      Value seq = Value::new_object();
      seq.set("version", Value::of(1.0));
      for (const char *k : {"notes", "locks", "lanes", "modulations"})
        seq.set(k, Value::new_array());
      clip.set("sequence", xmp::move(seq));
    }
    auto &notes = clip.get("sequence")->get("notes")->items();
    if (notes.size() >= 1024)
      return false;
    int id = 0;
    auto used = [&](int k) {
      for (const auto &n : notes)
        if (project::detail::str(n, "id") == Str("record-") + int_text(k))
          return true;
      return false;
    };
    while (used(id))
      ++id;
    Value n = Value::new_object();
    n.set("id", Value::of(Str("record-") + int_text(id)));
    n.set("pad", Value::of(static_cast<double>(hit.pad)));
    n.set("note", Value::of(static_cast<double>(hit.note)));
    n.set("position", Value::of(at));
    n.set("duration", Value::of(std::clamp(hit.length, .25, 64.0)));
    n.set("velocity", Value::of(std::clamp(hit.velocity, .01, 1.0)));
    n.set("probability", Value::of(1.0));
    n.set("microtiming", Value::of(0.0));
    n.set("condition", Value::of("always"));
    notes.push(xmp::move(n));
    return true;
  }
  int step = static_cast<int>(std::lround(hit.at));
  if (step >= length) step -= length;
  if (step < 0 || step >= length) return false;
  const double velocity = std::round(std::fmin(1, std::fmax(0.01, hit.velocity)) * 100) / 100;
  auto& steps = clip.get("steps")->items();
  std::array<bool, 16> taken{};
  for (auto& s : steps) {
    if (static_cast<int>(num(s, "step")) != step) continue;
    taken[static_cast<int>(num(s, "pad"))] = true;
    const Value* n = s.get("note");
    if (synth ? (n && static_cast<int>(n->as_number()) == hit.note) : static_cast<int>(num(s, "pad")) == hit.pad) {
      if (!synth && velocity > num(s, "velocity")) s.set("velocity", Value::of(velocity));
      return false;
    }
  }
  if (steps.size() >= kMaxSteps) return false;
  int pad = hit.pad;
  if (synth) {
    pad = -1;
    for (int k = 0; k < 16 && pad < 0; ++k)
      if (!taken[k]) pad = k;
    if (pad < 0) return false;
  }
  Value s = Value::new_object();
  s.set("step", Value::of(static_cast<double>(step))), s.set("pad", Value::of(static_cast<double>(pad)));
  s.set("velocity", Value::of(velocity)), s.set("probability", Value::of(1.0));
  if (synth) {
    s.set("note", Value::of(static_cast<double>(hit.note)));
    s.set("duration", Value::of(std::fmin(64, std::fmax(0.25, std::round(hit.length * 4) / 4))));
  }
  steps.push(xmp::move(s));
  return true;
}

// The clip length for a take that ran `steps` steps: whole bars, 16, 32 or 64.
inline int take_length(double steps) {
  const int bars = std::max(1, static_cast<int>(std::ceil(steps / 16 - 1e-9)));
  return bars <= 1 ? 16 : bars <= 2 ? 32 : 64;
}

// A take into an empty slot: a new clip ("Take N") on track `track`, given to
// scene `scene`. `id` is the new clip's id.
inline bool record_clip(Value& project, int track, int scene, int length, const std::vector<Hit>& hits,
                        History& history, std::string& id, std::string& error) {
  using project::detail::list;
  using project::detail::str;
  const auto& tracks = list(project, "tracks");
  const auto& scenes = list(project, "scenes");
  if (track < 0 || track >= tracks.size() || scene < 0 || scene >= scenes.size()) return error = "No such slot", false;
  if (length != 16 && length != 32 && length != 64) return error = "Invalid take length", false;
  const Str& track_id = str(tracks[track], "id");
  if (project::detail::at(scenes[scene], "clips").get(track_id.c_str())) return error = "The slot has a clip", false;
  if (hits.empty()) return error = "Nothing recorded", false;
  // An id no clip in the project has, and the track's next take number.
  int n = 1;
  auto used = [&](const std::string& candidate) {
    for (const auto& t : tracks)
      for (const auto& c : list(t, "clips"))
        if (str(c, "id") == candidate.c_str()) return true;
    return false;
  };
  while (used("take-" + std::to_string(n))) ++n;
  id = "take-" + std::to_string(n);
  int takes = 1;
  for (const auto& c : list(tracks[track], "clips"))
    if (str(c, "name").starts_with("Take ")) ++takes;
  const bool synth = [&] {
    const Value* machine = tracks[track].get("machine");
    const auto& pads=project::detail::track_pads(project,&tracks[track]);
    return machine && ((str(*machine, "id") == "xmp.subtractive" || str(*machine,"id")=="xmp.midi") || (!pads.empty()&&str(project::detail::at(pads[0],"playback"),"mode")=="chromatic"));
  }();
  Value clip = Value::new_object();
  clip.set("id", Value::of(Str(id.c_str())));
  clip.set("name", Value::of(Str(("Take " + std::to_string(takes)).c_str())));
  clip.set("length", Value::of(static_cast<double>(length)));
  clip.set("steps", Value::new_array());
  bool any = false;
  for (const auto& h : hits) any = add_hit(clip, synth, h) || any;
  if (!any) return error = "Nothing recorded", false;
  history.before_structure(project, track, scene);
  track_at(project, track).get("clips")->items().push(xmp::move(clip));
  scene_at(project, scene).get("clips")->set(track_id, Value::of(Str(id.c_str())));
  return true;
}

// Turns one step on or off. `error` says why nothing changed. A new step gets
// `velocity` and `chance` (the Steps view's NEW STEPS knobs), and a synth or
// MIDI step `step_length` steps when that is not one.
inline bool toggle(Value& project, Place p, int step, int pad, int note, History& history, std::string& error,
                   double velocity = 0.8, double chance = 1, double step_length = 1) {
  using project::detail::num;
  if (!p.ok()) return error = "No clip", false;
  Value& clip = clip_at(project, p);
  const int length = static_cast<int>(num(clip, "length"));
  if (step < 0 || step >= length || pad < 0 || pad > 15 || note < 0 || note > 127) return error = "Outside the clip", false;
  const bool synth = is_melodic(project, p), plain = is_synth(project, p);
  auto& steps = clip.get("steps")->items();
  // Off: the entry (or a synth's sequence note) on this step.
  for (int i = 0; i < steps.size(); ++i) {
    const auto& s = steps[i];
    if (static_cast<int>(num(s, "step")) != step) continue;
    if (synth ? step_note(project, s, plain, p) == note : static_cast<int>(num(s, "pad")) == pad) {
      history.before(project, p);
      clip_at(project, p).get("steps")->items().erase(i);
      return true;
    }
  }
    if (const Value* seq = clip.get("sequence")) {
      const auto& notes = project::detail::list(*seq, "notes");
      for (int i = 0; i < notes.size(); ++i)
        if ((synth?static_cast<int>(num(notes[i],"note"))==note:static_cast<int>(num(notes[i],"pad"))==pad) && static_cast<int>(std::floor(num(notes[i], "position"))) == step) {
          history.before(project, p);
          clip_at(project, p).get("sequence")->get("notes")->items().erase(i);
          return true;
        }
    }
  // On.
  if (steps.size() >= kMaxSteps) return error = "The clip is full", false;
  int use = pad;
  if (synth) {  // a pad number free at this step
    std::array<bool, 16> taken{};
    for (const auto& s : steps)
      if (static_cast<int>(num(s, "step")) == step) taken[static_cast<int>(num(s, "pad"))] = true;
    use = -1;
    for (int k = 0; k < 16 && use < 0; ++k)
      if (!taken[k]) use = k;
    if (use < 0) return error = "Sixteen notes on this step already", false;
  }
  history.before(project, p);
  Value s = Value::new_object();
  s.set("step", Value::of(static_cast<double>(step))), s.set("pad", Value::of(static_cast<double>(use)));
  s.set("velocity", Value::of(std::clamp(velocity, 0.0, 1.0))), s.set("probability", Value::of(std::clamp(chance, 0.0, 1.0)));
  if (synth) s.set("note", Value::of(static_cast<double>(note)));
  if (synth && step_length != 1) s.set("duration", Value::of(std::clamp(step_length, 0.25, 16.0)));
  clip_at(project, p).get("steps")->items().push(xmp::move(s));
  return true;
}

// Erase: every step of a kit's pad, or every note of one pitch on a synth.
inline bool erase(Value& project, Place p, int pad, int note, History& history, std::string& error) {
  using project::detail::num;
  if (!p.ok()) return error = "No clip", false;
  const bool synth = is_melodic(project, p), plain = is_synth(project, p);
  auto matches = [&](const Value& s) {
    return synth ? step_note(project, s, plain, p) == note : static_cast<int>(num(s, "pad")) == pad;
  };
  const Value& clip = clip_at(project, p);
  bool any = false;
  for (const auto& s : project::detail::list(clip, "steps")) any = any || matches(s);
  if (synth)
    if (const Value* seq = clip.get("sequence"))
      for (const auto& n : project::detail::list(*seq, "notes")) any = any || static_cast<int>(num(n, "note")) == note;
  if (!any) return error = "Nothing to erase", false;
  history.before(project, p);
  Value& live = clip_at(project, p);
  auto& steps = live.get("steps")->items();
  for (int i = steps.size() - 1; i >= 0; --i)
    if (matches(steps[i])) steps.erase(i);
  if (synth)
    if (Value* seq = live.get("sequence")) {
      auto& notes = seq->get("notes")->items();
      for (int i = notes.size() - 1; i >= 0; --i)
        if (static_cast<int>(num(notes[i], "note")) == note) notes.erase(i);
    }
  return true;
}

// ---- the Q-Link knobs ----

// What a knob shows on screen while it is touched or turned.
struct Shown {
  std::string name, value;
};
inline const char* step_knob_name(int knob) {
  static const char* names[4] = {"Velocity", "Chance", "Length", "Move"};
  return names[std::clamp(knob, 0, 3)];
}
// ---- a track's sound: its machine's parameters, and the synth's presets ----

// The synth's presets (synth_presets.hpp, instrument-schema.ts synthPresets),
// as the exact decimals a project stores, four pages of eight.
using synth::Preset;
using synth::kPresets;
using synth::presets;

// The (up to four) parameters the SOUND knobs set on track `track`: the
// synth's cutoff, attack, decay and release, else its machine's first four.
inline std::vector<parameters::Definition> sound_parameters(const Value& project, int track,
                                                            const Vec<parameters::Definition>* known = nullptr) {
  std::vector<parameters::Definition> out;
  const auto& tracks = project::detail::list(project, "tracks");
  if (track < 0 || track >= tracks.size()) return out;
  const std::string prefix = std::string("track.") + project::detail::str(tracks[track], "id").c_str() + ".machine.";
  auto ends = [](const std::string& s, const std::string& end) {
    return s.size() >= end.size() && s.compare(s.size() - end.size(), end.size(), end) == 0;
  };
  std::vector<parameters::Definition> own;
  const Vec<parameters::Definition> built = known ? Vec<parameters::Definition>() : parameters::registry(project);
  for (const auto& d : known ? *known : built)
    if (std::string(d.id.c_str()).rfind(prefix, 0) == 0) own.push_back(d);
  static const char* kSynth[4] = {".cutoff", ".attack", ".decay", ".release"};
  for (const char* end : kSynth)
    for (const auto& d : own)
      if (std::string(d.id.c_str()).rfind(prefix + "xmp.subtractive.", 0) == 0 && ends(d.id.c_str(), end))
        out.push_back(d);
  if (out.empty())
    for (const auto& d : own)
      if (out.size() < 4) out.push_back(d);
  return out;
}
// A synth parameter in its own units (the engine maps them linearly).
inline std::string sound_value(const Str& id, double v) {
  static const char* kFields[rack::kPatchFields] = {".attack", ".decay",     ".sustain",  ".release", ".cutoff",
                                                    ".resonance", ".env-amount", ".env-decay", ".detune", ".glide"};
  char text[32];
  const std::string s(id.c_str());
  for (int f = 0; f < rack::kPatchFields; ++f)
    if (s.find(".xmp.subtractive.") != std::string::npos && s.size() >= std::strlen(kFields[f]) &&
        s.compare(s.size() - std::strlen(kFields[f]), std::strlen(kFields[f]), kFields[f]) == 0) {
      const double x = rack::kPatchMin[f] + v * (rack::kPatchMax[f] - rack::kPatchMin[f]);
      if (f == 4) std::snprintf(text, sizeof text, "%d Hz", static_cast<int>(std::lround(x)));
      else if (f == 2 || f == 5) std::snprintf(text, sizeof text, "%d%%", static_cast<int>(std::lround(x * 100)));
      else if (f == 6) std::snprintf(text, sizeof text, "%.1f oct", x);
      else if (f == 8) std::snprintf(text, sizeof text, "%d cents", static_cast<int>(std::lround(x)));
      else std::snprintf(text, sizeof text, "%d ms", static_cast<int>(std::lround(x * 1000)));
      return text;
    }
  std::snprintf(text, sizeof text, "%d%%", static_cast<int>(std::lround(v * 100)));
  return text;
}
// SOUND knob `knob` turned `delta` clicks (1% each) on track `track`'s sound.
// A click writes the one assignment and the machine's state (a value inside
// 0..1 keeps the project valid), without checking the whole project again:
// a knob is turned many clicks a second, beside the player on the same thread.
// `known`: the project's registry, when the caller asks for several knobs.
inline bool sound_knob(Value& project, int track, int knob, int delta, bool fresh, History& history, Shown& shown,
                       std::string& error, const Vec<parameters::Definition>* known = nullptr) {
  const Vec<parameters::Definition> built = known ? Vec<parameters::Definition>() : parameters::registry(project);
  const Vec<parameters::Definition>& registry = known ? *known : built;
  const auto defs = sound_parameters(project, track, &registry);
  if (knob < 0 || knob >= static_cast<int>(defs.size())) {
    shown.name = "\xE2\x80\x93";
    return error = defs.empty() ? "No sound knobs for this machine yet" : "", false;
  }
  const auto& d = defs[static_cast<std::size_t>(knob)];
  // "Bass Tone (Hz)" shows as "Tone": the strip has the track, the value the unit.
  std::string name = d.name.c_str();
  const std::string track_name = project::detail::str(project::detail::list(project, "tracks")[track], "name").c_str();
  if (name.rfind(track_name + " ", 0) == 0) name = name.substr(track_name.size() + 1);
  if (const auto paren = name.find(" ("); paren != std::string::npos) name = name.substr(0, paren);
  shown.name = name;
  double v = 0;
  Str why;
  if (!parameters::value(project, d.id, v, why, machine::machines(), &registry)) return error = why.c_str(), false;
  shown.value = sound_value(d.id, v);
  if (delta == 0) return false;
  const double next = std::clamp(std::round((v + delta * 0.01) * 1000) / 1000, 0.0, 1.0);
  if (next == v) return false;
  const auto e = parameters::set_parameter_unchecked(project, d.id, next, Str("base"), machine::machines(), &registry);
  if (!e.ok) return error = e.error.c_str(), false;
  if (fresh) history.before_track(project, track);
  project = e.project;
  shown.value = sound_value(d.id, next);
  return true;
}
// Gives synth track `track` preset `preset`, forgetting knob changes to its sound.
inline bool set_preset(Value& project, int track, int preset, History& history, std::string& error) {
  using project::detail::str;
  const auto& tracks = project::detail::list(project, "tracks");
  if (track < 0 || track >= tracks.size()) return error = "No track here", false;
  if (preset < 0 || preset >= kPresets) return error = "No preset here", false;
  const Value* machine = tracks[track].get("machine");
  if (!machine || str(*machine, "id") != "xmp.subtractive") return error = "Presets are for synth tracks", false;
  const Preset& p = presets()[preset];
  Value next = project;
  Value& m = *next.get("tracks")->items()[track].get("machine");
  Value state = Value::new_object();
  state.set("name", Value::of(p.name)), state.set("oscillator", Value::of(p.oscillator));
  state.set("attack", Value::of(p.attack)), state.set("decay", Value::of(p.decay));
  state.set("sustain", Value::of(p.sustain)), state.set("release", Value::of(p.release));
  state.set("cutoff", Value::of(p.cutoff));
  if (p.extended) {
    state.set("resonance", Value::of(p.resonance)), state.set("env-amount", Value::of(p.env_amount));
    state.set("env-decay", Value::of(p.env_decay)), state.set("detune", Value::of(p.detune));
    state.set("glide", Value::of(p.glide));
  }
  m.set("state", xmp::move(state));
  const Str prefix = Str("track.") + str(tracks[track], "id") + ".machine.";
  auto& assigned = next.get("parameters")->items();
  for (int i = assigned.size() - 1; i >= 0; --i)
    if (str(assigned[i], "id").starts_with(prefix)) assigned.erase(i);
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why)) return error = why.c_str(), false;
  history.before_track(project, track);
  project = xmp::move(checked);
  return true;
}

inline const char* track_knob_name(int knob) {
  static const char* names[4] = {"Level", "Pan", "Send 1", "Send 2"};
  return names[std::clamp(knob, 0, 3)];
}
inline std::string percent(double v) { return std::to_string(static_cast<int>(std::lround(v * 100))) + "%"; }
// Pan 0..1 as the mixer writes it: "C", "L40", "R25".
inline std::string pan_text(double pan) {
  const int x = static_cast<int>(std::lround((pan - 0.5) * 200));
  return x == 0 ? "C" : (x < 0 ? "L" : "R") + std::to_string(x < 0 ? -x : x);
}
// "1 step", "0.75 steps".
inline std::string steps_text(double d) {
  char text[32];
  std::snprintf(text, sizeof text, "%g step%s", d, d == 1 ? "" : "s");
  return text;
}
// A value moved by `delta` hundredths, on that grid, within lo..hi.
inline double nudge(double v, int delta, double lo, double hi) {
  return std::clamp(std::round(v * 100 + delta) / 100, lo, hi);
}

// The step entry the Steps view edits: on `step`, for the kit pad or synth note (-1: none).
inline int step_entry(const Value& project, Place p, int step, int pad, int note) {
  using project::detail::num;
  if (!p.ok()) return -1;
  const bool synth = is_melodic(project, p), plain = is_synth(project, p);
  const auto& steps = project::detail::list(clip_at(project, p), "steps");
  for (int i = 0; i < steps.size(); ++i)
    if (static_cast<int>(num(steps[i], "step")) == step &&
        (synth ? step_note(project, steps[i], plain, p) == note : static_cast<int>(num(steps[i], "pad")) == pad))
      return i;
  return -1;
}

// Knob `knob` turned `delta` clicks on the selected step: velocity and chance
// in 1% clicks, a synth note's length in quarter steps, and Move (delta: whole
// steps, wrapping round the clip). `step` follows a move. `fresh`: the first
// click of a turn, which undo takes back as one. delta 0 only shows the value.
inline bool step_knob(Value& project, Place p, int& step, int pad, int note, int knob, int delta, bool fresh,
                      History& history, Shown& shown, std::string& error) {
  using project::detail::num;
  shown.name = step_knob_name(knob);
  if (!p.ok()) return error = "No clip", false;
  const int i = step_entry(project, p, step, pad, note);
  if (i < 0) {
    const auto *sequence = clip_at(project, p).get("sequence");
    int index = -1;
    if (sequence) {
      const auto &notes = project::detail::list(*sequence, "notes");
      for (int n = 0; n < notes.size(); ++n)
        if (static_cast<int>(std::floor(num(notes[n], "position"))) == step &&
            (is_melodic(project, p) ? static_cast<int>(num(notes[n], "note")) == note
                                    : static_cast<int>(num(notes[n], "pad")) == pad)) {
          index = n;
          break;
        }
    }
    if (index >= 0) {
      const auto &entry = sequence->get("notes")->items()[index];
      const int length = static_cast<int>(num(clip_at(project, p), "length"));
      const double old = num(entry, knob == 0   ? "velocity"
                                    : knob == 1 ? "probability"
                                    : knob == 2 ? "duration"
                                                : "position");
      const double value = knob < 2    ? nudge(old, delta, knob == 0 ? .01 : 0, 1)
                           : knob == 2 ? std::clamp(old + delta * .25, .25, 16.0)
                                       : static_cast<double>((step + delta % length + length) % length);
      shown.value = knob < 2    ? percent(value)
                    : knob == 2 ? steps_text(value)
                                : "Step " + std::to_string(static_cast<int>(value) + 1);
      if (delta == 0 || old == value)
        return false;
      if (fresh)
        history.before(project, p);
      clip_at(project, p)
          .get("sequence")
          ->get("notes")
          ->items()[index]
          .set(knob == 0   ? "velocity"
               : knob == 1 ? "probability"
               : knob == 2 ? "duration"
                           : "position",
               Value::of(value));
      if (knob == 3)
        step = static_cast<int>(value);
      return true;
    }
  }
  if (i < 0) return error = "No note on step " + std::to_string(step + 1), false;
  const bool synth = is_melodic(project, p), plain = is_synth(project, p);
  const Value& entry = project::detail::list(clip_at(project, p), "steps")[i];
  const int length = static_cast<int>(num(clip_at(project, p), "length"));
  auto entry_at = [&]() -> Value& { return clip_at(project, p).get("steps")->items()[i]; };
  switch (knob) {
    case 0:
    case 1: {
      const char* key = knob == 0 ? "velocity" : "probability";
      const double was = num(entry, key), v = nudge(was, delta, knob == 0 ? 0.01 : 0, 1);
      shown.value = percent(v);
      if (v == was) return false;
      if (fresh) history.before(project, p);
      entry_at().set(key, Value::of(v));
      return true;
    }
    case 2: {
      if (!synth) return error = "Length is for synth notes", false;
      const Value* d = entry.get("duration");
      const double was = d ? d->as_number() : 1;
      const double v = std::clamp(std::round(was * 4 + delta) / 4, 0.25, std::min(64.0, static_cast<double>(length)));
      shown.value = steps_text(v);
      if (v == was) return false;
      if (fresh) history.before(project, p);
      entry_at().set("duration", Value::of(v));
      return true;
    }
    default: {
      shown.value = "Step " + std::to_string(step + 1);
      if (delta == 0) return false;
      const int to = ((step + delta) % length + length) % length;
      if (to == step) return false;
      // The entry's pad must be free on the step it moves to (a synth takes any free pad).
      std::array<bool, 16> taken{};
      for (const auto& s : project::detail::list(clip_at(project, p), "steps"))
        if (static_cast<int>(num(s, "step")) == to) {
          taken[static_cast<int>(num(s, "pad"))] = true;
          if (synth ? step_note(project, s, plain, p) == note : static_cast<int>(num(s, "pad")) == pad)
            return error = "Step " + std::to_string(to + 1) + " has this note", false;
        }
      int use = static_cast<int>(num(entry, "pad"));
      if (taken[use]) {
        use = -1;
        for (int k = 0; k < 16 && use < 0 && synth; ++k)
          if (!taken[k]) use = k;
        if (use < 0) return error = "Step " + std::to_string(to + 1) + " is full", false;
      }
      if (fresh) history.before(project, p);
      entry_at().set("step", Value::of(static_cast<double>(to)));
      entry_at().set("pad", Value::of(static_cast<double>(use)));
      step = to;
      shown.value = "Step " + std::to_string(to + 1);
      return true;
    }
  }
}

// Knob `knob` turned `delta` clicks on track `track`: level, pan and the two
// sends, in 1% clicks. A parameter assignment that mirrors one of them keeps
// its base equal to it, as the browser's mixer keeps it.
inline bool track_knob(Value& project, int track, int knob, int delta, bool fresh, History& history, Shown& shown,
                       std::string& error) {
  using project::detail::num;
  using project::detail::str;
  shown.name = track_knob_name(knob);
  const auto& tracks = project::detail::list(project, "tracks");
  if (track < 0 || track >= tracks.size()) return error = "No track", false;
  const Str id = str(tracks[track], "id");
  Value* mix = project.get("mix");
  if (knob > 0 && !mix && delta != 0) { project.set("mix", xmp::edit::detail::empty_mix()); mix = project.get("mix"); }
  const Value* strip = knob > 0 && mix ? mix->get("tracks")->get(id.c_str()) : nullptr;
  double was = 0;
  if (knob == 0)
    was = num(tracks[track], "volume");
  else if (knob == 1)
    was = strip ? num(*strip, "pan") : 0.5;
  else
    was = strip ? project::detail::list(*strip, "sends")[knob - 2].as_number() : 0;
  const double v = !delta ? was : knob == 0 ? rack::fader_gain(nudge(rack::fader_position(was), delta, 0, 1)) : nudge(was, delta, 0, 1);
  char db[32]; std::snprintf(db, sizeof db, "%.1f dB", v > 0 ? 20 * std::log10(v) : -120);
  shown.value = knob == 0 ? (v > 0 ? db : "Off") : knob == 1 ? pan_text(v) : percent(v);
  if (v == was) return false;
  if (fresh) history.before_track(project, track);
  const Str parameter = Str("track.") + id + (knob == 0 ? ".gain" : knob == 1 ? ".pan" : knob == 2 ? ".send.0" : ".send.1");
  if (knob == 0) {
    track_at(project, track).set("volume", Value::of(v));
  } else {
    Value* strips = mix->get("tracks");
    if (!strips->get(id.c_str())) {
      Value fresh_strip = Value::new_object();
      Value sends = Value::new_array();
      sends.push(Value::of(0.0)), sends.push(Value::of(0.0));
      fresh_strip.set("pan", Value::of(0.5)), fresh_strip.set("sends", xmp::move(sends));
      fresh_strip.set("inserts", Value::new_array());
      strips->set(id, xmp::move(fresh_strip));
    }
    Value& s = *strips->get(id.c_str());
    if (knob == 1)
      s.set("pan", Value::of(v));
    else
      s.get("sends")->items()[knob - 2] = Value::of(v);
  }
  for (auto& a : project.get("parameters")->items())
    if (str(a, "id") == parameter && a.get("base")) a.set("base", Value::of(v));
  return true;
}

// ---- the song: the performance's scene chain ----

inline Value& chain_of(Value& project) { return *project.get("performance")->get("chain"); }
inline int chain_size(const Value& project) {
  const Value* p = project.get("performance");
  return p ? project::detail::list(*p, "chain").size() : 0;
}
// A song edit forgets where the song was stopped (the position may name a
// block that changes or goes).
inline void forget_position(Value& project) { project.get("performance")->remove("position"); }

// Adds a block of scene `scene` (once) at `at` in the chain; `at` becomes the new block.
inline bool song_insert(Value& project, int& at, int scene, History& history, std::string& error) {
  using project::detail::list;
  using project::detail::str;
  const bool first_song = !project.get("performance");
  const auto& scenes = list(project, "scenes");
  if (scene < 0 || scene >= scenes.size()) return error = "No scene " + std::to_string(scene + 1), false;
  const int n = chain_size(project);
  if (n >= 64) return error = "The song is full (64 blocks)", false;
  at = std::clamp(at, 0, n);
  if (first_song) {
    history.before_project(project);
    project.set("performance", xmp::edit::detail::empty_performance());
  } else {
    history.before_song(project);
  }
  int k = 1;
  auto used = [&](const std::string& id) {
    for (const auto& c : list(*project.get("performance"), "chain"))
      if (str(c, "id") == id.c_str()) return true;
    return false;
  };
  while (used("song-" + std::to_string(k))) ++k;
  Value block = Value::new_object();
  block.set("id", Value::of(Str(("song-" + std::to_string(k)).c_str())));
  block.set("sceneId", Value::of(str(scenes[scene], "id")));
  block.set("repeats", Value::of(1.0));
  chain_of(project).items().insert(at, xmp::move(block));
  forget_position(project);
  return true;
}

// ---- capturing a jam as the song ----

// What was heard for a while: each track's clip id ("" for none), and for how many steps.
struct HeardPart {
  std::array<std::string, 8> clips;
  double steps = 0;
};

// Writes a captured jam into the song at block `at`: each part becomes a block
// of the scene that holds exactly those clips (a new "Jam" scene when none
// does), repeated for as long as it played (at least once; a run longer than
// 16 repeats becomes several blocks). Parts in a row on the same scene merge.
// One undo step brings the song and the scenes back. `added` counts new scenes,
// `blocks` the blocks written.
inline bool song_capture(Value& project, const std::vector<HeardPart>& parts, int at, History& history, int& added,
                         int& blocks, std::string& error) {
  using project::detail::list;
  using project::detail::num;
  using project::detail::str;
  added = blocks = 0;
  Value next = project;
  if (!next.get("performance")) next.set("performance", xmp::edit::detail::empty_performance());
  const auto& tracks = list(next, "tracks");
  // Each part's scene (an index), and its length in steps.
  struct Run {
    int scene;
    double steps;
  };
  std::vector<Run> runs;
  for (const auto& part : parts) {
    bool any = false;
    for (int t = 0; t < tracks.size() && t < 8; ++t) any = any || !part.clips[static_cast<std::size_t>(t)].empty();
    if (!any || part.steps <= 0) continue;
    const auto& scenes = list(next, "scenes");
    int found = -1;
    for (int s = 0; s < scenes.size() && found < 0; ++s) {
      const Value& clips = *scenes[s].get("clips");
      bool same = true;
      int count = 0;
      for (int t = 0; t < tracks.size() && t < 8; ++t) {
        const std::string& want = part.clips[static_cast<std::size_t>(t)];
        const Value* have = clips.get(str(tracks[t], "id").c_str());
        if (have) ++count;
        same = same && (want.empty() ? !have : have && have->as_string() == want.c_str());
      }
      if (same && count == clips.members().size()) found = s;
    }
    if (found < 0) {
      if (scenes.size() >= 16) return error = "No room for another scene (16)", false;
      int k = 1;
      auto taken = [&](const std::string& id) {
        for (const auto& sc : list(next, "scenes"))
          if (str(sc, "id") == id.c_str()) return true;
        return false;
      };
      while (taken("jam-" + std::to_string(k))) ++k;
      Value scene = Value::new_object();
      scene.set("id", Value::of(Str(("jam-" + std::to_string(k)).c_str())));
      scene.set("name", Value::of(Str(("Jam " + std::to_string(k)).c_str())));
      Value clips = Value::new_object();
      for (int t = 0; t < tracks.size() && t < 8; ++t)
        if (!part.clips[static_cast<std::size_t>(t)].empty())
          clips.set(str(tracks[t], "id"), Value::of(Str(part.clips[static_cast<std::size_t>(t)].c_str())));
      scene.set("clips", xmp::move(clips));
      next.get("scenes")->items().push(xmp::move(scene));
      found = list(next, "scenes").size() - 1;
      ++added;
    }
    if (!runs.empty() && runs.back().scene == found)
      runs.back().steps += part.steps;
    else
      runs.push_back({found, part.steps});
  }
  if (runs.empty()) return error = "Nothing was played", false;
  std::vector<Value> made;
  for (const auto& run : runs) {
    const Value& scene = list(next, "scenes")[run.scene];
    const double length = play::detail::scene_length(next, scene);
    int repeats = std::max(1, static_cast<int>(std::lround(run.steps / length)));
    while (repeats > 0) {
      Value block = Value::new_object();
      block.set("sceneId", Value::of(str(scene, "id")));
      block.set("repeats", Value::of(static_cast<double>(std::min(repeats, 16))));
      made.push_back(xmp::move(block));
      repeats -= 16;
    }
  }
  const int n = chain_size(next);
  if (n + static_cast<int>(made.size()) > 64) return error = "The song is full (64 blocks)", false;
  at = std::clamp(at, 0, n);
  int k = 1;
  auto used = [&](const std::string& id) {
    for (const auto& c : list(*next.get("performance"), "chain"))
      if (str(c, "id") == id.c_str()) return true;
    return false;
  };
  for (auto& block : made) {
    while (used("song-" + std::to_string(k))) ++k;
    Value b = Value::new_object();
    b.set("id", Value::of(Str(("song-" + std::to_string(k)).c_str())));
    b.set("sceneId", *block.get("sceneId"));
    b.set("repeats", *block.get("repeats"));
    chain_of(next).items().insert(at + blocks, xmp::move(b));
    ++blocks;
  }
  forget_position(next);
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why)) return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}

inline bool song_remove(Value& project, int at, History& history, std::string& error) {
  if (at < 0 || at >= chain_size(project)) return error = "No block here", false;
  history.before_song(project);
  chain_of(project).items().erase(at);
  forget_position(project);
  return true;
}

inline const char* song_knob_name(int knob) {
  static const char* names[4] = {"Repeats", "Move", "End", "Scene"};
  return names[std::clamp(knob, 0, 3)];
}

// Knob `knob` turned `delta` (the interface's whole changes) on block `at`:
// its repeats (1-16), its place in the chain (`at` follows), the song's end
// (stop or loop) and its scene. delta 0 only shows the value.
inline bool song_knob(Value& project, int& at, int knob, int delta, bool fresh, History& history, Shown& shown,
                      std::string& error) {
  using project::detail::list;
  using project::detail::num;
  using project::detail::str;
  shown.name = song_knob_name(knob);
  if (!project.get("performance")) return error = "This project has no song", false;
  const int n = chain_size(project);
  Value& perf = *project.get("performance");
  if (knob == 2) {
    const bool loop = str(perf, "end") == "loop";
    const bool want = delta == 0 ? loop : delta > 0;
    shown.value = want ? "Loop" : "Stop";
    if (want == loop) return false;
    if (fresh) history.before_song(project);
    project.get("performance")->set("end", Value::of(want ? "loop" : "stop"));
    return true;
  }
  if (at < 0 || at >= n) return error = "No block here", false;
  const Value& block = list(perf, "chain")[at];
  const auto& scenes = list(project, "scenes");
  int scene = 0;
  for (int i = 0; i < scenes.size(); ++i)
    if (str(scenes[i], "id") == str(block, "sceneId")) scene = i;
  switch (knob) {
    case 0: {
      const int was = static_cast<int>(num(block, "repeats")), v = std::clamp(was + delta, 1, 16);
      shown.value = "x" + std::to_string(v);
      if (v == was) return false;
      if (fresh) history.before_song(project);
      chain_of(project).items()[at].set("repeats", Value::of(static_cast<double>(v)));
      break;
    }
    case 1: {
      const int to = std::clamp(at + delta, 0, n - 1);
      shown.value = "Block " + std::to_string(to + 1);
      if (to == at) return false;
      if (fresh) history.before_song(project);
      auto& items = chain_of(project).items();
      Value moving = items[at];
      items.erase(at);
      items.insert(to, xmp::move(moving));
      at = to;
      break;
    }
    default: {
      const int to = ((scene + delta) % scenes.size() + scenes.size()) % scenes.size();
      shown.value = str(scenes[to], "name").c_str();
      if (to == scene) return false;
      if (fresh) history.before_song(project);
      chain_of(project).items()[at].set("sceneId", Value::of(str(scenes[to], "id")));
      break;
    }
  }
  forget_position(project);
  return true;
}

// ---- the mixer: mute and solo ----
// A track is muted by its own "muted" or by the performance's saved mutes; a
// solo silences every track not soloed (controls.hpp). The Mix view changes
// the performance's mutes and solos, which play and save with the project.

inline const Str& track_id(const Value& project, int track) {
  return project::detail::str(project::detail::list(project, "tracks")[track], "id");
}
inline bool is_muted(const Value& project, int track) {
  if (project::detail::list(project, "tracks")[track].get("muted")->as_bool()) return true;
  const Value* perf = project.get("performance");
  const Value* m = perf ? perf->get("mutes")->get(track_id(project, track).c_str()) : nullptr;
  return m && m->as_bool();
}
inline bool is_soloed(const Value& project, int track) {
  const Value* perf = project.get("performance");
  if (!perf) return false;
  for (const auto& s : project::detail::list(*perf, "solos"))
    if (s.as_string() == track_id(project, track)) return true;
  return false;
}

// Mutes the track, or unmutes it (clearing its own "muted" too).
inline bool toggle_mute(Value& project, int track, History& history, std::string& error) {
  if (track < 0 || track >= project::detail::list(project, "tracks").size()) return error = "No track", false;
  if (!project.get("performance")) return error = "This project has no performance", false;
  const bool muted = is_muted(project, track);
  history.before_track(project, track);
  Value* mutes = project.get("performance")->get("mutes");
  const Str id = track_id(project, track);
  if (muted) {
    mutes->remove(id.c_str());
    track_at(project, track).set("muted", Value::of(false));
  } else {
    mutes->set(id, Value::of(true));
  }
  return true;
}

inline bool toggle_solo(Value& project, int track, History& history, std::string& error) {
  if (track < 0 || track >= project::detail::list(project, "tracks").size()) return error = "No track", false;
  if (!project.get("performance")) return error = "This project has no performance", false;
  const bool soloed = is_soloed(project, track);
  history.before_track(project, track);
  auto& solos = project.get("performance")->get("solos")->items();
  const Str id = track_id(project, track);
  if (soloed) {
    for (int i = solos.size() - 1; i >= 0; --i)
      if (solos[i].as_string() == id) solos.erase(i);
  } else {
    solos.push(Value::of(id));
  }
  return true;
}

}  // namespace xmp::live::edit
