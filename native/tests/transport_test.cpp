// XMP's performance transport (xmp/transport.hpp) built natively: the same
// header the browser runs as WebAssembly, ready for the device. Browser parity
// is tests/transport-parity.test.ts.
#include "xmp/transport.hpp"

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
using namespace xmp::transport;

// Two tracks (uids 1, 2), two scenes (uids 10, 11) of 16 and 32 steps, clips 100+.
void layout(Transport& t, int32_t chain) {
  Project& p = t.next;
  p = Project{};
  p.track_count = 2;
  p.scene_count = 2;
  for (int32_t i = 0; i < 2; ++i) {
    p.track[i] = 1 + i;
    p.clip_count[i] = 2;
    p.clips[i][0] = 100 + i * 10;
    p.clips[i][1] = 101 + i * 10;
    p.selection_clip[i] = -1;
  }
  p.scene[0] = 10, p.scene_length[0] = 16, p.scene_clip[0][0] = 100, p.scene_clip[0][1] = 110;
  p.scene[1] = 11, p.scene_length[1] = 32, p.scene_clip[1][0] = 101, p.scene_clip[1][1] = -1;
  for (int32_t i = 0; i < chain; ++i) p.chain[p.chain_count++] = {200 + i, 10 + i % 2, 1 + i};
}
}  // namespace

int main() {
  auto owner = std::make_unique<Transport>();
  Transport& t = *owner;
  t.init();
  layout(t, 0);
  t.commit_project(true);

  check(t.start(10, false, false) == ok && t.running && t.slot_count == 2, "scene start");
  check(t.slots[0].clip == 100 && t.slots[1].clip == 110 && t.release_count == 2, "scene clips launched");
  t.clear_releases();
  t.advance(5);
  t.queue_scene(11);
  check(t.queued_scene_at == 16, "launch waits for the next bar");
  t.advance(15);
  check(t.scene == 10, "still the first scene before the bar");
  t.advance(16);
  check(t.scene == 11 && t.slots[0].clip == 101 && t.slots[1].clip == -1 && t.slots[0].anchor == 16,
        "second scene launched on the bar");
  t.queue_clip(2, 111);
  t.advance(40);
  check(t.slots[1].clip == 111 && t.slots[1].anchor == 32, "clip launched on its bar");
  t.stop();
  check(!t.running && t.release_count == 2, "stop releases every track");

  // Song mode: scene 10 once (16 steps), then scene 11 twice (64 steps), then stop.
  layout(t, 2);
  t.commit_project(false);
  t.clear_releases();
  check(t.start(10, true, false) == ok && t.song && t.has_occurrence, "song start");
  t.advance(15);
  check(t.scene == 10, "first occurrence");
  t.advance(16);
  check(t.scene == 11 && t.occurrence.id == 201, "second occurrence");
  t.advance(79);
  check(t.running, "second occurrence repeats");
  t.advance(80);
  check(!t.running, "song stops at its end");

  // No chain: song mode refuses to start.
  layout(t, 0);
  t.commit_project(false);
  check(t.start(10, true, false) == no_occurrence && !t.running, "song needs an occurrence");

  if (failures) return 1;
  std::printf("transport: scenes, bar-quantized launches, clips, stop and song mode OK\n");
  return 0;
}
