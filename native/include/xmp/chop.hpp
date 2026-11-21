#pragma once
// Chop points for the Sampler machine. Mirrors packages/core/src/chop.ts step for
// step (same constants, same arithmetic order). Main thread only; allocates.
#include <algorithm>
#include <cmath>
#include <vector>

namespace xmp::chop {
constexpr int kMaxSlices = 16, kHop = 256, kWindow = 512;
constexpr double kSilence = 1e-6;

inline std::vector<int> even(int frames, int count) {
  if (frames < 1) return {};
  const int n = std::max(1, std::min({kMaxSlices, count, frames}));
  std::vector<int> out;
  for (int i = 0; i < n; ++i) out.push_back(static_cast<int>(std::floor(static_cast<double>(frames) * i / n)));
  return out;
}

inline std::vector<int> transients(const std::vector<float>& pcm, double rate, double sensitivity) {
  const int frames = static_cast<int>(pcm.size());
  if (frames < 1) return {};
  const double s = std::clamp(sensitivity, 0.0, 1.0);
  const int count = frames / kHop;
  std::vector<double> energy(count, 0.0), flux(count, 0.0);
  for (int i = 0; i < count; ++i) {
    double sum = 0;
    for (int j = i * kHop; j < std::min(frames, i * kHop + kWindow); ++j) sum += static_cast<double>(pcm[j]) * pcm[j];
    energy[i] = sum;
  }
  for (int i = 1; i < count; ++i) flux[i] = std::max(0.0, std::log10(energy[i] + 1e-9) - std::log10(energy[i - 1] + 1e-9));
  double strongest = 0;
  for (const double f : flux) strongest = std::max(strongest, f);
  if (strongest <= 0) return {0};
  const double threshold = (1 - s) * strongest;
  struct Candidate { int at; double flux; };
  std::vector<Candidate> candidates;
  for (int i = 1; i < count; ++i) {
    const double f = flux[i], next = i + 1 < count ? flux[i + 1] : 0;
    if (f > 0 && f >= threshold && f >= flux[i - 1] && f > next && energy[i] > kSilence * kWindow)
      candidates.push_back({i * kHop, f});
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const Candidate& a, const Candidate& b) { return a.flux != b.flux ? a.flux > b.flux : a.at < b.at; });
  const int gap = static_cast<int>(std::lround(0.05 * rate));
  std::vector<int> points{0};
  for (const auto& c : candidates) {
    if (static_cast<int>(points.size()) >= kMaxSlices) break;
    if (std::all_of(points.begin(), points.end(), [&](int p) { return std::abs(p - c.at) >= gap; })) points.push_back(c.at);
  }
  std::sort(points.begin(), points.end());
  return points;
}

inline std::vector<int> clean(std::vector<int> points, int frames) {
  std::sort(points.begin(), points.end());
  std::vector<int> out{0};
  for (const int p : points)
    if (p > out.back() && p < frames && static_cast<int>(out.size()) < kMaxSlices) out.push_back(p);
  return out;
}
}  // namespace xmp::chop
