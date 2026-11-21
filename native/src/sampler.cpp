#include "xmp/sampler.hpp"
#include <algorithm>
#include <cmath>

bool xmp::Sampler::trigger(const float* mono, std::size_t frames, float velocity) noexcept {
  if (!mono || frames == 0 || !std::isfinite(velocity)) return false;
  for (auto& voice : voices_) {
    if (!voice.data) {
      voice = {mono, frames, 0, std::clamp(velocity, 0.0f, 1.0f)};
      return true;
    }
  }
  return false;  // Bounded work and deterministic refusal when all voices are busy.
}
void xmp::Sampler::process(float* left, float* right, std::size_t frames) noexcept {
  if (!left || !right) return;
  for (std::size_t i = 0; i < frames; ++i) {
    float mixed = 0;
    for (auto& voice : voices_) {
      if (!voice.data) continue;
      const float value = voice.data[voice.cursor++] * voice.gain;
      if (std::isfinite(value)) mixed += value;
      if (voice.cursor == voice.length) voice.data = nullptr;
    }
    left[i] = right[i] = std::clamp(mixed, -1.0f, 1.0f);
  }
}
void xmp::Sampler::stop() noexcept { for (auto& voice : voices_) voice = {}; }
