#pragma once
// Rendering XMP projects to audio in C++: performanceCommands and
// renderPerformance, renderSequence, prepareScene and renderPlan,
// renderProjectScene, renderInstrumentScene and renderExchange. They began as
// ports of packages/core's TypeScript renderers, retired in phase 9 (the
// browser, tools and tests use these through the WebAssembly core).
// The engine is rack.hpp through voices.hpp; tests/parity/render-parity.test.ts
// compares the audio with the TypeScript's.
#include "xmp/voices.hpp"

namespace xmp::render {

using json::Value;
using voices::MidiEvent;

namespace detail {
using project::detail::at;
using project::detail::list;
using project::detail::num;
using project::detail::str;
inline double js_round(double x) { return edit::detail::js_round(x); }
// mix.ts musicalSeconds
inline bool musical_seconds(const Value& project, double step, double& out, Str& error) {
  if (!isfinite(step) || step < 0 || step > 1000100) return error = "Invalid musical position", false;
  double seconds = 0, previous = 0, bpm = num(project, "bpm");
  if (const Value* mix = project.get("mix"))
    for (const auto& t : list(*mix, "tempos")) {
      if (num(t, "step") > step) break;
      seconds += ((num(t, "step") - previous) * 15) / bpm;
      previous = num(t, "step"), bpm = num(t, "bpm");
    }
  out = seconds + ((step - previous) * 15) / bpm;
  return true;
}
inline double tempo_at(const Value& project, double step) {
  double bpm = num(project, "bpm");
  if (const Value* mix = project.get("mix"))
    for (const auto& t : list(*mix, "tempos")) {
      if (step < num(t, "step")) break;
      bpm = num(t, "bpm");
    }
  return bpm;
}
// stepTime
inline double step_time(double step, double bpm, double swing) { return xmp::sequencer::step_time(step, bpm, swing); }
inline int32_t track_index(const Value& project, const Str& id) {
  const auto& tracks = list(project, "tracks");
  for (int32_t i = 0; i < tracks.size(); ++i)
    if (str(tracks[i], "id") == id) return i;
  return -1;
}
}  // namespace detail

// performanceCommands: a window's work for the engine, frame by frame.
struct Command {
  double frame = 0;
  enum Kind : int32_t { clock = -1, release = 0, gates = 1, parameters = 2, on = 3 } kind = on;
  double position = 0, bpm = 0;
  Vec<Str> tracks;
  Value values;  // parameters
  Value note;    // on
};
inline bool performance_commands(const Value& window, const Value& project, double rate, Vec<Command>& out, Str& error) {
  using namespace detail;
  const Value& snapshot = at(window, "snapshot");
  double frame = 0;
  if (const Value* f = window.get("startFrame"))
    frame = f->as_number();
  else {
    double seconds = 0;
    if (!musical_seconds(project, num(snapshot, "step"), seconds, error)) return false;
    frame = js_round(seconds * rate);
  }
  Vec<Command> commands;
  if (project.get("mix")) {
    Command c;
    c.frame = frame, c.kind = Command::clock;
    const Value* clock = window.get("clock");
    c.position = clock ? num(*clock, "step") : num(snapshot, "step");
    c.bpm = clock ? num(*clock, "bpm") : tempo_at(project, num(snapshot, "step"));
    commands.push(xmp::move(c));
  }
  if (list(window, "releases").size()) {
    Command c;
    c.frame = frame, c.kind = Command::release;
    for (const auto& r : list(window, "releases")) c.tracks.push(r.as_string());
    commands.push(xmp::move(c));
  }
  for (const auto& ctl : list(window, "controls")) {
    Command g;
    g.frame = num(ctl, "frame"), g.kind = Command::gates;
    for (const auto& b : list(ctl, "blocked")) g.tracks.push(b.as_string());
    commands.push(xmp::move(g));
    Command p;
    p.frame = num(ctl, "frame"), p.kind = Command::parameters, p.values = at(ctl, "values");
    commands.push(xmp::move(p));
  }
  for (const auto& n : list(window, "notes")) {
    Command c;
    c.frame = num(n, "frame"), c.kind = Command::on, c.note = n;
    commands.push(xmp::move(c));
  }
  // By frame, then kind (stable).
  for (int32_t i = 1; i < commands.size(); ++i)
    for (int32_t k = i; k > 0; --k) {
      const Command &a = commands[k - 1], &b = commands[k];
      if (!(a.frame > b.frame || (a.frame == b.frame && a.kind > b.kind))) break;
      Command t = xmp::move(commands[k]);
      commands[k] = xmp::move(commands[k - 1]);
      commands[k - 1] = xmp::move(t);
    }
  for (auto& c : commands) out.push(xmp::move(c));
  return true;
}

struct Transition {
  double step = 0;
  Str scene, occurrence;
  bool has_occurrence = false;
};
struct Traced {
  double frame = 0;
  int32_t note = 0;
  Str track;
};
struct Performance {
  Vec<float> left, right;
  Value meter;
  Vec<Traced> trace;
  Vec<Transition> transitions;
  double body_steps = 0;
  Vec<MidiEvent> midi;
  int32_t command_count = 0;
  Vec<Command> commands;  // what the render scheduled, in order
  Value snapshot;
};

// renderPerformance: a scene or the song, played through the performance, to stereo audio.
inline bool render_performance(const Value& project, const Str& scene, const Str& mode, double steps, double tail,
                               bool resume, Performance& out, Str& error) {
  using namespace detail;
  Value checked;
  if (!project::canonical(project, checked, error)) return false;
  if (!(steps == floor(steps)) || steps < 1 || steps > 1024 || !isfinite(tail) || tail < 0 || tail > 8)
    return error = "Invalid performance render budget", false;
  play::Performance player(project);
  if (!player.ok()) return error = player.error(), false;
  if (!player.start(scene, mode == "song", resume, error)) return false;
  const double origin = player.clock_origin();
  auto seconds = [&](double position, double& s) {
    double a = 0, b = 0;
    if (!musical_seconds(project, origin + position, a, error) || !musical_seconds(project, origin, b, error)) return false;
    s = a - b;
    return true;
  };
  Vec<Command> commands;
  double body = steps;
  Str last;
  out = Performance{};
  const double swing = num(project, "swing");
  for (double step = 0; step < steps; ++step) {
    Value w;
    if (!play::performance_window(player, step, false, swing, 48000, w, error)) return false;
    const Value& snap = at(w, "snapshot");
    const Value* position = snap.get("position");
    const Str key = str(snap, "sceneId") + ":" + (position ? str(*position, "occurrenceId") : Str("manual"));
    if (key != last) {
      Transition t;
      t.step = step, t.scene = str(snap, "sceneId");
      if (position) t.has_occurrence = true, t.occurrence = str(*position, "occurrenceId");
      out.transitions.push(xmp::move(t));
      last = key;
    }
    if (!performance_commands(w, project, 48000, commands, error)) return false;
    if (!at(snap, "running").as_bool()) {
      body = step;
      break;
    }
  }
  double body_seconds = 0;
  if (!seconds(body, body_seconds)) return false;
  const double frames = js_round((body_seconds + tail) * 48000);
  if (frames < 1 || frames > 2100000 || commands.size() > 32768)
    return error = "Performance exceeds offline render budget", false;
  voices::Palette palette;
  if (!voices::prepare_instruments(project, palette, error)) return false;
  palette.has_master = true;
  if (!parameters::value(project, Str("master.gain"), palette.sequence_master, error)) return false;
  voices::Rack rack(48000);
  if (!rack.configure(palette, error)) return false;
  const int32_t n = static_cast<int32_t>(frames);
  out.left.reserve(n), out.right.reserve(n);
  Vec<Str> blocked;
  int32_t next = 0;
  double id = 1;
  const double panic_at = js_round(body_seconds * 48000);
  for (int32_t frame = 0; frame < n; ++frame) {
    while (next < commands.size() && commands[next].frame == frame) {
      const Command& c = commands[next++];
      if (c.kind == Command::clock && !rack.clock(c.position, c.bpm, error)) return false;
      if (c.kind == Command::release)
        for (const auto& t : c.tracks)
          if (!rack.release_track(t, error)) return false;
      if (c.kind == Command::gates) {
        if (!rack.set_blocked_tracks(c.tracks, error)) return false;
        blocked = c.tracks;
      }
      if (c.kind == Command::parameters && !rack.apply_parameters(c.values, error)) return false;
      if (c.kind == Command::on) {
        const Str& track = str(c.note, "trackId");
        bool silenced = false;
        for (const auto& b : blocked) silenced = silenced || b == track;
        if (!silenced) {
          bool played = false;
          if (!rack.note_on(id++, num(c.note, "pad"), track_index(project, track), num(c.note, "note"),
                            num(c.note, "velocity"), num(c.note, "durationFrames"), played, error))
            return false;
          out.trace.push(Traced{static_cast<double>(frame), static_cast<int32_t>(num(c.note, "note")), track});
        }
      }
    }
    if (frame == panic_at && !rack.panic(error)) return false;
    if (!rack.process(1, error)) return false;
    out.left.push(rack.left()[0]);
    out.right.push(rack.right()[0]);
  }
  if (!rack.panic(error)) return false;
  out.meter = rack.meter();
  out.body_steps = body;
  out.midi = xmp::move(rack.midi);
  out.command_count = commands.size();
  out.commands = xmp::move(commands);
  out.snapshot = player.snapshot();
  return true;
}

// renderSequence: a scene's timeline (clip sequences) through the engine, mono.
struct Mono {
  Vec<float> pcm;
  Vec<MidiEvent> midi;
  double refused = 0;
  // renderInstrumentScene's own path: the notes it played.
  struct Hit {
    double frame, id;
    int32_t pad, track, note;
    double velocity, duration;
  };
  Vec<Hit> hits;
};
inline bool render_sequence(const Value& project, const Str& scene, double steps, bool fill, bool tail, Mono& out,
                            Str& error) {
  using namespace detail;
  Value checked;
  if (!project::canonical(project, checked, error)) return false;
  if (!(steps == floor(steps)) || steps < 1 || steps > 64) return error = "Invalid render length", false;
  const double bpm = num(project, "bpm"), body = js_round(((steps * 60) / bpm / 4) * 48000);
  double longest = 2.01;
  for (const auto& s : list(project, "samples")) longest = fmax(longest, list(s, "pcm").size() / num(s, "sampleRate"));
  const double frames = body + (tail ? js_round(longest * 48000) : 0);
  if (frames > 2100000) return error = "Scene exceeds offline render duration budget", false;
  Vec<play::Note> notes;
  if (!play::timeline(project, scene, 0, steps, fill, num(project, "swing"), 48000, notes, error)) return false;
  voices::Palette palette;
  if (!voices::prepare_instruments(project, palette, error)) return false;
  voices::Rack rack(48000);
  if (!rack.configure(palette, error)) return false;
  // Control positions: every quarter step, and each lane point of the playing clips.
  Vec<double> controls;
  auto add = [&](double x) {
    for (const double c : controls)
      if (c == x) return;
    controls.push(x);
  };
  for (double i = 0; i < steps * 4; ++i) add(i / 4);
  const Value* sc = nullptr;
  for (const auto& s : list(project, "scenes"))
    if (str(s, "id") == scene) sc = &s;
  for (const auto& track : list(project, "tracks")) {
    const Value* clip = nullptr;
    if (sc)
      if (const Value* cid = at(*sc, "clips").get(str(track, "id").c_str()))
        for (const auto& c : list(track, "clips"))
          if (str(c, "id") == cid->as_string()) clip = &c;
    const Value* seq = clip ? clip->get("sequence") : nullptr;
    if (!seq) continue;
    const double length = num(*clip, "length");
    for (double cycle = 0; cycle < steps / length; ++cycle)
      for (const auto& lane : list(*seq, "lanes"))
        for (const auto& p : list(lane, "points"))
          if (num(p, "position") < length) add(cycle * length + num(p, "position"));
  }
  struct Item {
    double frame;
    int32_t note;  // index into notes, or -1 for a control
    double id;
    Value values;
  };
  Vec<Item> items;
  for (int32_t i = 0; i < notes.size(); ++i) items.push(Item{notes[i].frame, i, static_cast<double>(i + 1), Value()});
  for (const double c : controls) {
    play::Frame f;
    if (!play::parameter_frame(project, scene, c, Value::new_object(), f, error)) return false;
    Value values = Value::new_object();
    for (int32_t i = 0; i < f.registry.size(); ++i) values.set(f.registry[i].id, Value::of(f.values[i]));
    const double frame = js_round(((xmp::sequencer::groove_position(c, num(project, "swing")) * 60) / bpm / 4) * 48000);
    items.push(Item{frame, -1, 0, xmp::move(values)});
  }
  // By frame; at the same frame parameter changes before notes, otherwise in order (stable).
  for (int32_t i = 1; i < items.size(); ++i)
    for (int32_t k = i; k > 0; --k) {
      const Item &a = items[k - 1], &b = items[k];
      const double order = a.frame - b.frame != 0 ? a.frame - b.frame : (a.note < 0 ? 0 : 1) - (b.note < 0 ? 0 : 1);
      if (!(order > 0)) break;
      Item t = xmp::move(items[k]);
      items[k] = xmp::move(items[k - 1]);
      items[k - 1] = xmp::move(t);
    }
  const int32_t n = static_cast<int32_t>(frames);
  int32_t next = 0;
  out = Mono{};
  out.pcm.reserve(n);
  for (int32_t frame = 0; frame < n; ++frame) {
    while (next < items.size() && items[next].frame == frame) {
      const Item& c = items[next++];
      if (c.note < 0) {
        if (!rack.apply_parameters(c.values, error)) return false;
      } else {
        const play::Note& note = notes[c.note];
        bool played = false;
        if (!rack.note_on(c.id, note.pad, track_index(project, note.track_id), note.note, note.velocity,
                          note.duration_frames, played, error))
          return false;
      }
    }
    if (frame == body && !rack.panic(error)) return false;
    if (!rack.process(1, error)) return false;
    out.pcm.push(rack.left()[0]);
  }
  if (!rack.panic(error)) return false;
  out.midi = xmp::move(rack.midi);
  out.refused = rack.refused();
  return true;
}

// hasInstruments
inline bool has_instruments(const Value& project) {
  using namespace detail;
  if (project.get("mix") || project.get("performance")) return true;
  for (const auto& t : list(project, "tracks")) {
    for (const auto& c : list(t, "clips"))
      if (c.get("sequence")) return true;
    if (const Value* m = t.get("machine"))
      if (str(*m, "id") != "xmp.sampler" || num(*m, "version") != 1 || str(*m, "base") != "audio") return true;
  }
  for (const auto& p : list(project, "pads"))
    if (p.get("edit") || p.get("playback")) return true;
  for (const auto& t : list(project, "tracks"))
    if (const Value* own = t.get("pads"))
      for (const auto& p : own->items())
        if (p.get("edit") || p.get("playback")) return true;
  return false;
}
inline double scene_length(const Value& project, const Str& scene) {
  for (const auto& s : detail::list(project, "scenes"))
    if (detail::str(s, "id") == scene) return play::detail::scene_length(project, s);
  return 16;
}

// renderInstrumentScene: a scene through the engine, mono (with a tail unless exact).
inline bool render_instrument_scene(const Value& project, const Str& scene, double exact_steps, Mono& out, Str& error) {
  using namespace detail;
  Value checked;
  if (!project::canonical(project, checked, error)) return false;
  const bool exact = exact_steps > 0;
  if (project.get("mix")) {
    Performance p;
    if (!render_performance(project, scene, Str("scene"), exact ? exact_steps : scene_length(project, scene),
                            exact ? 0 : 2, false, p, error))
      return false;
    out = Mono{};
    for (int32_t i = 0; i < p.left.size(); ++i)
      out.pcm.push(static_cast<float>((static_cast<double>(p.left[i]) + static_cast<double>(p.right[i])) / 2));
    out.midi = xmp::move(p.midi);
    return true;
  }
  bool sequenced = false;
  for (const auto& t : list(project, "tracks"))
    for (const auto& c : list(t, "clips")) sequenced = sequenced || c.get("sequence");
  const Value* sc = nullptr;
  for (const auto& s : list(project, "scenes"))
    if (str(s, "id") == scene) sc = &s;
  if (sequenced) {
    const double steps = exact ? exact_steps : (sc ? play::detail::scene_length(project, *sc) : 16);
    // The TypeScript returns this path's audio without its MIDI events.
    if (!render_sequence(project, scene, steps, false, !exact, out, error)) return false;
    out.midi.clear();
    return true;
  }
  if (!sc) return error = "Unknown scene", false;
  const double steps = exact ? exact_steps : play::detail::scene_length(project, *sc);
  if (!(steps == floor(steps)) || steps < 1 || steps > 64) return error = "Invalid capture length", false;
  const double bpm = num(project, "bpm"), swing = num(project, "swing");
  const double body = js_round(step_time(steps, bpm, swing) * 48000);
  double longest = 2.01;
  for (const auto& s : list(project, "samples")) longest = fmax(longest, list(s, "pcm").size() / num(s, "sampleRate"));
  const double frames = body + (exact ? 0 : ceil(longest * 48000));
  if (frames > 2100000) return error = "Scene exceeds offline render duration budget", false;
  voices::Palette palette;
  if (!voices::prepare_instruments(project, palette, error)) return false;
  voices::Rack rack(48000);
  if (!rack.configure(palette, error)) return false;
  struct Event {
    double frame, id;
    int32_t pad, track, note;
    double velocity, duration;
  };
  Vec<Event> events;
  const auto& tracks = list(project, "tracks");
  for (double step = 0; step < steps; ++step) {
    Vec<Value> due;
    if (!play::events_at_step(project, scene, step, due, error)) return false;
    for (const auto& e : due) {
      const int32_t t = track_index(project, str(e, "trackId"));
      const double gain = t >= 0 && t < palette.tracks.size() ? palette.tracks[t].gain : 0;
      const int32_t pad = static_cast<int32_t>(num(e, "pad"));
      int32_t note = 60;
      if (const Value* nv = e.get("note"))
        note = static_cast<int32_t>(nv->as_number());
      else if (const Value* m = tracks[t].get("machine"); m && str(*m, "id") == "xmp.subtractive")
        note = 48 + pad;
      else if (const Value* pb = project::detail::track_pads(project, &tracks[t])[pad].get("playback"))
        note = static_cast<int32_t>(num(*pb, "rootNote"));
      const Value* d = e.get("duration");
      events.push(Event{js_round(step_time(step, bpm, swing) * 48000), static_cast<double>(events.size() + 1), pad, t, note,
                        gain ? num(e, "velocity") / gain : 0,
                        js_round((((d ? d->as_number() : 1) * 60) / bpm / 4) * 48000)});
    }
  }
  if (events.size() > 8192) return error = "Instrument event budget exceeded", false;
  double master = 0;
  if (!parameters::value(project, Str("master.gain"), master, error)) return false;
  const int32_t n = static_cast<int32_t>(frames);
  out = Mono{};
  out.pcm.reserve(n);
  int32_t next = 0;
  for (int32_t frame = 0; frame < n;) {
    while (next < events.size() && events[next].frame == frame) {
      const Event& e = events[next++];
      bool played = false;
      if (!rack.note_on(e.id, e.pad, e.track, e.note, e.velocity, e.duration, played, error)) return false;
    }
    if (frame == body)
      for (const auto& e : events)
        if (!rack.note_off(e.id, error)) return false;
    const double until = next < events.size() ? events[next].frame : n;
    const double count = fmin(fmin(fmin(128, n - frame), until - frame), frame < body ? body - frame : 128);
    if (count <= 0) return error = "Invalid instrument render progress", false;
    if (!rack.process(static_cast<int32_t>(count), error)) return false;
    for (int32_t i = 0; i < static_cast<int32_t>(count); ++i)
      out.pcm.push(static_cast<float>(fmax(-1, fmin(1, static_cast<double>(rack.left()[i]) * master))));
    frame += static_cast<int32_t>(count);
  }
  out.midi = xmp::move(rack.midi);
  out.refused = rack.refused();
  for (const auto& e : events) out.hits.push(Mono::Hit{e.frame, e.id, e.pad, e.track, e.note, e.velocity, e.duration});
  return true;
}

// prepareScene and renderPlan: the original pad-sampler renderer (projects with
// no instruments). The plan is also what the native song renderer reads.
struct ScenePlan {
  struct Event {
    double frame;
    int32_t sample;
    double velocity;
    Str track;
    int32_t pad;
    double step;
  };
  Vec<Vec<float>> samples;  // each distinct pad sound at 48 kHz
  Vec<Event> events;        // in frame order
  double frames = 0;
};
inline bool prepare_scene(const Value& project, const Str& scene_id, ScenePlan& plan, Str& error) {
  using namespace detail;
  Value checked;
  if (!project::canonical(project, checked, error)) return false;
  if (has_instruments(project))
    return error = "Instrument project requires the P05 renderer; legacy native plan is unsupported", false;
  const Value* scene = nullptr;
  for (const auto& s : list(project, "scenes"))
    if (str(s, "id") == scene_id) scene = &s;
  if (!scene) return error = "Unknown scene", false;
  const double length = play::detail::scene_length(project, *scene);
  plan = ScenePlan{};
  Vec<Vec<float>>& samples = plan.samples;
  Vec<Str> keys;
  // The project's pads, then each track's own kit (format 7).
  Vec<const Vec<Value>*> banks;
  Vec<Str> owners;
  banks.push(&list(project, "pads")), owners.push(Str());
  for (const auto& t : list(project, "tracks"))
    if (const Value* own = t.get("pads")) banks.push(&own->items()), owners.push(str(t, "id"));
  Vec<Vec<int32_t>> bank_sample;
  double total = 0;
  for (int32_t b = 0; b < banks.size(); ++b) {
  Vec<int32_t> pad_sample;
  for (const auto& pad : *banks[b]) {
    const Value* asset = nullptr;
    for (const auto& s : list(project, "samples"))
      if (str(s, "id") == str(pad, "sampleId")) asset = &s;
    if (!asset) return error = "Missing sample", false;
    const auto& pcm = list(*asset, "pcm");
    const Value* slice = pad.get("slice");
    const double start = slice ? num(*slice, "start") : 0, end = slice ? num(*slice, "end") : pcm.size();
    const Str key = str(*asset, "id") + ":" + json::number_text(start) + ":" + json::number_text(end);
    int32_t index = -1;
    for (int32_t i = 0; i < keys.size(); ++i)
      if (keys[i] == key) index = i;
    if (index < 0) {
      const double rate = num(*asset, "sampleRate");
      const int32_t frames = static_cast<int32_t>(fmax(1, js_round(((end - start) * 48000) / rate)));
      total += frames;
      if (total > 1000000) return error = "Prepared audio exceeds one million frames; shorten samples", false;
      Vec<float> s;
      s.reserve(frames);
      for (int32_t i = 0; i < frames; ++i) {
        const double position = start + (i * rate) / 48000;
        const double left = fmin(end - 1, floor(position)), right = fmin(end - 1, left + 1), fraction = position - left;
        const auto sample = [&](double at) { return at >= 0 && at < pcm.size() ? pcm[static_cast<int32_t>(at)].as_number() : 0; };
        s.push(static_cast<float>(sample(left) * (1 - fraction) + sample(right) * fraction));
      }
      index = samples.size();
      keys.push(key);
      samples.push(xmp::move(s));
    }
    pad_sample.push(index);
  }
  bank_sample.push(xmp::move(pad_sample));
  }
  const auto bank_of = [&](const Str& track) {
    for (int32_t b = 1; b < owners.size(); ++b)
      if (owners[b] == track) return b;
    return 0;
  };
  using Event = ScenePlan::Event;
  Vec<Event>& events = plan.events;
  double master = 0;
  if (!parameters::value(project, Str("master.gain"), master, error)) return false;
  const double bpm = num(project, "bpm"), swing = num(project, "swing");
  for (double step = 0; step < length; ++step) {
    Vec<Value> due;
    if (!play::events_at_step(project, scene_id, step, due, error)) return false;
    for (const auto& e : due)
      events.push(Event{js_round(step_time(step, bpm, swing) * 48000),
                        bank_sample[bank_of(str(e, "trackId"))][static_cast<int32_t>(num(e, "pad"))],
                        fmin(1, num(e, "velocity")) * master, str(e, "trackId"),
                        static_cast<int32_t>(num(e, "pad")), step});
  }
  if (events.size() > 8192) return error = "Scene exceeds 8192 rendered events", false;
  for (int32_t i = 1; i < events.size(); ++i)
    for (int32_t k = i; k > 0 && events[k - 1].frame > events[k].frame; --k) {
      const Event t = events[k];
      events[k] = events[k - 1], events[k - 1] = t;
    }
  double frames = ceil(step_time(length, bpm, swing) * 48000);
  for (const auto& e : events) frames = fmax(frames, e.frame + samples[e.sample].size());
  if (frames > 2100000) return error = "Scene exceeds offline render duration budget", false;
  plan.frames = frames;
  return true;
}
inline bool render_plan(const ScenePlan& plan, Vec<float>& out, Str& error) {
  const auto& samples = plan.samples;
  const auto& events = plan.events;
  const double frames = plan.frames;
  using Event = ScenePlan::Event;
  if (frames > 2100000 || frames < 1) return error = "Invalid render frame budget", false;
  struct Voice {
    int32_t sample, cursor;
    float gain;
  };
  Vec<Voice> live;
  out.clear();
  int32_t next = 0;
  for (int32_t frame = 0; frame < static_cast<int32_t>(frames); ++frame) {
    while (next < events.size() && events[next].frame == frame) {
      const Event& e = events[next++];
      if (live.size() == 32) return error = "Offline voice budget exceeded", false;
      live.push(Voice{e.sample, 0, static_cast<float>(e.velocity)});
    }
    float value = 0;
    for (int32_t i = 0; i < live.size();) {
      Voice& v = live[i];
      const auto& s = samples[v.sample];
      value = static_cast<float>(static_cast<double>(value) +
                                 static_cast<double>(static_cast<float>(static_cast<double>(s[v.cursor++]) * v.gain)));
      if (v.cursor == s.size())
        live.erase(i);
      else
        ++i;
    }
    out.push(static_cast<float>(fmax(-1, fmin(1, static_cast<double>(value)))));
  }
  return true;
}
inline bool render_plan_scene(const Value& project, const Str& scene_id, Vec<float>& out, Str& error) {
  ScenePlan plan;
  return prepare_scene(project, scene_id, plan, error) && render_plan(plan, out, error);
}

// renderProjectScene: a scene as a stereo WAV, by whichever renderer the project needs.
inline bool render_project_scene(const Value& project, const Str& scene, files::Bytes& wav, Str& error) {
  Vec<Vec<float>> channels;
  if (project.get("mix")) {
    Performance p;
    if (!render_performance(project, scene, Str("scene"), scene_length(project, scene), 2, false, p, error)) return false;
    channels.push(xmp::move(p.left)), channels.push(xmp::move(p.right));
  } else if (has_instruments(project)) {
    Mono m;
    if (!render_instrument_scene(project, scene, 0, m, error)) return false;
    channels.push(m.pcm), channels.push(xmp::move(m.pcm));
  } else {
    Vec<float> mono;
    if (!render_plan_scene(project, scene, mono, error)) return false;
    channels.push(mono), channels.push(xmp::move(mono));
  }
  return files::encode_wav(channels, 48000, wav, error);
}

// renderExchange: the audio and the MIDI file of a scene or a finite song.
inline bool render_exchange(const Value& project, const Str& mode, const Str& scene, double tail, Performance& audio,
                            files::Bytes& midi_file, files::MidiDocument& document, Str& error) {
  double steps = 0;
  if (!files::exchange_plan(project, mode, scene, document, steps, error)) return false;
  if (!render_performance(project, scene, mode, steps + (mode == "song" ? 1 : 0), tail, false, audio, error)) return false;
  return files::encode_midi(document, midi_file, error);
}

}  // namespace xmp::render
