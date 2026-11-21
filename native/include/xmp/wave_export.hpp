#pragma once
// Offline playback uses the production player in bounded blocks. No audio device,
// complete-song PCM buffer, MIDI-event list or per-song command queue is needed.
#include <cmath>
#include "xmp/live_player.hpp"
namespace xmp::files {
class WaveExport {
 public:
  static constexpr int kBlock = 4096;
  static constexpr double kMaxSeconds = 1800;
  Str error;
  uint64_t frames = 0, position = 0;
  unsigned char bytes[44 + kBlock * 4]{};
  bool begin(const json::Value& project, bool song, const Str& scene, double tail) {
    using namespace project::detail;
    if (!std::isfinite(tail) || tail < 0 || tail > 8) return error = "Tail must be between zero and eight seconds", false;
    double steps = 0;
    if (song) {
      const auto& perf = at(project, "performance");
      if (str(perf, "end") != "stop" || list(perf, "chain").empty()) return error = "Song export requires a finite chain ending in Stop", false;
      for (const auto& block : list(perf, "chain")) {
        const json::Value* scene_value = nullptr;
        for (const auto& s : list(project, "scenes")) if (str(s, "id") == str(block, "sceneId")) scene_value = &s;
        if (!scene_value) return error = "Song scene unavailable", false;
        steps += play::detail::scene_length(project, *scene_value) * num(block, "repeats");
      }
    } else {
      const json::Value* scene_value = nullptr;
      for (const auto& s : list(project, "scenes")) if (str(s, "id") == scene) scene_value = &s;
      if (!scene_value) return error = "Scene unavailable", false;
      steps = play::detail::scene_length(project, *scene_value);
    }
    double seconds = 0;
    if (!render::detail::musical_seconds(project, steps, seconds, error)) return false;
    if (seconds <= 0 || seconds + tail > kMaxSeconds) return error = "WAV export supports up to thirty minutes including the tail", false;
    frames = static_cast<uint64_t>(render::detail::js_round((seconds + tail) * 48000));
    if (!sound.prepare(project, error) || !player.start(project, sound, scene, song, 0, song ? 0 : steps, error)) return false;
    auto u16 = [&](int at, uint32_t n) { bytes[at] = n; bytes[at + 1] = n >> 8; };
    auto u32 = [&](int at, uint32_t n) { u16(at, n); u16(at + 2, n >> 16); };
    memcpy(bytes, "RIFF", 4); u32(4, 36 + frames * 4); memcpy(bytes + 8, "WAVEfmt ", 8);
    u32(16, 16); u16(20, 1); u16(22, 2); u32(24, 48000); u32(28, 192000); u16(32, 4); u16(34, 16);
    memcpy(bytes + 36, "data", 4); u32(40, frames * 4);
    return true;
  }
  // Header first; then <=4096 stereo frames. A negative result is an error.
  int next() {
    if (!header_sent) { header_sent = true; return 44; }
    if (position >= frames) return 0;
    const int n = std::min<uint64_t>(kBlock, frames - position);
    if (player.playing() && !player.fill(position + n + 1, error)) return -1;
    float left[kBlock]{}, right[kBlock]{};
    sound.process(left, right, n, position);
    if (sound.dropped() || sound.late()) return error = "Export scheduling failed", -1;
    for (int i = 0; i < n; ++i) for (int ch = 0; ch < 2; ++ch) {
      const double v = ch ? right[i] : left[i];
      if (!std::isfinite(v)) return error = "Non-finite export audio", -1;
      const double clamped = std::clamp(v, -1.0, 1.0), scaled = clamped * (clamped < 0 ? 32768 : 32767);
      const uint16_t pcm = static_cast<int16_t>(render::detail::js_round(scaled));
      bytes[i * 4 + ch * 2] = pcm; bytes[i * 4 + ch * 2 + 1] = pcm >> 8;
    }
    position += n; return n * 4;
  }
 private:
  live::ProjectSound sound;
  live::ProjectPlayer player;
  bool header_sent = false;
};
} // namespace xmp::files
