// Makes build/fonts/xmp_font_atlas.hpp: antialiased glyphs (8-bit coverage)
// for each face the Live interface draws with, at the web Device view's sizes,
// with advances and kerning in 1/64 px. Run by tools/fonts.mjs on the Mac;
// the Live only blends the finished coverage, so it never parses a font.
//
//   font_atlas <out.hpp> <name>:<font.ttf>:<px> ...
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {
// Printable ASCII and the few typographic marks the interface writes.
std::vector<int> codepoints() {
  std::vector<int> out;
  for (int c = 32; c < 127; ++c) out.push_back(c);
  for (int c : {0xB7, 0xD7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2039, 0x203A, 0x2190, 0x2192, 0x25B2, 0x25B6, 0x25BC, 0x25A0}) out.push_back(c);
  return out;
}

// ---- kerning from GPOS, as a browser applies it ----
// stb_truetype reads pair positioning only partly (not through extension
// lookups, which Inter uses for its letter pairs). This reads every lookup of
// every 'kern' feature: PairPos formats 1 and 2, directly or by extension,
// and sums their x-advance adjustments.
struct Gpos {
  const unsigned char* d = nullptr;
  std::vector<int> lookups;
  int u16(std::size_t at) const { return d[at] << 8 | d[at + 1]; }
  int s16(std::size_t at) const { return static_cast<short>(u16(at)); }
  std::size_t u32(std::size_t at) const {
    return static_cast<std::size_t>(d[at]) << 24 | static_cast<std::size_t>(d[at + 1]) << 16 | d[at + 2] << 8 | d[at + 3];
  }
  std::size_t base = 0;
  bool load(const unsigned char* data, std::size_t gpos) {
    if (!gpos) return false;
    d = data, base = gpos;
    const std::size_t features = base + u16(base + 6), list = base + u16(base + 8);
    for (int i = 0; i < u16(features); ++i) {
      const std::size_t record = features + 2 + i * 6;
      if (std::memcmp(d + record, "kern", 4) != 0) continue;
      const std::size_t feature = features + u16(record + 4);
      for (int k = 0; k < u16(feature + 2); ++k) {
        const int index = u16(feature + 4 + k * 2);
        bool seen = false;
        for (int x : lookups) seen = seen || x == index;
        if (!seen) lookups.push_back(index);
      }
    }
    lookup_list = list;
    return !lookups.empty();
  }
  std::size_t lookup_list = 0;
  int coverage(std::size_t at, int glyph) const {
    if (u16(at) == 1) {
      for (int i = 0, n = u16(at + 2); i < n; ++i)
        if (u16(at + 4 + i * 2) == glyph) return i;
    } else if (u16(at) == 2) {
      for (int i = 0, n = u16(at + 2); i < n; ++i) {
        const std::size_t r = at + 4 + i * 6;
        if (glyph >= u16(r) && glyph <= u16(r + 2)) return u16(r + 4) + glyph - u16(r);
      }
    }
    return -1;
  }
  int class_of(std::size_t at, int glyph) const {
    if (u16(at) == 1) {
      const int start = u16(at + 2), n = u16(at + 4);
      if (glyph >= start && glyph < start + n) return u16(at + 6 + (glyph - start) * 2);
    } else if (u16(at) == 2) {
      for (int i = 0, n = u16(at + 2); i < n; ++i) {
        const std::size_t r = at + 4 + i * 6;
        if (glyph >= u16(r) && glyph <= u16(r + 2)) return u16(r + 4);
      }
    }
    return 0;
  }
  static int bits(int v) {
    int n = 0;
    for (; v; v &= v - 1) ++n;
    return n;
  }
  // One PairPos subtable: true when it applies to `a` (then `out` is its adjustment).
  bool pair(std::size_t sub, int a, int b, int& out) const {
    const int format = u16(sub), f1 = u16(sub + 4), f2 = u16(sub + 6);
    if (coverage(sub + u16(sub + 2), a) < 0) return false;
    const int size1 = bits(f1) * 2, size2 = bits(f2) * 2, x = (f1 & 4) ? bits(f1 & 3) * 2 : -1;
    if (format == 1) {
      const int index = coverage(sub + u16(sub + 2), a);
      if (index >= u16(sub + 8)) return false;
      const std::size_t set = sub + u16(sub + 10 + index * 2);
      for (int i = 0, n = u16(set); i < n; ++i) {
        const std::size_t record = set + 2 + static_cast<std::size_t>(i) * (2 + size1 + size2);
        if (u16(record) != b) continue;
        out = x >= 0 ? s16(record + 2 + x) : 0;
        return true;
      }
      return false;
    }
    if (format == 2) {
      const int c1 = class_of(sub + u16(sub + 8), a), c2 = class_of(sub + u16(sub + 10), b);
      const int n1 = u16(sub + 12), n2 = u16(sub + 14);
      if (c1 >= n1 || c2 >= n2) return false;
      const std::size_t record = sub + 16 + (static_cast<std::size_t>(c1) * n2 + c2) * (size1 + size2);
      out = x >= 0 ? s16(record + x) : 0;
      return true;
    }
    return false;
  }
  int kern(int a, int b) const {
    int total = 0;
    for (const int index : lookups) {
      const std::size_t lookup = lookup_list + u16(lookup_list + 2 + index * 2);
      const int type = u16(lookup);
      for (int i = 0, n = u16(lookup + 4); i < n; ++i) {
        std::size_t sub = lookup + u16(lookup + 6 + i * 2);
        if (type == 9) {
          if (u16(sub + 2) != 2) continue;
          sub += u32(sub + 4);
        } else if (type != 2) {
          continue;
        }
        int v = 0;
        if (pair(sub, a, b, v)) {
          total += v;
          break;  // the first subtable that applies is the lookup's
        }
      }
    }
    return total;
  }
};

struct Spec {
  std::string name, path;
  int size = 0;
};
}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: font_atlas <out.hpp> <name>:<font.ttf>:<px> ...\n");
    return 2;
  }
  std::vector<Spec> specs;
  for (int i = 2; i < argc; ++i) {
    const std::string s = argv[i];
    const auto a = s.find(':'), b = s.rfind(':');
    if (a == std::string::npos || a == b) return std::fprintf(stderr, "bad spec %s\n", argv[i]), 2;
    specs.push_back({s.substr(0, a), s.substr(a + 1, b - a - 1), std::atoi(s.substr(b + 1).c_str())});
  }
  std::string glyphs, kerns, faces, alpha;
  std::size_t offset = 0;
  int glyph_total = 0, kern_total = 0, column = 0;
  const auto cps = codepoints();
  for (const auto& spec : specs) {
    std::ifstream in(spec.path, std::ios::binary);
    std::vector<unsigned char> ttf((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    stbtt_fontinfo font;
    if (ttf.empty() || !stbtt_InitFont(&font, ttf.data(), stbtt_GetFontOffsetForIndex(ttf.data(), 0)))
      return std::fprintf(stderr, "cannot read %s\n", spec.path.c_str()), 1;
    // CSS font-size is the em size.
    const float scale = stbtt_ScaleForMappingEmToPixels(&font, static_cast<float>(spec.size));
    Gpos gpos;
    const bool gpos_ok = gpos.load(font.data, font.gpos ? static_cast<std::size_t>(font.gpos) : 0);
    int ascent = 0, descent = 0, gap = 0;
    stbtt_GetFontVMetrics(&font, &ascent, &descent, &gap);
    const int first_glyph = glyph_total, first_kern = kern_total;
    std::vector<int> present;
    for (const int cp : cps) {
      const int g = stbtt_FindGlyphIndex(&font, cp);
      if (cp != ' ' && g == 0) continue;
      present.push_back(cp);
      int advance = 0, bearing = 0, x0 = 0, y0 = 0, x1 = 0, y1 = 0;
      stbtt_GetGlyphHMetrics(&font, g, &advance, &bearing);
      stbtt_GetGlyphBitmapBox(&font, g, scale, scale, &x0, &y0, &x1, &y1);
      const int w = x1 - x0, h = y1 - y0;
      std::vector<unsigned char> bitmap(static_cast<std::size_t>(std::max(0, w * h)));
      if (w > 0 && h > 0) stbtt_MakeGlyphBitmap(&font, bitmap.data(), w, h, w, scale, scale, g);
      char line[160];
      std::snprintf(line, sizeof line, "    {%d, %d, %d, %d, %d, %ld, %zu},\n", cp, x0, y0, std::max(0, w), std::max(0, h),
                    std::lround(advance * scale * 64), offset);
      glyphs += line;
      for (const unsigned char v : bitmap) {
        alpha += std::to_string(v) + ",";
        if (++column == 40) alpha += "\n", column = 0;
      }
      offset += bitmap.size();
      ++glyph_total;
    }
    for (const int a : present)
      for (const int b : present) {
        if (a > 126 || b > 126) continue;
        const int k = gpos_ok ? gpos.kern(stbtt_FindGlyphIndex(&font, a), stbtt_FindGlyphIndex(&font, b))
                              : stbtt_GetCodepointKernAdvance(&font, a, b);
        if (!k) continue;
        char line[96];
        std::snprintf(line, sizeof line, "    {0x%08X, %ld},\n", static_cast<unsigned>(a << 16 | b), std::lround(k * scale * 64));
        kerns += line;
        ++kern_total;
      }
    char line[320];
    std::snprintf(line, sizeof line, "    {\"%s\", %d, %ld, %ld, %ld, %d, %d, %d, %d},\n", spec.name.c_str(), spec.size,
                  std::lround(ascent * scale * 64), std::lround(-descent * scale * 64),
                  std::lround((ascent - descent + gap) * scale * 64), first_glyph, glyph_total - first_glyph, first_kern,
                  kern_total - first_kern);
    faces += line;
  }
  std::FILE* out = std::fopen(argv[1], "w");
  if (!out) return std::fprintf(stderr, "cannot write %s\n", argv[1]), 1;
  std::fprintf(out,
               "#pragma once\n// Generated by native/tools/font_atlas.cpp (tools/fonts.mjs). Do not edit or commit.\n"
               "// Inter and JetBrains Mono, SIL Open Font Licence 1.1.\n#include <cstdint>\n\n"
               "namespace xmp::live::atlas {\n\n"
               "// A glyph: its codepoint, the coverage box from the pen on the baseline (y down),\n"
               "// its advance in 1/64 px, and where its coverage starts in kAlpha.\n"
               "struct Glyph {\n  std::uint32_t codepoint;\n  std::int16_t x0, y0;\n  std::uint16_t w, h;\n"
               "  std::int32_t advance;\n  std::uint32_t offset;\n};\n"
               "// Kerning between two ASCII characters ((a << 16) | b), in 1/64 px.\n"
               "struct Kern {\n  std::uint32_t pair;\n  std::int32_t amount;\n};\n"
               "// A face: ascent, descent and line height in 1/64 px, and its glyphs and kerning.\n"
               "struct Face {\n  const char* name;\n  int size;\n  int ascent, descent, line;\n"
               "  int first_glyph, glyph_count, first_kern, kern_count;\n};\n\n");
  std::fprintf(out, "inline const Glyph kGlyphs[] = {\n%s};\n\n", glyphs.c_str());
  std::fprintf(out, "inline const Kern kKerns[] = {\n%s    {0, 0}};\n\n", kerns.c_str());
  std::fprintf(out, "inline const Face kFaces[] = {\n%s};\n\n", faces.c_str());
  std::fprintf(out, "inline const std::uint8_t kAlpha[] = {\n%s0};\n\n}  // namespace xmp::live::atlas\n", alpha.c_str());
  std::fclose(out);
  std::printf("font atlas: %zu faces, %d glyphs, %d kerning pairs, %zu bytes of coverage\n", specs.size(), glyph_total,
              kern_total, offset);
  return 0;
}
