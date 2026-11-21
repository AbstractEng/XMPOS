// Test driver for tests/parity/files-parity.test.ts: NUL-separated JSON commands on
// stdin, one answer each ("ok\n" + JSON, or "error\n" + message). Bytes travel
// as arrays of numbers.
//   encodeWav [[channel...], rate]   -> bytes
//   decodeWav [bytes]                -> {pcm, sampleRate}
//   encodeMidi [document]            -> bytes
//   decodeMidi [bytes]               -> document
//   exchangePlan [project, mode, scene] -> {document, steps}
//   importMidiClip [project, bytes, fileTrack, trackId, clipId] -> project
#include <stdio.h>

#include "xmp/files.hpp"

using xmp::Str;
using xmp::Vec;
using xmp::json::Value;
namespace F = xmp::files;

namespace {
const Value& arg(const Value& a, int32_t i) {
  static const Value none;
  return a.is_array() && i < a.items().size() ? a.items()[i] : none;
}
F::Bytes bytes_of(const Value& v) {
  F::Bytes b;
  for (const auto& x : v.items()) b.push(static_cast<uint8_t>(x.as_number()));
  return b;
}
Value bytes_json(const F::Bytes& b) {
  Value out = Value::new_array();
  for (const uint8_t x : b) out.push(Value::of(static_cast<double>(x)));
  return out;
}
double num(const Value& o, const char* k) { return o.get(k) && o.get(k)->is_number() ? o.get(k)->as_number() : NAN; }
F::MidiDocument document_of(const Value& v) {
  F::MidiDocument d;
  d.ppq = num(v, "ppq"), d.end_tick = num(v, "endTick"), d.ignored_events = num(v, "ignoredEvents");
  for (const auto& n : v.get("notes")->items())
    d.notes.push(F::MidiNote{num(n, "track"), num(n, "channel"), num(n, "note"), num(n, "velocity"), num(n, "tick"),
                             num(n, "duration")});
  for (const auto& t : v.get("tempos")->items()) d.tempos.push(F::MidiTempo{num(t, "tick"), num(t, "micros")});
  return d;
}
Value document_json(const F::MidiDocument& d) {
  Value o = Value::new_object();
  o.set("ppq", Value::of(d.ppq));
  Value notes = Value::new_array();
  for (const auto& n : d.notes) {
    Value x = Value::new_object();
    x.set("track", Value::of(n.track)), x.set("channel", Value::of(n.channel)), x.set("note", Value::of(n.note));
    x.set("velocity", Value::of(n.velocity)), x.set("tick", Value::of(n.tick)), x.set("duration", Value::of(n.duration));
    notes.push(xmp::move(x));
  }
  o.set("notes", xmp::move(notes));
  Value tempos = Value::new_array();
  for (const auto& t : d.tempos) {
    Value x = Value::new_object();
    x.set("tick", Value::of(t.tick)), x.set("micros", Value::of(t.micros));
    tempos.push(xmp::move(x));
  }
  o.set("tempos", xmp::move(tempos));
  o.set("endTick", Value::of(d.end_tick)), o.set("ignoredEvents", Value::of(d.ignored_events));
  return o;
}

bool apply(const Value& c, Value& out, Str& error) {
  const Str op = c.get("op") ? c.get("op")->as_string() : Str();
  const Value& a = c.get("args") ? *c.get("args") : Value();
  if (op == "encodeWav") {
    Vec<Vec<float>> channels;
    for (const auto& ch : arg(a, 0).items()) {
      Vec<float> v;
      for (const auto& x : ch.items()) v.push(static_cast<float>(x.as_number()));
      channels.push(xmp::move(v));
    }
    F::Bytes b;
    if (!F::encode_wav(channels, static_cast<uint32_t>(arg(a, 1).as_number()), b, error)) return false;
    out = bytes_json(b);
    return true;
  }
  if (op == "decodeWav") {
    const F::Bytes b = bytes_of(arg(a, 0));
    F::Sample s;
    if (!F::decode_sample_wav(b.begin(), static_cast<size_t>(b.size()), s, error)) return false;
    out = Value::new_object();
    Value pcm = Value::new_array();
    for (const float x : s.pcm) pcm.push(Value::of(static_cast<double>(x)));
    out.set("pcm", xmp::move(pcm)), out.set("sampleRate", Value::of(static_cast<double>(s.rate)));
    return true;
  }
  if (op == "encodeMidi") {
    F::Bytes b;
    if (!F::encode_midi(document_of(arg(a, 0)), b, error)) return false;
    out = bytes_json(b);
    return true;
  }
  if (op == "decodeMidi") {
    const F::Bytes b = bytes_of(arg(a, 0));
    F::MidiDocument d;
    if (!F::decode_midi(b.begin(), static_cast<size_t>(b.size()), d, error)) return false;
    out = document_json(d);
    return true;
  }
  if (op == "exchangePlan") {
    F::MidiDocument d;
    double steps = 0;
    if (!F::exchange_plan(arg(a, 0), arg(a, 1).as_string(), arg(a, 2).as_string(), d, steps, error)) return false;
    out = Value::new_object();
    out.set("document", document_json(d)), out.set("steps", Value::of(steps));
    return true;
  }
  if (op == "importMidiClip") {
    const F::Bytes b = bytes_of(arg(a, 1));
    auto e = F::import_midi_clip(arg(a, 0), b.begin(), static_cast<size_t>(b.size()), arg(a, 2).as_number(),
                                 arg(a, 3).as_string(), arg(a, 4).as_string());
    if (!e.ok) return error = e.error, false;
    out = e.project;
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
