// Test driver for tests/parity/project-edit-parity.test.ts. Reads NUL-separated JSON
// commands on stdin: {"op":"set","project":{...}} sets the current project
// (canonically checked); any other op applies an edit to it with "args". For
// each command it writes "ok\n" + the resulting project or "error\n" + the
// message (the current project is kept on error), NUL-separated.
#include <stdio.h>

#include "xmp/project_edit.hpp"

using xmp::Str;
using xmp::Vec;
using xmp::json::Value;
namespace edit = xmp::edit;

namespace {
Value current;
const Value& arg(const Value& args, int32_t i) {
  static const Value none;
  return args.is_array() && i < args.items().size() ? args.items()[i] : none;
}
Str text(const Value& v) { return v.is_string() ? v.as_string() : Str("\x01not-a-string"); }
double number(const Value& v) { return v.is_number() ? v.as_number() : NAN; }
Vec<Value> list(const Value& v) { return v.is_array() ? v.items() : Vec<Value>(); }

edit::Edited apply(const Value& command) {
  const Str op = command.get("op") ? command.get("op")->as_string() : Str();
  const Value& a = command.get("args") ? *command.get("args") : Value();
  if (op == "set") {
    edit::Edited e;
    const Value* p = command.get("project");
    e.ok = p && xmp::project::canonical(*p, e.project, e.error);
    return e;
  }
  if (op == "toggleStep") return edit::toggle_step(current, text(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2)), number(arg(a, 3)));
  if (op == "expandSong") return edit::expand_song(current);
  if (op == "appendNotes") return edit::append_notes(current, text(arg(a, 0)), text(arg(a, 1)), list(arg(a, 2)));
  if (op == "quantizeNotes") {
    Vec<Str> ids;
    for (const auto& v : list(arg(a, 2))) ids.push(text(v));
    return edit::quantize_notes(current, text(arg(a, 0)), text(arg(a, 1)), ids, number(arg(a, 3)),
                                arg(a, 4).is_bool() && arg(a, 4).as_bool());
  }
  if (op == "resizeClip") return edit::resize_clip(current, text(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2)));
  if (op == "duplicateClip") return edit::duplicate_clip(current, text(arg(a, 0)), text(arg(a, 1)));
  if (op == "editChain") return edit::edit_chain(current, list(arg(a, 0)));
  if (op == "deleteTrack") return edit::delete_track(current, text(arg(a, 0)));
  if (op == "setMidiDestination") {
    const Str d = text(arg(a, 1));
    return edit::set_midi_destination(current, text(arg(a, 0)), arg(a, 1).is_null() ? nullptr : &d);
  }
  if (op == "manualSlices") {
    Vec<double> b;
    for (const auto& v : list(arg(a, 1))) b.push(number(v));
    const Str track = text(arg(a, 2));
    return edit::manual_slices(current, number(arg(a, 0)), b, arg(a, 2).is_string() ? &track : nullptr);
  }
  if (op == "installSample") {
    Vec<double> pcm;
    for (const auto& v : list(arg(a, 3))) pcm.push(number(v));
    const Str track = text(arg(a, 4));
    return edit::install_sample(current, number(arg(a, 0)), text(arg(a, 1)), number(arg(a, 2)), pcm,
                                arg(a, 4).is_string() ? &track : nullptr);
  }
  if (op == "applyDrumKit") {
    const Str track = text(arg(a, 1));
    return edit::apply_drum_kit(current, arg(a, 0), arg(a, 1).is_string() ? &track : nullptr);
  }
  if (op == "ownKit") return edit::own_kit(current, text(arg(a, 0)));
  if (op == "shareKit") return edit::share_kit(current, text(arg(a, 0)));
  // Object.assign onto the mix, the performance or a clip's sequence.
  auto assign = [&](const Value& from) {
    return [&from](Value& target) {
      if (from.is_object())
        for (const auto& m : from.members()) target.set(m.key, m.value);
    };
  };
  if (op == "assignMix") return edit::edit_mix(current, assign(arg(a, 0)));
  if (op == "assignPerformance") return edit::edit_performance(current, assign(arg(a, 0)));
  if (op == "assignSequence") return edit::edit_sequence(current, text(arg(a, 0)), text(arg(a, 1)), assign(arg(a, 2)));
  edit::Edited e;
  e.error = Str("unknown op ") + op;
  return e;
}
}  // namespace

int main() {
  Str doc;
  int c;
  auto flush = [&] {
    const auto parsed = xmp::json::parse(doc);
    const auto r = parsed.ok ? apply(parsed.value) : edit::Edited{};
    if (r.ok) {
      current = r.project;
      const auto out = xmp::json::stringify(current);
      fputs("ok\n", stdout);
      fwrite(out.data(), 1, out.size(), stdout);
    } else {
      fputs("error\n", stdout);
      fwrite(r.error.data(), 1, r.error.size(), stdout);
    }
    fputc('\0', stdout);
    doc = Str();
  };
  while ((c = getchar()) != EOF) {
    if (c == 0)
      flush();
    else
      doc.push(static_cast<char>(c));
  }
  return 0;
}
