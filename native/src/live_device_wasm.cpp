// Browser platform bindings for the Live touchscreen and project engine.
#include "xmp/live_workbench.hpp"

namespace {
namespace live = xmp::live;
namespace ui = xmp::live::ui;
constexpr int kWidth = ui::layout::kWidth, kHeight = 800, kBlock = 512;
constexpr int kMaxFile = xmp::project_limits::kSongBytes;

#define IMPORT(name) __attribute__((import_module("xmp"), import_name(#name)))
#define EXPORT(name) extern "C" __attribute__((export_name(#name)))
extern "C" {
IMPORT(read_file) int read_file(int id, unsigned char* output, int bytes);
}

struct Runtime {
  xmp::json::Value project;
  live::ProjectSound sound;
  std::vector<live::library::Entry> files;
  std::vector<std::uint32_t> pixels = std::vector<std::uint32_t>(kWidth * kHeight);
  std::vector<unsigned char> input;
  live::Canvas canvas;
  std::vector<float> preview, capture_wave;
  std::size_t preview_pos = 0, capture_pos = 0;
  std::uint64_t frame = 0;
  float audio[2][kBlock]{};
  bool capturing = false, ready = false, save_pending = false, microphone = false;
  live::sample::InputRing<> input_ring;
  live::sample::LoopTake loop;
  bool input_ready = false;
  live::Workbench::Clock::time_point saved_at{}, auto_save_attempt{};
  xmp::Str save_data;
  std::string save_name;
  std::array<uint32_t, static_cast<size_t>(ui::Action::chop_mark) + 1> usage{};
  live::Workbench workbench;

  Runtime()
      : workbench(project, sound, true, {
          [&] { return frame; },
          [&](const auto& pcm) {
            if (preview_pos < preview.size()) return false;
            preview = pcm; preview_pos = 0; return true;
          },
          [&] { capture_pos = 0; return capturing = microphone || !capture_wave.empty(); },
          [&] { return capturing; },
          [&] { capturing = false; },
          [&] { return files; },
          [&](const auto& entry, auto& bytes) {
            bytes.resize(entry.bytes);
            return read_file(std::atoi(entry.relative.c_str()), bytes.data(), static_cast<int>(bytes.size()));
          },
          [](const char*) {},
          [&](const auto& name) { return save(name); },
          [&](ui::Action::Kind kind) { if (usage[kind] < 1000000) ++usage[kind]; },
        }) {
    workbench.loop = &loop;
    canvas.memory = reinterpret_cast<unsigned char*>(pixels.data());
    canvas.size = sizeof(std::uint32_t) * pixels.size();
    canvas.width = canvas.xres = kWidth;
    canvas.height = canvas.yres = kHeight;
    canvas.line_length = sizeof(std::uint32_t) * kWidth;
    canvas.red_offset = 0;
    canvas.blue_offset = 16;
    canvas.extra_bits = 0xff000000;
  }

  std::string save(const std::string& name) {
    if (save_pending) return "Save in progress";
    xmp::Str error;
    if (!xmp::portable::save_song(project, save_data, error) || save_data.size() > kMaxFile)
      return "Could not save";
    save_name = name;
    saved_at = workbench.project_changed;
    save_pending = true;
    workbench.face.save_status = "Saving";
    return {};
  }

  void actions() {
    workbench.run_actions("browser panel");
  }
};

Runtime& runtime() {
  static Runtime value;
  return value;
}
}

EXPORT(input_buffer) unsigned char* input_buffer(int bytes) {
  if (bytes < 0 || bytes > kMaxFile) return nullptr;
  auto& r = runtime();
  r.input.resize(bytes);
  return r.input.data();
}

EXPORT(initialize) int initialize(int bytes) {
  auto& r = runtime();
  if (r.ready || bytes < 0 || static_cast<std::size_t>(bytes) > r.input.size()) return 0;
  auto install = [&](const auto& opened) {
    xmp::Str error;
    if (!opened.ok || !r.sound.prepare(opened.project, error)) return false;
    r.project = opened.project;
    r.workbench.board = ui::board_of(r.project);
    r.workbench.face.save_status = "Saved";
    r.workbench.painter.lights = {1, 1, 1, 0, 0};
    r.ready = true;
    return true;
  };
  if (bytes) {
    const auto opened = xmp::song_snapshot::open(reinterpret_cast<const char*>(r.input.data()), bytes);
    return install(opened);
  }
  return install(live::blank_project());
}

EXPORT(touch) void touch(int phase, int x, int y) {
  if (phase < 0 || phase > 3) return;
  runtime().workbench.touch(static_cast<ui::TouchPhase>(phase), x, y);
}
EXPORT(button) void button(int code, int down) {
  auto& w = runtime().workbench;
  w.face.button(ui::button_of(code), down, w.board, w.now_state(), w.actions);
  runtime().actions();
}
EXPORT(pad) void pad(int index, int velocity) {
  auto& w = runtime().workbench;
  ui::pad_event(w.face, w.project_doc, w.board, w.now_state(), index, velocity, w.actions);
  runtime().actions();
}
EXPORT(text_editing) int text_editing() { return runtime().workbench.face.rename_kind; }
EXPORT(text_input) void text_input(int bytes, int key) {
  auto& r = runtime(); auto& w = r.workbench;
  if (bytes < 0 || bytes > 4096 || static_cast<std::size_t>(bytes) > r.input.size() || key < 0 || key > 4) return;
  ui::text_event(w.face, w.project_doc, w.board, w.now_state(),
                 std::string(reinterpret_cast<const char*>(r.input.data()), bytes), key, w.actions);
  r.actions();
}
EXPORT(wheel) void wheel(int clicks) {
  auto& w = runtime().workbench;
  w.face.wheel(clicks, w.board);
}
EXPORT(knob) void knob(int index, int clicks) {
  if (index < 0 || index >= 4) return;
  auto& r = runtime();
  auto& w = r.workbench;
  w.face.knob_touch(index, true, w.board, w.actions);
  w.face.knob(index, clicks, w.board, w.actions);
  w.face.knob_touch(index, false, w.board, w.actions);
  r.actions();
}

EXPORT(render) const std::uint32_t* render() {
  auto& r = runtime();
  auto& w = r.workbench;
  w.tick();
  if (r.auto_save_attempt != w.project_changed && w.project_dirty && !r.save_pending && !w.player.playing() &&
      live::Workbench::Clock::now() - w.project_changed >= std::chrono::seconds(2)) {
    r.auto_save_attempt = w.project_changed;
    r.save("");
  }
  if (!r.save_pending && w.project_dirty && w.face.save_status == "Saved") w.face.save_status = "Unsaved changes";
  return w.draw(r.canvas) ? r.pixels.data() : nullptr;
}

EXPORT(audio_block) const float* audio_block(int frames) {
  if (frames < 1 || frames > kBlock) return nullptr;
  auto& r = runtime();
  auto& w = r.workbench;
  // ProjectSound adds into its destination, as it does in the native audio
  // callback. Reusing uncleared output feeds old samples into every new block
  // and keeps the last block audible even after the voices have been silenced.
  for (auto& channel : r.audio) std::fill_n(channel, frames, 0.0f);
  if (w.player.playing()) {
    xmp::Str error;
    if (!w.player.fill(r.frame + 4800, error)) w.player.stop(r.frame);
  }
  float incoming[kBlock]{}; unsigned char valid[kBlock]{};
  if (r.microphone) {
    if (!r.input_ready && r.input_ring.available() >= 2048) r.input_ready = true;
    const bool overflow = r.input_ring.overflowed();
    for(int i=0;i<frames;++i) {
      if(r.input_ready && r.input_ring.pop(incoming[i]) && !overflow) valid[i]=1;
      else r.input_ready=false;
    }
  } else if(r.capturing) {
    for(int i=0;i<frames && r.capture_pos<r.capture_wave.size();++i) {
      incoming[i]=r.capture_wave[r.capture_pos++];valid[i]=1;
    }
  }
  r.sound.process(r.audio[0], r.audio[1], frames, r.frame, &r.loop, incoming, valid);
  r.frame += frames;
  if(r.microphone && w.monitor_input()) for(int i=0;i<frames;++i) if(valid[i]) {
    r.audio[0][i] += incoming[i]*.25f;r.audio[1][i] += incoming[i]*.25f;
  }
  if(w.recorder.state != live::sample::Recorder::State::idle) {
    for(int i=0;i<frames;++i) if(valid[i]) w.recorder.feed(incoming+i,1);
    if(!r.microphone && r.capturing && r.capture_pos==r.capture_wave.size()) {
      r.capturing=false;w.finish_sampling("WAV input");
    }
  }
  for (int i = 0; i < frames && r.preview_pos < r.preview.size(); ++i, ++r.preview_pos) {
    const float value = r.preview[r.preview_pos] * 0.25f;
    for (auto& channel : r.audio) channel[i] = std::clamp(channel[i] + value, -1.0f, 1.0f);
  }
  return r.audio[0];
}

EXPORT(capture_file) int capture_file(int bytes) {
  auto& r = runtime();
  if (r.capturing || bytes <= 0 || bytes > 16 * 1024 * 1024 || static_cast<std::size_t>(bytes) != r.input.size())
    return 0;
  auto decoded = live::decode_wav(r.input, 48000);
  if (!decoded.error.empty() || decoded.samples.empty()) return 0;
  r.microphone = false;
  r.workbench.input_failed = false;
  r.capture_wave = std::move(decoded.samples);
  return 1;
}

EXPORT(catalog_clear) void catalog_clear() { runtime().files.clear(); }
EXPORT(catalog_entry) void catalog_entry(int id, int kind, int bytes, int length, int factory) {
  auto& r = runtime();
  if (id < 0 || kind < 1 || kind > 3 || bytes <= 0 || bytes > kMaxFile ||
      length <= 0 || length > 200 || static_cast<std::size_t>(length) > r.input.size() || r.files.size() >= 256) return;
  r.files.push_back({std::to_string(id), std::string(reinterpret_cast<const char*>(r.input.data()), length),
                     kind, static_cast<std::size_t>(bytes), factory != 0});
}
EXPORT(catalog_refresh) void catalog_refresh() { runtime().workbench.refresh_files(); }

EXPORT(save_size) int save_size() { return runtime().save_pending ? runtime().save_data.size() : 0; }
EXPORT(save_bytes) const char* save_bytes() { return runtime().save_data.data(); }
EXPORT(save_filename) const char* save_filename() { return runtime().save_name.c_str(); }
EXPORT(save_complete) void save_complete(int ok) {
  auto& r = runtime();
  auto& w = r.workbench;
  if (ok == 1 && r.save_name.empty() && r.saved_at == w.project_changed) w.project_dirty = false;
  w.face.save_status = ok != 1 ? "Save failed" : w.project_dirty ? "Unsaved changes" : "Saved";
  if (ok != 1) w.face.say(ok == -1 ? "A project file with this name already exists" : "Could not save");
  else w.face.say(r.save_name.empty() ? "Project saved" : "Saved " + r.save_name + ".xmpsong");
  r.save_pending = false;
  r.save_data = {};
}
EXPORT(view) const char* view() {
  const auto& face = runtime().workbench.face;
  return face.menu ? "MENU" : ui::view_name(face.view);
}
// Browser adapter metadata only: no names, notes, values or audio are exposed.
EXPORT(usage_count) int usage_count() { return runtime().usage.size(); }
EXPORT(usage_counts) const uint32_t* usage_counts() { return runtime().usage.data(); }
EXPORT(usage_recording) int usage_recording() {
  const auto& r = runtime();
  const auto& w = r.workbench;
  return r.loop.state() == live::sample::LoopTake::State::capturing ||
    w.recorder.state == live::sample::Recorder::State::recording ||
    w.face.rec == ui::Ui::Rec::recording || w.face.rec == ui::Ui::Rec::overdub;
}
EXPORT(usage_machine) int usage_machine() {
  const auto& w = runtime().workbench;
  return w.face.track < w.board.tracks && !w.board.unchosen[w.face.track]
    ? static_cast<int>(w.board.kind[w.face.track]) : 5;
}
EXPORT(menu_pending) int menu_pending() {
  const auto& face = runtime().workbench.face;
  return face.menu || face.task_pads_active();
}
EXPORT(menu_hold_ready) int menu_hold_ready() {
  return runtime().workbench.face.menu_hold_ready(live::Workbench::Clock::now());
}
EXPORT(project_name) const char* project_name() { return runtime().workbench.board.name.c_str(); }
EXPORT(pad_name) const char* pad_name(int index) {
  const auto& w = runtime().workbench;
  if (index < 0 || index >= 16 || w.face.track >= w.board.tracks) return "";
  return w.board.pad_name[w.face.track][index].c_str();
}
EXPORT(message) const char* message() { return runtime().workbench.face.toast.c_str(); }
EXPORT(qlink_page) int qlink_page() { return runtime().workbench.face.qlink_led_page(); }
EXPORT(panel_lights) const live::PanelLights* panel_lights() {
  static live::PanelLights lights;
  auto& w=runtime().workbench;
  lights=w.face.panel_lights(w.board,w.now_state());
  return &lights;
}

EXPORT(input_enable) void input_enable(int enabled) {
  auto& r=runtime();r.microphone=enabled != 0;r.workbench.input_failed=!enabled;
  if(!enabled) {r.loop.cancel();r.capturing=false;}
}
EXPORT(input_push) int input_push(int frames) {
  auto& r=runtime();if(frames<1 || frames>4096 || r.input.size()<static_cast<size_t>(frames)*4) return 0;
  const auto* pcm=reinterpret_cast<const float*>(r.input.data());
  for(int i=0;i<frames;++i) if(!r.input_ring.push(std::isfinite(pcm[i])?std::clamp(pcm[i],-1.0f,1.0f):0.0f)) return 0;
  return 1;
}
EXPORT(input_track) int input_track() {
  auto& w=runtime().workbench;
  return w.face.view==ui::View::sample || (w.face.track<w.board.tracks && w.board.input_track[w.face.track]);
}
EXPORT(input_monitor) int input_monitor() {return runtime().workbench.monitor_input();}
EXPORT(recording) int recording() {return runtime().workbench.face.sampling;}
