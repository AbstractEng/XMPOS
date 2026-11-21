// Bounded offline test port. No hardware libraries or device endpoints.
#include "xmp/sampler.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
static std::uint32_t read32(std::istream& in) {
  std::uint32_t value=0;
  for(int i=0;i<4;++i){const auto c=in.get();if(c==EOF) throw std::runtime_error("Truncated fixture");value|=static_cast<std::uint32_t>(c)<<(8*i);}
  return value;
}
static void put16(std::ostream& out,std::uint16_t n){out.put(n&255);out.put((n>>8)&255);}
static void put32(std::ostream& out,std::uint32_t n){put16(out,n&65535);put16(out,n>>16);}
int main(int argc,char** argv){
  try {
    if(argc!=3) throw std::runtime_error("Usage: xmp_fixture_render local-input.xmpf local-output.wav");
    std::ifstream input(argv[1],std::ios::binary);
    char magic[4];input.read(magic,4);
    if(!input||std::string(magic,4)!="XMPF") throw std::runtime_error("Invalid fixture header");
    const auto frames=read32(input),count=read32(input),event=read32(input);
    if(frames==0||frames>480000||count==0||count>480000||event>=frames) throw std::runtime_error("Fixture bounds exceeded");
    std::vector<float> sample(count),left(frames),right(frames);
    // Signed 16-bit little endian sample format avoids float representation assumptions.
    for(auto& value:sample){const auto lo=input.get(),hi=input.get();if(lo==EOF||hi==EOF) throw std::runtime_error("Truncated sample");value=static_cast<std::int16_t>(lo|(hi<<8))/32768.0f;}
    if(input.peek()!=EOF) throw std::runtime_error("Unexpected fixture data");
    xmp::Sampler sampler;
    for(std::uint32_t i=0;i<frames;){
      if(i==event) sampler.trigger(sample.data(),sample.size(),1.0f);
      const auto block=std::min<std::uint32_t>(128,std::min(frames-i,i<event?event-i:frames-i));
      sampler.process(left.data()+i,right.data()+i,block);i+=block;
    }
    std::ofstream out(argv[2],std::ios::binary);
    if(!out) throw std::runtime_error("Cannot open local output");
    out.write("RIFF",4);put32(out,36+frames*4);out.write("WAVEfmt ",8);put32(out,16);
    put16(out,1);put16(out,2);put32(out,48000);put32(out,192000);put16(out,4);put16(out,16);out.write("data",4);put32(out,frames*4);
    for(std::uint32_t i=0;i<frames;++i){put16(out,static_cast<std::int16_t>(std::clamp(left[i],-1.0f,1.0f)*32767));put16(out,static_cast<std::int16_t>(std::clamp(right[i],-1.0f,1.0f)*32767));}
    out.close();if(!out) throw std::runtime_error("WAV write failed");
    std::cout<<"offline fixture render: "<<frames<<" frames\n";
  } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
