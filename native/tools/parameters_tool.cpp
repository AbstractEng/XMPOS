// Test driver for tests/parity/parameters-parity.test.ts: NUL-separated JSON commands
// on stdin, one answer each ("ok\n" + JSON, or "error\n" + message).
//   set {project}            the current project (canonically checked)
//   machine {definition}     adds an SDK-style machine definition
//   registry                 parameterRegistry as JSON
//   sources [id]             parameterSources
//   value [id]               parameterValue
//   machineParameter [id]    [track index, parameter id] or null
//   instantiate [id]         machines.instantiate
//   smooth [current, target, rate, ms, frames]
//   advance [id, current, frames, rate]
//   setParameter [id, value, source]       edits the current project
//   clearParameterSource [id, source]      edits the current project
#include <stdio.h>

#include "xmp/parameters.hpp"

using xmp::Str;
using xmp::json::Value;

namespace {
Value current;
const Value& arg(const Value& a, int32_t i) {
  static const Value none;
  return a.is_array() && i < a.items().size() ? a.items()[i] : none;
}
Str text(const Value& v) { return v.is_string() ? v.as_string() : Str("\x01not-a-string"); }
double number(const Value& v) { return v.is_number() ? v.as_number() : NAN; }
Value num(double v) { return Value::of(v); }

struct Answer {
  bool ok = false;
  Value value;
  Str error;
  bool edits = false;
};
Answer answer(bool ok, Value v, const Str& error, bool edits = false) {
  Answer a;
  a.ok = ok, a.value = xmp::move(v), a.error = error, a.edits = edits;
  return a;
}
Answer edited(const xmp::edit::Edited& e) { return answer(e.ok, e.project, e.error, true); }

Value definition_json(const xmp::parameters::Definition& d) {
  Value o = Value::new_object();
  o.set("id", Value::of(d.id)), o.set("name", Value::of(d.name));
  o.set("min", num(0)), o.set("max", num(1)), o.set("unit", Value::of("normalized"));
  o.set("defaultValue", num(d.default_value));
  if (d.has_step) o.set("step", num(d.step));
  Value s = Value::new_object();
  s.set("type", Value::of("one-pole")), s.set("timeMs", num(xmp::parameters::kSmoothingMs));
  o.set("smoothing", xmp::move(s));
  return o;
}

Answer apply(const Value& c) {
  namespace P = xmp::parameters;
  const Str op = c.get("op") ? c.get("op")->as_string() : Str();
  const Value& a = c.get("args") ? *c.get("args") : Value();
  Str error;
  if (op == "set") {
    Value out;
    const Value* p = c.get("project");
    const bool ok = p && xmp::project::canonical(*p, out, error);
    return answer(ok, out, error, true);
  }
  if (op == "machine") {
    const Value& d = arg(a, 0);
    xmp::machine::Definition m;
    m.id = text(d.get("id") ? *d.get("id") : Value()), m.name = "SDK machine";
    m.base = d.get("base") ? d.get("base")->as_string() : Str("audio");
    m.version = static_cast<int32_t>(number(d.get("version") ? *d.get("version") : Value()));
    m.automation = d.get("automation") && d.get("automation")->as_bool();
    if (const Value* ps = d.get("parameters"))
      for (const auto& p : ps->items()) {
        xmp::machine::Parameter q;
        q.id = p.get("id")->as_string(), q.name = p.get("name")->as_string(), q.unit = p.get("unit")->as_string();
        q.min = p.get("min")->as_number(), q.max = p.get("max")->as_number();
        q.default_value = p.get("defaultValue")->as_number();
        if (const Value* st = p.get("step")) q.has_step = true, q.step = st->as_number();
        m.parameters.push(q);
      }
    if (const Value* df = d.get("defaults")) m.defaults = *df;
    xmp::machine::machines().add(xmp::move(m));
    return answer(true, Value(), Str());
  }
  if (op == "registry") {
    Value list = Value::new_array();
    for (const auto& d : P::registry(current)) list.push(definition_json(d));
    return answer(true, list, Str());
  }
  if (op == "sources") {
    Value s;
    const bool ok = P::sources(current, text(arg(a, 0)), s, error);
    return answer(ok, s, error);
  }
  if (op == "value") {
    double v = 0;
    const bool ok = P::value(current, text(arg(a, 0)), v, error);
    return answer(ok, num(v), error);
  }
  if (op == "machineParameter") {
    const auto m = P::machine_parameter(current, text(arg(a, 0)));
    if (!m.parameter) return answer(true, Value(), Str());
    Value pair = Value::new_array();
    pair.push(num(m.track)), pair.push(Value::of(m.parameter->id));
    return answer(true, pair, Str());
  }
  if (op == "instantiate") {
    Value out;
    const bool ok = xmp::machine::machines().instantiate(text(arg(a, 0)), out, error);
    return answer(ok, out, error);
  }
  if (op == "smooth") {
    double v = 0;
    const bool ok = P::smooth(number(arg(a, 0)), number(arg(a, 1)), number(arg(a, 2)), number(arg(a, 3)),
                              number(arg(a, 4)), v, error);
    return answer(ok, num(v), error);
  }
  if (op == "advance") {
    double v = 0;
    const bool ok = P::advance(current, text(arg(a, 0)), number(arg(a, 1)), number(arg(a, 2)), number(arg(a, 3)), v, error);
    return answer(ok, num(v), error);
  }
  if (op == "setParameter")
    return edited(P::set_parameter(current, text(arg(a, 0)), number(arg(a, 1)),
                                   arg(a, 2).is_string() ? arg(a, 2).as_string() : Str("base")));
  if (op == "clearParameterSource") return edited(P::clear_parameter_source(current, text(arg(a, 0)), text(arg(a, 1))));
  return answer(false, Value(), Str("unknown op ") + op);
}
}  // namespace

int main() {
  Str doc;
  int ch;
  auto flush = [&] {
    const auto parsed = xmp::json::parse(doc);
    const Answer r = parsed.ok ? apply(parsed.value) : Answer{};
    if (r.ok) {
      if (r.edits) current = r.value;
      const auto out = xmp::json::stringify(r.value);
      fputs("ok\n", stdout);
      fwrite(out.data(), 1, out.size(), stdout);
    } else {
      fputs("error\n", stdout);
      fwrite(r.error.data(), 1, r.error.size(), stdout);
    }
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
