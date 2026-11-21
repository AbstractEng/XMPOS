// Replays the same surface interactions as the browser acceptance runner.
#include "xmp/live_workbench.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>

namespace {
namespace fs = std::filesystem;
namespace live = xmp::live;
namespace ui = live::ui;
using xmp::json::Value;
using xmp::project::detail::str;

std::string read(const fs::path& path) {
  std::ifstream f(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), {}};
}

void write(const fs::path& path, const char* data, std::size_t size) {
  std::ofstream f(path, std::ios::binary);
  f.write(data, static_cast<std::streamsize>(size));
  if (!f) throw std::runtime_error("Could not write test artifact");
}

struct Temp {
  fs::path path;
  Temp() {
    auto name = (fs::temp_directory_path() / "xmp-project-parity.XXXXXX").string();
    if (!mkdtemp(name.data())) throw std::runtime_error("Could not create isolated test stick");
    path = name;
  }
  ~Temp() { fs::remove_all(path); }
};

int run(const fs::path& fixture, const fs::path& output) {
  const auto steps = xmp::json::parse(xmp::Str(read(fixture).c_str()));
  auto opened = live::blank_project();
  if (!steps.ok || !opened.ok) {
    std::cerr << opened.error.c_str() << '\n';
    return 1;
  }
  auto project = xmp::move(opened.project);
  project.set("name", Value::of("Parity original"));
  xmp::Str error, initial;
  if (!xmp::portable::save_song(project, initial, error)) return 1;
  Temp stick;
  if (!output.empty()) {
    fs::create_directories(output);
    write(output / "initial.xmpsong", initial.data(), initial.size());
  }
  live::ProjectSound audio;
  if (!audio.prepare(project, error)) return 1;
  std::uint64_t frame = 0;
  live::Workbench device(project, audio, true, {
      [&] { return frame; },
      [](const auto&) { return true; },
      [] { return false; }, [] { return false; }, [] {},
      [&] { return live::library::scan((stick.path / "Projects").string()); },
      [&](const auto& entry, auto& bytes) { return live::library::read((stick.path / "Projects").string(), entry, bytes); },
      [](const char*) {},
      [&](const auto& name) -> std::string {
        xmp::Str song, why;
        if (!xmp::portable::save_song(project, song, why)) return why.c_str();
        if (name.empty()) write(stick.path / "project.xmpsong", song.data(), song.size());
        else if (!live::library::save_copy(stick.path.string(), name, song.data(), song.size()))
          return "Could not save named project";
        return {};
      },
  });
  std::vector<std::uint32_t> pixels(1280 * 800);
  live::Canvas canvas;
  canvas.memory = reinterpret_cast<unsigned char*>(pixels.data());
  canvas.size = sizeof(std::uint32_t) * pixels.size();
  canvas.xres = canvas.width = 1280;
  canvas.yres = canvas.height = 800;
  canvas.line_length = 1280 * sizeof(std::uint32_t);
  device.face.save_status = "Saved";
  device.painter.lights = {1, 1, 1, 0, 0};
  float left[512]{}, right[512]{};
  int index = 0;
  bool menu = false;
  for (const auto& step : steps.value.items()) {
    const auto& args = step.items();
    const auto kind = args[0].as_string();
    if (kind == "menu") {
      menu = true;
      device.face.button(ui::Button::menu, true, device.board, device.now_state(), device.actions);
      device.run_actions("native panel");
    } else if (kind == "hold-menu") {
      auto now = device.now_state();
      device.face.button(ui::Button::menu, true, device.board, now, device.actions);
      now.input_time += std::chrono::milliseconds(static_cast<int>(args[1].as_number()));
      device.face.button(ui::Button::menu, false, device.board, now, device.actions);
      device.run_actions("native panel");
    } else if (kind == "touch") {
      const int x = args[1].as_number(), y = args[2].as_number();
      device.touch(ui::TouchPhase::down, x, y);
      device.touch(ui::TouchPhase::up, x, y);
    } else if (kind == "pad") {
      const int pad = static_cast<int>(args[1].as_number()) - 1;
      ui::pad_event(device.face, project, device.board, device.now_state(), pad, 100, device.actions);
      device.run_actions("native panel");
      ui::pad_event(device.face, project, device.board, device.now_state(), pad, 0, device.actions);
      device.run_actions("native panel");
    } else if (kind == "text") {
      ui::text_event(device.face, project, device.board, device.now_state(), args[1].as_string().c_str(), args[2].as_number(), device.actions);
      device.run_actions("native keyboard");
    } else if (kind == "key") {
      const auto key = ui::button_of(args[1].as_number());
      device.face.button(key, true, device.board, device.now_state(), device.actions);
      device.face.button(key, false, device.board, device.now_state(), device.actions);
      device.run_actions("native panel");
    } else if (kind == "knob") {
      device.face.knob(args[1].as_number(), args[2].as_number(), device.board, device.actions);
      device.run_actions("native knob");
    } else if (kind == "delete") {
      for (const auto button : {ui::Button::shift, ui::Button::copy})
        device.face.button(button, true, device.board, device.now_state(), device.actions);
      device.run_actions("native delete gesture");
      for (const auto button : {ui::Button::copy, ui::Button::shift})
        device.face.button(button, false, device.board, device.now_state(), device.actions);
    } else if (kind == "playing-empty") {
      if (!device.player.playing() || !device.now_state().clip[0].empty()) return 1;
    } else if (kind == "saved-empty") {
      const auto saved = read(stick.path / "project.xmpsong");
      const auto loaded = xmp::portable::open(saved.data(), saved.size());
      if (!loaded.ok || live::edit::focused_clip(loaded.project, {0, 0}).ok()) return 1;
    } else if (kind == "undo") {
      device.face.button(ui::Button::undo, true, device.board, device.now_state(), device.actions);
      device.run_actions("native panel");
    } else if (kind == "verify") {
      const auto actual = device.face.menu ? "MENU" : ui::view_name(device.face.view);
      if (args[1].as_string() != actual || device.board.name != args[2].as_string().c_str()) {
        std::cerr << "Step " << index << ": " << actual << ", " << device.board.name << '\n';
        return 1;
      }
    } else if (kind == "saved") {
      const std::string name = args[1].as_string().c_str();
      const auto path = name == "project.xmpsong" ? stick.path / name : stick.path / "Projects" / name;
      const auto saved = read(path);
      const auto loaded = xmp::portable::open(saved.data(), saved.size());
      if (!loaded.ok || str(loaded.project, "name") != args[2].as_string()) {
        std::cerr << "Step " << index << ": could not verify " << name << '\n';
        return 1;
      }
      if (!output.empty()) write(output / name, saved.data(), saved.size());
    } else if (kind == "saved-clip") {
      const auto saved = read(stick.path / "project.xmpsong");
      const auto loaded = xmp::portable::open(saved.data(), saved.size());
      if (!loaded.ok) return 1;
      namespace E = live::edit;
      const auto place = E::focused_clip(loaded.project, E::Focus{0, 0});
      if (!place.ok()) return 1;
      const auto& clip = E::clip_at(loaded.project, place);
      if (xmp::project::detail::num(clip, "length") != args[1].as_number() ||
          xmp::project::detail::list(clip, "steps").size() != args[2].as_number()) {
        std::cerr << "Step " << index << ": saved clip has the wrong length or note count\n";
        return 1;
      }
    } else if (kind == "image" && !output.empty()) {
      const auto lights=device.face.panel_lights(device.board,device.now_state());
      write(output / (std::string(args[1].as_string().c_str()) + ".leds"),reinterpret_cast<const char*>(&lights),sizeof lights);
      device.draw(canvas);
      std::string ppm = "P6\n1280 800\n255\n";
      ppm.reserve(ppm.size() + 1280 * 800 * 3);
      for (std::uint32_t pixel : pixels) {
        ppm.push_back(static_cast<char>(pixel >> 16));
        ppm.push_back(static_cast<char>(pixel >> 8));
        ppm.push_back(static_cast<char>(pixel));
      }
      write(output / (std::string(args[1].as_string().c_str()) + ".ppm"), ppm.data(), ppm.size());
    }
    if (menu && !device.face.menu) {
      menu = false;
      device.face.button(ui::Button::menu, false, device.board, device.now_state(), device.actions);
    }
    audio.process(left, right, 512, frame);
    frame += 512;
    ++index;
  }
  const auto first = read(stick.path / "Projects/TEST.xmpsong");
  if (!first.empty() && (live::library::save_copy(stick.path.string(), "TEST", "malformed", 9) ||
      read(stick.path / "Projects/TEST.xmpsong") != first)) return 1;
  std::cout << "Native touchscreen passed " << index << " shared project steps\n";
  return 0;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2 || argc > 3) return 2;
  try {
    return run(argv[1], argc == 3 ? argv[2] : "");
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
