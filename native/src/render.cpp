#include "xmp/sampler.hpp"
#include "xmp/plugin.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <vector>
static void u16(std::ofstream& out, std::uint16_t n) {out.put(n & 255); out.put((n >> 8) & 255);}
static void u32(std::ofstream& out, std::uint32_t n) {u16(out,n & 65535); u16(out,n >> 16);}
int main(int argc, char** argv) {
  if (argc != 2) {std::cerr << "Usage: xmp_render <local-output.wav>\n"; return 1;}
  constexpr int rate = 48000, frames = rate*3;
  std::vector<float> sample(rate/3), left(frames), right(frames);
  double phase = 0;
  for (std::size_t i = 0; i < sample.size(); ++i) {
    const double t = static_cast<double>(i)/rate;
    phase += 6.283185307179586*(48+110*std::exp(-35*t))/rate;
    sample[i] = static_cast<float>(std::sin(phase)*std::exp(-14*t)*std::min(1.0,i/80.0)*0.7);
  }
  xmp::Sampler sampler;
  for (int i = 0; i < frames;) {
    if (i % (rate/2) == 0) sampler.trigger(sample.data(),sample.size(),0.8f);
    const auto block = std::min(128,std::min(frames-i,rate/2-i%(rate/2)));
    sampler.process(left.data()+i,right.data()+i,block);
    xmp_gain_process(left.data()+i,right.data()+i,block,0.55f);
    i += block;
  }
  std::ofstream out(argv[1],std::ios::binary);
  if (!out) {std::cerr << "Could not open local output\n"; return 1;}
  out.write("RIFF",4); u32(out,36+frames*4); out.write("WAVEfmt ",8); u32(out,16);
  u16(out,1); u16(out,2); u32(out,rate); u32(out,rate*4); u16(out,4); u16(out,16);
  out.write("data",4); u32(out,frames*4);
  for (int i = 0; i < frames; ++i) {u16(out,static_cast<std::int16_t>(left[i]*32767)); u16(out,static_cast<std::int16_t>(right[i]*32767));}
  out.close();
  if (!out) {std::cerr << "WAV write failed\n"; return 1;}
  std::cout << "Rendered original kick pattern: " << argv[1] << "\n";
}
