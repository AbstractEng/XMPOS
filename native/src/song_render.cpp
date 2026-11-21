// Offline prepared-song protocol. Preparation and file I/O stay outside callbacks.
#include "xmp/sampler.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
static std::uint32_t read32(std::istream& in){std::uint32_t n=0;for(int i=0;i<4;++i){const int c=in.get();if(c==EOF)throw std::runtime_error("Truncated song plan");n|=static_cast<std::uint32_t>(c)<<(8*i);}return n;}
static float read_float(std::istream& in){const auto bits=read32(in);float value;static_assert(sizeof(value)==sizeof(bits));std::memcpy(&value,&bits,sizeof(value));if(!std::isfinite(value))throw std::runtime_error("Non-finite song value");return value;}
static void put16(std::ostream& out,std::uint16_t n){out.put(n&255);out.put((n>>8)&255);}
static void put32(std::ostream& out,std::uint32_t n){put16(out,n&65535);put16(out,n>>16);}
struct Event {std::uint32_t frame,sample;float velocity;};
int main(int argc,char** argv){
 try{
  if(argc!=3)throw std::runtime_error("Expected local song plan and output WAV");
  std::ifstream input(argv[1],std::ios::binary);char magic[4];input.read(magic,4);if(!input||std::string(magic,4)!="XMPS")throw std::runtime_error("Invalid song header");
  const auto frames=read32(input),sample_count=read32(input),event_count=read32(input);
  if(frames==0||frames>2100000||sample_count==0||sample_count>16||event_count>8192)throw std::runtime_error("Song plan bounds exceeded");
  std::vector<std::vector<float>> samples;std::uint32_t total=0;
  for(std::uint32_t i=0;i<sample_count;++i){const auto size=read32(input);if(size==0||size>1000000-total)throw std::runtime_error("Sample budget exceeded");total+=size;samples.emplace_back(size);for(auto& value:samples.back()){value=read_float(input);if(std::abs(value)>1)throw std::runtime_error("Invalid sample amplitude");}}
  std::vector<Event> events;std::uint32_t previous=0;
  for(std::uint32_t i=0;i<event_count;++i){const auto frame=read32(input),sample=read32(input);const auto velocity=read_float(input);if(frame>=frames||frame<previous||sample>=sample_count||velocity<0||velocity>1)throw std::runtime_error("Invalid song event");previous=frame;events.push_back({frame,sample,velocity});}
  if(input.peek()!=EOF)throw std::runtime_error("Trailing song data");
  std::vector<float> left(frames),right(frames);xmp::Sampler sampler;std::size_t event=0;
  for(std::uint32_t frame=0;frame<frames;){
   while(event<events.size()&&events[event].frame==frame){const auto& item=events[event++];if(!sampler.trigger(samples[item.sample].data(),samples[item.sample].size(),item.velocity))throw std::runtime_error("Voice budget exceeded");}
   const auto next=event<events.size()?events[event].frame:frames;
   const auto block=std::min<std::uint32_t>(128,std::min(frames-frame,next-frame));if(block==0)throw std::runtime_error("Invalid event progress");sampler.process(left.data()+frame,right.data()+frame,block);frame+=block;
  }
  std::ofstream out(argv[2],std::ios::binary);if(!out)throw std::runtime_error("Cannot open local capture");
  out.write("RIFF",4);put32(out,36+frames*4);out.write("WAVEfmt ",8);put32(out,16);put16(out,1);put16(out,2);put32(out,48000);put32(out,192000);put16(out,4);put16(out,16);out.write("data",4);put32(out,frames*4);
  for(std::uint32_t i=0;i<frames;++i){for(float value:{left[i],right[i]}){const auto encoded=std::lround(std::clamp(value,-1.0f,1.0f)*(value<0?32768:32767));put16(out,static_cast<std::int16_t>(encoded));}}
  out.close();if(!out)throw std::runtime_error("Capture write failed");std::cout<<"Native song rendered: "<<events.size()<<" events\n";
 }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
