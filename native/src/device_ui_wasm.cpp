// The actual native touchscreen painter and interaction state for browser Device.
// Platform adapters supply project metadata, input audio and transport state.
#include "xmp/live_ui.hpp"
#include <cstring>

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))
namespace {
namespace ui = xmp::live::ui;
using xmp::json::Value;
ui::Ui face;
ui::Board board;
ui::Now now;
ui::Painter painter;
ui::SampleScreen screen;
xmp::live::Canvas canvas;
Value project;
std::vector<unsigned char> pixels(1280 * 800 * 4);
std::vector<float> take;
std::vector<ui::Action> actions;
xmp::Str result;

void initialize_canvas() {
  canvas.memory = pixels.data(), canvas.size = pixels.size();
  canvas.xres = canvas.width = 1280, canvas.yres = canvas.height = 800;
  canvas.line_length = 1280 * 4;
}
}

EXPORT(du_alloc) void* du_alloc(int32_t size) { return malloc(size > 0 ? static_cast<size_t>(size) : 1); }
EXPORT(du_free) void du_free(void* pointer) { free(pointer); }
EXPORT(du_result) const char* du_result() { return result.c_str(); }
EXPORT(du_result_size) int32_t du_result_size() { return static_cast<int32_t>(result.size()); }
EXPORT(du_project) int32_t du_project(const char* text, int32_t size, int32_t track, int32_t pad) {
  xmp::Str error;
  if (size < 0 || !xmp::project::preflight(text, static_cast<size_t>(size), error)) return 0;
  const auto parsed = xmp::json::parse(text, static_cast<size_t>(size));
  if (!parsed.ok || !parsed.value.is_object()) return 0;
  const auto* tracks = parsed.value.get("tracks"), *scenes = parsed.value.get("scenes"), *pads = parsed.value.get("pads");
  if (!tracks || !tracks->is_array() || tracks->items().size() > 8 || !scenes || !scenes->is_array() ||
      scenes->items().size() > 16 || !pads || !pads->is_array() || pads->items().size() != 16) return 0;
  project = parsed.value;
  board = ui::board_of(project);
  face.track = std::clamp(track, 0, std::max(0, board.tracks - 1));
  face.sample_pad = std::clamp(pad, 0, 15);
  if (face.view != ui::View::sample) face.open(ui::View::sample);
  initialize_canvas();
  return 1;
}
EXPORT(du_take) int32_t du_take(const float* pcm, int32_t frames) {
  if (frames < 0 || frames > 1536000) return 0;
  for (int i = 0; i < frames; ++i) if (!std::isfinite(pcm[i]) || std::fabs(pcm[i]) > 1) return 0;
  take.assign(pcm, pcm + frames);
  face.sample_done(frames);
  screen.frames = frames;
  screen.state = frames ? ui::SampleScreen::ready : ui::SampleScreen::none;
  screen.peaks = xmp::live::sample::overview(take, 300);
  ++screen.revision;
  return 1;
}
EXPORT(du_notice) void du_notice(const char* text,int size) { if(size>=0 && size<=512) face.say(std::string(text,static_cast<size_t>(size))); }
EXPORT(du_take_name) void du_take_name(const char* text,int size) { if(size>=0 && size<=512) face.sample_name.assign(text,static_cast<size_t>(size)); }
EXPORT(du_save) void du_save(int state) { static const char* labels[]={"Saved","Unsaved changes","Saving","Save failed"};face.save_status=labels[std::clamp(state,0,3)]; }
EXPORT(du_edit) void du_edit(int32_t start, int32_t end, int32_t reverse) {
  face.sample.start = start, face.sample.end = end, face.sample.reverse = reverse != 0;
  face.sample.fit(static_cast<int>(take.size()));
  ++face.revision;
}
EXPORT(du_recording) void du_recording(int state, int frames) {
  face.sampling = state == 1 || state == 2;
  screen.frames = std::clamp(frames,0,1536000);
  screen.state = state == 1 ? ui::SampleScreen::armed : state == 2 ? ui::SampleScreen::recording : take.empty() ? ui::SampleScreen::none : ui::SampleScreen::ready;
  ++face.revision;
}
EXPORT(du_transport) void du_transport(double step, int32_t playing) { now.step = step, now.playing = playing != 0; face.set_playing(now.playing); }
EXPORT(du_touch) void du_touch(int32_t phase, int32_t x, int32_t y) {
  if (phase < 0 || phase > 2 || x < 0 || x >= 1280 || y < 0 || y >= 800) return;
  ui::touch_event(face, project, board, now, static_cast<ui::TouchPhase>(phase), x, y, actions);
}
EXPORT(du_pad) void du_pad(int32_t pad, float velocity) {
  if (pad < 0 || pad >= 16 || !std::isfinite(velocity) || velocity < 0 || velocity > 1) return;
  face.pad(pad, velocity, board, now, actions);
}
EXPORT(du_button) void du_button(int32_t button, int32_t down) {
  if (button < 0 || button > static_cast<int>(ui::Button::wheel)) return;
  face.button(static_cast<ui::Button>(button), down != 0, board, now, actions);
}
EXPORT(du_buttons) void du_buttons() {
  Value buttons = Value::new_array();
  for (int i = 1; i <= static_cast<int>(ui::Button::wheel); ++i) {
    Value b = Value::new_object();
    b.set("id", Value::of(static_cast<double>(i)));
    b.set("name", Value::of(ui::button_name(static_cast<ui::Button>(i))));
    buttons.push(b);
  }
  result = xmp::json::stringify(buttons);
}
EXPORT(du_number) int du_number(const char* text,int size) {
  if (!face.editor_open || size<0 || size>12) return 0;
  for(int i=0;i<size;++i) if ((text[i]<'0'||text[i]>'9') && text[i]!='.' && text[i]!='-') return 0;
  face.editor_text.assign(text,static_cast<size_t>(size));++face.revision;return 1;
}
EXPORT(du_knob) void du_knob(int32_t knob, int32_t clicks) {
  if (knob < 0 || knob >= 4 || clicks < -127 || clicks > 127) return;
  face.knob(knob, clicks, board, actions);
}
EXPORT(du_draw) const unsigned char* du_draw() {
  ui::fill_strip(face, project, board);
  painter.draw(canvas, face, board, now, 0, nullptr, nullptr, &screen);
  return pixels.data();
}
EXPORT(du_controls) void du_controls() {
  Value controls = Value::new_array();
  auto add = [&](const char* name, const xmp::live::Rect& rect) {
    Value control = Value::new_object();
    control.set("name", Value::of(name));
    control.set("x", Value::of(static_cast<double>(rect.x))), control.set("y", Value::of(static_cast<double>(rect.y)));
    control.set("width", Value::of(static_cast<double>(rect.w))), control.set("height", Value::of(static_cast<double>(rect.h)));
    control.set("enabled", Value::of(face.sample_frames > 0 && !face.sampling));
    controls.push(control);
  };
  if (face.editor_open) {
    add("Apply",ui::layout::dialog_apply()); add("Cancel",ui::layout::dialog_cancel()); add("Reset",ui::layout::dialog_reset());
    add(face.editor.name.c_str(),{296,198,640,60});
    auto& input=controls.items().back();input.set("kind",Value::of("number"));
    input.set("value",Value::of(face.editor.value)); input.set("min",Value::of(face.editor.min));input.set("max",Value::of(face.editor.max));
    for(auto& control:controls.items()) control.set("enabled",Value::of(true));
    result=xmp::json::stringify(controls);return;
  }
  if(face.rename_kind) {
    add("Apply",ui::layout::dialog_apply());add("Cancel",ui::layout::dialog_cancel());
    for(auto& control:controls.items()) control.set("enabled",Value::of(true));
    result=xmp::json::stringify(controls);return;
  }
  add("Tempo",{960,0,150,ui::layout::kHeader});controls.items().back().set("enabled",Value::of(true));
  add("Rename project",{ui::layout::kHeaderIdentity,0,ui::layout::kHeaderSave-ui::layout::kHeaderIdentity,30});controls.items().back().set("enabled",Value::of(true));
  add("Rename track",{ui::layout::kHeaderIdentity,30,ui::layout::kHeaderSave-ui::layout::kHeaderIdentity,ui::layout::kHeader-30});controls.items().back().set("enabled",Value::of(true));
  static const char* keys[]={"start","end","tune","level","fadeIn","fadeOut","reverse","slices"};
  for (int k=0;k<4;++k) {
    add(face.sample_knob_name(k).c_str(),{ui::layout::kPageWidth,ui::layout::kHeader+k*182,1280-ui::layout::kPageWidth,182});
    auto& control=controls.items().back();control.set("key",Value::of(xmp::Str("sample:")+keys[face.sample_knob_index(k)]));
    const auto& e=face.sample;
    const double values[]={static_cast<double>(e.start),static_cast<double>(e.end),static_cast<double>(e.tune),e.level*100.0,static_cast<double>(e.fade_in),static_cast<double>(e.fade_out),e.reverse ? 1.0 : 0.0,static_cast<double>(e.slices)};
    control.set("value",Value::of(values[face.sample_knob_index(k)]));
  }
  add(xmp::live::sample::chop_mode_name(face.sample.chop_mode), ui::layout::sample_chop_mode());
  add(board.input_monitor[face.track] ? "Monitor: On" : "Monitor: Off",ui::layout::sample_monitor());
  controls.items().back().set("enabled",Value::of(!face.sampling));
  const auto bars = std::to_string(board.input_bars[face.track])+" bars";
  add(bars.c_str(),ui::layout::sample_length());
  controls.items().back().set("enabled",Value::of(!face.sampling));
  add("Chop to drum kit", ui::layout::sample_make_kit());
  for (int i = 0; i < 5; ++i) {
    add(ui::sample_task_name(face,i), ui::layout::task(i));
    controls.items().back().set("enabled", Value::of(ui::workbench_task_available(face,board,i)));
  }
  result = xmp::json::stringify(controls);
}
EXPORT(du_state) void du_state() {
  Value state = Value::new_object();
  state.set("name",Value::of(face.sample_name.c_str()));
  state.set("message",Value::of(face.toast.c_str()));
  state.set("view", Value::of(ui::view_name(face.view)));
  state.set("track", Value::of(static_cast<double>(face.track)));
  state.set("pad", Value::of(static_cast<double>(face.sample_pad)));
  state.set("sampling",Value::of(face.sampling));
  state.set("inputTrack",Value::of(board.input_track[face.track]));
  state.set("monitor",Value::of(board.input_monitor[face.track]));
  state.set("bars",Value::of(static_cast<double>(board.input_bars[face.track])));
  state.set("frames", Value::of(static_cast<double>(face.sample_frames)));
  Value edit = Value::new_object();
  edit.set("start", Value::of(static_cast<double>(face.sample.start))), edit.set("end", Value::of(static_cast<double>(face.sample.end)));
  edit.set("tune", Value::of(static_cast<double>(face.sample.tune))), edit.set("level", Value::of(static_cast<double>(face.sample.level)));
  edit.set("fadeIn", Value::of(static_cast<double>(face.sample.fade_in))), edit.set("fadeOut", Value::of(static_cast<double>(face.sample.fade_out)));
  edit.set("reverse", Value::of(face.sample.reverse)), edit.set("slices", Value::of(static_cast<double>(face.sample.slices)));
  edit.set("chopMode", Value::of(static_cast<double>(face.sample.chop_mode)));
  Value boundaries = Value::new_array();
  const int frames = std::clamp(static_cast<int>(std::floor((face.sample.end - face.sample.start) / std::pow(2.0, face.sample.tune / 12.0))), 0, xmp::live::sample::kMaxFrames);
  for (int at : xmp::live::sample::chop_boundaries(frames, face.sample)) boundaries.push(Value::of(static_cast<double>(at)));
  edit.set("boundaries", boundaries), state.set("edit", edit);
  result = xmp::json::stringify(state);
}
EXPORT(du_actions) void du_actions() {
  Value out = Value::new_array();
  for (const auto& action : actions) {
    if (action.kind == ui::Action::sample_chop_mode) {
      xmp::live::sample::refresh_chops(take, face.sample, board.bpm);
      ++face.revision;
      continue;
    }
    if (action.kind == ui::Action::sample_monitor || action.kind == ui::Action::sample_length) {
      const int t = face.track;
      if (action.kind == ui::Action::sample_monitor) board.input_monitor[t] = !board.input_monitor[t];
      else board.input_bars[t] = board.input_bars[t] == 4 ? 1 : board.input_bars[t]*2;
    }
    const char* name = action.kind == ui::Action::rename ? "rename" : action.kind == ui::Action::set_value && action.field.field == xmp::live::edit::Field::tempo ? "tempo" : action.kind == ui::Action::sample_monitor || action.kind == ui::Action::sample_length ? "settings" : action.kind == ui::Action::sample_arm ? "record" : action.kind == ui::Action::sample_stop ? "stop-record" :
      action.kind == ui::Action::sample_keep ? "keep" : action.kind == ui::Action::sample_chop ? "chop" :
      action.kind == ui::Action::sample_discard ? "discard" : action.kind == ui::Action::sample_audition ? "audition" : "";
    if (!*name) continue;
    Value value = Value::new_object();
    value.set("kind", Value::of(name)), value.set("track", Value::of(static_cast<double>(action.track)));
    value.set("pad", Value::of(static_cast<double>(action.pad)));
    if(action.kind==ui::Action::set_value) value.set("value",Value::of(action.value));
    if(action.kind==ui::Action::rename) value.set("name",Value::of(action.name.c_str())),value.set("renameKind",Value::of(static_cast<double>(action.knob)));
    out.push(value);
  }
  actions.clear();
  result = xmp::json::stringify(out);
}
EXPORT(du_preview) int32_t du_preview(int32_t pad) {
  static std::vector<float> preview;
  preview = xmp::live::sample::preview_chop(take, face.sample, pad);
  Value state = Value::new_object();
  state.set("pointer", Value::of(static_cast<double>(reinterpret_cast<uintptr_t>(preview.data()))));
  state.set("frames", Value::of(static_cast<double>(preview.size())));
  result = xmp::json::stringify(state);
  return static_cast<int32_t>(preview.size());
}
