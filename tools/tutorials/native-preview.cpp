// Host-only tutorial fixture. No device, audio, storage or controller APIs.
// Uses the production native painter with an explicitly synthetic take.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <vector>
#include "xmp/live_ui.hpp"
#include "xmp/portable.hpp"
int main(int argc, char** argv) {
  if (argc != 4) return 2;
  std::ifstream input(argv[1]);
  std::stringstream text; text << input.rdbuf();
  const std::string bytes = text.str();
  auto project = xmp::portable::open(bytes.data(), bytes.size());
  if (!project.ok) return 1;
  namespace ui = xmp::live::ui;
  ui::Board board = ui::board_of(project.project);
  ui::Ui face; face.view = ui::View::sample;
  ui::SampleScreen take;
  const int stage = std::atoi(argv[3]);
  if (stage == 1) take.state = ui::SampleScreen::armed;
  if (stage >= 2) {
    take.state = ui::SampleScreen::ready;
    take.frames = face.sample_frames = 24000;
    take.revision = stage;
    face.sample.end = 24000;
    for (int i = 0; i < 600; ++i) {
      const float at = i / 600.0f;
      take.peaks.push_back(at < 0.08f ? 0.0f : std::exp(-(at - 0.08f) * 5) * (0.45f + 0.4f * std::abs(std::sin(i * 0.71f))));
    }
    face.sample.start = 1920;
    face.sample.end = 21000;
    if (stage >= 3) face.sample.tune = -2, face.sample.level = 0.75f;
  }
  if (stage == 5) face.say("Wheel keeps the edited take on the stick");
  ui::fill_strip(face, project.project, board);
  xmp::live::Canvas canvas;
  std::vector<unsigned char> pixels(1280 * 800 * 4);
  canvas.memory = pixels.data(); canvas.size = pixels.size();
  canvas.xres = canvas.width = 1280; canvas.yres = canvas.height = 800;
  canvas.line_length = 1280 * 4;
  ui::Painter painter;
  painter.draw(canvas, face, board, ui::Now{}, 0, nullptr, nullptr, &take);
  std::FILE* out = std::fopen(argv[2], "wb");
  if (!out) return 1;
  std::fprintf(out, "P6 1280 800 255\n");
  for (std::size_t i = 0; i < pixels.size(); i += 4) {
    const unsigned char rgb[] = {pixels[i + 2], pixels[i + 1], pixels[i]};
    std::fwrite(rgb, 1, 3, out);
  }
  std::fclose(out);
}
