// Test driver for tests/parity/performance-play-parity.test.ts: NUL-separated JSON
// commands on stdin, one answer each ("ok\n" + JSON, or "error\n" + message).
//   new {project}                a new performance (transport) for the project
//   setProject {project}         the transport's project changes
//   start [scene|null, mode, resume], queueScene [scene], queueClip [track, clip|null],
//   cancel, stop, control [event], advance [step] -> {snapshot, releases}
//   window [step, fill, swing, rate], values [position], state
//   controls [project, position, overrides]   performanceControls (stateless)
#include <stdio.h>

#include "xmp/performance.hpp"

using xmp::Str;
using xmp::Vec;
using xmp::json::Value;
namespace P = xmp::play;

namespace {
P::Performance* perf = nullptr;
const Value& arg(const Value& a, int32_t i) {
  static const Value none;
  return a.is_array() && i < a.items().size() ? a.items()[i] : none;
}
Str text(const Value& v) { return v.is_string() ? v.as_string() : Str("\x01not-a-string"); }
double number(const Value& v) { return v.is_number() ? v.as_number() : NAN; }
bool flag(const Value& v) { return v.is_bool() && v.as_bool(); }

Value state() {
  Value o = Value::new_object();
  o.set("sceneId", Value::of(perf->scene_id()));
  o.set("running", Value::of(perf->running()));
  o.set("mode", Value::of(perf->song() ? "song" : "scene"));
  o.set("step", Value::of(perf->step()));
  o.set("songOffset", Value::of(perf->song_offset()));
  o.set("clockOrigin", Value::of(perf->clock_origin()));
  Value slots = Value::new_array();
  for (const auto& s : perf->slots()) {
    Value x = Value::new_array();
    x.push(Value::of(s.track));
    if (s.has_clip)
      x.push(Value::of(s.clip));
    else
      x.push(Value());
    x.push(Value::of(s.anchor));
    slots.push(xmp::move(x));
  }
  o.set("slots", xmp::move(slots));
  return o;
}

bool apply(const Value& c, Value& out, Str& error) {
  const Str op = c.get("op") ? c.get("op")->as_string() : Str();
  const Value& a = c.get("args") ? *c.get("args") : Value();
  if (op == "new") {
    if (perf) perf->~Performance(), free(perf);
    perf = new (xmp::checked_alloc(sizeof(P::Performance))) P::Performance(*c.get("project"));
    if (!perf->ok()) return error = perf->error(), false;
    out = state();
    return true;
  }
  if (op == "controls") {
    P::Overrides o;
    for (const auto& e : arg(a, 2).items()) o.set(e.items()[0].as_string(), e.items()[1]);
    return P::performance_controls(arg(a, 0), number(arg(a, 1)), o, out, error);
  }
  if (!perf) return error = "no performance", false;
  bool ok = true;
  if (op == "setProject")
    ok = perf->set_project(*c.get("project"), error);
  else if (op == "start")
    ok = arg(a, 0).is_null() ? perf->start(perf->scene_id(), text(arg(a, 1)) == "song", flag(arg(a, 2)), error)
                             : perf->start(text(arg(a, 0)), text(arg(a, 1)) == "song", flag(arg(a, 2)), error);
  else if (op == "queueScene")
    ok = perf->queue_scene(text(arg(a, 0)), error);
  else if (op == "queueClip") {
    const Str clip = text(arg(a, 1));
    ok = perf->queue_clip(text(arg(a, 0)), arg(a, 1).is_null() ? nullptr : &clip, error);
  } else if (op == "cancel") {
    out = Value::of(perf->cancel_launch());
    return true;
  } else if (op == "stop")
    perf->stop();
  else if (op == "control")
    ok = perf->control(arg(a, 0), error);
  else if (op == "advance") {
    Vec<Str> releases;
    if (!perf->advance(number(arg(a, 0)), releases, error)) return false;
    out = Value::new_object();
    out.set("snapshot", perf->snapshot());
    Value r = Value::new_array();
    for (const auto& x : releases) r.push(Value::of(x));
    out.set("releases", xmp::move(r));
    return true;
  } else if (op == "window")
    return P::performance_window(*perf, number(arg(a, 0)), flag(arg(a, 1)), number(arg(a, 2)), number(arg(a, 3)), out,
                                 error);
  else if (op == "values")
    return P::performance_values(*perf, number(arg(a, 0)), out, error);
  else if (op != "state")
    return error = Str("unknown op ") + op, false;
  if (!ok) return false;
  out = state();
  return true;
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
    if (ok) {
      const auto t = xmp::json::stringify(out);
      fputs("ok\n", stdout);
      fwrite(t.data(), 1, t.size(), stdout);
    } else {
      fputs("error\n", stdout);
      fwrite(error.data(), 1, error.size(), stdout);
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
