// Draws XMP's Live interface (xmp/live_ui.hpp) for a project on the Mac, as the
// Live's screen would show it, to a PPM image (1280 x 800):
//   live_ui_preview PROJECT_FILE OUT.ppm [clips|play|steps|menu] [playing-scene]
// PROJECT_FILE is anything the Live opens: .xmpsong, .xmp.json or a bundle.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

#include "xmp/live_ui.hpp"
#include "xmp/portable.hpp"

int main(int argc, char** argv) {
  if (argc < 3) return std::fprintf(stderr, "usage: live_ui_preview PROJECT OUT.ppm [clips|play|menu] [scene]\n"), 2;
  std::ifstream in(argv[1], std::ios::binary);
  std::stringstream text;
  text << in.rdbuf();
  const std::string s = text.str();
  auto opened = xmp::portable::open(s.data(), s.size());
  if (!opened.ok) return std::fprintf(stderr, "cannot open: %s\n", opened.error.c_str()), 1;
  namespace ui = xmp::live::ui;
  const ui::Board board = ui::board_of(opened.project);
  ui::Ui face;
  ui::Now now;
  const std::string mode = argc > 3 ? argv[3] : "clips";
  if (mode == "play") face.view = ui::View::play, face.track = board.tracks > 1 ? 1 : 0;
  if (mode == "menu") face.menu = true;
  if (mode == "steps") face.view = ui::View::steps, face.selected_step = 0;
  if (mode == "roll") face.view = ui::View::steps, face.track = 1, face.selected_step = 0, face.step_note = 41, face.fit_roll();
  if (mode == "mix") face.view = ui::View::mix, face.track = 1;
  if (mode == "sound") {  // the first synth track's Sound page
    for (int t = board.tracks - 1; t >= 0; --t)
      if (board.kind[t] == ui::Kind::synth) face.track = t;
    face.open(ui::View::sound);
  }
  if (mode == "soundcontrols") {  // the first synth track's Sound page, on Controls
    for (int t = board.tracks - 1; t >= 0; --t)
      if (board.kind[t] == ui::Kind::synth) face.track = t;
    face.open(ui::View::sound), face.sound_controls = true;
  }
  if (mode == "kitsound") face.track = 0, face.open(ui::View::sound);
  if (mode == "menu" && board.tracks > 1) face.track = 1;
  if (mode == "song") {  // the third block selected; with a scene, the song playing its fourth block
    face.view = ui::View::song, face.block = 2;
    if (argc > 4 && board.chain.size() > 3) now.song = true, now.block = board.chain[3].id;
  }
  if (argc > 4) {  // that scene playing, a third of the way into its clips
    const int scene = std::atoi(argv[4]);
    now.playing = true, now.step = 21;
    for (int t = 0; t < board.tracks; ++t) now.clip[t] = board.clip[t][scene];
    face.select_scene(scene, board);
    if (board.tracks > 2) now.queued[2] = true, now.queued_clip[2] = board.clip[2][scene + 1 < board.scenes ? scene + 1 : 0];
  }
  ui::fill_strip(face, opened.project, board);
  xmp::live::Canvas c;
  std::vector<unsigned char> memory(1280 * 800 * 4);
  c.memory = memory.data(), c.size = memory.size(), c.xres = 1280, c.yres = 800, c.line_length = 1280 * 4;
  c.width = 1280, c.height = 800;
  ui::Painter painter;
  painter.lights = {1, 1, 1, 1, 3};
  xmp::live::edit::Row row;
  if (face.view == ui::View::steps && face.clip_length(board) > 0)
    row = xmp::live::edit::row(opened.project,
                               xmp::live::edit::find(opened.project, xmp::Str(board.track_id[face.track].c_str()),
                                                     xmp::Str(board.clip[face.track][face.cursor].c_str())),
                               face.step_pad, face.step_note);
  xmp::live::edit::Roll roll;
  if (face.view == ui::View::steps && face.clip_length(board) > 0)
    roll = xmp::live::edit::roll(opened.project,
                                 xmp::live::edit::find(opened.project, xmp::Str(board.track_id[face.track].c_str()),
                                                       xmp::Str(board.clip[face.track][face.cursor].c_str())));
  painter.draw(c, face, board, now, 0, &row, &roll);
  std::FILE* out = std::fopen(argv[2], "wb");
  if (!out) return 1;
  std::fprintf(out, "P6 1280 800 255\n");
  for (size_t i = 0; i < memory.size(); i += 4) {
    const unsigned char px[3] = {memory[i + 2], memory[i + 1], memory[i]};
    std::fwrite(px, 1, 3, out);
  }
  std::fclose(out);
  return 0;
}
