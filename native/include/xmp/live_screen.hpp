#pragma once
// The device session's screen drawing, separate from the Linux framebuffer so
// it also renders on the Mac (tools/live-mk1/screen-preview.mjs). A Canvas is
// a 32-bit pixel buffer in the panel's own orientation; drawing happens on the
// landscape canvas and is turned by `rotation` (live_session.hpp).
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

#include "xmp/live_sequencer.hpp"
#include "xmp/live_session.hpp"
#include "xmp/live_theme.hpp"

namespace xmp::live {

struct Canvas {
  unsigned char* memory = nullptr;
  std::size_t size = 0;
  int xres = 0, yres = 0, xoffset = 0, yoffset = 0;
  std::size_t line_length = 0;
  unsigned red_offset = 16, red_length = 8, green_offset = 8, green_length = 8, blue_offset = 0, blue_length = 8;
  std::uint32_t extra_bits = 0;
  int rotation = 0, width = 0, height = 0;

  std::uint32_t colour(unsigned r, unsigned g, unsigned b) const {
    return (r >> (8 - red_length)) << red_offset | (g >> (8 - green_length)) << green_offset |
           (b >> (8 - blue_length)) << blue_offset | extra_bits;
  }

  void fill(const xmp::live::Rect& rect, unsigned r, unsigned g, unsigned b) {
    if (!memory) return;
    const auto value = colour(r, g, b);
    for (int y = std::max(0, rect.y); y < std::min(height, rect.y + rect.h); ++y)
      for (int x = std::max(0, rect.x); x < std::min(width, rect.x + rect.w); ++x) {
        int fx = 0, fy = 0;
        xmp::live::to_framebuffer(rotation, xres, yres, x, y, fx, fy);
        const std::size_t at = (static_cast<std::size_t>(fy) + static_cast<std::size_t>(yoffset)) * line_length +
                               (static_cast<std::size_t>(fx) + static_cast<std::size_t>(xoffset)) * 4;
        if (at + 4 <= size) std::memcpy(memory + at, &value, 4);
      }
  }

  void fill(const xmp::live::Rect& rect, xmp::live::theme::Rgb c) { fill(rect, c.r, c.g, c.b); }

  // Copies `rect` of a landscape picture (0xRRGGBB, `stride` pixels a row) to the panel.
  void blit(const std::uint32_t* source, int stride, const xmp::live::Rect& rect) {
    if (!memory) return;
    for (int y = std::max(0, rect.y); y < std::min(height, rect.y + rect.h); ++y)
      for (int x = std::max(0, rect.x); x < std::min(width, rect.x + rect.w); ++x) {
        const std::uint32_t v = source[static_cast<std::size_t>(y) * static_cast<std::size_t>(stride) + static_cast<std::size_t>(x)];
        const auto value = colour(v >> 16 & 255, v >> 8 & 255, v & 255);
        int fx = 0, fy = 0;
        xmp::live::to_framebuffer(rotation, xres, yres, x, y, fx, fy);
        const std::size_t at = (static_cast<std::size_t>(fy) + static_cast<std::size_t>(yoffset)) * line_length +
                               (static_cast<std::size_t>(fx) + static_cast<std::size_t>(xoffset)) * 4;
        if (at + 4 <= size) std::memcpy(memory + at, &value, 4);
      }
  }

  // A rectangle with rounded corners (radius in canvas pixels), row by row.
  void fill_round(const xmp::live::Rect& rect, int radius, xmp::live::theme::Rgb c) {
    radius = std::min(radius, std::min(rect.w, rect.h) / 2);
    for (int row = 0; row < rect.h; ++row) {
      int inset = 0;
      const int from_edge = std::min(row, rect.h - 1 - row);
      if (from_edge < radius) {
        const double dy = radius - from_edge - 0.5;
        inset = static_cast<int>(radius - std::sqrt(std::max(0.0, radius * radius - dy * dy)) + 0.5);
      }
      fill({rect.x + inset, rect.y + row, rect.w - 2 * inset, 1}, c);
    }
  }
  // Rounded panel with an optional border ring of `thickness`.
  void panel(const xmp::live::Rect& rect, xmp::live::theme::Rgb body, xmp::live::theme::Rgb border, int thickness) {
    const int radius = std::max(4, std::min(rect.w, rect.h) / 9);
    if (thickness <= 0) return fill_round(rect, radius, body);
    fill_round(rect, radius, border);
    fill_round({rect.x + thickness, rect.y + thickness, rect.w - 2 * thickness, rect.h - 2 * thickness},
               std::max(2, radius - thickness), body);
  }

  // Dot-matrix text: each font pixel is a small rounded dot with a hairline gap.
  void text(const std::string& label, const xmp::live::Rect& box, xmp::live::theme::Rgb c) {
    xmp::live::draw_text(label, box, [&](int x, int y, int w, int h) {
      if (w < 4) return fill({x, y, w, h}, c);
      const int gap = std::max(1, w / 7);
      fill_round({x, y, w - gap, h - gap}, std::max(1, (w - gap) / 3), c);
    });
  }

  // A pad with its sound's name along the bottom: ivory on the resting pad,
  // dark on a brightly lit one.
  void pad(int index, float level, bool selected, const std::string& label = {}) {
    using namespace xmp::live::theme;
    const auto rect = xmp::live::sequencer_pad_rect(index, width, height);
    panel(rect, pad_colour(level), kGold, selected ? std::max(3, rect.w / 30) : 0);
    if (label.empty()) return;
    const xmp::live::Rect box{rect.x + rect.w / 12, rect.y + rect.h * 6 / 10, rect.w - rect.w / 6, rect.h / 4};
    const auto colour = level > 0.45f ? kBackground : selected ? kGoldBright : kIvory;
    xmp::live::draw_text(label, box, [&](int x, int y, int w, int h) {
      if (w < 3) return fill({x, y, w, h}, colour);
      fill_round({x, y, w - 1, h - 1}, std::max(1, (w - 1) / 3), colour);
    }, 1);
  }

  void step(int index, std::uint8_t velocity, bool playhead) {
    using namespace xmp::live::theme;
    const auto rect = xmp::live::step_rect(index, width, height);
    if (playhead) panel(rect, velocity ? kIvory : kEmerald, kIvory, 0);
    else if (velocity) panel(rect, step_colour(velocity), kGoldBright, 0);
    else panel(rect, index % 4 == 0 ? kStepBeat : kStepIdle, kStepIdle, 0);
  }

  void control(xmp::live::Control c, bool active) {
    using namespace xmp::live::theme;
    using xmp::live::Control;
    const auto rect = xmp::live::control_rect(c, width, height);
    const char* label = c == Control::play ? (active ? "STOP" : "PLAY")
                        : c == Control::record ? "REC"
                        : c == Control::clear ? "CLEAR"
                        : c == Control::bpm_down ? "-" : "+";
    if (c == Control::play && active) panel(rect, kEmerald, kEmeraldBright, 2);
    else if (c == Control::record && active) panel(rect, kRuby, kRuby, 0);
    else panel(rect, kSurfaceRaised, kGoldDeep, 1);
    if (c == Control::bpm_down || c == Control::bpm_up) {
      // Clean rounded bars for minus and plus.
      const int len = std::min(rect.w, rect.h) / 2, thick = std::max(4, len / 6);
      const int cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      fill_round({cx - len / 2, cy - thick / 2, len, thick}, thick / 2, kGoldBright);
      if (c == Control::bpm_up) fill_round({cx - thick / 2, cy - len / 2, thick, len}, thick / 2, kGoldBright);
      return;
    }
    text(label, rect, (c == Control::play && active) || (c == Control::record && active) ? kIvory : kGoldBright);
  }

  void track(int index, const std::string& label, float level, bool muted, bool selected) {
    using namespace xmp::live::theme;
    const auto rect = xmp::live::track_rect(index, width, height);
    const Rgb body = muted ? kRubyDeep : selected ? kEmeraldDeep : kSurface;
    panel(rect, body, kGold, selected ? 2 : 0);
    // Level bar along the bottom, inside the rounded corners.
    const int bar = std::max(3, rect.h / 9), inset = std::max(6, rect.w / 12);
    const xmp::live::Rect slot{rect.x + inset, rect.y + rect.h - bar - 4, rect.w - 2 * inset, bar};
    fill(slot, kStepIdle);
    fill({slot.x, slot.y, static_cast<int>(slot.w * std::clamp(level, 0.0f, 1.0f)), slot.h}, muted ? kRuby : kGold);
    text(label, {rect.x, rect.y, rect.w, rect.h - bar - 4}, muted ? kRuby : selected ? kGoldBright : kIvory);
  }

  void bpm(int value) {
    using namespace xmp::live::theme;
    const auto rect = xmp::live::bpm_rect(width, height);
    fill(rect, kBar);
    text(std::to_string(value) + " BPM", rect, kGoldBright);
  }

  // Round status lights: 0 off, 1 ok (emerald), 2 failed (ruby), 3 waiting (gold).
  void light(int index, int state) {
    using namespace xmp::live::theme;
    const auto rect = xmp::live::status_rect(index, width, height);
    fill_round(rect, rect.w / 2, state == 1 ? kEmeraldBright : state == 2 ? kRuby : state == 3 ? kGold : kLightOff);
  }

  void clear() {
    using namespace xmp::live::theme;
    fill({0, 0, width, height}, kBackground);
    const int bar = xmp::live::bar_height(height);
    fill({0, 0, width, bar}, kBar);
    fill({0, bar - 1, width, 1}, kGoldDeep);  // gold hairline under the top bar
    // A fine gold divider between the pads and the steps.
    const int top = bar + xmp::live::strip_height(height);
    fill({width / 2, top + (height - top) / 16, 1, (height - top) * 7 / 8}, kGoldDeep);
  }

};

}  // namespace xmp::live
