#pragma once
// XMP's parameters in C++: the C++ port of packages/core parameters.ts and the
// mix helpers it uses (mix.ts mixEffects and mixParameterBase). The registry
// of every automatable parameter in a project, each parameter's sources
// (base, automation, step lock, macro, LFO) and resolved value, the edits
// setParameter and clearParameterSource, and parameter smoothing.
// tests/parity/parameters-parity.test.ts compares it with the TypeScript.
#include "xmp/machines.hpp"
#include "xmp/project_edit.hpp"

namespace xmp::parameters {

using json::Value;
using edit::Edited;

// A registry entry (ParameterDefinition); every one is normalized 0..1 with
// 10 ms one-pole smoothing.
struct Definition {
  Str id, name;
  double default_value = 0;
  bool has_step = false;
  double step = 0;
};
constexpr double kSmoothingMs = 10;

namespace detail {
using project::detail::at;
using project::detail::list;
using project::detail::num;
using project::detail::str;

struct MixEffect {
  Str prefix;
  const Value* effect;
};
// mixEffects: the strips' inserts in record order, then the returns'.
inline Vec<MixEffect> mix_effects(const Value& mix) {
  Vec<MixEffect> out;
  for (const auto& strip : at(mix, "tracks").members())
    for (const auto& e : list(strip.value, "inserts"))
      out.push(MixEffect{Str("track.") + strip.key + ".insert." + str(e, "id"), &e});
  const auto& returns = list(mix, "returns");
  for (int32_t r = 0; r < returns.size(); ++r)
    for (const auto& e : returns[r].items())
      out.push(MixEffect{Str("return.") + int_text(r) + ".insert." + str(e, "id"), &e});
  return out;
}
inline Definition entry(Str id, Str name, double default_value) {
  Definition d;
  d.id = xmp::move(id), d.name = xmp::move(name), d.default_value = default_value;
  return d;
}
}  // namespace detail

// machineParameters: a track's automatable machine parameters.
inline void machine_parameters(const Value& track, Vec<Definition>& out,
                               const machine::Registry& registry = machine::machines()) {
  using namespace detail;
  const machine::Definition* d = registry.get(track.get("machine"));
  if (!d || !d->automation) return;
  for (const auto& p : d->parameters) {
    Definition e = entry(Str("track.") + str(track, "id") + ".machine." + d->id + ".v" + int_text(d->version) + "." + p.id,
                         str(track, "name") + " " + p.name + " (" + p.unit + ")",
                         (p.default_value - p.min) / (p.max - p.min));
    if (p.has_step && p.step) e.has_step = true, e.step = p.step / (p.max - p.min);
    out.push(xmp::move(e));
  }
}

// parameterRegistry
inline Vec<Definition> registry(const Value& project, const machine::Registry& machines = machine::machines()) {
  using namespace detail;
  Vec<Definition> out;
  out.push(entry("master.gain", "Master gain", 0.55));
  if (const Value* mix = project.get("mix")) {
    static const char* kKeys[] = {"pan", "send.0", "send.1"};
    for (const auto& t : list(project, "tracks"))
      for (const char* key : kKeys)
        out.push(entry(Str("track.") + str(t, "id") + "." + key, str(t, "name") + " " + key,
                       Str(key) == "pan" ? 0.5 : 0));
    for (const auto& fx : mix_effects(*mix)) {
      bool ours = fx.prefix.starts_with("return.");
      for (const auto& t : list(project, "tracks")) ours = ours || fx.prefix.starts_with(Str("track.") + str(t, "id") + ".");
      if (!ours) continue;
      const Value& params = at(*fx.effect, "params");
      for (const auto& p : params.members())
        out.push(entry(fx.prefix + "." + p.key, str(*fx.effect, "kind") + " " + p.key, p.value.as_number()));
      out.push(entry(fx.prefix + ".bypass", str(*fx.effect, "kind") + " bypass",
                     at(*fx.effect, "bypass").as_bool() ? 1 : 0));
    }
  }
  for (const auto& t : list(project, "tracks")) {
    out.push(entry(Str("track.") + str(t, "id") + ".gain", str(t, "name") + " gain", 0.8));
    out.push(entry(Str("track.") + str(t, "id") + ".effect.gain", str(t, "name") + " effect gain", 0.5));
    machine_parameters(t, out, machines);
  }
  return out;
}

// machineParameter: the track and machine parameter an ID names, if any.
struct MachineParameter {
  int32_t track = -1;
  const machine::Parameter* parameter = nullptr;
};
inline MachineParameter machine_parameter(const Value& project, const Str& id,
                                          const machine::Registry& machines = machine::machines()) {
  using namespace detail;
  const auto& tracks = list(project, "tracks");
  for (int32_t t = 0; t < tracks.size(); ++t) {
    const machine::Definition* d = machines.get(tracks[t].get("machine"));
    if (!d) continue;
    for (const auto& p : d->parameters)
      if (id == Str("track.") + str(tracks[t], "id") + ".machine." + d->id + ".v" + int_text(d->version) + "." + p.id)
        return MachineParameter{t, &p};
  }
  return {};
}

// resolveParameter: the replacement (step lock, else automation, else base)
// plus macro and LFO, clamped to 0..1; false with the TypeScript's message
// when a source is out of range.
inline bool resolve(const Value& sources, double& out, Str& error) {
  static const char* kSources[] = {"base", "automation", "stepLock", "macro", "lfo"};
  for (int32_t k = 0; k < 5; ++k) {
    const Value* v = sources.get(kSources[k]);
    if (!v && k != 0) continue;
    const double x = v && v->is_number() ? v->as_number() : NAN;
    if (!isfinite(x) || x < (k >= 3 ? -1 : 0) || x > 1) return error = Str("Invalid ") + kSources[k] + " parameter value", false;
  }
  auto get = [&](const char* key, double fallback) {
    const Value* v = sources.get(key);
    return v ? v->as_number() : fallback;
  };
  const double replacement =
      sources.get("stepLock") ? get("stepLock", 0) : sources.get("automation") ? get("automation", 0) : get("base", 0);
  const double v = replacement + get("macro", 0) + get("lfo", 0);
  out = v < 0 ? 0 : v > 1 ? 1 : v;
  return true;
}

// parameterSources: the parameter's assignment if it has one, else its base.
// `known`: the project's registry when the caller already has it (building it
// is the cost of this function; a caller asking for many parameters passes it).
inline bool sources(const Value& project, const Str& id, Value& out, Str& error,
                    const machine::Registry& machines = machine::machines(), const Vec<Definition>* known = nullptr) {
  using namespace detail;
  const Vec<Definition> built = known ? Vec<Definition>() : registry(project, machines);
  const Vec<Definition>& reg = known ? *known : built;
  const Definition* definition = nullptr;
  for (const auto& d : reg)
    if (d.id == id) definition = &d;
  if (!definition) return error = Str("Unknown parameter ") + id, false;
  for (const auto& a : list(project, "parameters"))
    if (str(a, "id") == id) return out = a, true;
  double base = definition->default_value;
  const MachineParameter m =
      strstr(id.c_str(), ".machine.") ? machine_parameter(project, id, machines) : MachineParameter{};
  if (id == "master.gain")
    base = num(project, "master");
  else if (m.parameter) {
    const Value& state = at(at(list(project, "tracks")[m.track], "machine"), "state");
    const Value* v = state.get(m.parameter->id.c_str());
    // Number(state[id] ?? default): states hold numbers for these keys.
    const double native = v ? (v->is_number() ? v->as_number() : NAN) : m.parameter->default_value;
    base = (native - m.parameter->min) / (m.parameter->max - m.parameter->min);
  } else {
    double mixed = 0;
    if (project::detail::mix_parameter_base(project, id, mixed))
      base = mixed;
    else
      for (const auto& t : list(project, "tracks"))
        if (id == Str("track.") + str(t, "id") + ".gain") {
          base = num(t, "volume");
          break;
        }
  }
  out = Value::new_object();
  out.set("base", Value::of(base));
  return true;
}

// parameterValue
inline bool value(const Value& project, const Str& id, double& out, Str& error,
                  const machine::Registry& machines = machine::machines(), const Vec<Definition>* known = nullptr) {
  Value s;
  return sources(project, id, s, error, machines, known) && resolve(s, out, error);
}

// setParameter: one source of a parameter; a base also updates the master
// gain, the track volume or the machine state it mirrors.
// setParameter without the whole-project check at the end: the assignment
// and what mirrors it (master, a track's volume, a machine's state). For
// callers that change one value many times a second (a knob being turned)
// with a value already inside 0..1; `known` is the project's registry.
inline Edited set_parameter_unchecked(const Value& project, const Str& id, double v, const Str& source = Str("base"),
                                      const machine::Registry& machines = machine::machines(),
                                      const Vec<Definition>* known = nullptr) {
  using namespace detail;
  Edited e;
  Value s;
  if (!sources(project, id, s, e.error, machines, known)) return e;
  if (source != "base" && source != "automation" && source != "stepLock" && source != "macro" && source != "lfo")
    return e.error = "Unknown parameter source", e;
  if (source == "base") {
    const MachineParameter discrete = machine_parameter(project, id, machines);
    if (discrete.parameter && discrete.parameter->has_step && discrete.parameter->step && isfinite(v) && v >= 0 &&
        v <= 1) {
      const machine::Parameter& p = *discrete.parameter;
      const double native =
          fmax(p.min, fmin(p.max, p.min + edit::detail::js_round((v * (p.max - p.min)) / p.step) * p.step));
      v = (native - p.min) / (p.max - p.min);
    }
  }
  Value updated = s;
  updated.set(source, Value::of(v));
  double ignored = 0;
  if (!resolve(updated, ignored, e.error)) return e;
  Value next = project;
  Vec<Value> kept;
  for (auto& a : edit::detail::items(next, "parameters"))
    if (str(a, "id") != id) kept.push(a);
  Value assignment = Value::new_object();
  assignment.set("id", Value::of(id));
  for (const auto& m : updated.members()) assignment.set(m.key, m.value);
  kept.push(xmp::move(assignment));
  edit::detail::items(next, "parameters") = xmp::move(kept);
  if (source == "base") {
    if (id == "master.gain") next.set("master", Value::of(v));
    for (auto& t : edit::detail::items(next, "tracks"))
      if (id == Str("track.") + str(t, "id") + ".gain") {
        t.set("volume", Value::of(v));
        break;
      }
    const MachineParameter m = machine_parameter(next, id, machines);
    if (m.parameter) {
      Value& track = edit::detail::items(next, "tracks")[m.track];
      edit::detail::member(edit::detail::member(track, "machine"), "state")
          .set(m.parameter->id, Value::of(m.parameter->min + v * (m.parameter->max - m.parameter->min)));
    }
  }
  e.ok = true, e.project = xmp::move(next);
  return e;
}
inline Edited set_parameter(const Value& project, const Str& id, double v, const Str& source = Str("base"),
                            const machine::Registry& machines = machine::machines()) {
  Edited e = set_parameter_unchecked(project, id, v, source, machines);
  if (!e.ok) return e;
  return edit::detail::finish(e.project);
}

// clearParameterSource
inline Edited clear_parameter_source(const Value& project, const Str& id, const Str& source,
                                     const machine::Registry& machines = machine::machines()) {
  Edited e;
  Value s;
  if (!sources(project, id, s, e.error, machines)) return e;
  Value next = project;
  for (auto& a : edit::detail::items(next, "parameters"))
    if (detail::str(a, "id") == id) {
      a.remove(source.c_str());
      break;
    }
  return edit::detail::finish(next);
}

// smoothParameter: one-pole smoothing over `frames`; false for inputs the TypeScript refuses.
inline bool smooth(double current, double target, double rate, double ms, double frames, double& out, Str& error) {
  const double all[] = {current, target, rate, ms, frames};
  for (const double x : all)
    if (!isfinite(x)) return error = "Invalid parameter smoothing input", false;
  if (current < 0 || current > 1 || target < 0 || target > 1 || rate < 8000 || rate > 192000 || ms < 0 ||
      ms > 10000 || frames != floor(frames) || frames < 0 || frames > 2100000)
    return error = "Invalid parameter smoothing input", false;
  if (frames == 0) return out = current, true;
  out = ms == 0 ? target : target + (current - target) * exp(-frames / ((rate * ms) / 1000));
  return true;
}
// parameterSmoothingMs
inline bool smoothing_ms(const Value& project, const Str& id, double& out, Str& error,
                         const machine::Registry& machines = machine::machines()) {
  for (const auto& d : registry(project, machines))
    if (d.id == id) return out = kSmoothingMs, true;
  return error = Str("Unknown parameter ") + id, false;
}
// advanceParameter
inline bool advance(const Value& project, const Str& id, double current, double frames, double rate, double& out,
                    Str& error, const machine::Registry& machines = machine::machines()) {
  double target = 0, ms = 0;
  return value(project, id, target, error, machines) && smoothing_ms(project, id, ms, error, machines) &&
         smooth(current, target, rate, ms, frames, out, error);
}

}  // namespace xmp::parameters
