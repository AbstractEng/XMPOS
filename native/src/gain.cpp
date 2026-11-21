#include "xmp/plugin.h"
#include <algorithm>
#include <cmath>
extern "C" void xmp_gain_process(float* left, float* right, uint32_t frames, float gain) {
  if (!left || !right) return;
  gain = std::isfinite(gain) ? std::clamp(gain,0.0f,1.0f) : 0.0f;
  for (uint32_t i = 0; i < frames; ++i) {
    left[i] = std::isfinite(left[i]) ? left[i]*gain : 0;
    right[i] = std::isfinite(right[i]) ? right[i]*gain : 0;
  }
}
