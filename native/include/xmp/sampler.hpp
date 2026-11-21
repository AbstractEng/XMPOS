#pragma once
#include <array>
#include <cstddef>

namespace xmp {
// This engine owns no device and performs no I/O. Samples must outlive all voices.
// Single audio-thread ownership. The future transport must deliver timestamped
// commands at block boundaries; do not invoke concurrently from a UI thread.
class Sampler {
 public:
  static constexpr std::size_t kVoices = 32;
  bool trigger(const float* mono, std::size_t frames, float velocity) noexcept;
  void process(float* left, float* right, std::size_t frames) noexcept;
  void stop() noexcept;
 private:
  struct Voice {const float* data = nullptr; std::size_t length = 0; std::size_t cursor = 0; float gain = 0;};
  std::array<Voice, kVoices> voices_{};
};
}
