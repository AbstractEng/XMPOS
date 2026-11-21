#include "xmp/sampler.hpp"
#include "xmp/plugin.h"
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
static void check(bool ok) {if (!ok) {std::cerr << "DSP check failed\n"; std::exit(1);}}
int main() {
  xmp::Sampler sampler;
  const float sample[] = {0.5f, -0.5f, 0.25f};
  float left[4]{}, right[4]{};
  check(sampler.trigger(sample,3,0.5f));
  sampler.process(left,right,2);
  check(left[0] == 0.25f && left[1] == -0.25f && right[0] == left[0]);
  sampler.process(left,right,4);
  check(left[0] == 0.125f && left[1] == 0 && left[3] == 0);
  check(!sampler.trigger(nullptr,3,1));
  check(!sampler.trigger(sample,0,1));
  check(!sampler.trigger(sample,3,std::numeric_limits<float>::quiet_NaN()));
  for (std::size_t i = 0; i < xmp::Sampler::kVoices; ++i) check(sampler.trigger(sample,3,1));
  check(!sampler.trigger(sample,3,1));
  sampler.process(left,right,1); check(left[0] == 1);
  sampler.stop(); sampler.process(left,right,4); check(left[0] == 0 && left[3] == 0);
  left[0] = 0.75f; right[0] = -0.5f;
  xmp_gain_process(left,right,1,0.5f); check(left[0] == 0.375f && right[0] == -0.25f);
  xmp_gain_process(left,right,1,std::numeric_limits<float>::infinity()); check(left[0] == 0 && right[0] == 0);
  std::cout << "Sampler continuity, silence, bounds, saturation and gain passed\n";
}
