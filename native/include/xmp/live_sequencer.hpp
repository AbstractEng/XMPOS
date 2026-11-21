#pragma once
// Phase 2 of the XMP session on the MPC Live Mk1: a 16-step, 16-pad pattern
// sequencer with a touchscreen interface. Pure logic only (timing, pattern
// text, screen layout, touch hit-testing, a small bitmap font), so all of it is
// tested on the Mac. The session turns due steps into engine note commands
// timestamped with exact sample frames, scheduled ahead of the audio thread.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "xmp/live_session.hpp"

namespace xmp::live {

constexpr int kSteps = 16;
constexpr int kMinBpm = 60, kMaxBpm = 200;

// velocity[pad][step], 0 = no note.
struct Pattern {
  std::array<std::array<std::uint8_t, kSteps>, 16> velocity{};
  int bpm = 120;
  bool empty() const {
    for (const auto& pad : velocity)
      for (auto v : pad)
        if (v) return false;
    return true;
  }
};

// ---- pattern file: xmp/pattern.txt on the stick, bounded text ----
inline std::string pattern_text(const Pattern& p) {
  std::string out = "# XMP pattern: bpm, then one line per pad, 16 step velocities in hex (00 = off)\n";
  out += "bpm=" + std::to_string(p.bpm) + "\n";
  char cell[4];
  for (int pad = 0; pad < 16; ++pad) {
    out += "pad" + std::to_string(pad + 1) + "=";
    for (int s = 0; s < kSteps; ++s) {
      std::snprintf(cell, sizeof cell, "%02X", p.velocity[static_cast<std::size_t>(pad)][static_cast<std::size_t>(s)]);
      out += cell;
      if (s + 1 < kSteps) out += ' ';
    }
    out += '\n';
  }
  return out;
}

// Parses pattern text; anything malformed leaves that line's values unchanged.
inline Pattern parse_pattern(const std::string& text, std::vector<std::string>* errors = nullptr) {
  Pattern p;
  auto fail = [&](const std::string& what) {
    if (errors) errors->push_back(what);
  };
  if (text.size() > 8192) {
    fail("pattern.txt is larger than 8 KiB");
    return p;
  }
  std::size_t start = 0;
  int lines = 0;
  while (start < text.size() && lines < 64) {
    const auto end = std::min(text.find('\n', start), text.size());
    std::string line = text.substr(start, end - start);
    start = end + 1;
    ++lines;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    const auto eq = line.find('=');
    if (eq == std::string::npos) {
      fail("line without '='");
      continue;
    }
    const auto key = line.substr(0, eq), value = line.substr(eq + 1);
    if (key == "bpm") {
      if (value.size() >= 2 && value.size() <= 3 && value.find_first_not_of("0123456789") == std::string::npos) {
        const int bpm = std::stoi(value);
        if (bpm >= kMinBpm && bpm <= kMaxBpm) p.bpm = bpm;
        else fail("bpm out of range");
      } else {
        fail("bpm needs a number");
      }
    } else if (key.rfind("pad", 0) == 0 && key.size() <= 5 && key.size() > 3 &&
               key.find_first_not_of("0123456789", 3) == std::string::npos) {
      const int pad = std::stoi(key.substr(3));
      if (pad < 1 || pad > 16 || value.size() != kSteps * 3 - 1) {
        fail("bad pad line " + key);
        continue;
      }
      std::array<std::uint8_t, kSteps> row{};
      bool ok = true;
      for (int s = 0; s < kSteps && ok; ++s) {
        const auto cell = value.substr(static_cast<std::size_t>(s) * 3, 2);
        ok = cell.find_first_not_of("0123456789abcdefABCDEF") == std::string::npos &&
             (s + 1 == kSteps || value[static_cast<std::size_t>(s) * 3 + 2] == ' ');
        if (ok) {
          const auto v = std::stoul(cell, nullptr, 16);
          ok = v <= 127;
          row[static_cast<std::size_t>(s)] = static_cast<std::uint8_t>(v);
        }
      }
      if (ok) p.velocity[static_cast<std::size_t>(pad - 1)] = row;
      else fail("bad step values in " + key);
    } else {
      fail("unknown key " + key);
    }
  }
  return p;
}

// ---- timing: steps are sixteenth notes placed on exact sample frames ----
struct DueNote {
  std::uint64_t frame;
  int pad, step;
  std::uint8_t velocity;
};

class Sequencer {
 public:
  explicit Sequencer(std::uint32_t rate) : rate_(rate) {}

  double step_frames(int bpm) const { return rate_ * 60.0 / bpm / 4.0; }
  bool playing() const { return playing_; }

  // Starts at the given engine frame (already including the scheduling lead).
  void start(std::uint64_t frame, int bpm) {
    playing_ = true;
    origin_ = static_cast<double>(frame);
    origin_step_ = 0;
    next_ = 0;
    bpm_ = bpm;
  }
  void stop() { playing_ = false; }

  // Tempo changes take effect from the next unscheduled step, with no jump.
  void set_bpm(int bpm) {
    bpm = std::clamp(bpm, kMinBpm, kMaxBpm);
    if (!playing_) {
      bpm_ = bpm;
      return;
    }
    origin_ = frame_of(next_);
    origin_step_ = next_;
    bpm_ = bpm;
  }
  int bpm() const { return bpm_; }

  // Notes whose frame falls before `horizon`, in order; advances the cursor.
  template <class Out>
  void due(const Pattern& pattern, std::uint64_t horizon, Out&& out) {
    while (playing_) {
      const double f = frame_of(next_);
      if (f >= static_cast<double>(horizon)) break;
      const int step = static_cast<int>(next_ % kSteps);
      for (int pad = 0; pad < 16; ++pad) {
        const auto v = pattern.velocity[static_cast<std::size_t>(pad)][static_cast<std::size_t>(step)];
        if (v) out(DueNote{static_cast<std::uint64_t>(std::llround(f)), pad, step, v});
      }
      ++next_;
    }
  }

  // Every step due before `horizon`, in order, as (frame, step); advances the
  // cursor. Tracks are expanded by the caller.
  template <class Out>
  void due_steps(std::uint64_t horizon, Out&& out) {
    while (playing_) {
      const double f = frame_of(next_);
      if (f >= static_cast<double>(horizon)) break;
      out(static_cast<std::uint64_t>(std::llround(f)), static_cast<int>(next_ % kSteps));
      ++next_;
    }
  }

  // Step sounding at an engine frame (for the screen), or -1 when stopped.
  int step_at(std::uint64_t frame) const {
    if (!playing_ || static_cast<double>(frame) < origin_) return -1;
    const double steps = (static_cast<double>(frame) - origin_) / step_frames(bpm_);
    return static_cast<int>((origin_step_ + static_cast<std::uint64_t>(steps)) % kSteps);
  }

  // The next step that due() has not scheduled yet.
  int next_step() const { return static_cast<int>(next_ % kSteps); }

  // Live recording: the step nearest to a hit heard at `frame`.
  int nearest_step(std::uint64_t frame) const {
    if (!playing_ || static_cast<double>(frame) < origin_) return 0;
    const double steps = (static_cast<double>(frame) - origin_) / step_frames(bpm_);
    return static_cast<int>((origin_step_ + static_cast<std::uint64_t>(std::llround(steps))) % kSteps);
  }

 private:
  double frame_of(std::uint64_t index) const {
    return origin_ + static_cast<double>(index - origin_step_) * step_frames(bpm_);
  }
  std::uint32_t rate_;
  bool playing_ = false;
  double origin_ = 0;
  std::uint64_t origin_step_ = 0, next_ = 0;
  int bpm_ = 120;
};

// ---- screen layout: top bar of touch buttons, pads left, steps right ----
enum class Control : std::uint8_t { none, play, record, clear, bpm_down, bpm_up, step, pad, track };

struct Hit {
  Control control = Control::none;
  int index = -1;  // step, pad or track number for Control::step / pad / track
};

inline int bar_height(int height) { return height / 7; }

inline Rect control_rect(Control c, int width, int height) {
  const int bar = bar_height(height), gap = std::max(4, bar / 8), h = bar - 2 * gap;
  const int unit = std::max(20, width / 9);
  switch (c) {
    case Control::play: return {width - unit * 6, gap, unit * 3 / 2 - gap, h};
    case Control::record: return {width - unit * 9 / 2, gap, unit - gap, h};
    case Control::clear: return {width - unit * 7 / 2, gap, unit - gap, h};
    case Control::bpm_down: return {width - unit * 5 / 2, gap, unit / 2 - gap, h};
    case Control::bpm_up: return {width - unit / 2 - gap, gap, unit / 2, h};
    default: return {};
  }
}
// BPM readout between the - and + buttons.
inline Rect bpm_rect(int width, int height) {
  const auto down = control_rect(Control::bpm_down, width, height), up = control_rect(Control::bpm_up, width, height);
  return {down.x + down.w + 4, down.y, up.x - (down.x + down.w) - 8, down.h};
}

// 4x4 grid inside a region, cell 0 bottom left (pads) or top left (steps).
inline Rect grid_cell(int index, Rect region, bool bottom_up) {
  const int side = std::min(region.w, region.h);
  const int cell = side / 4, gap = std::max(2, cell / 14);
  const int left = region.x + (region.w - cell * 4) / 2, top = region.y + (region.h - cell * 4) / 2;
  const int col = index % 4, row = bottom_up ? 3 - index / 4 : index / 4;
  return {left + col * cell + gap, top + row * cell + gap, cell - 2 * gap, cell - 2 * gap};
}
// Eight track buttons in a strip under the top bar.
inline int strip_height(int height) { return height / 11; }
inline Rect track_rect(int track, int width, int height) {
  const int top = bar_height(height), h = strip_height(height), cell = width / 8, gap = std::max(3, cell / 30);
  return {track * cell + gap, top + gap, cell - 2 * gap, h - 2 * gap};
}
inline Rect pads_region(int width, int height) {
  const int top = bar_height(height) + strip_height(height);
  return {0, top, width / 2, height - top};
}
inline Rect steps_region(int width, int height) {
  const int top = bar_height(height) + strip_height(height);
  return {width / 2, top, width - width / 2, height - top};
}
inline Rect sequencer_pad_rect(int pad, int width, int height) {
  return grid_cell(pad, pads_region(width, height), true);
}
inline Rect step_rect(int step, int width, int height) {
  return grid_cell(step, steps_region(width, height), false);
}

inline bool inside(const Rect& r, int x, int y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }

inline Hit hit_test(int x, int y, int width, int height) {
  for (auto c : {Control::play, Control::record, Control::clear, Control::bpm_down, Control::bpm_up})
    if (inside(control_rect(c, width, height), x, y)) return {c, -1};
  for (int i = 0; i < 8; ++i)
    if (inside(track_rect(i, width, height), x, y)) return {Control::track, i};
  for (int i = 0; i < 16; ++i) {
    if (inside(step_rect(i, width, height), x, y)) return {Control::step, i};
    if (inside(sequencer_pad_rect(i, width, height), x, y)) return {Control::pad, i};
  }
  return {};
}

// Inverse of to_framebuffer: a framebuffer pixel back to the logical canvas.
inline void from_framebuffer(int rotation, int xres, int yres, int fx, int fy, int& x, int& y) {
  switch (rotation) {
    case 90: x = fy; y = xres - 1 - fx; break;
    case 180: x = xres - 1 - fx; y = yres - 1 - fy; break;
    case 270: x = yres - 1 - fy; y = fx; break;
    default: x = fx; y = fy; break;
  }
}

// Raw touch coordinates (device range) to framebuffer pixels.
inline int scale_axis(int value, int minimum, int maximum, int pixels) {
  if (maximum <= minimum || pixels <= 0) return 0;
  const long long v = std::clamp(value, minimum, maximum) - minimum;
  return static_cast<int>(std::min<long long>(pixels - 1, v * pixels / (static_cast<long long>(maximum) - minimum + 1)));
}

// ---- 5x7 bitmap font: A-Z, digits and a few signs (lower case draws as upper) ----
// Each glyph is 7 rows of 5 bits (bit 4 = leftmost column).
inline const std::array<std::uint8_t, 7>* glyph(char c) {
  struct G {
    char c;
    std::array<std::uint8_t, 7> rows;
  };
  static const G font[] = {
      {'0', {14, 17, 19, 21, 25, 17, 14}}, {'1', {4, 12, 4, 4, 4, 4, 14}},    {'2', {14, 17, 1, 2, 4, 8, 31}},
      {'3', {30, 1, 1, 14, 1, 1, 30}},     {'4', {2, 6, 10, 18, 31, 2, 2}},   {'5', {31, 16, 30, 1, 1, 17, 14}},
      {'6', {6, 8, 16, 30, 17, 17, 14}},   {'7', {31, 1, 2, 4, 8, 8, 8}},     {'8', {14, 17, 17, 14, 17, 17, 14}},
      {'9', {14, 17, 17, 15, 1, 2, 12}},   {'A', {14, 17, 17, 31, 17, 17, 17}}, {'B', {30, 17, 17, 30, 17, 17, 30}},
      {'C', {14, 17, 16, 16, 16, 17, 14}}, {'D', {28, 18, 17, 17, 17, 18, 28}}, {'E', {31, 16, 16, 30, 16, 16, 31}},
      {'I', {14, 4, 4, 4, 4, 4, 14}},      {'K', {17, 18, 20, 24, 20, 18, 17}}, {'L', {16, 16, 16, 16, 16, 16, 31}},
      {'M', {17, 27, 21, 21, 17, 17, 17}}, {'O', {14, 17, 17, 17, 17, 17, 14}}, {'P', {30, 17, 17, 30, 16, 16, 16}},
      {'R', {30, 17, 17, 30, 20, 18, 17}}, {'S', {15, 16, 16, 14, 1, 1, 30}},  {'T', {31, 4, 4, 4, 4, 4, 4}},
      {'Y', {17, 17, 10, 4, 4, 4, 4}},     {'-', {0, 0, 0, 31, 0, 0, 0}},     {'+', {0, 4, 4, 31, 4, 4, 0}},
      {' ', {0, 0, 0, 0, 0, 0, 0}},        {'F', {31, 16, 16, 30, 16, 16, 16}}, {'G', {14, 17, 16, 23, 17, 17, 15}},
      {'H', {17, 17, 17, 31, 17, 17, 17}}, {'J', {7, 2, 2, 2, 2, 18, 12}},    {'N', {17, 17, 25, 21, 19, 17, 17}},
      {'Q', {14, 17, 17, 17, 21, 18, 13}}, {'U', {17, 17, 17, 17, 17, 17, 14}}, {'V', {17, 17, 17, 17, 17, 10, 4}},
      {'W', {17, 17, 17, 21, 21, 21, 10}}, {'X', {17, 17, 10, 4, 10, 17, 17}}, {'Z', {31, 1, 2, 4, 8, 16, 31}},
      {'#', {10, 10, 31, 10, 31, 10, 10}}, {':', {0, 12, 12, 0, 12, 12, 0}}, {'.', {0, 0, 0, 0, 0, 12, 12}},    {'/', {1, 1, 2, 4, 8, 16, 16}},
      {'%', {24, 25, 2, 4, 8, 19, 3}},
  };
  const char upper = c >= 'a' && c <= 'z' ? static_cast<char>(c - 'a' + 'A') : c;
  for (const auto& g : font)
    if (g.c == upper) return &g.rows;
  return nullptr;
}

// Calls plot(x, y, w, h) for every lit block of `text`, centred in `box`.
// `fill` 4 leaves a quarter of the box as margin; 1 uses the whole box.
template <class Plot>
void draw_text(const std::string& text, Rect box, Plot&& plot, int fill = 4) {
  if (text.empty()) return;
  const int columns = static_cast<int>(text.size()) * 6 - 1;
  const int scale = std::max(1, std::min(box.w / columns, box.h / 7) * (fill > 1 ? fill - 1 : 1) / std::max(1, fill));
  const int x0 = box.x + (box.w - columns * scale) / 2, y0 = box.y + (box.h - 7 * scale) / 2;
  for (std::size_t i = 0; i < text.size(); ++i) {
    const auto* g = glyph(text[i]);
    if (!g) continue;
    for (int row = 0; row < 7; ++row)
      for (int col = 0; col < 5; ++col)
        if ((*g)[static_cast<std::size_t>(row)] & (16 >> col))
          plot(x0 + (static_cast<int>(i) * 6 + col) * scale, y0 + row * scale, scale, scale);
  }
}

// A pad label of at most 7 characters, upper case: "closed hat" -> "CL HAT".
// Longer names keep two letters of each word but the last, then cut.
inline std::string short_label(const std::string& name) {
  std::string upper;
  for (char c : name) {
    if (c == '_' || c == '-') c = ' ';
    upper += c >= 'a' && c <= 'z' ? static_cast<char>(c - 'a' + 'A') : c;
  }
  while (!upper.empty() && upper.back() == ' ') upper.pop_back();
  while (!upper.empty() && upper.front() == ' ') upper.erase(upper.begin());
  if (upper.size() <= 7) return upper;
  std::string out;
  std::size_t at = 0;
  for (;;) {
    const auto space = upper.find(' ', at);
    if (space == std::string::npos) {
      out += upper.substr(at);
      break;
    }
    if (space > at) out += upper.substr(at, std::min<std::size_t>(2, space - at)) + " ";
    at = space + 1;
  }
  return out.substr(0, 7);
}

// Note name with the MPC's octave numbering (MIDI 36 = C1, 60 = C3).
inline std::string note_label(int note) {
  static constexpr const char* names[] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
  note = std::clamp(note, 0, 127);
  return std::string(names[note % 12]) + std::to_string(note / 12 - 2);
}

}  // namespace xmp::live
