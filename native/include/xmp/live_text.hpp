#pragma once
// Drawing for the Live interface as the web Device view draws it: an
// off-screen 1280 x 800 picture with antialiased text (Inter and JetBrains
// Mono from the glyph atlas tools/fonts.mjs makes), rounded boxes with
// borders and vertical gradients, and dashed borders. The interface paints
// regions here, then copies only those regions to the framebuffer.
// Main thread only; nothing here allocates after construction.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "xmp/live_session.hpp"
#include "xmp/live_theme.hpp"
#include "xmp_font_atlas.hpp"

namespace xmp::live::gfx {

using theme::Rgb;

// The faces, in tools/fonts.mjs FACES order.
enum class Font : std::uint8_t {
  caption,    // 15 regular
  small,      // 14 regular
  muted,      // 17 regular
  label,      // 18 regular
  status,     // 19 regular
  body,       // 20 regular
  base,       // 22 regular
  title,      // 24 bold
  heading,    // 28 semibold
  large,      // 34 bold
  glyph,      // 38 regular
  mono,       // 24 JetBrains Mono
  mono_large, // 40 JetBrains Mono
  body_bold,  // 20 bold
  card,       // 25 bold
};

inline const atlas::Face& face(Font f) { return atlas::kFaces[static_cast<int>(f)]; }

// The web view's colours (apps/studio/src/device/style.css).
namespace css {
constexpr Rgb kBg{0x07, 0x11, 0x0d}, kScreen{0x0a, 0x16, 0x12}, kSurface{0x0f, 0x1f, 0x19}, kSurface2{0x14, 0x2a, 0x21},
    kSurface3{0x1b, 0x38, 0x2c}, kLine{0x24, 0x45, 0x3a}, kLineStrong{0x3a, 0x63, 0x52}, kEmeraldDeep{0x0e, 0x4d, 0x38},
    kEmerald{0x14, 0xa6, 0x73}, kEmeraldBright{0x3e, 0xd6, 0x9a}, kGoldDeep{0x8f, 0x72, 0x28}, kGold{0xd8, 0xb4, 0x50},
    kGoldBright{0xf2, 0xd6, 0x85}, kIvory{0xf4, 0xec, 0xd6}, kMuted{0xa9, 0xbc, 0xb0}, kSubtle{0x7d, 0x93, 0x87},
    kRuby{0xd2, 0x58, 0x4c}, kRubySoft{0xf1, 0xaa, 0x9f};
// A filled clip cell's gradient, and a lit step's.
constexpr Rgb kCellTop{0x15, 0x56, 0x3f}, kCellBottom{0x0e, 0x3f, 0x2e}, kStepTop{0xe0, 0xbe, 0x5c},
    kStepBottom{0xb8, 0x93, 0x2f}, kStepText{0x1a, 0x14, 0x06}, kStepMark{0x3d, 0x2e, 0x0a};
}  // namespace css

inline Rgb blend_colour(Rgb a, Rgb b, float t) {
  t = std::clamp(t, 0.0f, 1.0f);
  return {static_cast<std::uint8_t>(a.r + (b.r - a.r) * t + 0.5f), static_cast<std::uint8_t>(a.g + (b.g - a.g) * t + 0.5f),
          static_cast<std::uint8_t>(a.b + (b.b - a.b) * t + 0.5f)};
}

class Surface {
 public:
  static constexpr int kWidth = 1280, kHeight = 800;
  Surface() : px_(static_cast<std::size_t>(kWidth) * kHeight, 0) {}

  std::uint32_t at(int x, int y) const { return px_[static_cast<std::size_t>(y) * kWidth + x]; }
  const std::uint32_t* pixels() const { return px_.data(); }

  void fill(Rect r, Rgb c) {
    clip(r);
    const std::uint32_t v = pack(c);
    for (int y = r.y; y < r.y + r.h; ++y) std::fill_n(&px_[static_cast<std::size_t>(y) * kWidth + r.x], r.w, v);
  }
  void two_colour_mask(Rect area, const std::uint8_t* mask, Rgb first, Rgb second) {
    Rect visible = area;
    clip(visible);
    for (int y = visible.y; y < visible.y + visible.h; ++y)
      for (int x = visible.x; x < visible.x + visible.w; ++x) {
        const auto pixel = mask[(y - area.y) * area.w + x - area.x];
        const int opacity = pixel & 0x7f;
        if (opacity) blend(x, y, (pixel & 0x80) ? second : first, opacity / 127.0f);
      }
  }
  // A rounded box from `top` to `bottom` colour, its corners antialiased.
  void round(Rect r, float radius, Rgb top, Rgb bottom) {
    radius = std::min(radius, std::min(r.w, r.h) / 2.0f);
    for (int y = std::max(0, r.y); y < std::min(kHeight, r.y + r.h); ++y) {
      const Rgb c = r.h > 1 ? blend_colour(top, bottom, (y - r.y) / static_cast<float>(r.h - 1)) : top;
      const float cy = y + 0.5f;
      for (int x = std::max(0, r.x); x < std::min(kWidth, r.x + r.w); ++x) {
        const float a = coverage(r, radius, x + 0.5f, cy);
        if (a >= 1) put(x, y, c);
        else if (a > 0) blend(x, y, c, a);
      }
    }
  }
  void round(Rect r, float radius, Rgb c) { round(r, radius, c, c); }
  // A box with a border of `width` (CSS border-box): the border colour, then the body inside.
  void box(Rect r, float radius, int width, Rgb border, Rgb top, Rgb bottom) {
    round(r, radius, border);
    round({r.x + width, r.y + width, r.w - 2 * width, r.h - 2 * width}, std::max(0.0f, radius - width), top, bottom);
  }
  void box(Rect r, float radius, int width, Rgb border, Rgb body) { box(r, radius, width, border, body, body); }
  // A ring of `width` inside `r` (CSS outline with a negative offset): only the ring is painted.
  void ring(Rect r, float radius, int width, Rgb c) {
    radius = std::min(radius, std::min(r.w, r.h) / 2.0f);
    const Rect in{r.x + width, r.y + width, r.w - 2 * width, r.h - 2 * width};
    const float inner = std::max(0.0f, radius - width);
    for (int y = std::max(0, r.y); y < std::min(kHeight, r.y + r.h); ++y)
      for (int x = std::max(0, r.x); x < std::min(kWidth, r.x + r.w); ++x) {
        const float a = coverage(r, radius, x + 0.5f, y + 0.5f) - coverage(in, inner, x + 0.5f, y + 0.5f);
        if (a > 0) blend(x, y, c, std::min(1.0f, a));
      }
  }
  // A 1 px dashed border (3 on, 3 off along each side), with rounded corners drawn solid.
  void dashed(Rect r, float radius, Rgb c) {
    ring(r, radius, 1, c);
    const int corner = static_cast<int>(std::ceil(radius));
    for (int x = r.x + corner; x < r.x + r.w - corner; ++x)
      if ((x - r.x) / 3 % 2) restore(x, r.y), restore(x, r.y + r.h - 1);
    for (int y = r.y + corner; y < r.y + r.h - corner; ++y)
      if ((y - r.y) / 3 % 2) restore(r.x, y), restore(r.x + r.w - 1, y);
  }
  // A dashed border's gap: the colour of the box behind it.
  void restore(int x, int y) {
    if (x >= 0 && y >= 0 && x < kWidth && y < kHeight) px_[static_cast<std::size_t>(y) * kWidth + x] = gap_;
  }
  // The colour a dashed border's gaps take (the box behind it).
  void gap_colour(Rgb c) { gap_ = pack(c); }

  // Text with its baseline at y, from x; returns the advance in px. `max`:
  // cut with an ellipsis to fit that many px (0: no limit).
  int text(Font f, int x, int y, const std::string& s, Rgb c, int max = 0) {
    const std::string shown = max > 0 ? fit(f, s, max) : s;
    const atlas::Face& fc = face(f);
    long pen = static_cast<long>(x) * 64;
    std::uint32_t prev = 0;
    for (std::size_t i = 0; i < shown.size();) {
      const std::uint32_t cp = next(shown, i);
      if (prev) pen += kern(fc, prev, cp);
      const atlas::Glyph* g = glyph(fc, cp);
      if (!g) g = glyph(fc, '?');
      if (!g) continue;
      const int gx = static_cast<int>((pen + 32) >> 6) + g->x0, gy = y + g->y0;
      const std::uint8_t* a = atlas::kAlpha + g->offset;
      for (int row = 0; row < g->h; ++row) {
        const int py = gy + row;
        if (py < 0 || py >= kHeight) continue;
        for (int col = 0; col < g->w; ++col) {
          const int px = gx + col;
          const std::uint8_t v = a[row * g->w + col];
          if (v && px >= 0 && px < kWidth) blend(px, py, c, v / 255.0f);
        }
      }
      pen += g->advance;
      prev = cp;
    }
    return static_cast<int>((pen + 32) / 64) - x;
  }
  // Text centred on x.
  int text_centre(Font f, int cx, int y, const std::string& s, Rgb c, int max = 0) {
    const std::string shown = max > 0 ? fit(f, s, max) : s;
    return text(f, cx - width(f, shown) / 2, y, shown, c);
  }
  // Text ending at x.
  int text_right(Font f, int right, int y, const std::string& s, Rgb c) { return text(f, right - width(f, s), y, s, c); }

  static int width(Font f, const std::string& s) {
    const atlas::Face& fc = face(f);
    long pen = 0;
    std::uint32_t prev = 0;
    for (std::size_t i = 0; i < s.size();) {
      const std::uint32_t cp = next(s, i);
      if (prev) pen += kern(fc, prev, cp);
      const atlas::Glyph* g = glyph(fc, cp);
      if (!g) g = glyph(fc, '?');
      if (g) pen += g->advance;
      prev = cp;
    }
    return static_cast<int>((pen + 32) / 64);
  }
  // The baseline for a line of `f` in a CSS line box `line_height` px tall from `top`.
  static int baseline(Font f, int top, float line_height) {
    const atlas::Face& fc = face(f);
    const float ascent = fc.ascent / 64.0f, descent = fc.descent / 64.0f;
    return static_cast<int>(std::lround(top + (line_height - (ascent + descent)) / 2 + ascent));
  }
  // The CSS line box of a face at line-height 1.3 (the screen's).
  static float line(Font f) { return face(f).size * 1.3f; }

  // `s` shortened with "…" to fit `max` px.
  static std::string fit(Font f, const std::string& s, int max) {
    if (width(f, s) <= max) return s;
    std::string cut = s;
    while (!cut.empty()) {
      do cut.pop_back();
      while (!cut.empty() && (static_cast<unsigned char>(cut.back()) & 0xC0) == 0x80);
      if (width(f, cut + "\xE2\x80\xA6") <= max) return cut + "\xE2\x80\xA6";
    }
    return "";
  }

 private:
  static std::uint32_t pack(Rgb c) { return static_cast<std::uint32_t>(c.r) << 16 | c.g << 8 | c.b; }
  void clip(Rect& r) const {
    const int x0 = std::max(0, r.x), y0 = std::max(0, r.y), x1 = std::min(kWidth, r.x + r.w),
              y1 = std::min(kHeight, r.y + r.h);
    r = {x0, y0, std::max(0, x1 - x0), std::max(0, y1 - y0)};
  }
  void put(int x, int y, Rgb c) { px_[static_cast<std::size_t>(y) * kWidth + x] = pack(c); }
  void blend(int x, int y, Rgb c, float a) {
    std::uint32_t& d = px_[static_cast<std::size_t>(y) * kWidth + x];
    const float r = (d >> 16 & 255) + (c.r - static_cast<float>(d >> 16 & 255)) * a;
    const float g = (d >> 8 & 255) + (c.g - static_cast<float>(d >> 8 & 255)) * a;
    const float b = (d & 255) + (c.b - static_cast<float>(d & 255)) * a;
    d = static_cast<std::uint32_t>(r + 0.5f) << 16 | static_cast<std::uint32_t>(g + 0.5f) << 8 | static_cast<std::uint32_t>(b + 0.5f);
  }
  // How much of the pixel centred at (px, py) a rounded box covers (0..1).
  static float coverage(Rect r, float radius, float px, float py) {
    if (px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) return 0;
    if (radius <= 0) return 1;
    const float cx = std::clamp(px, r.x + radius, r.x + r.w - radius), cy = std::clamp(py, r.y + radius, r.y + r.h - radius);
    const float dx = px - cx, dy = py - cy;
    if (dx == 0 && dy == 0) return 1;
    return std::clamp(radius + 0.5f - std::sqrt(dx * dx + dy * dy), 0.0f, 1.0f);
  }
  static std::uint32_t next(const std::string& s, std::size_t& i) {
    const auto c = static_cast<unsigned char>(s[i]);
    int n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
    if (i + n > s.size()) n = 1;
    std::uint32_t cp = n == 1 ? c : n == 2 ? c & 0x1F : n == 3 ? c & 0x0F : c & 0x07;
    for (int k = 1; k < n; ++k) cp = cp << 6 | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    i += n;
    return cp;
  }
  static const atlas::Glyph* glyph(const atlas::Face& f, std::uint32_t cp) {
    const atlas::Glyph* g = atlas::kGlyphs + f.first_glyph;
    if (cp >= 32 && cp < 127 && static_cast<int>(cp - 32) < f.glyph_count && g[cp - 32].codepoint == cp) return &g[cp - 32];
    for (int i = 0; i < f.glyph_count; ++i)
      if (g[i].codepoint == cp) return &g[i];
    return nullptr;
  }
  static long kern(const atlas::Face& f, std::uint32_t a, std::uint32_t b) {
    if (a > 126 || b > 126 || f.kern_count == 0) return 0;
    const std::uint32_t key = a << 16 | b;
    const atlas::Kern* lo = atlas::kKerns + f.first_kern;
    const atlas::Kern* hi = lo + f.kern_count;
    const atlas::Kern* k = std::lower_bound(lo, hi, key, [](const atlas::Kern& x, std::uint32_t v) { return x.pair < v; });
    return k != hi && k->pair == key ? k->amount : 0;
  }
  std::vector<std::uint32_t> px_;
  std::uint32_t gap_ = 0;
};

}  // namespace xmp::live::gfx
