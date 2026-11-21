#pragma once
// Main-thread, bounded value editors shared by touch and physical controls.
#include <cmath>

#include "xmp/live_edit.hpp"
namespace xmp::live::edit {
enum class Field {
  none,
  tempo,
  level,
  pan,
  send_a,
  send_b,
  velocity,
  chance,
  duration,
  condition,
  repeats,
  block_scene,
  song_end,
  clip_length,
  launch_grid,
  cutoff,
  attack,
  decay,
  sustain,
  release,
  oscillator,
  midi_channel,
  midi_destination,
  sample_start,
  sample_end,
  sample_tune,
  sample_level,
  sample_fade_in,
  sample_fade_out,
  sample_slices,
  sample_reverse,
  scale,
  quantize,
  machine,
  scale_root,  // the playing scale's root note (Play view): 0 = C ... 11 = B
  // The subtractive synth's later controls (Sound view, Controls page).
  resonance,
  env_amount,
  env_decay,
  detune,
  glide,
  effect_sync
};
struct Focus {
  int track = 0, scene = 0, pad = 0, note = 48, step = 0, block = 0;
};
struct FieldValue {
  bool available = false;
  Field field = Field::none;
  Focus focus{};
  std::string name, unit;
  double value = 0, min = 0, max = 1, increment = .01, reset = 0;
  Str parameter;
  double parameter_scale = 100;
};
inline const char *condition_name(int i) {
  static const char *names[] = {"always", "first", "not-first", "fill", "not-fill", "every-2", "every-4"};
  return names[std::clamp(i, 0, 6)];
}
inline Place focused_clip(const Value &project, Focus f) {
  const auto &tracks = project::detail::list(project, "tracks");
  const auto &scenes = project::detail::list(project, "scenes");
  if (f.track < 0 || f.track >= tracks.size() || f.scene < 0 || f.scene >= scenes.size())
    return {};
  const Str id = project::detail::str(tracks[f.track], "id");
  const Value *clip = project::detail::at(scenes[f.scene], "clips").get(id.c_str());
  return clip ? find(project, id, clip->as_string()) : Place{};
}
constexpr int kNewClipSteps = 16;
inline bool create_empty_clip(Value &project, Focus f, History &history, std::string &error) {
  using namespace project::detail;
  const auto &tracks = list(project, "tracks");
  const auto &scenes = list(project, "scenes");
  if (f.track < 0 || f.track >= tracks.size() || f.scene < 0 || f.scene >= scenes.size())
    return error = "No such slot", false;
  if (focused_clip(project, f).ok())
    return error = "This slot already has a clip", false;
  int number = 1;
  auto used = [&](int n) {
    for (const auto &t : tracks)
      for (const auto &c : list(t, "clips"))
        if (str(c, "id") == Str("clip-") + int_text(n))
          return true;
    return false;
  };
  while (used(number))
    ++number;
  const Str id = Str("clip-") + int_text(number);
  Value next = project, clip = Value::new_object();
  clip.set("id", Value::of(id));
  clip.set("name", Value::of(Str("Clip ") + int_text(number)));
  clip.set("length", Value::of(static_cast<double>(kNewClipSteps)));
  clip.set("steps", Value::new_array());
  track_at(next, f.track).get("clips")->items().push(xmp::move(clip));
  scene_at(next, f.scene).get("clips")->set(str(tracks[f.track], "id"), Value::of(id));
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why))
    return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}
inline const Value *focused_note(const Value &project, Place p, Focus f) {
  if (!p.ok())
    return nullptr;
  const int i = step_entry(project, p, f.step, f.pad, f.note);
  if (i >= 0)
    return &project::detail::list(clip_at(project, p), "steps")[i];
  if (const Value *seq = clip_at(project, p).get("sequence"))
    for (const auto &n : project::detail::list(*seq, "notes"))
      if (static_cast<int>(std::floor(project::detail::num(n, "position"))) == f.step &&
          (is_melodic(project, p) ? static_cast<int>(project::detail::num(n, "note")) == f.note
                                  : static_cast<int>(project::detail::num(n, "pad")) == f.pad))
        return &n;
  return nullptr;
}
inline FieldValue read_field(const Value &project, Focus f, Field field) {
  using project::detail::at;
  using project::detail::list;
  using project::detail::num;
  using project::detail::str;
  FieldValue v;
  v.field = field;
  v.focus = f;
  v.available = true;
  const auto &tracks = list(project, "tracks");
  if (f.track < 0 || f.track >= tracks.size())
    return {};
  const auto &t = tracks[f.track];
  const Str prefix = Str("track.") + str(t, "id") + ".";
  auto number = [&](const char *name, double value, double min, double max, double increment, double reset,
                    const char *unit = "") {
    v.name = name;
    v.value = value;
    v.min = min;
    v.max = max;
    v.increment = increment;
    v.reset = reset;
    v.unit = unit;
  };
  const auto p = focused_clip(project, f);
  const Value *note = focused_note(project, p, f);
  switch (field) {
  case Field::tempo:
    number("Tempo", num(project, "bpm"), 30, 300, 1, 112, " BPM");
    break;
  case Field::level:
  case Field::pan:
  case Field::send_a:
  case Field::send_b: {
    v.parameter = prefix + (field == Field::level    ? "gain"
                            : field == Field::pan    ? "pan"
                            : field == Field::send_a ? "send.0"
                                                     : "send.1");
    double value = 0;
    Str why;
    if (!parameters::value(project, v.parameter, value, why))
      value = field == Field::pan ? .5 : 0;
    number(field == Field::level    ? "Level"
           : field == Field::pan    ? "Pan"
           : field == Field::send_a ? "Send A"
                                    : "Send B",
           value * 100, 0, 100, 1,
           field == Field::level ? 80
           : field == Field::pan ? 50
                                 : 0,
           "%");
    break;
  }
  case Field::velocity:
  case Field::chance:
  case Field::duration:
  case Field::condition: {
    if (!note)
      return {};
    if (field == Field::condition) {
      int i = 0;
      while (i < 6 && str(*note, "condition") != condition_name(i))
        ++i;
      if (!note->get("condition"))
        i = 0;
      number("Condition", i, 0, 6, 1, 0);
    } else if (field == Field::duration)
      number("Length", note->get("duration") ? num(*note, "duration") : 1, .25, 16, .25, 1, " steps");
    else
      number(field == Field::velocity ? "Velocity" : "Chance",
             num(*note, field == Field::velocity ? "velocity" : "probability") * 100, field == Field::velocity ? 1 : 0,
             100, 1, field == Field::velocity ? 80 : 100, "%");
    break;
  }
  case Field::clip_length:
    if (!p.ok())
      return {};
    number("Clip length", num(clip_at(project, p), "length"), 1, 1024, 1, 16, " steps");
    break;
  case Field::launch_grid:
    number("Launch grid",
           at(project, "performance").get("launchQuantize") ? num(at(project, "performance"), "launchQuantize") : 16, 0,
           64, 1, 16, " steps");
    break;
  case Field::repeats:
  case Field::block_scene: {
    const auto &chain = list(at(project, "performance"), "chain");
    if (f.block < 0 || f.block >= chain.size())
      return {};
    if (field == Field::repeats)
      number("Repeats", num(chain[f.block], "repeats"), 1, 16, 1, 1, "x");
    else {
      int i = 0;
      for (const auto &s : list(project, "scenes")) {
        if (str(s, "id") == str(chain[f.block], "sceneId"))
          break;
        ++i;
      }
      number("Scene", i, 0, list(project, "scenes").size() - 1, 1, 0);
    }
    break;
  }
  case Field::song_end:
    number("Song end", str(at(project, "performance"), "end") == "loop" ? 1 : 0, 0, 1, 1, 0);
    break;
  case Field::cutoff:
  case Field::attack:
  case Field::decay:
  case Field::sustain:
  case Field::release:
  case Field::midi_channel: {
    const char *key = field == Field::cutoff    ? "cutoff"
                      : field == Field::attack  ? "attack"
                      : field == Field::decay   ? "decay"
                      : field == Field::sustain ? "sustain"
                      : field == Field::release ? "release"
                                                : "channel";
    const auto *machine = t.get("machine");
    if (!machine)
      return {};
    v.parameter = prefix + "machine." + str(*machine, "id") + ".v1." + key;
    double normalized = 0;
    Str why;
    if (!parameters::value(project, v.parameter, normalized, why))
      return {};
    if (field == Field::cutoff)
      number("Tone", num(at(*machine, "state"), key), 30, 16000, 10, 750, " Hz");
    else if (field == Field::midi_channel)
      number("MIDI channel", num(at(*machine, "state"), key), 1, 16, 1, 1);
    else if (field == Field::sustain)
      number("Sustain", num(at(*machine, "state"), key) * 100, 0, 100, 1, 45, "%");
    else
      number(field == Field::attack ? "Attack" : field == Field::decay ? "Decay" : "Release",
             num(at(*machine, "state"), key) * 1000, field == Field::release ? 5 : 1, 2000, 1,
             field == Field::attack ? 5 : 120, " ms");
    break;
  }
  case Field::resonance:
  case Field::env_amount:
  case Field::env_decay:
  case Field::detune:
  case Field::glide: {
    // Optional in the patch: shown from the parameter, which knows the default.
    const char *key = field == Field::resonance    ? "resonance"
                      : field == Field::env_amount ? "env-amount"
                      : field == Field::env_decay  ? "env-decay"
                      : field == Field::detune     ? "detune"
                                                   : "glide";
    const auto *machine = t.get("machine");
    if (!machine || str(*machine, "id") != "xmp.subtractive")
      return {};
    v.parameter = prefix + "machine." + str(*machine, "id") + ".v1." + key;
    double n = 0;
    Str why;
    if (!parameters::value(project, v.parameter, n, why))
      return {};
    if (field == Field::resonance)
      number("Resonance", n * 100, 0, 100, 1, 0, "%");
    else if (field == Field::env_amount)
      number("Filter envelope", std::round(n * 60) / 10, 0, 6, .1, 0, " oct");
    else if (field == Field::env_decay)
      number("Filter decay", std::round(10 + n * 1990), 10, 2000, 1, 300, " ms");
    else if (field == Field::detune)
      number("Detune", std::round(n * 50), 0, 50, 1, 0, " cents");
    else
      number("Glide", std::round(n * 1000), 0, 1000, 1, 0, " ms");
    break;
  }
  case Field::oscillator: {
    const Str name = str(at(at(t, "machine"), "state"), "oscillator");
    number("Wave", name == "square" ? 2 : name == "saw" ? 1 : 0, 0, 2, 1, 1);
    break;
  }
  case Field::midi_destination: {
    int index = 0;
    const Str dest = str(at(at(t, "machine"), "state"), "destination");
    for (int i = 0; i < tracks.size(); ++i)
      if (str(tracks[i], "id") == dest)
        index = i + 1;
    number("Destination", index, 0, tracks.size(), 1, 0);
    break;
  }
  default:
    return {};
  }
  return v;
}
// The notes a clip would lose at a shorter length (they start at or after it).
inline int notes_beyond(const Value &project, Focus f, double length) {
  using project::detail::at;
  using project::detail::list;
  using project::detail::num;
  const auto place = focused_clip(project, f);
  if (!place.ok()) return 0;
  const auto &clip = clip_at(project, place);
  int n = 0;
  for (const auto &s : list(clip, "steps")) n += num(s, "step") >= length;
  for (const auto &note : list(at(clip, "sequence"), "notes")) n += num(note, "position") >= length;
  return n;
}
inline bool apply_field(Value &project, FieldValue field, double value, History &history, std::string &error) {
  using project::detail::at;
  using project::detail::list;
  using project::detail::num;
  using project::detail::str;
  if (!field.available || !std::isfinite(value) || value < field.min || value > field.max)
    return error = "Value outside bounds", false;
  if ((field.field == Field::condition || field.field == Field::repeats || field.field == Field::block_scene ||
       field.field == Field::midi_channel || field.field == Field::midi_destination ||
       field.field == Field::oscillator) &&
      value != std::floor(value))
    return error = "Choose a whole-number option", false;
  if (field.value == value)
    return false;
  const auto f = field.focus;
  Value next = project;
  if (!field.parameter.empty()) {
    if (field.field == Field::pan || field.field == Field::send_a || field.field == Field::send_b) {
      if (!next.get("mix"))
        next.set("mix", xmp::edit::detail::empty_mix());
      auto &strips = *next.get("mix")->get("tracks");
      const Str id = str(track_at(next, f.track), "id");
      if (!strips.get(id.c_str())) {
        Value strip = Value::new_object(), sends = Value::new_array();
        sends.push(Value::of(0.0));
        sends.push(Value::of(0.0));
        strip.set("pan", Value::of(.5));
        strip.set("sends", xmp::move(sends));
        strip.set("inserts", Value::new_array());
        strips.set(id, xmp::move(strip));
      }
    }
    double normalized = value / field.parameter_scale;
    if (field.field == Field::cutoff)
      normalized = (value - 30) / 15970;
    else if (field.field == Field::midi_channel)
      normalized = (value - 1) / 15;
    else if (field.field == Field::attack || field.field == Field::decay)
      normalized = (value / 1000 - .001) / 1.999;
    else if (field.field == Field::release)
      normalized = (value / 1000 - .005) / 1.995;
    else if (field.field == Field::env_amount)
      normalized = value / 6;
    else if (field.field == Field::env_decay)
      normalized = (value / 1000 - .01) / 1.99;
    else if (field.field == Field::detune)
      normalized = value / 50;
    else if (field.field == Field::glide)
      normalized = value / 1000;
    auto e = parameters::set_parameter(next, field.parameter, normalized);
    if (!e.ok)
      return error = e.error.c_str(), false;
    next = e.project;
  } else
    switch (field.field) {
    case Field::effect_sync: {
      if (value != std::floor(value) || value < 0 || value > 6 || f.track < 0 || f.track >= list(next, "tracks").size() || f.scene < -1 || f.scene > 1 || f.pad < 0 || f.pad > 1)
        return error = "Invalid delay sync", false;
      auto* mix = next.get("mix"); if (!mix) return error = "No effect", false;
      auto* strip = mix->get("tracks")->get(str(track_at(next, f.track), "id").c_str());
      if (f.scene < 0 && !strip) return error = "No effect", false;
      auto& inserts = f.scene < 0 ? strip->get("inserts")->items() : mix->get("returns")->items()[f.scene].items();
      if (f.pad >= inserts.size() || str(inserts[f.pad], "kind") != "delay") return error = "No delay", false;
      auto& effect = inserts[f.pad];
      if (value == 0) effect.remove("sync");
      else {
        static const double divisions[] = {0, .25, .5, 1, 2, 4, 8};
        Value sync = Value::new_object(), seq = Value::new_array(); seq.push(Value::of(1.0));
        sync.set("division", Value::of(divisions[static_cast<int>(value)])); sync.set("sequence", xmp::move(seq));
        sync.set("phase", Value::of("transport")); sync.set("loss", Value::of("hold-last-tempo")); effect.set("sync", xmp::move(sync));
      }
      break;
    }
    case Field::tempo:
      next.set("bpm", Value::of(value));
      break;
    case Field::launch_grid:
      if (value != 0 && value != 4 && value != 16 && value != 32 && value != 64)
        return error = "Choose 0, 4, 16, 32 or 64", false;
      if (!next.get("performance"))
        next.set("performance", xmp::edit::detail::empty_performance());
      next.get("performance")->set("launchQuantize", Value::of(value));
      break;
    case Field::velocity:
    case Field::chance:
    case Field::duration:
    case Field::condition: {
      auto place = focused_clip(next, f);
      if (!place.ok())
        return false;
      Value &clip = clip_at(next, place);
      const int entry = step_entry(next, place, f.step, f.pad, f.note);
      Value *note = nullptr;
      if (entry >= 0 && field.field != Field::condition)
        note = &clip.get("steps")->items()[entry];
      else {
        if (!clip.get("sequence")) {
          Value seq = Value::new_object();
          seq.set("version", Value::of(1.0));
          for (const char *k : {"notes", "locks", "lanes", "modulations"})
            seq.set(k, Value::new_array());
          clip.set("sequence", xmp::move(seq));
        }
        auto &notes = clip.get("sequence")->get("notes")->items();
        for (auto &n : notes)
          if (static_cast<int>(std::floor(num(n, "position"))) == f.step &&
              (is_melodic(next, place) ? static_cast<int>(num(n, "note")) == f.note
                                       : static_cast<int>(num(n, "pad")) == f.pad)) {
            note = &n;
            break;
          }
        if (!note && entry >= 0) {
          const Value old = clip.get("steps")->items()[entry];
          Value n = Value::new_object();
          int id = 0;
          auto used = [&](int k) {
            for (const auto &q : notes)
              if (str(q, "id") == Str("touch-") + int_text(k))
                return true;
            return false;
          };
          while (used(id))
            ++id;
          n.set("id", Value::of(Str("touch-") + int_text(id)));
          n.set("pad", *old.get("pad"));
          n.set("note", Value::of(static_cast<double>(old.get("note") ? num(old, "note") : f.note)));
          n.set("position", Value::of(static_cast<double>(f.step)));
          n.set("duration", Value::of(old.get("duration") ? num(old, "duration") : 1));
          n.set("velocity", *old.get("velocity"));
          n.set("probability", *old.get("probability"));
          n.set("microtiming", Value::of(0.0));
          n.set("condition", Value::of("always"));
          notes.push(xmp::move(n));
          note = &notes.back();
          clip.get("steps")->items().erase(entry);
        }
      }
      if (!note)
        return error = "Select an existing note", false;
      if (field.field == Field::condition)
        note->set("condition", Value::of(condition_name(static_cast<int>(value))));
      else
        note->set(field.field == Field::velocity ? "velocity"
                  : field.field == Field::chance ? "probability"
                                                 : "duration",
                  Value::of(field.field == Field::duration ? value : value / 100));
      break;
    }
    case Field::repeats:
    case Field::block_scene: {
      Value &part = next.get("performance")->get("chain")->items()[f.block];
      if (field.field == Field::repeats)
        part.set("repeats", Value::of(value));
      else
        part.set("sceneId", Value::of(str(list(next, "scenes")[static_cast<int>(value)], "id")));
      break;
    }
    case Field::song_end:
      next.get("performance")->set("end", Value::of(value > 0 ? "loop" : "stop"));
      break;
    case Field::oscillator:
      track_at(next, f.track)
          .get("machine")
          ->get("state")
          ->set("oscillator", Value::of(value == 0   ? "sine"
                                        : value == 1 ? "saw"
                                                     : "square"));
      break;
    case Field::midi_destination: {
      auto &machine = *track_at(next, f.track).get("machine");
      if (value == 0)
        machine.get("state")->remove("destination");
      else {
        const int index = static_cast<int>(value) - 1;
        if (index == f.track || str(at(list(next, "tracks")[index], "machine"), "id") == "xmp.midi")
          return error = "Choose another instrument track", false;
        machine.get("state")->set("destination", Value::of(str(list(next, "tracks")[index], "id")));
      }
      break;
    }
    case Field::clip_length: {
      if (value != std::floor(value)) return error = "Choose a whole number of steps", false;
      const auto place = focused_clip(next, f);
      if (!place.ok()) return false;
      auto resized = xmp::edit::resize_clip(next, str(track_at(next, place.track), "id"), str(clip_at(next, place), "id"), value);
      if (!resized.ok) return error = resized.error.c_str(), false;
      next = xmp::move(resized.project);
      break;
    }
    default:
      return error = "Field unavailable", false;
    }
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why))
    return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}
inline bool rename_item(Value &project, Focus focus, int kind, const std::string &name, History &history,
                        std::string &error) {
  if (name.empty() || Str(name.c_str()).utf16_length() > (kind == 1 ? 80u : 40u) || kind < 1 || kind > 3)
    return error = "Invalid name", false;
  Value next = project;
  if (kind == 1)
    next.set("name", Value::of(Str(name.c_str())));
  else if (kind == 2) {
    if (focus.track < 0 || focus.track >= project::detail::list(next, "tracks").size())
      return false;
    track_at(next, focus.track).set("name", Value::of(Str(name.c_str())));
  } else {
    const auto place = focused_clip(next, focus);
    if (!place.ok())
      return error = "No clip", false;
    clip_at(next, place).set("name", Value::of(Str(name.c_str())));
  }
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why))
    return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}
inline bool choose_instrument(Value &project, int track, int kind, History &history, std::string &error) {
  using namespace project::detail;
  const auto &tracks = list(project, "tracks");
  if (track < 0 || track >= tracks.size() || kind < 0 || kind > 3)
    return error = "Invalid instrument", false;
  const auto &previous = tracks[track];
  const auto &old_machine = at(previous, "machine");
  const Str old_mode = str(at(old_machine, "state"), "mode");
  const auto &old_pads = track_pads(project, &previous);
  const bool from_sampler = (old_machine.is_null() || str(old_machine, "id") == "xmp.sampler") &&
                            (old_mode == "keys" || old_mode == "slices" ||
                             (!old_pads.empty() && str(at(old_pads[0], "playback"), "mode") == "chromatic"));
  Value next = project, machine;
  Str why;
  if (!machine::machines().instantiate(Str(kind == 2   ? "xmp.subtractive"
                                           : kind == 3 ? "xmp.midi"
                                                       : "xmp.sampler"),
                                       machine, why))
    return error = why.c_str(), false;
  if (kind == 1)  // a Sampler: its one sample plays across the pads as notes
    machine.get("state")->set("mode", Value::of("keys"));
  track_at(next, track).set("machine", xmp::move(machine));
  const Str id = project::detail::str(track_at(next, track), "id"), prefix = Str("track.") + id + ".machine.";
  auto &parameters = next.get("parameters")->items();
  for (int i = parameters.size() - 1; i >= 0; --i)
    if (project::detail::str(parameters[i], "id").starts_with(prefix))
      parameters.erase(i);
  if (kind == 0 && from_sampler) {
    // A Sampler's pads are copies or slices of one sound. Start a Kit from
    // the project bank so each pad has its own assignment again.
    auto shared = xmp::edit::share_kit(next, id);
    if (!shared.ok)
      return error = shared.error.c_str(), false;
    next = xmp::move(shared.project);
  }
  if (kind < 2) {
    auto owned = xmp::edit::own_kit(next, id);
    if (!owned.ok)
      return error = owned.error.c_str(), false;
    next = owned.project;
    auto &pads = track_at(next, track).get("pads")->items();
    const Value source = pads[0];
    for (int i = 0; i < pads.size(); ++i) {
      if (kind == 0 && str(at(pads[i], "playback"), "mode") != "chromatic")
        continue;
      if (kind == 1) {
        pads[i].set("sampleId", *source.get("sampleId"));
        if (const auto *layers = source.get("layers"))
          pads[i].set("layers", *layers);
        else
          pads[i].remove("layers");
        if (const auto *slice = source.get("slice"))
          pads[i].set("slice", *slice);
        else
          pads[i].remove("slice");
      }
      Value playback = Value::new_object();
      playback.set("mode", Value::of(kind == 1 ? "chromatic" : "one-shot"));
      playback.set("rootNote", Value::of(48.0));
      playback.set("chokeGroup", Value::of(0.0));
      pads[i].set("playback", xmp::move(playback));
    }
  }
  Value checked;
  if (!project::canonical(next, checked, why))
    return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}
inline bool lock_step(Value &project, Focus f, int knob, int delta, bool clear, History &history, std::string &error) {
  const auto place = focused_clip(project, f);
  if (!place.ok() || f.step < 0 || f.step >= project::detail::num(clip_at(project, place), "length"))
    return error = "Select a step", false;
  Value next = project;
  auto &clip = clip_at(next, place);
  if (!clip.get("sequence")) {
    Value seq = Value::new_object();
    seq.set("version", Value::of(1.0));
    for (const char *k : {"notes", "locks", "lanes", "modulations"})
      seq.set(k, Value::new_array());
    clip.set("sequence", xmp::move(seq));
  }
  auto &locks = clip.get("sequence")->get("locks")->items();
  if (clear) {
    for (int i = locks.size() - 1; i >= 0; --i)
      if (project::detail::num(locks[i], "position") == f.step)
        locks.erase(i);
  } else {
    const auto definitions = sound_parameters(project, f.track);
    const Str id = !definitions.empty() ? definitions[std::clamp(knob, 0, static_cast<int>(definitions.size()) - 1)].id
                                        : Str("track.") + project::detail::str(track_at(next, f.track), "id") + ".gain";
    double value = 0;
    Str why;
    if (!parameters::value(project, id, value, why))
      return error = why.c_str(), false;
    int index = -1;
    for (int i = 0; i < locks.size(); ++i)
      if (project::detail::num(locks[i], "position") == f.step && project::detail::str(locks[i], "parameter") == id) {
        index = i;
        value = project::detail::num(locks[i], "value");
      }
    Value lock = Value::new_object();
    lock.set("position", Value::of(static_cast<double>(f.step)));
    lock.set("parameter", Value::of(id));
    lock.set("value", Value::of(std::clamp(value + delta * .01, 0.0, 1.0)));
    if (index >= 0)
      locks[index] = xmp::move(lock);
    else {
      if (locks.size() >= 256)
        return error = "Lock budget reached", false;
      locks.push(xmp::move(lock));
    }
  }
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why))
    return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}
inline bool effect_edit(Value &project, int track, int location, int slot, int operation, int kind, History &history,
                        std::string &error) {
  using project::detail::list;
  using project::detail::num;
  using project::detail::str;
  if (track < 0 || track >= list(project, "tracks").size() || location < -1 || location > 1 || slot < 0 || slot > 1 ||
      operation < 0 || operation > 2 || kind < 0 || kind > 5)
    return error = "Invalid effect selection", false;
  Value next = project;
  if (!next.get("mix"))
    next.set("mix", xmp::edit::detail::empty_mix());
  auto &mix = *next.get("mix");
  const Str track_id = str(track_at(next, track), "id");
  if (!mix.get("tracks")->get(track_id.c_str())) {
    Value strip = Value::new_object(), sends = Value::new_array();
    sends.push(Value::of(0.0));
    sends.push(Value::of(0.0));
    strip.set("pan", Value::of(.5));
    strip.set("sends", xmp::move(sends));
    strip.set("inserts", Value::new_array());
    mix.get("tracks")->set(track_id, xmp::move(strip));
  }
  auto &inserts = location < 0 ? mix.get("tracks")->get(track_id.c_str())->get("inserts")->items()
                               : mix.get("returns")->items()[location].items();
  if (operation == 1) {
    if (slot >= inserts.size())
      return error = "No effect in this slot", false;
    inserts.erase(slot);
  } else if (operation == 2) {
    if (slot >= inserts.size())
      return error = "No effect in this slot", false;
    inserts[slot].set("bypass", Value::of(!project::detail::at(inserts[slot], "bypass").as_bool()));
  } else {
    static const char *kinds[] = {"eq", "filter", "delay", "reverb", "distortion", "compressor"};
    Value effect = Value::new_object(), params = Value::new_object();
    switch (kind) {
    case 0:
      params.set("tone", Value::of(.5));
      params.set("gain", Value::of(.5));
      break;
    case 1:
      params.set("cutoff", Value::of(.7));
      break;
    case 2:
      params.set("time", Value::of(.125));
      params.set("feedback", Value::of(.4));
      params.set("wet", Value::of(.35));
      break;
    case 3:
      params.set("decay", Value::of(.5));
      params.set("wet", Value::of(.25));
      break;
    case 4:
      params.set("drive", Value::of(.25));
      params.set("wet", Value::of(.5));
      break;
    default:
      params.set("threshold", Value::of(.6));
      params.set("ratio", Value::of(.3));
      params.set("makeup", Value::of(0.0));
      break;
    }
    int id = 0;
    auto used = [&](int n) {
      const Str candidate = Str("ui-fx-") + int_text(n);
      for (const auto &member : mix.get("tracks")->members())
        for (const auto &e : list(member.value, "inserts"))
          if (str(e, "id") == candidate)
            return true;
      for (const auto &ret : mix.get("returns")->items())
        for (const auto &e : ret.items())
          if (str(e, "id") == candidate)
            return true;
      return false;
    };
    while (used(id))
      ++id;
    effect.set("id", Value::of(Str("ui-fx-") + int_text(id)));
    effect.set("kind", Value::of(kinds[kind]));
    effect.set("params", xmp::move(params));
    effect.set("bypass", Value::of(false));
    if (slot < inserts.size())
      inserts[slot] = xmp::move(effect);
    else
      inserts.push(xmp::move(effect));
  }
  Value checked;
  Str why;
  if (!project::canonical(next, checked, why))
    return error = why.c_str(), false;
  history.before_project(project);
  project = xmp::move(checked);
  return true;
}
} // namespace xmp::live::edit
