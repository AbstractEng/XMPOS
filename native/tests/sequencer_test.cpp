// XMP's sequencer (xmp/sequencer.hpp) built natively: the same header the
// browser runs as WebAssembly, checked with the system compiler so it stays
// ready for the device. Browser parity is tests/sequencer-parity.test.ts.
#include "xmp/sequencer.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
using namespace xmp::sequencer;

Text put(Plan& plan, const char* s) {
  const int32_t n = static_cast<int32_t>(std::strlen(s));
  for (int32_t i = 0; i < n; ++i) plan.pool_tail()[i] = static_cast<uint8_t>(s[i]);
  return plan.commit_text(n);
}
}  // namespace

int main() {
  // Swing pushes every second sixteenth late; step times follow it.
  check(groove_position(1, 0.2) == 1.2 && groove_position(2, 0.2) == 2, "groove position");
  check(std::fabs(step_time(1, 120, 0.25) - 0.15625) < 1e-12, "swung step time");
  check(js_round(0.49999999999999994) == 0 && js_round(2.5) == 3, "Math.round");

  auto plan = std::make_unique<Plan>();
  Plan& p = *plan;
  p.reset(0);
  p.set_project(put(p, "first-light"));
  const int32_t t = p.add_track(put(p, "drums"), put(p, "clip-0"), 16);
  Note kick;
  kick.legacy = true;
  kick.id = put(p, "step-0-0");
  p.add_note(t, kick);
  Note late;
  late.id = put(p, "n1");
  late.position = 4;
  late.microtiming = 0.25;
  late.condition = every_2;
  p.add_note(t, late);

  // Two bars: the step note every cycle, the late note only on even cycles.
  check(p.window(0, 32, false) == 3, "notes in two cycles");
  check(p.results[0].position == 0 && p.results[1].position == 4.25 && p.results[2].position == 16,
        "positions with microtiming, in order");
  p.timeline(0, 120, 48000);
  check(p.results[1].frame == 25500, "frame of a late note at 120 BPM");
  check(p.step_events(16) == 1 && p.step_events(17) == 0, "step events on their step");

  // Automation: a lane from 0.2 to 0.8 at step 8, and a step lock on step 10.
  Sources gain;
  gain.value[0] = 0.5;
  p.add_parameter(gain);
  const int32_t c = p.add_clip_track(16);
  const double positions[2] = {0, 8}, values[2] = {0.2, 0.8};
  p.add_lane(c, 0, positions, values, 2);
  p.add_lock(c, 0, 10, 1);
  double out[1] = {0}, none[1] = {NAN};
  p.parameter_frame(3, none, out);
  check(out[0] == 0.2, "lane value before its second point");
  p.parameter_frame(9, none, out);
  check(out[0] == 0.8, "lane value after its second point");
  p.parameter_frame(10.5, none, out);
  check(out[0] == 1, "step lock wins over the lane");
  const double offset[1] = {-0.5};
  p.parameter_frame(25, offset, out);
  check(std::fabs(out[0] - 0.3) < 1e-12, "macro offset added to the next cycle's lane");
  p.parameter_frame(9, none, out, -1);
  check(out[0] == 0.5, "no clip track applied: the base value");
  p.parameter_frame(9, none, out, c);
  check(out[0] == 0.8, "only its own clip track applied");

  if (failures) return 1;
  std::printf("sequencer: swing, cycles, microtiming, conditions, frames, steps and automation OK\n");
  return 0;
}
