#pragma once
// The device session's colours: emerald and gold, made to sit with the owner's
// gold MPC Live, and matching the Device app's theme (apps/studio/src/device/
// style.css). Ivory text on deep emerald-black for contrast; emerald marks what
// is active, gold marks steps, levels, selection and accents.
#include <algorithm>
#include <cstdint>

namespace xmp::live::theme {

struct Rgb {
  std::uint8_t r, g, b;
};

constexpr Rgb kBackground{7, 17, 13};
constexpr Rgb kBar{15, 31, 25};
constexpr Rgb kSurface{20, 42, 33};
constexpr Rgb kSurfaceRaised{27, 56, 44};
constexpr Rgb kStepIdle{18, 38, 30};
constexpr Rgb kStepBeat{26, 52, 41};
constexpr Rgb kEmeraldDeep{14, 77, 56};
constexpr Rgb kEmerald{20, 166, 115};
constexpr Rgb kEmeraldBright{62, 214, 154};
constexpr Rgb kGoldDeep{143, 114, 40};
constexpr Rgb kGold{216, 180, 80};
constexpr Rgb kGoldBright{242, 214, 133};
constexpr Rgb kIvory{244, 236, 214};
constexpr Rgb kRuby{210, 88, 76};
constexpr Rgb kRubyDeep{90, 28, 26};
constexpr Rgb kLightOff{40, 60, 52};

inline Rgb mix(Rgb a, Rgb b, float t) {
  t = std::clamp(t, 0.0f, 1.0f);
  auto m = [t](std::uint8_t x, std::uint8_t y) {
    return static_cast<std::uint8_t>(static_cast<float>(x) + (static_cast<float>(y) - static_cast<float>(x)) * t + 0.5f);
  };
  return {m(a.r, b.r), m(a.g, b.g), m(a.b, b.b)};
}

// A pad lit by a hit: from its resting surface towards bright emerald.
inline Rgb pad_colour(float level) { return mix(kSurface, kEmeraldBright, level); }
// A step that is on: deep to bright gold with its velocity.
inline Rgb step_colour(std::uint8_t velocity) { return mix(kGoldDeep, kGoldBright, velocity / 127.0f); }

}  // namespace xmp::live::theme
