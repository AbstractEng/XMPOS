#include "xmp/host_graph.hpp"
#include "xmp/protocol.hpp"
#include <array>
#include <cmath>
#include <cstring>
#include <fstream>
#include <stdexcept>

// Bounded loader for the prepared host graph format (XMPH v1/v2). Shared by the
// virtual engine host and the ALSA engine. Runs before any audio callback.
namespace xmp {
namespace {
std::uint32_t read32(std::istream& input){std::array<std::uint8_t,4> bytes{};if(!input.read(reinterpret_cast<char*>(bytes.data()),4))throw std::runtime_error("Truncated graph");return static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),0,4));}
float read_float(std::istream& input){const auto bits=read32(input);float value;std::memcpy(&value,&bits,4);if(!std::isfinite(value)||std::abs(value)>1)throw std::runtime_error("Invalid graph amplitude");return value;}
}  // namespace
GraphOwner load_host_graph(const char* path){
 std::ifstream input(path,std::ios::binary);std::array<std::uint8_t,96> bytes{};
 if(!input.read(reinterpret_cast<char*>(bytes.data()),bytes.size())||xmp::protocol::get(bytes.data(),0,4)!=0x48504d58||(xmp::protocol::get(bytes.data(),4,4)!=1&&xmp::protocol::get(bytes.data(),4,4)!=2))throw std::runtime_error("Invalid host graph header");
 GraphOwner owner;auto& graph=owner.graph;graph.allow_groove=xmp::protocol::get(bytes.data(),4,4)==2;if(graph.allow_groove){const std::uint64_t low=read32(input),bits=low|(static_cast<std::uint64_t>(read32(input))<<32);std::memcpy(&graph.swing,&bits,8);if(!std::isfinite(graph.swing)||graph.swing<0||graph.swing>0.5)throw std::runtime_error("Invalid initial groove");}graph.sample_count=static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),8,4));graph.event_count=static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),12,4));graph.loop_ticks=static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),16,4));graph.bpm=xmp::protocol::number(bytes.data(),20);std::copy(bytes.begin()+28,bytes.begin()+60,graph.project_hash.begin());
 if(graph.sample_count==0||graph.sample_count>16||graph.event_count>512||graph.loop_ticks==0||graph.loop_ticks>15360||!std::isfinite(graph.bpm)||graph.bpm<30||graph.bpm>300)throw std::runtime_error("Host graph exceeds profile");
 for(std::size_t i=0;i<8;++i){const auto bits=static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),60+i*4,4));std::memcpy(&graph.track_gain[i],&bits,4);if(!std::isfinite(graph.track_gain[i])||graph.track_gain[i]<0||graph.track_gain[i]>1)throw std::runtime_error("Invalid track gain");}
 const auto bits=static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),92,4));std::memcpy(&graph.master,&bits,4);if(!std::isfinite(graph.master)||graph.master<0||graph.master>1)throw std::runtime_error("Invalid master gain");
 owner.samples.reserve(graph.sample_count);std::uint32_t total=0;
 for(std::uint32_t i=0;i<graph.sample_count;++i){const auto frames=read32(input);if(frames==0||frames>1000000-total)throw std::runtime_error("Prepared sample budget exceeded");total+=frames;owner.samples.emplace_back(frames);for(auto& value:owner.samples.back())value=read_float(input);graph.samples[i]={owner.samples.back().data(),frames};}
 std::uint32_t previous=0;
 for(std::uint32_t i=0;i<graph.event_count;++i){auto& event=graph.events[i];event.tick=read32(input);event.sample=read32(input);event.id=read32(input);event.duration=read32(input);event.velocity=read_float(input);event.track=read32(input);if(event.tick<previous||event.tick>=graph.loop_ticks||event.sample>=graph.sample_count||event.id==0||event.id>65535||event.duration>15360||event.velocity<0||event.track>=8)throw std::runtime_error("Invalid prepared event");previous=event.tick;}
 if(input.peek()!=EOF){throw std::runtime_error("Trailing graph payload");}
 return owner;
}
}  // namespace xmp
