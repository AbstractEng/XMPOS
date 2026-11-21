// Phase 2 XMP session on the MPC Live Mk1: sequencer timing, pattern file,
// touchscreen layout and hit-testing, and the bitmap font.
#include "xmp/live_sequencer.hpp"

#include <cmath>
#include <cstdio>
#include <set>
#include <vector>

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

  // Timing: sixteenths at 120 BPM are exactly 6000 frames apart at 48 kHz.
  {
    Pattern p;
    for (int s = 0; s < kSteps; ++s) p.velocity[7][static_cast<std::size_t>(s)] = 100;
    p.velocity[0][0] = 127;
    Sequencer seq(48000);
    check(std::fabs(seq.step_frames(120) - 6000.0) < 1e-9, "120 BPM sixteenth = 6000 frames");
    seq.start(10000, 120);
    std::vector<DueNote> notes;
    seq.due(p, 10000 + 6000 * 32, [&](const DueNote& n) { notes.push_back(n); });
    check(notes.size() == 32 + 2, "two bars: 32 rim hits and 2 kicks");
    bool spaced = true;
    std::uint64_t last = 0;
    for (const auto& n : notes)
      if (n.pad == 7) {
        if (last) spaced = spaced && n.frame - last == 6000;
        last = n.frame;
      }
    check(spaced, "steps land on exact frames");
    check(notes.front().frame == 10000 && notes.front().step == 0, "first step at the start frame");
    std::vector<DueNote> again;
    seq.due(p, 10000 + 6000 * 32, [&](const DueNote& n) { again.push_back(n); });
    check(again.empty(), "no step is scheduled twice");
    check(seq.next_step() == 0, "after two whole bars the next unscheduled step is step 1");
    {
      Sequencer steps(48000);
      steps.start(1000, 120);
      std::vector<std::pair<std::uint64_t, int>> got;
      steps.due_steps(1000 + 6000 * 3, [&](std::uint64_t f, int s) { got.emplace_back(f, s); });
      check(got.size() == 3 && got[0] == std::pair<std::uint64_t, int>{1000, 0} &&
                got[2] == std::pair<std::uint64_t, int>{13000, 2},
            "due_steps yields each step once on its frame");
    }
    check(seq.step_at(10000 + 6000 * 3 + 10) == 3, "screen step follows the frame");
    check(seq.nearest_step(10000 + 6000 * 5 - 100) == 5, "a hit just early records on the next step");
    check(seq.nearest_step(10000 + 6000 * 5 + 2900) == 5, "a hit just late records on that step");

    // Tempo change: continues from the next step without a jump.
    seq.set_bpm(60);
    std::vector<DueNote> slow;
    seq.due(p, 10000 + 6000 * 32 + 12000 * 3, [&](const DueNote& n) {
      if (n.pad == 7) slow.push_back(n);
    });
    check(slow.size() >= 3 && slow[0].frame == 10000 + 6000 * 32, "tempo change keeps the next step in place");
    check(slow.size() >= 3 && slow[1].frame - slow[0].frame == 12000, "new tempo from then on");
    seq.set_bpm(500);
    check(seq.bpm() == kMaxBpm, "tempo is bounded");
    seq.stop();
    check(seq.step_at(999999) == -1, "stopped shows no step");
  }

  // Pattern file round-trip and bounded rejection.
  {
    Pattern p;
    p.bpm = 97;
    p.velocity[0][0] = 0x7F;
    p.velocity[15][15] = 0x01;
    p.velocity[4][8] = 0x40;
    const auto text = pattern_text(p);
    std::vector<std::string> errors;
    const auto back = parse_pattern(text, &errors);
    check(errors.empty() && back.bpm == 97 && back.velocity == p.velocity, "pattern round-trips");
    check(!back.empty() && Pattern{}.empty(), "empty detection");
    errors.clear();
    const auto bad = parse_pattern(
        "bpm=999\npad0=00\npad17=00\npad1=ZZ 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n"
        "pad2=80 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\nexec=/bin/sh\nnonsense\n",
        &errors);
    check(errors.size() == 7 && bad.bpm == 120 && bad.empty(), "malformed lines are rejected");
    check(parse_pattern(std::string(9000, 'x'), &errors).empty(), "oversized pattern rejected");
  }

  // Layout: everything inside the canvas, nothing overlapping, hit-test finds each control.
  for (const auto& [w, h] : {std::pair{1280, 800}, std::pair{800, 480}}) {
    std::vector<std::pair<Rect, Hit>> all;
    for (auto c : {Control::play, Control::record, Control::clear, Control::bpm_down, Control::bpm_up})
      all.push_back({control_rect(c, w, h), Hit{c, -1}});
    for (int i = 0; i < 8; ++i) all.push_back({track_rect(i, w, h), Hit{Control::track, i}});
    for (int i = 0; i < 16; ++i) {
      all.push_back({sequencer_pad_rect(i, w, h), Hit{Control::pad, i}});
      all.push_back({step_rect(i, w, h), Hit{Control::step, i}});
    }
    for (int i = 0; i < 5; ++i) all.push_back({status_rect(i, w, h), Hit{}});  // incl. the bridge light
    all.push_back({bpm_rect(w, h), Hit{}});
    bool ok = true, found = true;
    for (std::size_t a = 0; a < all.size(); ++a) {
      const auto& r = all[a].first;
      ok = ok && r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= w && r.y + r.h <= h;
      for (std::size_t b = a + 1; b < all.size(); ++b) {
        const auto& s = all[b].first;
        ok = ok && (r.x + r.w <= s.x || s.x + s.w <= r.x || r.y + r.h <= s.y || s.y + s.h <= r.y);
      }
      if (all[a].second.control != Control::none) {
        const auto hit = hit_test(r.x + r.w / 2, r.y + r.h / 2, w, h);
        found = found && hit.control == all[a].second.control && hit.index == all[a].second.index;
      }
    }
    check(ok, "layout inside canvas, no overlaps");
    check(found, "hit-test finds every control, pad and step");
    check(sequencer_pad_rect(0, w, h).y > sequencer_pad_rect(12, w, h).y, "pad 1 bottom left");
    check(step_rect(0, w, h).y < step_rect(12, w, h).y, "step 1 top left");
    check(hit_test(1, h - 2, w, h).control == Control::none, "empty space hits nothing");
  }

  // Touch mapping: inverse rotation and axis scaling.
  for (int rotation : {0, 90, 180, 270}) {
    bool ok = true;
    const int xres = 80, yres = 128;
    int cw = 0, ch = 0;
    canvas_size(rotation, xres, yres, cw, ch);
    for (int y = 0; y < ch; y += 7)
      for (int x = 0; x < cw; x += 5) {
        int fx = 0, fy = 0, bx = 0, by = 0;
        to_framebuffer(rotation, xres, yres, x, y, fx, fy);
        from_framebuffer(rotation, xres, yres, fx, fy, bx, by);
        ok = ok && bx == x && by == y;
      }
    check(ok, "from_framebuffer inverts to_framebuffer");
  }
  check(scale_axis(0, 0, 4095, 800) == 0 && scale_axis(4095, 0, 4095, 800) == 799 &&
            scale_axis(2048, 0, 4095, 800) == 400 && scale_axis(-5, 0, 4095, 800) == 0 &&
            scale_axis(10, 10, 10, 800) == 0,
        "touch axis scaling is bounded");

  // Font: every label the screen uses has glyphs, and text stays in its box.
  for (const char* label : {"PLAY", "STOP", "REC", "CLEAR", "BPM", "-", "+", "0123456789", "KIT", "BASS", "KEYS", "LEAD"})
    for (const char* c = label; *c; ++c) check(glyph(*c) != nullptr, "glyph present");
  {
    const Rect box{100, 50, 200, 60};
    bool in = true;
    int blocks = 0;
    draw_text("PLAY", box, [&](int x, int y, int bw, int bh) {
      ++blocks;
      in = in && x >= box.x && y >= box.y && x + bw <= box.x + box.w && y + bh <= box.y + box.h;
    });
    check(in && blocks > 20, "text drawn inside its box");
  }

  // Pad labels: the whole alphabet, digits and note signs have glyphs; names
  // shorten to fit a pad; notes use the MPC's octaves.
  for (const char* c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcxyz0123456789#+-./ "; *c; ++c)
    check(glyph(*c) != nullptr, "full font");
  check(short_label("kick") == "KICK" && short_label("closed hat") == "CL HAT" &&
            short_label("open hat") == "OP HAT" && short_label("x-stick") == "X STICK" &&
            short_label("snare muted") == "SN MUTE" && short_label("  ride ") == "RIDE",
        "short labels");
  check(short_label("a very long sample name").size() <= 7, "labels at most 7 characters");
  check(note_label(36) == "C1" && note_label(61) == "C#3" && note_label(0) == "C-2", "note labels");
  {
    const Rect pad = sequencer_pad_rect(0, 1280, 800);
    const Rect box{pad.x + pad.w / 12, pad.y + pad.h * 6 / 10, pad.w - pad.w / 6, pad.h / 4};
    int tallest = 0;
    bool in = true;
    draw_text("X STICK", box, [&](int x, int y, int bw, int bh) {
      tallest = std::max(tallest, bh);
      in = in && x >= box.x && y >= box.y && x + bw <= box.x + box.w && y + bh <= box.y + box.h;
    }, 1);
    check(in && tallest >= 2, "7-character pad label fits its pad");
  }

  if (failures) return 1;
  std::printf("live sequencer: timing, pattern, layout, touch and font ok\n");
  return 0;
}
