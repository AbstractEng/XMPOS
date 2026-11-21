// Host-only Gherkin driver. Executes production Ui and project edits in memory.
// No session boot, device, audio-card, network or filesystem APIs are called.
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>
#include "xmp/live_ui.hpp"

namespace ui = xmp::live::ui;
namespace edit = xmp::live::edit;
using xmp::json::Value;
using xmp::Str;

namespace {
const Value& required(const Value& o, const char* key) {
  const auto* v = o.get(key);
  if (!v) throw std::runtime_error(std::string("Missing ") + key);
  return *v;
}
std::string text(const Value& o, const char* key) {
  const auto& v = required(o, key);
  if (!v.is_string() || v.as_string().size() > 64) throw std::runtime_error("Invalid event name");
  return ui::text(v.as_string());
}
int integer(const Value& o, const char* key, int low, int high) {
  const auto& v = required(o, key);
  if (!v.is_number() || !std::isfinite(v.as_number()) || v.as_number() < low || v.as_number() > high ||
      std::floor(v.as_number()) != v.as_number()) throw std::runtime_error("Invalid event number");
  return static_cast<int>(v.as_number());
}
ui::Button button(const std::string& name) {
  if (name == "shift") return ui::Button::shift;
  if (name == "menu") return ui::Button::menu;
  if (name == "copy") return ui::Button::copy;
  if (name == "wheel") return ui::Button::wheel;
  if (name == "undo") return ui::Button::undo;
  if (name == "play") return ui::Button::play;
  if (name == "16-level") return ui::Button::level16;
  if (name == "bank-b") return ui::Button::bank_b;
  throw std::runtime_error("Unsupported test button");
}
}

int main() {
  try {
    Str bytes;
    for (int c; (c = std::getchar()) != EOF;) {
      if (bytes.size() >= 24 * 1024 * 1024) throw std::runtime_error("Test input exceeds limit");
      bytes.push(static_cast<char>(c));
    }
    Str error;
    if (!xmp::project::preflight(bytes.data(), bytes.size(), error)) throw std::runtime_error(error.c_str());
    const auto parsed = xmp::json::parse(bytes);
    if (!parsed.ok || !parsed.value.is_object()) throw std::runtime_error("Invalid test JSON");
    Value project;
    if (!xmp::project::canonical(required(parsed.value, "project"), project, error))
      throw std::runtime_error(error.c_str());
    const auto& events = required(parsed.value, "events");
    if (!events.is_array() || events.items().size() > 128) throw std::runtime_error("Invalid test event list");
    ui::Ui face;
    ui::Now stopped;
    auto board = ui::board_of(project);
    edit::History history;
    Value errors = Value::new_array();
    int transport_requests = 0, note_requests = 0, preview_frames = 0;
    std::string preview_sample;
    for (const auto& event : events.items()) {
      if (!event.is_object()) throw std::runtime_error("Invalid event");
      std::vector<ui::Action> actions;
      const auto type = text(event, "type");
      if (type == "button") {
        const auto& down = required(event, "down");
        if (!down.is_bool()) throw std::runtime_error("Invalid button state");
        face.button(button(text(event, "name")), down.as_bool(), board, stopped, actions);
      } else if (type == "pad") {
        face.pad(integer(event, "pad", 0, 15), 100, board, stopped, actions);
      } else if (type == "wheel") {
        face.wheel(integer(event, "delta", -16, 16), board);
      } else throw std::runtime_error("Unsupported test event");
      for (const auto& a : actions) {
        bool changed = false;
        std::string why;
        edit::Place place;
        switch (a.kind) {
          case ui::Action::copy_clip:
            changed = edit::copy_slot(project, a.source_track, Str(a.source_clip.c_str()), a.track, a.scene, history, why);
            break;
          case ui::Action::unlink_clip:
            changed = edit::unlink_slot(project, a.track, a.scene, history, why);
            break;
          case ui::Action::browse_assign:
            changed = edit::assign_pool_sample(project, a.track, a.pad, Str(a.sample_id.c_str()), history, why);
            break;
          case ui::Action::undo:
            if (!(changed = history.undo(project, place))) why = "Nothing to undo";
            break;
          case ui::Action::redo:
            if (!(changed = history.redo(project, place))) why = "Nothing to redo";
            break;
          case ui::Action::browse_audition: {
            const auto samples = edit::preview_pool_sample(project, Str(a.sample_id.c_str()));
            for (const auto value : samples) if (!std::isfinite(value)) throw std::runtime_error("Nonfinite preview");
            preview_frames = static_cast<int>(samples.size()), preview_sample = a.sample_id;
            break;
          }
          case ui::Action::play_clip:
          case ui::Action::play_scene:
          case ui::Action::play_song:
            ++transport_requests;
            break;
          case ui::Action::note_on:
          case ui::Action::note_off:
            ++note_requests;
            break;
          default: throw std::runtime_error("Unexpected native action in this control contract");
        }
        if (!why.empty()) errors.push(Value::of(Str(why.c_str())));
        if (changed) board = ui::board_of(project);
      }
    }
    ui::fill_strip(face, project, board);
    Value names = Value::new_array();
    for (const auto& shown : face.strip) names.push(Value::of(Str(shown.name.c_str())));
    Value result = Value::new_object();
    result.set("project", project);
    result.set("view", Value::of(ui::view_name(face.view)));
    result.set("knobNames", xmp::move(names));
    result.set("canUndo", Value::of(history.can_undo()));
    result.set("canRedo", Value::of(history.can_redo()));
    result.set("errors", xmp::move(errors));
    result.set("transportRequests", Value::of(static_cast<double>(transport_requests)));
    result.set("noteRequests", Value::of(static_cast<double>(note_requests)));
    result.set("previewFrames", Value::of(static_cast<double>(preview_frames)));
    result.set("previewSampleId", Value::of(Str(preview_sample.c_str())));
    const auto out = xmp::json::stringify(result);
    std::fwrite(out.data(), 1, out.size(), stdout);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
