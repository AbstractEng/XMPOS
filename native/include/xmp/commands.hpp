#pragma once
// Edits and questions to the C++ project core by JSON command, for the
// browser (native/src/project_wasm.cpp, phase 9 of docs/cpp-port.md): one
// place that maps packages/core's edit and parameter functions to their C++
// ports. A command is {"op": name, "args": [...]}, the arguments as the
// TypeScript function takes them after its project.
//
// Edits return the new project (`edited`); questions return a value.
// "setMix", "setPerformance" and "setSequence" are what editMix,
// editPerformance and editSequence become: the browser applies its change to
// a copy of the mix, performance or sequence, and the core puts it in place
// and checks the whole project, as ProjectSchema.parse does.
#include "xmp/parameters.hpp"
#include "xmp/play.hpp"
#include "xmp/project_edit.hpp"

namespace xmp::commands {

using json::Value;

struct Result {
  bool ok = false, edited = false;
  Value value;  // the new project (edited) or the answer
  Str error;
};

namespace detail {
inline const Value& arg(const Value& args, int32_t i) {
  static const Value none;
  return args.is_array() && i < args.items().size() ? args.items()[i] : none;
}
inline Str text(const Value& v) { return v.is_string() ? v.as_string() : Str("\x01not-a-string"); }
inline double number(const Value& v) { return v.is_number() ? v.as_number() : NAN; }
inline Vec<Value> list(const Value& v) { return v.is_array() ? v.items() : Vec<Value>(); }
inline Result edited(const edit::Edited& e) {
  Result r;
  r.ok = e.ok, r.edited = true, r.value = e.project, r.error = e.error;
  return r;
}
inline Result answer(bool ok, Value v, const Str& error = Str()) {
  Result r;
  r.ok = ok, r.value = xmp::move(v), r.error = error;
  return r;
}
inline Value definition_json(const parameters::Definition& d) {
  Value o = Value::new_object();
  o.set("id", Value::of(d.id)), o.set("name", Value::of(d.name));
  o.set("min", Value::of(0.0)), o.set("max", Value::of(1.0)), o.set("unit", Value::of("normalized"));
  o.set("defaultValue", Value::of(d.default_value));
  if (d.has_step) o.set("step", Value::of(d.step));
  Value s = Value::new_object();
  s.set("type", Value::of("one-pole")), s.set("timeMs", Value::of(parameters::kSmoothingMs));
  o.set("smoothing", xmp::move(s));
  return o;
}
inline Value notes_json(const Vec<play::Note>& notes) {
  Value list = Value::new_array();
  for (const auto& n : notes) {
    Value o = Value::new_object();
    o.set("id", Value::of(n.id)), o.set("trackId", Value::of(n.track_id));
    o.set("pad", Value::of(static_cast<double>(n.pad))), o.set("note", Value::of(static_cast<double>(n.note)));
    o.set("position", Value::of(n.position)), o.set("duration", Value::of(n.duration)), o.set("velocity", Value::of(n.velocity));
    o.set("cycle", Value::of(static_cast<double>(n.cycle)));
    o.set("frame", Value::of(n.frame)), o.set("durationFrames", Value::of(n.duration_frames));
    list.push(xmp::move(o));
  }
  return list;
}
}  // namespace detail

// Registers an SDK machine definition (as the browser's machines.register).
inline Result register_machine(const Value& d) {
  using namespace detail;
  if (!d.is_object() || !d.get("id") || !d.get("id")->is_string()) return answer(false, Value(), Str("Invalid machine"));
  machine::Definition m;
  m.id = d.get("id")->as_string(), m.name = d.get("name") && d.get("name")->is_string() ? d.get("name")->as_string() : Str("SDK machine");
  m.base = d.get("base") && d.get("base")->is_string() ? d.get("base")->as_string() : Str("audio");
  m.version = static_cast<int32_t>(number(d.get("version") ? *d.get("version") : Value()));
  m.automation = d.get("automation") && d.get("automation")->is_bool() && d.get("automation")->as_bool();
  if (const Value* ps = d.get("parameters"))
    for (const auto& p : list(*ps)) {
      if (!p.is_object()) continue;
      machine::Parameter q;
      q.id = text(p.get("id") ? *p.get("id") : Value()), q.name = text(p.get("name") ? *p.get("name") : Value());
      q.unit = p.get("unit") && p.get("unit")->is_string() ? p.get("unit")->as_string() : Str();
      q.min = number(p.get("min") ? *p.get("min") : Value()), q.max = number(p.get("max") ? *p.get("max") : Value());
      q.default_value = number(p.get("defaultValue") ? *p.get("defaultValue") : Value());
      if (const Value* st = p.get("step")) q.has_step = true, q.step = number(*st);
      m.parameters.push(q);
    }
  if (const Value* df = d.get("defaults")) m.defaults = *df;
  machine::machines().add(xmp::move(m));
  return answer(true, Value());
}

inline Result run(const Value& current, const Value& command) {
  using namespace detail;
  namespace P = parameters;
  const Str op = command.get("op") && command.get("op")->is_string() ? command.get("op")->as_string() : Str();
  const Value& a = command.get("args") ? *command.get("args") : Value();
  Str error;
  // ---- edits ----
  if (op == "toggleStep")
    return edited(edit::toggle_step(current, text(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2)), number(arg(a, 3))));
  if (op == "expandSong") return edited(edit::expand_song(current));
  if (op == "appendNotes") return edited(edit::append_notes(current, text(arg(a, 0)), text(arg(a, 1)), list(arg(a, 2))));
  if (op == "overdubSteps") return edited(edit::overdub_steps(current, text(arg(a, 0)), text(arg(a, 1)), list(arg(a, 2))));
  if (op == "quantizeNotes") {
    Vec<Str> ids;
    for (const auto& v : list(arg(a, 2))) ids.push(text(v));
    return edited(edit::quantize_notes(current, text(arg(a, 0)), text(arg(a, 1)), ids, number(arg(a, 3)),
                                       arg(a, 4).is_bool() && arg(a, 4).as_bool()));
  }
  if (op == "resizeClip") return edited(edit::resize_clip(current, text(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2))));
  if (op == "duplicateClip") return edited(edit::duplicate_clip(current, text(arg(a, 0)), text(arg(a, 1))));
  if (op == "editChain") return edited(edit::edit_chain(current, list(arg(a, 0))));
  if (op == "deleteTrack") return edited(edit::delete_track(current, text(arg(a, 0))));
  if (op == "setMidiDestination") {
    const Str d = text(arg(a, 1));
    return edited(edit::set_midi_destination(current, text(arg(a, 0)), arg(a, 1).is_string() ? &d : nullptr));
  }
  if (op == "manualSlices") {
    Vec<double> b;
    for (const auto& v : list(arg(a, 1))) b.push(number(v));
    const Str track = text(arg(a, 2));
    return edited(edit::manual_slices(current, number(arg(a, 0)), b, arg(a, 2).is_string() ? &track : nullptr));
  }
  if (op == "installSample") {
    Vec<double> pcm;
    for (const auto& v : list(arg(a, 3))) pcm.push(number(v));
    const Str track = text(arg(a, 4));
    return edited(edit::install_sample(current, number(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2)), pcm,
                                       arg(a, 4).is_string() ? &track : nullptr));
  }
  if (op == "samplerPlan") {
    const double bars=number(arg(a,0));uint32_t frames=0;Str error;
    if((bars!=1 && bars!=2 && bars!=4) || !edit::sampler_plan(current,static_cast<int>(bars),frames,error)) return answer(false,Value(),error.empty()? Str("Invalid take length"):error);
    Value value=Value::new_object();value.set("frames",Value::of(static_cast<double>(frames)));return answer(true,value);
  }
  if (op == "samplerInput") {
    const double bars=number(arg(a,2));
    if (!arg(a,1).is_bool() || (bars!=1 && bars!=2 && bars!=4)) return edited(edit::detail::fail("Invalid sampler settings"));
    return edited(edit::sampler_input(current,text(arg(a,0)),arg(a,1).as_bool(),static_cast<int>(bars)));
  }
  if (op == "recordLoop") {
    const double pad=number(arg(a,2)), bars=number(arg(a,5));
    if (!isfinite(pad) || pad!=floor(pad) || pad<0 || pad>15 || (bars!=1 && bars!=2 && bars!=4) || list(arg(a,4)).size()>project_limits::kLoopSampleFrames) return edited(edit::detail::fail("Invalid loop target"));
    Vec<double> pcm; for (const auto& v : list(arg(a,4))) pcm.push(number(v));
    return edited(edit::record_loop(current,text(arg(a,0)),text(arg(a,1)),static_cast<int>(pad),text(arg(a,3)),pcm,static_cast<int>(bars)));

  }
  if (op == "chopSampleToKit") {
    Vec<double> pcm, boundaries;
    for (const auto& v : list(arg(a, 3))) pcm.push(number(v));
    for (const auto& v : list(arg(a, 4))) boundaries.push(number(v));
    return edited(edit::chop_sample_to_kit(current, text(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2)), pcm, boundaries));
  }
  if (op == "applyDrumKit") {
    const Str track = text(arg(a, 1));
    return edited(edit::apply_drum_kit(current, arg(a, 0), arg(a, 1).is_string() ? &track : nullptr));
  }
  if (op == "ownKit") return edited(edit::own_kit(current, text(arg(a, 0))));
  if (op == "shareKit") return edited(edit::share_kit(current, text(arg(a, 0))));
  if (op == "setMix") return edited(edit::edit_mix(current, [&](Value& m) { m = arg(a, 0); }));
  if (op == "setPerformance") return edited(edit::edit_performance(current, [&](Value& p) { p = arg(a, 0); }));
  if (op == "setSequence")
    return edited(edit::edit_sequence(current, text(arg(a, 0)), text(arg(a, 1)), [&](Value& s) { s = arg(a, 2); }));
  if (op == "setParameter")
    return edited(P::set_parameter(current, text(arg(a, 0)), number(arg(a, 1)),
                                   arg(a, 2).is_string() ? arg(a, 2).as_string() : Str("base")));
  if (op == "clearParameterSource") return edited(P::clear_parameter_source(current, text(arg(a, 0)), text(arg(a, 1))));
  // ---- questions ----
  if (op == "parameterRegistry") {
    Value out = Value::new_array();
    for (const auto& d : P::registry(current)) out.push(definition_json(d));
    return answer(true, out);
  }
  if (op == "parameterValue") {
    double v = 0;
    const bool ok = P::value(current, text(arg(a, 0)), v, error);
    return answer(ok, Value::of(v), error);
  }
  if (op == "parameterSources") {
    Value s;
    const bool ok = P::sources(current, text(arg(a, 0)), s, error);
    return answer(ok, s, error);
  }
  if (op == "parameterSmoothingMs") {
    for (const auto& d : P::registry(current))
      if (d.id == text(arg(a, 0))) return answer(true, Value::of(P::kSmoothingMs));
    return answer(false, Value(), Str("Unknown parameter ") + text(arg(a, 0)));
  }
  // ---- playing a project with neither a performance nor a mix ----
  if (op == "timeline") {
    Vec<play::Note> notes;
    const bool ok = play::timeline(current, text(arg(a, 0)), number(arg(a, 1)), number(arg(a, 2)),
                                   arg(a, 3).is_bool() && arg(a, 3).as_bool(), number(arg(a, 4)), number(arg(a, 5)), notes,
                                   error);
    return answer(ok, ok ? notes_json(notes) : Value(), error);
  }
  if (op == "eventsAtStep") {
    Vec<Value> events;
    if (!play::events_at_step(current, text(arg(a, 0)), number(arg(a, 1)), events, error))
      return answer(false, Value(), error);
    Value out = Value::new_array();
    for (auto& e : events) out.push(xmp::move(e));
    return answer(true, out);
  }
  if (op == "parameterFrame") {
    play::Frame frame;
    if (!play::parameter_frame(current, text(arg(a, 0)), number(arg(a, 1)), arg(a, 2), frame, error))
      return answer(false, Value(), error);
    Value out = Value::new_object();
    for (int32_t i = 0; i < frame.registry.size(); ++i) out.set(frame.registry[i].id, Value::of(frame.values[i]));
    return answer(true, out);
  }
  return answer(false, Value(), Str("Unknown command ") + op);
}

}  // namespace xmp::commands
