// Test driver for tests/parity/render-parity.test.ts: NUL-separated JSON commands on
// stdin, one answer each ("ok\n" + JSON, or "error\n" + message).
//   performance [project, scene, mode, steps, tail, resume]
//   sequence [project, scene, steps, fill, tail]
//   instrument [project, scene, exactSteps (0: none)]
//   plan [project, scene]
//   projectScene [project, scene]           -> WAV bytes
//   exchange [project, mode, scene, tail]
#include <stdio.h>

#include "xmp/render.hpp"

using xmp::Str;
using xmp::Vec;
using xmp::json::Value;
namespace R = xmp::render;

namespace {
const Value& arg(const Value& a, int32_t i) {
  static const Value none;
  return a.is_array() && i < a.items().size() ? a.items()[i] : none;
}
Value floats(const Vec<float>& v) {
  Value out = Value::new_array();
  out.items().reserve(v.size());
  for (const float x : v) out.push(Value::of(static_cast<double>(x)));
  return out;
}
Value midi_json(const Vec<xmp::voices::MidiEvent>& midi) {
  Value out = Value::new_array();
  for (const auto& e : midi) {
    Value o = Value::new_object();
    o.set("kind", Value::of(e.on ? "on" : "off")), o.set("id", Value::of(e.id)), o.set("note", Value::of(static_cast<double>(e.note)));
    o.set("velocity", Value::of(e.velocity)), o.set("channel", Value::of(static_cast<double>(e.channel)));
    out.push(xmp::move(o));
  }
  return out;
}
Value performance_json(R::Performance& p) {
  Value o = Value::new_object();
  o.set("pcm", floats(p.left)), o.set("rightPcm", floats(p.right));
  o.set("meter", p.meter);
  Value trace = Value::new_array();
  for (const auto& t : p.trace) {
    Value x = Value::new_object();
    x.set("frame", Value::of(t.frame)), x.set("note", Value::of(static_cast<double>(t.note))), x.set("trackId", Value::of(t.track));
    trace.push(xmp::move(x));
  }
  o.set("trace", xmp::move(trace));
  Value transitions = Value::new_array();
  for (const auto& t : p.transitions) {
    Value x = Value::new_object();
    x.set("step", Value::of(t.step)), x.set("sceneId", Value::of(t.scene));
    if (t.has_occurrence) x.set("occurrenceId", Value::of(t.occurrence));
    transitions.push(xmp::move(x));
  }
  o.set("transitions", xmp::move(transitions));
  o.set("bodySteps", Value::of(p.body_steps));
  o.set("midi", midi_json(p.midi));
  o.set("commands", Value::of(static_cast<double>(p.command_count)));
  o.set("snapshot", p.snapshot);
  return o;
}

bool apply(const Value& c, Value& out, Str& error) {
  const Str op = c.get("op") ? c.get("op")->as_string() : Str();
  const Value& a = c.get("args") ? *c.get("args") : Value();
  if (op == "performance") {
    R::Performance p;
    if (!R::render_performance(arg(a, 0), arg(a, 1).as_string(), arg(a, 2).as_string(), arg(a, 3).as_number(),
                               arg(a, 4).as_number(), arg(a, 5).is_bool() && arg(a, 5).as_bool(), p, error))
      return false;
    out = performance_json(p);
    return true;
  }
  if (op == "sequence" || op == "instrument") {
    R::Mono m;
    const bool ok = op == "sequence"
                        ? R::render_sequence(arg(a, 0), arg(a, 1).as_string(), arg(a, 2).as_number(),
                                             arg(a, 3).is_bool() && arg(a, 3).as_bool(), arg(a, 4).is_bool() && arg(a, 4).as_bool(), m,
                                             error)
                        : R::render_instrument_scene(arg(a, 0), arg(a, 1).as_string(), arg(a, 2).as_number(), m, error);
    if (!ok) return false;
    out = Value::new_object();
    out.set("pcm", floats(m.pcm)), out.set("midi", midi_json(m.midi));
    return true;
  }
  if (op == "plan") {  // renderPlan(prepareScene(...)): its WAV, the mono pad mix on both channels
    Vec<float> pcm;
    if (!R::render_plan_scene(arg(a, 0), arg(a, 1).as_string(), pcm, error)) return false;
    Vec<Vec<float>> channels;
    channels.push(pcm), channels.push(xmp::move(pcm));
    xmp::files::Bytes wav;
    if (!xmp::files::encode_wav(channels, 48000, wav, error)) return false;
    out = Value::new_array();
    for (const uint8_t x : wav) out.push(Value::of(static_cast<double>(x)));
    return true;
  }
  if (op == "projectScene") {
    xmp::files::Bytes wav;
    if (!R::render_project_scene(arg(a, 0), arg(a, 1).as_string(), wav, error)) return false;
    out = Value::new_array();
    for (const uint8_t x : wav) out.push(Value::of(static_cast<double>(x)));
    return true;
  }
  if (op == "exchange") {
    R::Performance p;
    xmp::files::Bytes midi;
    xmp::files::MidiDocument d;
    if (!R::render_exchange(arg(a, 0), arg(a, 1).as_string(), arg(a, 2).as_string(), arg(a, 3).as_number(), p, midi, d, error))
      return false;
    out = performance_json(p);
    Value bytes = Value::new_array();
    for (const uint8_t x : midi) bytes.push(Value::of(static_cast<double>(x)));
    out.set("midiFile", xmp::move(bytes));
    return true;
  }
  return error = Str("unknown op ") + op, false;
}
}  // namespace

int main() {
  Str doc;
  int ch;
  auto flush = [&] {
    const auto parsed = xmp::json::parse(doc);
    Value out;
    Str error;
    const bool ok = parsed.ok && apply(parsed.value, out, error);
    const auto t = ok ? xmp::json::stringify(out) : error;
    fputs(ok ? "ok\n" : "error\n", stdout);
    fwrite(t.data(), 1, t.size(), stdout);
    fputc('\0', stdout);
    doc = Str();
  };
  while ((ch = getchar()) != EOF) {
    if (ch == 0)
      flush();
    else
      doc.push(static_cast<char>(ch));
  }
  return 0;
}
