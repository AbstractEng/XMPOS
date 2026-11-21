#pragma once
// Sample-clock input looping. All storage is prepared before process(); the
// audio path performs no allocation, locking, filesystem I/O or scripting.
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <vector>

namespace xmp::live::sample {
constexpr int kMaxLoopFrames = 48000 * 32;  // four bars at 30 BPM

template<size_t Capacity = 32768>
class InputRing {
 public:
  bool push(float value) noexcept {
    const auto w = written_.load(std::memory_order_relaxed);
    if (w - read_.load(std::memory_order_acquire) == Capacity) {
      overflow_.store(true, std::memory_order_release);
      return false;
    }
    data_[w % Capacity] = value;
    written_.store(w + 1, std::memory_order_release);
    return true;
  }
  bool pop(float& value) noexcept {
    const auto r = read_.load(std::memory_order_relaxed);
    if (r == written_.load(std::memory_order_acquire)) return false;
    value = data_[r % Capacity];
    read_.store(r + 1, std::memory_order_release);
    return true;
  }
  size_t available() const noexcept { return static_cast<size_t>(written_.load(std::memory_order_acquire)-read_.load(std::memory_order_acquire)); }
  bool overflowed() noexcept { return overflow_.exchange(false, std::memory_order_acq_rel); }
 private:
  std::array<float, Capacity> data_{};
  std::atomic<uint64_t> written_{0}, read_{0};
  std::atomic<bool> overflow_{false};
};

inline uint64_t next_record_bar(double audible_step) {
  if (!std::isfinite(audible_step) || audible_step > 1000000) return 0;
  return static_cast<uint64_t>(std::floor(std::max(0.0, audible_step) / 16) + 1) * 16;
}
inline uint32_t loop_frames(double bpm, int bars = 4) {
  if (!std::isfinite(bpm) || bpm < 30 || bpm > 300 || (bars != 1 && bars != 2 && bars != 4)) return 0;
  return static_cast<uint32_t>(std::llround(48000.0 * 60 / bpm * bars * 4));
}

class LoopTake {
 public:
  enum class State : uint8_t { idle, queued, capturing, looping, published, cancelled, failed };
  explicit LoopTake(uint32_t capacity = kMaxLoopFrames) : pcm_(capacity) {}
  State state() const noexcept { return state_.load(std::memory_order_acquire); }
  bool busy() const noexcept {
    const auto s = state();
    return s == State::queued || s == State::capturing || s == State::looping;
  }
  // Main thread. A published/cancelled take is no longer touched by process().
  bool queue(uint64_t first_frame, uint32_t frames, int track, int pad) noexcept {
    if (busy() || first_frame > UINT64_MAX - frames || !frames || frames > pcm_.size() || track < 0 || track >= 8 || pad < 0 || pad >= 16) return false;
    first_ = first_frame, length_ = frames, track_ = track, pad_ = pad;
    captured_.store(0, std::memory_order_relaxed);
    stop_at_.store(UINT64_MAX, std::memory_order_relaxed);
    cancel_.store(false, std::memory_order_relaxed);
    state_.store(State::queued, std::memory_order_release);
    return true;
  }
  void cancel() noexcept { cancel_.store(true, std::memory_order_release); }
  void handoff_at(uint64_t frame) noexcept { stop_at_.store(frame, std::memory_order_release); }
  uint32_t frames() const noexcept { return captured_.load(std::memory_order_acquire); }
  uint32_t length() const noexcept { return length_; }
  uint64_t first_frame() const noexcept { return first_; }
  int track() const noexcept { return track_; }
  int pad() const noexcept { return pad_; }
  // Stable once looping: the recorder never trims or normalizes a timed loop.
  const float* pcm() const noexcept { return pcm_.data(); }

  void process(uint64_t frame, const float* input, const uint8_t* valid, uint32_t count,
               float* left, float* right, float gain) noexcept {
    auto s = state_.load(std::memory_order_acquire);
    if (s != State::queued && s != State::capturing && s != State::looping) return;
    if (cancel_.load(std::memory_order_acquire)) {
      state_.store(State::cancelled, std::memory_order_release);
      return;
    }
    for (uint32_t i = 0; i < count; ++i) {
      const uint64_t at = frame + i;
      if (s == State::queued && at >= first_) {
        if (at != first_) { state_.store(State::failed, std::memory_order_release); return; }
        s = State::capturing;
        state_.store(s, std::memory_order_release);
      }
      if (s == State::capturing) {
        if (!valid[i] || !std::isfinite(input[i])) {
          state_.store(State::failed, std::memory_order_release);
          return;
        }
        const auto index = static_cast<uint32_t>(at - first_);
        if (index >= length_) { state_.store(State::failed, std::memory_order_release); return; }
        pcm_[index] = std::clamp(input[i], -1.0f, 1.0f);
        captured_.store(index + 1, std::memory_order_release);
        if (index + 1 == length_) {
          s = State::looping;
          state_.store(s, std::memory_order_release);
        }
      } else if (s == State::looping) {
        if (at >= stop_at_.load(std::memory_order_acquire)) {
          state_.store(State::published, std::memory_order_release);
          return;
        }
        const float value = pcm_[static_cast<uint32_t>((at - first_ - length_) % length_)] * gain;
        left[i] += value, right[i] += value;
      }
    }
  }
 private:
  std::vector<float> pcm_;
  std::atomic<State> state_{State::idle};
  std::atomic<uint32_t> captured_{0};
  std::atomic<uint64_t> stop_at_{UINT64_MAX};
  std::atomic<bool> cancel_{false};
  uint64_t first_ = 0;
  uint32_t length_ = 0;
  int track_ = 0, pad_ = 0;
};
}  // namespace xmp::live::sample
