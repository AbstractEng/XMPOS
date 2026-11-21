// XMP session on the MPC Live Mk1: kit, screen geometry and stick config.
#include "xmp/live_controls.hpp"
#include "xmp/live_session.hpp"

#include <cmath>
#include <cstdio>
#include <set>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
}  // namespace

int main() {
  using namespace xmp::live;

  // Kit: 16 distinct, deterministic, bounded sounds that start loud and end silent.
  std::set<std::size_t> lengths;
  for (int pad = 0; pad < 16; ++pad) {
    const auto a = make_sound(pad, 48000), b = make_sound(pad, 48000);
    check(a == b, "kit is deterministic");
    check(a.size() > 1000 && a.size() <= 48000, "sound length is bounded to 1 s");
    float peak = 0;
    bool finite = true;
    for (float v : a) {
      peak = std::max(peak, std::fabs(v));
      finite = finite && std::isfinite(v);
    }
    check(finite, "kit samples are finite");
    check(std::fabs(peak - 1.0f) < 1e-3f, "each sound is normalized to full scale");
    check(std::fabs(a.back()) < 1e-6f, "each sound ends silent (no click)");
    check(std::string(kit_name(pad)) != "?", "every pad has a name");
    lengths.insert(a.size());
  }
  // One sound at full velocity under the kit master stays below -12 dBFS by itself.
  check(kKitMaster * 1.0f < kPeakLimit, "one voice stays under the ceiling");
  check(kKitMaster * 2.0f < kPeakLimit, "two voices stay under the ceiling");

  // Screen: pads inside the canvas, non-overlapping, pad 0 bottom left, pad 15 top right.
  for (const auto& [w, h] : {std::pair{1280, 800}, std::pair{800, 480}, std::pair{1920, 1080}}) {
    for (int p = 0; p < 16; ++p) {
      const auto r = pad_rect(p, w, h);
      check(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h && r.w > 0 && r.h > 0,
            "pad inside canvas");
      for (int q = p + 1; q < 16; ++q) {
        const auto s = pad_rect(q, w, h);
        check(r.x + r.w <= s.x || s.x + s.w <= r.x || r.y + r.h <= s.y || s.y + s.h <= r.y,
              "pads do not overlap");
      }
    }
    const auto first = pad_rect(0, w, h), last = pad_rect(15, w, h), fourth = pad_rect(3, w, h);
    check(first.y > last.y && first.x < last.x, "pad 0 bottom left, pad 15 top right");
    check(fourth.y == first.y && fourth.x > first.x, "pads 0-3 are the bottom row");
    for (int i = 0; i < 4; ++i) {
      const auto s = status_rect(i, w, h);
      check(s.x + s.w < pad_rect(12, w, h).x || s.y + s.h < pad_rect(12, w, h).y,
            "status lights clear of the pads");
    }
  }

  // Rotation maps the logical canvas onto the framebuffer one to one.
  for (int rotation : {0, 90, 180, 270}) {
    const int xres = 80, yres = 128;
    int w = 0, h = 0;
    canvas_size(rotation, xres, yres, w, h);
    std::set<int> seen;
    bool inside = true;
    for (int y = 0; y < h; ++y)
      for (int x = 0; x < w; ++x) {
        int fx = 0, fy = 0;
        to_framebuffer(rotation, xres, yres, x, y, fx, fy);
        inside = inside && fx >= 0 && fy >= 0 && fx < xres && fy < yres;
        seen.insert(fy * xres + fx);
      }
    check(inside, "rotation stays on the framebuffer");
    check(seen.size() == static_cast<std::size_t>(xres * yres), "rotation is a bijection");
  }
  {
    int w = 0, h = 0;
    canvas_size(270, 800, 1280, w, h);
    check(w == 1280 && h == 800, "a portrait 800x1280 panel turned 270 is a 1280x800 canvas");
  }

  // Config: defaults, valid keys, and bounded rejection of everything else.
  {
    const auto d = parse_config("");
    check(d.errors.empty() && d.startup == Startup::full && d.startup_port == 1 && d.idle_minutes == 30,
          "defaults");
    check(effective_rotation(d, 800, 1280) == 270 && effective_rotation(d, 1280, 800) == 0,
          "default rotation follows the panel");
    const auto c = parse_config("# comment\nrotation=90\r\nstartup=none\nstartup_port=0\nidle_minutes=5\nlisten_seconds=10\n");
    check(c.errors.empty() && c.rotation == 90 && c.startup == Startup::none && c.startup_port == 0 &&
              c.idle_minutes == 5 && c.listen_seconds == 10,
          "valid config");
    const auto bad = parse_config("rotation=45\nstartup=firmware\nidle_minutes=999\nstartup_port=-1\nexec=/bin/sh\n");
    check(bad.errors.size() == 5 && bad.rotation == -1 && bad.startup == Startup::full &&
              bad.idle_minutes == 30 && bad.startup_port == 1,
          "invalid lines are reported and ignored");
    check(parse_config(std::string(5000, 'a')).errors.size() == 1, "oversized config rejected");
    const auto b = parse_config(
        "button_play=86\nbutton_record=0x4A\nbutton_clear=1\ntouch_rotation=90\nbutton_stop=50h\n"
        "tempo_control=none\nbutton_play=128\ntouch_rotation=45\nbutton_stop=0xZZ\n");
    check(b.button_play == 86 && b.button_record == 0x4A && b.button_clear == 1 && b.touch_rotation == 90 &&
              b.button_stop == 0x50 && b.tempo_control == -1 && b.errors.size() == 3,
          "button and touch settings");
    check(d.button_play == 0x52 && d.button_stop == 0x51 && d.button_record == 0x49 && d.button_clear == -1 &&
              d.tempo_control == 0x64 && d.touch_rotation == -1,
          "the Live's own transport buttons and data wheel by default");
    check(parse_config("idle_minutes=99999999999\n").errors.size() == 1, "huge numbers rejected");
  }

  if (failures) return 1;
  std::printf("live session: kit, screen and config ok\n");
  return 0;
}
