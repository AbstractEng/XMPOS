// XMP's performance controls (xmp/controls.hpp) built natively: the same header
// the browser runs as WebAssembly, ready for the device. Browser parity is
// tests/controls-parity.test.ts.
#include "xmp/controls.hpp"

#include <cmath>
#include <cstdio>
#include <memory>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
using namespace xmp::controls;

// Tracks 1 (MIDI source, routed to track index 1), 2 (synth), 3; macro 20
// assigned to parameters 30 and 31 (31 unavailable).
void layout(Controls& c) {
  Setup& s = c.setup;
  s = Setup{};
  s.bpm = 120;
  s.track_count = 3;
  const int32_t uids[] = {1, 2, 3}, destinations[] = {1, -1, -1};
  for (int32_t t = 0; t < 3; ++t) {
    s.track[t] = uids[t];
    s.destination[t] = destinations[t];
  }
  s.macro_count = 1;
  s.macro[0] = 20;
  s.macro_value[0] = 1;
  s.assignment_count[0] = 2;
  s.assignments[0] = {30, 0.75, true};
  s.assignments[1] = {31, 0.5, false};
  s.total_assignments = 2;
  s.event_count = 2;
  s.events[0] = {mute, 3, 1, 8};
  s.events[1] = {solo, 1, 1, 16};
  s.tempo_count = 1;
  s.tempo_step[0] = 16;
  s.tempo_bpm[0] = 60;
}
}  // namespace

int main() {
  auto c = std::make_unique<Controls>();
  layout(*c);
  c->evaluate(0, true);
  check(c->blocked_count == 0, "nothing blocked at the start");
  check(c->offsets.count == 1 && c->offsets.items[0].value == 0.75, "macro offset");
  check(c->unavailable_count == 1 && c->unavailable[0] == 31, "unavailable assignment");
  check(c->is_blocked(2, 8) && !c->is_blocked(0, 8), "recorded mute applies at its step");
  c->evaluate(16, false);
  check(c->blocked_count == 1 && c->blocked[0] == 2, "soloed MIDI source keeps its synth audible");
  c->setup.overrides[0] = {solo, 1, 0, 0};
  c->setup.override_count = 1;
  check(!c->is_blocked(1, 16) && c->is_blocked(2, 16), "a live override clears the solo");
  c->setup.overrides[0] = {macro, 20, 0, 0};
  c->evaluate(0, true);
  check(c->offsets.items[0].value == -0.75, "a live macro override");
  check(c->musical_seconds(16) == 2 && c->musical_seconds(20) == 3, "tempo map");
  check(std::isnan(c->musical_seconds(-1)), "refused position");
  int32_t error = 0;
  check(c->window_frame(1, 0.5, 48000, 0, error) == 9000 && !error, "swung frame");
  c->window_frame(1, 0.6, 48000, 0, error);
  check(error == invalid_groove, "refused swing");
  if (failures) return 1;
  std::printf("performance controls: all checks passed\n");
  return 0;
}
