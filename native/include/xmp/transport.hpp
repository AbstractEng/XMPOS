#pragma once
// XMP's performance transport: which scene and clips are playing, launches
// queued to the next bar, and song mode (a chain of scene occurrences with
// repeats, resume, loop or stop at the end, and chain edits that take effect
// when the current occurrence ends). It is the C++ port of PerformanceTransport
// in packages/core performance.ts, step for step; tests/transport-parity.test.ts
// runs both.
//
// Scenes, tracks, clips and chain entries are numbers the binding assigns to
// their IDs for the transport's lifetime, so a transport survives project edits.
// Only C headers are used; fixed tables, no allocation.
#include <math.h>
#include <stdint.h>

namespace xmp::transport {

constexpr int kTracks = 16, kClips = 64, kScenes = 256, kChain = 512;
enum Error : int32_t { ok = 0, no_occurrence = 1, scene_unavailable = 2, missing_scene = 3 };

struct Entry {
  int32_t id = 0, scene = 0, repeats = 0;  // zero defaults keep the tables out of the module's data
  bool operator==(const Entry& o) const { return id == o.id && scene == o.scene && repeats == o.repeats; }
};
struct Slot {
  int32_t track = 0, clip = 0;  // clip -1: no clip
  double anchor = 0;
};
struct QueuedClip {
  int32_t track = 0, clip = 0;  // clip -1: stop the track
  double at = 0;
};

// The project as the transport sees it.
struct Project {
  int32_t track_count = 0, track[kTracks] = {}, clip_count[kTracks] = {}, clips[kTracks][kClips] = {};
  int32_t scene_count = 0, scene[kScenes] = {}, scene_clip[kScenes][kTracks] = {};
  double scene_length[kScenes] = {};
  int32_t chain_count = 0;
  Entry chain[kChain];
  bool loop = false, has_position = false, has_selection = false;
  int32_t position_occurrence = 0, selection_scene = 0, selection_clip[kTracks] = {};
  double position_offset = 0;
  double launch_grid = 16;

  int32_t scene_index(int32_t uid) const {
    for (int32_t i = 0; i < scene_count; ++i)
      if (scene[i] == uid) return i;
    return -1;
  }
  bool has_track(int32_t uid) const {
    for (int32_t i = 0; i < track_count; ++i)
      if (track[i] == uid) return true;
    return false;
  }
  bool track_has_clip(int32_t t, int32_t clip) const {
    for (int32_t i = 0; i < clip_count[t]; ++i)
      if (clips[t][i] == clip) return true;
    return false;
  }
};

class Transport {
 public:
  Project project{}, next{};
  int32_t scene = 0;
  bool has_scene = false;  // a scene has been launched
  bool running = false, song = false;
  double step = 0, song_offset = 0, clock_origin = 0;
  bool has_queued_scene = false;
  int32_t queued_scene = 0;
  double queued_scene_at = 0;
  QueuedClip queued[kTracks];
  int32_t queued_count = 0;
  Slot slots[kTracks * 2];
  int32_t slot_count = 0;
  int32_t releases[kTracks * 2] = {}, release_count = 0;
  bool has_occurrence = false;
  Entry occurrence{};
  double occurrence_start = 0, occurrence_length = 0;

  // Call once before use: not yet started is step -1. (Not a member initializer,
  // so a static transport stays zero-initialized and out of the module's data.)
  void init() { step = -1; }

  // setProject: the binding fills `next`, then commits it.
  void commit_project(bool first) {
    if (!first && running && song) {
      bool same = next.chain_count == chain_count_;
      for (int32_t i = 0; same && i < chain_count_; ++i) same = next.chain[i] == chain_[i];
      if (!same) {
        pending_count_ = next.chain_count;
        for (int32_t i = 0; i < pending_count_; ++i) pending_[i] = next.chain[i];
        has_pending_ = true;
      }
    }
    project = next;
    for (int32_t i = 0; i < slot_count;)
      if (!project.has_track(slots[i].track)) {
        release(slots[i].track);
        for (int32_t k = i; k + 1 < slot_count; ++k) slots[k] = slots[k + 1];
        --slot_count;
      } else
        ++i;
  }
  int32_t start(int32_t scene_uid, bool song_mode, bool resume) {
    running = true;
    clock_origin = 0;
    song_offset = 0;
    song = song_mode;
    step = -1;
    has_queued_scene = false;
    queued_count = 0;
    has_pending_ = false;
    has_occurrence = false;
    chain_count_ = project.chain_count;
    for (int32_t i = 0; i < chain_count_; ++i) chain_[i] = project.chain[i];
    if (song_mode) {
      const bool saved = resume && project.has_position;
      int32_t at = -1;
      for (int32_t i = 0; saved && i < chain_count_; ++i)
        if (chain_[i].id == project.position_occurrence) {
          at = i;
          break;
        }
      if (at < 0 && chain_count_) at = 0;
      if (at < 0) {
        running = false;
        return no_occurrence;
      }
      const Entry e = chain_[at];
      double length;
      if (!scene_length(e.scene, length)) return missing_scene;
      const double offset = saved && project.position_occurrence == e.id ? project.position_offset : 0;
      double before = 0;
      for (int32_t i = 0; i < at; ++i) {
        double l;
        if (!scene_length(chain_[i].scene, l)) return missing_scene;
        before += l * chain_[i].repeats;
      }
      song_offset = before + offset;
      clock_origin = song_offset;
      has_occurrence = true;
      occurrence = e;
      occurrence_start = -offset;
      occurrence_length = length;
      return launch(e.scene, -fmod(offset, length), false);
    }
    return launch(scene_uid, 0, project.has_selection && project.selection_scene == scene_uid);
  }
  void queue_scene(int32_t scene_uid) {
    queued_count = 0;
    has_queued_scene = true;
    queued_scene = scene_uid;
    queued_scene_at = next_bar();
  }
  void queue_clip(int32_t track, int32_t clip) {
    has_queued_scene = false;
    for (int32_t i = 0; i < queued_count; ++i)
      if (queued[i].track == track) {
        queued[i] = {track, clip, next_bar()};
        return;
      }
    if (queued_count < kTracks) queued[queued_count++] = {track, clip, next_bar()};
  }
  bool queue_clip_at(int32_t track, int32_t clip, double at) {
    if (!isfinite(at) || at < step || at > 1000000) return false;
    queue_clip(track,clip);
    for (int i=0;i<queued_count;++i) if (queued[i].track == track) queued[i].at = at;
    return true;
  }
  void cancel_clip(int32_t track) {
    for (int32_t i = 0; i < queued_count;)
      if (queued[i].track == track) {
        for (int32_t k = i; k + 1 < queued_count; ++k) queued[k] = queued[k + 1];
        --queued_count;
      } else ++i;
  }
  bool stop_clip_now(int32_t track) {
    if (!project.has_track(track)) return false;
    cancel_clip(track);
    set_slot(track, -1, step);
    release(track);
    return true;
  }
  bool cancel() {
    const bool had = has_queued_scene || queued_count;
    has_queued_scene = false;
    queued_count = 0;
    return had;
  }
  void stop() {
    running = false;
    cancel();
    for (int32_t i = 0; i < project.track_count; ++i) release(project.track[i]);
  }
  // advance: everything due on steps after the current one, up to `to`.
  int32_t advance(double to) {
    for (double n = step + 1; n <= to && running; ++n) {
      if (has_queued_scene && n >= queued_scene_at) {
        const int32_t error = launch(queued_scene, n, false);
        if (error) return error;
        song = false;
        has_occurrence = false;
        has_queued_scene = false;
      }
      for (int32_t i = 0; i < queued_count;) {
        if (n >= queued[i].at) {
          set_slot(queued[i].track, queued[i].clip, n);
          release(queued[i].track);
          for (int32_t k = i; k + 1 < queued_count; ++k) queued[k] = queued[k + 1];
          --queued_count;
          song = false;
          has_occurrence = false;
        } else
          ++i;
      }
      if (song && has_occurrence && n >= occurrence_start + occurrence_length * occurrence.repeats) {
        const int32_t index = find(chain_, chain_count_, occurrence.id);
        Entry old[kChain];
        const int32_t old_count = chain_count_;
        for (int32_t i = 0; i < old_count; ++i) old[i] = chain_[i];
        if (has_pending_) {
          chain_count_ = pending_count_;
          for (int32_t i = 0; i < chain_count_; ++i) chain_[i] = pending_[i];
        }
        has_pending_ = false;
        const int32_t now = find(chain_, chain_count_, occurrence.id);
        const Entry* following = nullptr;
        if (now >= 0)
          following = now + 1 < chain_count_ ? &chain_[now + 1] : nullptr;
        else
          for (int32_t i = index + 1; i < old_count && !following; ++i) {
            const int32_t k = find(chain_, chain_count_, old[i].id);
            if (k >= 0) following = &chain_[k];
          }
        if (!following && project.loop) {
          following = chain_count_ ? &chain_[0] : nullptr;
          song_offset = -n;
        }
        if (!following) {
          running = false;
          for (int32_t i = 0; i < project.track_count; ++i) release(project.track[i]);
        } else {
          const Entry e = *following;
          double length;
          if (!scene_length(e.scene, length)) return missing_scene;
          has_occurrence = true;
          occurrence = e;
          occurrence_start = n;
          occurrence_length = length;
          const int32_t error = launch(e.scene, n, false);
          if (error) return error;
        }
      }
      step = n;
    }
    step = to;
    return ok;
  }
  void clear_releases() { release_count = 0; }

 private:
  double next_bar() const {
    const double grid = project.launch_grid;
    // Immediate launches land on the next unscheduled step; no old audio is rewritten.
    return grid <= 0 ? fmax(0, step + 1) : (floor(fmax(0, step) / grid) + 1) * grid;
  }
  static int32_t find(const Entry* list, int32_t count, int32_t id) {
    for (int32_t i = 0; i < count; ++i)
      if (list[i].id == id) return i;
    return -1;
  }
  bool scene_length(int32_t uid, double& length) const {
    const int32_t i = project.scene_index(uid);
    if (i < 0) return false;
    length = project.scene_length[i];
    return true;
  }
  void release(int32_t track) {
    for (int32_t i = 0; i < release_count; ++i)
      if (releases[i] == track) return;
    if (release_count < kTracks * 2) releases[release_count++] = track;
  }
  void set_slot(int32_t track, int32_t clip, double anchor) {
    for (int32_t i = 0; i < slot_count; ++i)
      if (slots[i].track == track) {
        slots[i].clip = clip;
        slots[i].anchor = anchor;
        return;
      }
    if (slot_count < kTracks * 2) slots[slot_count++] = {track, clip, anchor};
  }
  int32_t launch(int32_t scene_uid, double at, bool selection) {
    const int32_t s = project.scene_index(scene_uid);
    if (s < 0) return scene_unavailable;
    scene = scene_uid;
    has_scene = true;
    for (int32_t t = 0; t < project.track_count; ++t) {
      release(project.track[t]);
      const int32_t clip = selection ? project.selection_clip[t] : project.scene_clip[s][t];
      set_slot(project.track[t], clip >= 0 && project.track_has_clip(t, clip) ? clip : -1, at);
    }
    return ok;
  }

  Entry chain_[kChain], pending_[kChain];
  int32_t chain_count_ = 0, pending_count_ = 0;
  bool has_pending_ = false;
};

}  // namespace xmp::transport
