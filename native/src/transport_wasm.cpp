// WebAssembly exports of XMP's performance transport (xmp/transport.hpp).
// packages/core/src/performance.ts is the only caller; one transport per instance.
#include "xmp/transport.hpp"

using namespace xmp::transport;

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static Transport transport;
static int32_t scratch[kClips];

EXPORT(tx_init) void tx_init() { transport.init(); }
EXPORT(tx_scratch) int32_t* tx_scratch() { return scratch; }

// ---- the project (setProject) ----
EXPORT(tx_project_begin)
void tx_project_begin(int32_t tracks, int32_t scenes, int32_t loop, int32_t has_position, int32_t occurrence,
                      double offset, int32_t has_selection, int32_t selection_scene) {
  Project& p = transport.next;
  p = Project{};
  p.track_count = tracks < 0 ? 0 : tracks > kTracks ? kTracks : tracks;
  p.scene_count = scenes < 0 ? 0 : scenes > kScenes ? kScenes : scenes;
  p.loop = loop;
  p.has_position = has_position;
  p.position_occurrence = occurrence;
  p.position_offset = offset;
  p.has_selection = has_selection;
  p.selection_scene = selection_scene;
  for (auto& c : p.selection_clip) c = -1;
}
// The track's clips in scratch[0 .. count).
EXPORT(tx_track) int32_t tx_track(int32_t i, int32_t uid, int32_t count, int32_t selection_clip) {
  Project& p = transport.next;
  if (i < 0 || i >= p.track_count || count < 0 || count > kClips) return 0;
  p.track[i] = uid;
  p.clip_count[i] = count;
  for (int32_t k = 0; k < count; ++k) p.clips[i][k] = scratch[k];
  p.selection_clip[i] = selection_clip;
  return 1;
}
// The scene's clip for each track, in track order, in scratch.
EXPORT(tx_scene) int32_t tx_scene(int32_t i, int32_t uid, double length) {
  Project& p = transport.next;
  if (i < 0 || i >= p.scene_count) return 0;
  p.scene[i] = uid;
  p.scene_length[i] = length;
  for (int32_t t = 0; t < p.track_count; ++t) p.scene_clip[i][t] = scratch[t];
  return 1;
}
EXPORT(tx_chain) int32_t tx_chain(int32_t id, int32_t scene, int32_t repeats) {
  Project& p = transport.next;
  if (p.chain_count >= kChain) return 0;
  p.chain[p.chain_count++] = {id, scene, repeats};
  return 1;
}
EXPORT(tx_project_commit) void tx_project_commit(int32_t first) { transport.commit_project(first); }
EXPORT(tx_launch_grid) void tx_launch_grid(double grid) {
  if (grid == 0 || grid == 4 || grid == 16 || grid == 32 || grid == 64) transport.next.launch_grid = grid;
}

// ---- control ----
EXPORT(tx_start) int32_t tx_start(int32_t scene, int32_t song, int32_t resume) {
  return transport.start(scene, song, resume);
}
EXPORT(tx_queue_scene) void tx_queue_scene(int32_t scene) { transport.queue_scene(scene); }
EXPORT(tx_queue_clip_at) int tx_queue_clip_at(int32_t track, int32_t clip, double at) { return transport.queue_clip_at(track,clip,at); }
EXPORT(tx_queue_clip) void tx_queue_clip(int32_t track, int32_t clip) { transport.queue_clip(track, clip); }
EXPORT(tx_cancel) int32_t tx_cancel() { return transport.cancel(); }
EXPORT(tx_stop) void tx_stop() { transport.stop(); }
EXPORT(tx_advance) int32_t tx_advance(double step) { return transport.advance(step); }

// ---- state ----
EXPORT(tx_running) int32_t tx_running() { return transport.running; }
EXPORT(tx_song) int32_t tx_song() { return transport.song; }
EXPORT(tx_step) double tx_step() { return transport.step; }
EXPORT(tx_song_offset) double tx_song_offset() { return transport.song_offset; }
EXPORT(tx_clock_origin) double tx_clock_origin() { return transport.clock_origin; }
EXPORT(tx_scene_uid) int32_t tx_scene_uid() { return transport.has_scene ? transport.scene : -1; }
EXPORT(tx_queued_scene) int32_t tx_queued_scene() { return transport.has_queued_scene ? transport.queued_scene : -1; }
EXPORT(tx_queued_scene_at) double tx_queued_scene_at() { return transport.queued_scene_at; }
EXPORT(tx_queued_count) int32_t tx_queued_count() { return transport.queued_count; }
EXPORT(tx_queued_track) int32_t tx_queued_track(int32_t i) { return transport.queued[i].track; }
EXPORT(tx_queued_clip) int32_t tx_queued_clip(int32_t i) { return transport.queued[i].clip; }
EXPORT(tx_queued_at) double tx_queued_at(int32_t i) { return transport.queued[i].at; }
EXPORT(tx_slot_count) int32_t tx_slot_count() { return transport.slot_count; }
EXPORT(tx_slot_track) int32_t tx_slot_track(int32_t i) { return transport.slots[i].track; }
EXPORT(tx_slot_clip) int32_t tx_slot_clip(int32_t i) { return transport.slots[i].clip; }
EXPORT(tx_slot_anchor) double tx_slot_anchor(int32_t i) { return transport.slots[i].anchor; }
EXPORT(tx_release_count) int32_t tx_release_count() { return transport.release_count; }
EXPORT(tx_release) int32_t tx_release(int32_t i) { return transport.releases[i]; }
EXPORT(tx_clear_releases) void tx_clear_releases() { transport.clear_releases(); }
EXPORT(tx_has_occurrence) int32_t tx_has_occurrence() { return transport.has_occurrence; }
EXPORT(tx_occurrence_id) int32_t tx_occurrence_id() { return transport.occurrence.id; }
EXPORT(tx_occurrence_start) double tx_occurrence_start() { return transport.occurrence_start; }
EXPORT(tx_occurrence_span) double tx_occurrence_span() {
  return transport.occurrence_length * transport.occurrence.repeats;
}
