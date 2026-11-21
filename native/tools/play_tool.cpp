// Test driver for tests/parity/play-parity.test.ts: NUL-separated JSON commands on
// stdin, one answer each ("ok\n" + JSON, or "error\n" + message).
//   set {project}
//   notesInWindow [scene, from, to, fill]
//   timeline [scene, from, to, fill, swing, rate]
//   eventsAtStep [scene, step]
//   parameterFrame [scene, position, offsets]
#include <stdio.h>

#include "xmp/play.hpp"

using xmp::Str;
using xmp::Vec;
using xmp::json::Value;

namespace {
Value current;
const Value& arg(const Value& a, int32_t i) {
  static const Value none;
  return a.is_array() && i < a.items().size() ? a.items()[i] : none;
}
Str text(const Value& v) { return v.is_string() ? v.as_string() : Str("\x01not-a-string"); }
double number(const Value& v) { return v.is_number() ? v.as_number() : NAN; }
bool flag(const Value& v) { return v.is_bool() && v.as_bool(); }
Value num(double v) { return Value::of(v); }

Value notes_json(const Vec<xmp::play::Note>& notes, bool frames) {
  Value list = Value::new_array();
  for (const auto& n : notes) {
    Value o = Value::new_object();
    o.set("id", Value::of(n.id)), o.set("trackId", Value::of(n.track_id));
    o.set("pad", num(n.pad)), o.set("note", num(n.note)), o.set("position", num(n.position));
    o.set("duration", num(n.duration)), o.set("velocity", num(n.velocity)), o.set("cycle", num(static_cast<double>(n.cycle)));
    if (frames) o.set("frame", num(n.frame)), o.set("durationFrames", num(n.duration_frames));
    list.push(xmp::move(o));
  }
  return list;
}

bool apply(const Value& c, Value& out, Str& error, bool& edits) {
  namespace P = xmp::play;
  const Str op = c.get("op") ? c.get("op")->as_string() : Str();
  const Value& a = c.get("args") ? *c.get("args") : Value();
  if (op == "set") {
    edits = true;
    const Value* p = c.get("project");
    return p && xmp::project::canonical(*p, out, error);
  }
  if (op == "notesInWindow" || op == "timeline") {
    Vec<P::Note> notes;
    const bool frames = op == "timeline";
    const bool ok =
        frames ? P::timeline(current, text(arg(a, 0)), number(arg(a, 1)), number(arg(a, 2)), flag(arg(a, 3)),
                             number(arg(a, 4)), number(arg(a, 5)), notes, error)
               : P::notes_in_window(current, text(arg(a, 0)), number(arg(a, 1)), number(arg(a, 2)), flag(arg(a, 3)),
                                    notes, error);
    if (ok) out = notes_json(notes, frames);
    return ok;
  }
  if (op == "eventsAtStep") {
    Vec<Value> events;
    if (!P::events_at_step(current, text(arg(a, 0)), number(arg(a, 1)), events, error)) return false;
    out = Value::new_array();
    for (auto& e : events) out.push(xmp::move(e));
    return true;
  }
  if (op == "parameterFrame") {
    P::Frame frame;
    if (!P::parameter_frame(current, text(arg(a, 0)), number(arg(a, 1)), arg(a, 2), frame, error)) return false;
    out = Value::new_object();
    for (int32_t i = 0; i < frame.registry.size(); ++i) out.set(frame.registry[i].id, num(frame.values[i]));
    return true;
  }
  error = Str("unknown op ") + op;
  return false;
}
}  // namespace

int main() {
  Str doc;
  int ch;
  auto flush = [&] {
    const auto parsed = xmp::json::parse(doc);
    Value out;
    Str error;
    bool edits = false;
    const bool ok = parsed.ok && apply(parsed.value, out, error, edits);
    if (ok) {
      if (edits) current = out;
      const auto text = xmp::json::stringify(out);
      fputs("ok\n", stdout);
      fwrite(text.data(), 1, text.size(), stdout);
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
