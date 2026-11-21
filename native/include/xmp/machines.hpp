#pragma once
// XMP's track machines in C++: the registry of packages/core machines.ts with
// the three built-in machines (the pad sampler, the subtractive synth and the
// MIDI track), their automatable parameters, defaults and state checks, and
// instantiate. tests/parity/parameters-parity.test.ts compares it with the TypeScript.
//
// Machines from the SDK are JavaScript. Their definitions (parameters and
// defaults) can be added so the parameter registry lists them as the browser
// does; their own state checks run only in JavaScript, so here their state is
// not checked beyond the project's generic bounds.
#include "xmp/project.hpp"

namespace xmp::machine {

using json::Value;

struct Parameter {
  Str id, name, unit;
  double min = 0, max = 1, default_value = 0;
  bool has_step = false;
  double step = 0;
};

struct Definition {
  Str id, name, base;
  int32_t version = 1;
  bool automation = false;
  Vec<Parameter> parameters;
  Value defaults = Value::new_object();
  const schema::Node* state = nullptr;  // the state's schema (built-ins); null: not checked here
};

class Registry {
 public:
  Registry() {
    const auto& s = project::schemas();
    Definition sampler;
    sampler.id = "xmp.sampler", sampler.name = "Pad sampler", sampler.base = "audio";
    sampler.state = s.sampler_state;
    add(xmp::move(sampler));

    Definition synth;
    synth.id = "xmp.subtractive", synth.name = "Subtractive synth", synth.base = "audio", synth.automation = true;
    synth.state = s.synth_patch;
    auto param = [](const char* id, const char* name, const char* unit, double lo, double hi, double def) {
      Parameter p;
      p.id = id, p.name = name, p.unit = unit, p.min = lo, p.max = hi, p.default_value = def;
      return p;
    };
    synth.parameters.push(param("attack", "Attack", "seconds", 0.001, 2, 0.005));
    synth.parameters.push(param("decay", "Decay", "seconds", 0.001, 2, 0.12));
    synth.parameters.push(param("sustain", "Sustain", "normalized", 0, 1, 0.45));
    synth.parameters.push(param("release", "Release", "seconds", 0.005, 2, 0.12));
    synth.parameters.push(param("cutoff", "Tone", "Hz", 30, 16000, 750));
    synth.parameters.push(param("resonance", "Resonance", "normalized", 0, 1, 0));
    synth.parameters.push(param("env-amount", "Filter envelope", "octaves", 0, 6, 0));
    synth.parameters.push(param("env-decay", "Filter decay", "seconds", 0.01, 2, 0.3));
    synth.parameters.push(param("detune", "Detune", "cents", 0, 50, 0));
    synth.parameters.push(param("glide", "Glide", "seconds", 0, 1, 0));
    // defaults: { ...synthPresets[0] }
    synth.defaults.set("name", Value::of("Warm bass"));
    synth.defaults.set("oscillator", Value::of("saw"));
    synth.defaults.set("attack", Value::of(0.005));
    synth.defaults.set("decay", Value::of(0.12));
    synth.defaults.set("sustain", Value::of(0.45));
    synth.defaults.set("release", Value::of(0.12));
    synth.defaults.set("cutoff", Value::of(750.0));
    add(xmp::move(synth));

    Definition midi;
    midi.id = "xmp.midi", midi.name = "MIDI track", midi.base = "midi", midi.automation = true;
    midi.state = s.midi_state;
    Parameter channel = param("channel", "Channel", "MIDI channel", 1, 16, 1);
    channel.has_step = true, channel.step = 1;
    midi.parameters.push(channel);
    midi.defaults.set("channel", Value::of(1.0));
    add(xmp::move(midi));
  }

  // register: a machine (an SDK machine's definition, or a replacement).
  void add(Definition d) {
    for (auto& existing : definitions_)
      if (existing.id == d.id) {
        existing = xmp::move(d);
        return;
      }
    definitions_.push(xmp::move(d));
  }
  const Vec<Definition>& list() const { return definitions_; }
  const Definition* find(const Str& id) const {
    for (const auto& d : definitions_)
      if (d.id == id) return &d;
    return nullptr;
  }

  // get: the definition playing a track's machine (the pad sampler when it has
  // none), or null when it is not installed or another version or base. A
  // state its machine refuses sets `refused` (the TypeScript throws).
  const Definition* get(const Value* machine, Str* refused = nullptr) const {
    const Str id = machine ? project::detail::str(*machine, "id") : Str("xmp.sampler");
    const Definition* d = find(id);
    if (!d) return nullptr;
    if (machine &&
        (project::detail::num(*machine, "version") != d->version || project::detail::str(*machine, "base") != d->base))
      return nullptr;
    if (!machine && (d->version != 1 || d->base != "audio")) return nullptr;
    if (d->state) {
      schema::Checker c;
      Value ignored;
      const Value empty = Value::new_object();
      if (!c.check(*d->state, machine ? project::detail::at(*machine, "state") : empty, ignored, Str("machine state")) &&
          refused)
        *refused = c.problem;
    }
    return d;
  }

  // instantiate: a track machine with the machine's defaults.
  bool instantiate(const Str& id, Value& out, Str& error) const {
    const Definition* d = find(id);
    if (!d) return error = "Machine is not installed", false;
    out = Value::new_object();
    out.set("id", Value::of(d->id));
    out.set("base", Value::of(d->base));
    out.set("version", Value::of(static_cast<double>(d->version)));
    out.set("state", d->defaults);
    return true;
  }

 private:
  Vec<Definition> definitions_;
};

inline Registry& machines() {
  static Registry r;
  return r;
}

}  // namespace xmp::machine
