#pragma once
// The device session's sample banks for kit and sampler tracks: 16 pads, each
// with up to 8 velocity layers of up to 8 round-robin takes, all mono, prepared
// before the audio thread starts and kept for the whole session. They are
// played by XMP's engine (live_engine.hpp over rack.hpp).
//
// Velocity: the hit's velocity picks the layer (layer i covers velocities up to
// its `top`); takes in a layer rotate in turn so repeated hits differ. With one
// layer, velocity scales the level directly (as the phase 1 kit did); with
// several, the recordings carry the dynamics, so velocity scales the level
// only gently inside its layer. Choke groups: a pad in a group stops the
// others in that group on the same track (the closed hat stops the open hat).
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace xmp::live {

constexpr std::size_t kMaxLayers = 8;
constexpr std::size_t kMaxTakes = 8;

struct SampleLayer {
  std::uint8_t top = 127;                 // highest velocity this layer plays
  std::vector<std::vector<float>> takes;  // round-robin takes, at least one
};

struct SamplePad {
  std::vector<SampleLayer> layers;  // ascending `top`; the last one reaches 127
  std::uint8_t choke = 0;           // 0 = no group
  float trim = 1;
  std::string name;                 // shown on the pad (sampler tracks)

  bool empty() const { return layers.empty(); }
  // Spreads `count` layers evenly over velocities 1..127.
  static std::uint8_t even_top(std::size_t layer, std::size_t count) {
    return static_cast<std::uint8_t>(count ? (127 * (layer + 1) + count - 1) / count : 127);
  }
};

struct SampleBank {
  std::array<SamplePad, 16> pads{};

  // One sound per pad (the synthesized kits).
  void set_single(int pad, std::vector<float> sound, std::uint8_t choke = 0) {
    auto& p = pads[static_cast<std::size_t>(pad)];
    p.layers.clear();
    p.layers.push_back({127, {}});
    p.layers.back().takes.push_back(std::move(sound));
    p.choke = choke;
  }
  std::size_t frames() const {
    std::size_t n = 0;
    for (const auto& p : pads)
      for (const auto& l : p.layers)
        for (const auto& t : l.takes) n += t.size();
    return n;
  }
};

// Index of the layer that plays velocity `v`.
inline std::size_t layer_for(const SamplePad& pad, int v) {
  for (std::size_t i = 0; i < pad.layers.size(); ++i)
    if (v <= pad.layers[i].top) return i;
  return pad.layers.empty() ? 0 : pad.layers.size() - 1;
}

// Level for velocity `v` (1..127) on a pad with `layers` layers.
inline float velocity_gain(std::size_t layers, int v) {
  const float x = std::clamp(v, 1, 127) / 127.0f;
  return layers <= 1 ? x : 0.6f + 0.4f * x;
}

}  // namespace xmp::live
