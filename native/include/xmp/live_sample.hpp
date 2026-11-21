#pragma once
// The Live's Sample view (docs/live-ux.md): recording from the Live's inputs
// (AGENTS.md authorization 7) with a threshold start, the take trimmed and
// normalized, then edited (start, end, fades, tune, reverse, level) and kept
// on a kit track's pad, or sliced across its pads.
//
// Everything here runs on the session's main thread: the capture thread only
// copies the card's input into a ring (live_session.cpp), and the recorder
// reads it from there. Nothing here touches a device or a file; recordings stay
// in memory until kept, then reach the stick inside the project.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace xmp::live::sample {

constexpr int kRate = 48000;
constexpr int kMaxFrames = 32 * kRate;  // extended sample profile: four bars at 30 BPM
constexpr int kThresholdFrames = 10 * kRate;
constexpr int kPreroll = kRate / 100;   // 10 ms kept from before the threshold
constexpr float kThreshold = 0.02f;     // about -34 dBFS: what starts a take
constexpr float kFloor = 0.003f;        // about -50 dBFS: what trimming treats as silence
constexpr int kMargin = kRate / 200;    // 5 ms kept around the sound when trimming

// A take from the inputs: waiting for sound (armed), recording, then done.
class Recorder {
 public:
  enum class State : std::uint8_t { idle, armed, recording, done };
  State state = State::idle;
  float level = 0;      // the input's recent peak, for the meter (0..1)
  float loudest = 0;    // the loudest input since arming (for the log)
  std::uint64_t fed = 0;  // input frames since arming

  void arm() {
    pcm_.clear();
    pcm_.reserve(kThresholdFrames);
    preroll_.fill(0), at_ = 0, filled_ = 0, level = 0, loudest = 0, fed = 0;
    state = State::armed;
  }
  // Mono input, as it arrives.
  void feed(const float* in, int n) {
    float peak = 0;
    for (int i = 0; i < n; ++i) peak = std::max(peak, std::fabs(in[i]));
    level = std::max(peak, level * 0.85f);
    loudest = std::max(loudest, peak);
    fed += static_cast<std::uint64_t>(n);
    for (int i = 0; i < n; ++i) {
      const float v = in[i];
      if (state == State::armed) {
        if (std::fabs(v) < kThreshold) {
          preroll_[static_cast<std::size_t>(at_)] = v;
          at_ = (at_ + 1) % kPreroll, filled_ = std::min(filled_ + 1, kPreroll);
          continue;
        }
        // The sound starts: the last 10 ms first, then everything from here.
        for (int k = 0; k < filled_; ++k)
          pcm_.push_back(preroll_[static_cast<std::size_t>((at_ - filled_ + k + kPreroll) % kPreroll)]);
        state = State::recording;
      }
      if (state != State::recording) return;
      if (static_cast<int>(pcm_.size()) >= kThresholdFrames) return void(state = State::done);
      pcm_.push_back(v);
    }
  }
  // Ends the take (Rec or Stop pressed, or the card went away).
  void stop() {
    if (state == State::recording) state = State::done;
    else if (state == State::armed) state = State::idle;
  }
  void clear() {
    pcm_.clear();
    state = State::idle;
  }
  const std::vector<float>& pcm() const { return pcm_; }
  std::vector<float> take() { return std::move(pcm_); }

 private:
  std::vector<float> pcm_;
  std::array<float, kPreroll> preroll_{};
  int at_ = 0, filled_ = 0;
};

// Trims silence from both ends (keeping 5 ms around the sound) and normalizes
// the peak to full scale. A take with no sound is left empty.
inline void trim_and_normalize(std::vector<float>& pcm) {
  int first = -1, last = -1;
  float peak = 0;
  for (int i = 0; i < static_cast<int>(pcm.size()); ++i) {
    const float a = std::fabs(pcm[static_cast<std::size_t>(i)]);
    if (a >= kFloor) {
      if (first < 0) first = i;
      last = i;
    }
    peak = std::max(peak, a);
  }
  if (first < 0 || peak <= 0) return pcm.clear();
  const int from = std::max(0, first - kMargin), to = std::min(static_cast<int>(pcm.size()), last + 1 + kMargin);
  std::vector<float> out(pcm.begin() + from, pcm.begin() + to);
  for (auto& v : out) v = std::clamp(v / peak, -1.0f, 1.0f);
  pcm = std::move(out);
}

// How the take is edited before it is kept. Start and end are frames of the take.
struct Edit {
  int start = 0, end = 0;
  int fade_in = 0, fade_out = 0;  // ms, 0..500
  int tune = 0;                   // semitones, -24..24
  bool reverse = false;
  float level = 1;  // 0..1
  int slices = 1;   // 1..16: kept across this many pads
  int chop_mode = 0;  // equal, beat grid, transients, manual
  std::vector<double> markers;  // interior boundaries, fractions of the edited take

  void fit(int frames) {
    end = end <= 0 || end > frames ? frames : end;
    start = std::clamp(start, 0, std::max(0, end - 1));
    fade_in = std::clamp(fade_in, 0, 500), fade_out = std::clamp(fade_out, 0, 500);
    tune = std::clamp(tune, -24, 24), level = std::clamp(level, 0.0f, 1.0f), slices = std::clamp(slices, 1, 16);
  }
};

// The kept sound: the take between start and end, reversed, retuned (played
// faster or slower, as a sampler pitches), faded and levelled. Bounded to a
// project sample's length and to -1..1.
inline std::vector<float> render(const std::vector<float>& take, Edit e) {
  e.fit(static_cast<int>(take.size()));
  std::vector<float> part;
  if (take.empty() || e.end <= e.start) return part;
  part.assign(take.begin() + e.start, take.begin() + e.end);
  if (e.reverse) std::reverse(part.begin(), part.end());
  if (e.tune != 0) {
    const double ratio = std::pow(2.0, e.tune / 12.0);
    const auto frames = static_cast<std::size_t>(
        std::clamp<double>(std::floor(part.size() / ratio), 1, kMaxFrames));
    std::vector<float> tuned(frames);
    for (std::size_t i = 0; i < frames; ++i) {
      const double at = i * ratio;
      const auto left = std::min(part.size() - 1, static_cast<std::size_t>(at));
      const auto right = std::min(part.size() - 1, left + 1);
      const double f = at - static_cast<double>(left);
      tuned[i] = static_cast<float>(part[left] * (1 - f) + part[right] * f);
    }
    part = std::move(tuned);
  }
  const int n = static_cast<int>(part.size());
  const int in = std::min(n, e.fade_in * kRate / 1000), out = std::min(n, e.fade_out * kRate / 1000);
  for (int i = 0; i < n; ++i) {
    float g = e.level;
    if (i < in) g *= static_cast<float>(i) / in;
    if (n - 1 - i < out) g *= static_cast<float>(n - 1 - i) / out;
    part[static_cast<std::size_t>(i)] = std::clamp(part[static_cast<std::size_t>(i)] * g, -1.0f, 1.0f);
  }
  if (static_cast<int>(part.size()) > kMaxFrames) part.resize(kMaxFrames);
  return part;
}

inline const char* chop_mode_name(int mode) {
  static constexpr const char* names[] = {"Equal slices", "Beat grid", "Transients", "Manual markers"};
  return names[std::clamp(mode, 0, 3)];
}

inline std::vector<int> chop_boundaries(int frames, const Edit& edit) {
  std::vector<int> points{0};
  if (frames < 1) return points;
  if (edit.chop_mode == 0 || edit.markers.empty()) {
    const int count = std::min(std::clamp(edit.slices, 1, 16), frames);
    for (int i = 1; i < count; ++i) points.push_back(static_cast<int>(static_cast<int64_t>(frames) * i / count));
  } else {
    for (const double fraction : edit.markers) {
      if (!std::isfinite(fraction) || fraction <= 0 || fraction >= 1 || points.size() >= 16) continue;
      const int at = static_cast<int>(std::llround(fraction * frames));
      if (at > points.back() && at < frames) points.push_back(at);
    }
  }
  points.push_back(frames);
  return points;
}

inline void refresh_chops(const std::vector<float>& take, Edit& edit, double bpm) {
  if (edit.chop_mode == 0) { edit.markers.clear(); return; }
  if (edit.chop_mode == 3) { edit.slices = static_cast<int>(edit.markers.size()) + 1; return; }
  const auto pcm = render(take, edit);
  edit.markers.clear();
  if (pcm.empty()) return;
  if (edit.chop_mode == 1) {
    const int beat = static_cast<int>(std::llround(kRate * 60.0 / std::clamp(bpm, 30.0, 300.0)));
    for (int at = beat; at < static_cast<int>(pcm.size()) && edit.markers.size() < 15; at += beat)
      edit.markers.push_back(at / static_cast<double>(pcm.size()));
  } else {
    float peak = 0;
    for (const float value : pcm) peak = std::max(peak, std::fabs(value));
    const float threshold = std::max(0.03f, peak * 0.25f);
    int quiet = kRate / 100, last = 0;
    for (int i = 0; i < static_cast<int>(pcm.size()) && edit.markers.size() < 15; ++i) {
      const float level = std::fabs(pcm[static_cast<size_t>(i)]);
      if (level < threshold * 0.25f) ++quiet;
      else if (level >= threshold) {
        if (quiet >= kRate / 100 && i - last >= kRate / 50) {
          edit.markers.push_back(i / static_cast<double>(pcm.size()));
          last = i;
        }
        quiet = 0;
      }
    }
  }
  edit.slices = static_cast<int>(edit.markers.size()) + 1;
}

inline std::vector<float> preview_chop(const std::vector<float>& take, const Edit& edit, int pad) {
  auto pcm = render(take, edit);
  if (pad < 0 || (edit.slices == 1 && edit.chop_mode == 0)) return pcm;
  const auto points = chop_boundaries(static_cast<int>(pcm.size()), edit);
  if (pad + 1 >= static_cast<int>(points.size())) return {};
  return {pcm.begin() + points[static_cast<size_t>(pad)], pcm.begin() + points[static_cast<size_t>(pad + 1)]};
}

// Equal slices of `frames` for `count` pads from `pad` (no further than pad 16):
// the slice boundaries, from 0 to `frames`.
inline std::vector<double> slice_points(int frames, int count, int pad) {
  count = std::clamp(std::min(count, 16 - pad), 1, 16);
  count = std::min(count, std::max(1, frames));
  std::vector<double> points;
  for (int i = 0; i <= count; ++i) points.push_back(std::floor(static_cast<double>(frames) * i / count));
  return points;
}

// The waveform on screen: the peak of each of `columns` stretches.
inline std::vector<float> overview(const std::vector<float>& pcm, int columns) {
  std::vector<float> out(static_cast<std::size_t>(std::max(0, columns)), 0.0f);
  if (pcm.empty() || columns <= 0) return out;
  for (std::size_t i = 0; i < pcm.size(); ++i) {
    auto& c = out[std::min(out.size() - 1, i * out.size() / pcm.size())];
    c = std::max(c, std::fabs(pcm[i]));
  }
  return out;
}

inline std::string seconds_text(int frames) {
  char text[32];
  std::snprintf(text, sizeof text, "%.2f s", static_cast<double>(frames) / kRate);
  return text;
}

}  // namespace xmp::live::sample
