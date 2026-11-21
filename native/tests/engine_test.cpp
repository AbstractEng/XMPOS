#include "xmp/engine.hpp"
#include "xmp/rt_audit.hpp"
#include "xmp/protocol.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <pthread.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>
static void check(bool value,const char* message){if(!value){std::cerr<<message<<'\n';std::exit(1);}}
int main(int argc,char** argv){
 const std::string mode=argc>1?argv[1]:"render";
 if(mode=="canary"){
  FILE* file=std::tmpfile();check(file,"tmpfile");int sockets[2];check(socketpair(AF_UNIX,SOCK_STREAM,0,sockets)==0,"socketpair");pthread_mutex_t mutex=PTHREAD_MUTEX_INITIALIZER;
  char byte='x';xmp::audit::begin();void* allocation=std::malloc(64);pthread_mutex_lock(&mutex);pthread_mutex_unlock(&mutex);std::fwrite(&byte,1,1,file);::send(sockets[0],&byte,1,0);::recv(sockets[1],&byte,1,0);std::free(allocation);const auto counts=xmp::audit::end();
  std::fclose(file);::close(sockets[0]);::close(sockets[1]);pthread_mutex_destroy(&mutex);
  std::cout<<"{\"allocations\":"<<counts.allocations<<",\"frees\":"<<counts.frees<<",\"locks\":"<<counts.locks<<",\"files\":"<<counts.files<<",\"network\":"<<counts.network<<"}\n";
  check(counts.allocations>0&&counts.locks>0&&counts.files>0&&counts.network>0,"Audit canary did not observe real operations");return 0;
 }
 if(mode=="critical"){
  float sample[]={0.1f,-0.1f};xmp::PreparedGraph graph;graph.sample_count=1;graph.samples[0]={sample,2};graph.event_count=1;graph.events[0]={0,0,1,4800,1,0};graph.loop_ticks=15360;auto engine=std::make_unique<xmp::Engine>(graph);engine->critical.push({xmp::Op::start,1,0,0,0,0});
  for(std::uint32_t i=0;i<64;++i)check(engine->commands.push({xmp::Op::note_on,10+i,12000,100+i,0,0.1}),"Fill queue");check(!engine->commands.push({xmp::Op::note_on,1000,12000,999,0,1}),"Reject newest queue policy");check(engine->critical.push({xmp::Op::note_off,2,1024,1,0,0}),"Reserved critical lane");std::array<float,256> left{},right{};for(int i=0;i<6;++i)engine->render(left.data(),right.data(),256);std::uint32_t count=0;xmp::Trace trace;while(engine->traces.pop(trace))if(trace.kind==2&&trace.id==1){++count;check(trace.frame==1024,"Scheduled critical note-off moved");}check(count==1,"Exactly once critical note-off");
  engine->critical.push({xmp::Op::backend_lost,3,0,0,0,0});engine->render(left.data(),right.data(),256);xmp::Snapshot state;check(engine->snapshot(state)&&state.safe&&!state.running,"Safe backend state");for(const auto value:left)check(value==0,"Silent safe output");std::cout<<"{\"noteOffFrame\":1024,\"queueCapacity\":64,\"criticalCapacity\":16,\"safeOutput\":true}\n";return 0;
 }
 if(mode=="commands"){
  xmp::PreparedGraph graph;float sample[]={0.5f,0};graph.sample_count=1;graph.samples[0]={sample,2};auto engine=std::make_unique<xmp::Engine>(graph);engine->critical.push({xmp::Op::start,1,0,0,0,0});engine->commands.push({xmp::Op::note_on,2,100,1,0,1});engine->commands.push({xmp::Op::note_on,3,200,2,0,1});
  std::array<std::uint8_t,40> bytes{};xmp::protocol::put(bytes.data(),0,4,0x34504d58);xmp::protocol::put(bytes.data(),4,2,1);xmp::protocol::put(bytes.data(),6,2,5);xmp::protocol::put(bytes.data(),12,4,16);xmp::protocol::put(bytes.data(),24,4,3);xmp::protocol::number(bytes.data(),32,1);
  xmp::Snapshot snapshot;xmp::Command command;std::uint32_t rejected=0;
  auto bad=bytes;xmp::protocol::put(bad.data(),4,2,2);if(xmp::protocol::decode(bad.data(),snapshot,1,true,command)!=xmp::Status::ok)++rejected;
  bad=bytes;xmp::protocol::put(bad.data(),16,8,~0ull);if(xmp::protocol::decode(bad.data(),snapshot,1,true,command)!=xmp::Status::ok)++rejected;
  bad=bytes;xmp::protocol::put(bad.data(),12,4,4097);if(xmp::protocol::decode(bad.data(),snapshot,1,true,command)!=xmp::Status::ok)++rejected;
  std::array<float,256> left{},right{};engine->render(left.data(),right.data(),256);std::vector<std::uint64_t> on;xmp::Trace trace;while(engine->traces.pop(trace))if(trace.kind==1)on.push_back(trace.frame);
  check(rejected==3&&on==std::vector<std::uint64_t>({100,200}),"Malformed commands changed musical ordering");std::cout<<"{\"rejected\":3,\"responseBytes\":176,\"eventFrames\":[100,200]}\n";return 0;
 }
 std::array<float,480> sample{};for(std::size_t i=0;i<sample.size();++i)sample[i]=static_cast<float>(std::sin(i*6.283185307179586/480)*0.01);
 xmp::PreparedGraph graph;graph.sample_count=1;graph.samples[0]={sample.data(),sample.size()};graph.event_count=32;
 for(std::uint32_t i=0;i<32;++i)graph.events[i]={0,0,i+1,3839,1,i/4};
 auto engine=std::make_unique<xmp::Engine>(graph);std::array<float,256> left{},right{};
 engine->critical.push({xmp::Op::start,1,0,0,0,0});
 xmp::audit::Counts total;std::uint64_t callback_count=0,nonfinite=0,range_errors=0;std::vector<double> times;times.reserve(12000);
 const auto frames=mode=="render"?60*xmp::kRate:mode=="render-short"?xmp::kRate:256u;
 for(std::uint32_t i=0;i<frames;){const auto count=std::min<std::uint32_t>(256,frames-i);const auto start=std::chrono::steady_clock::now();xmp::audit::begin();engine->render(left.data(),right.data(),count);const auto counts=xmp::audit::end();const auto elapsed=std::chrono::duration<double,std::nano>(std::chrono::steady_clock::now()-start).count();times.push_back(elapsed);total.allocations+=counts.allocations;total.frees+=counts.frees;total.locks+=counts.locks;total.files+=counts.files;total.network+=counts.network;++callback_count;for(std::uint32_t frame=0;frame<count;++frame){if(!std::isfinite(left[frame])||!std::isfinite(right[frame]))++nonfinite;if(std::abs(left[frame])>1||std::abs(right[frame])>1)++range_errors;}i+=count;
  // Consume telemetry outside the callback so a one-minute test cannot overflow its trace ring.
  xmp::Trace trace;while(engine->traces.pop(trace)){}
 }
 xmp::Snapshot snapshot;check(engine->snapshot(snapshot),"snapshot");
 if(mode=="exhaustion"){
  check(engine->commands.push({xmp::Op::note_on,2,snapshot.frame,99,0,1}),"command push");engine->render(left.data(),right.data(),256);check(engine->snapshot(snapshot),"snapshot");check(snapshot.on==32&&snapshot.refused==1,"Reject-newest voice policy");
 }
 if(mode=="tempo"){
  graph.event_count=25;graph.loop_ticks=15360;graph.events[0]={0,0,1,4800,1};for(std::uint32_t step=0;step<24;++step)graph.events[step+1]={step*240,0,100+step,0,1};engine=std::make_unique<xmp::Engine>(graph);engine->critical.push({xmp::Op::start,1,0,0,0,0});engine->commands.push({xmp::Op::tempo,2,3840,0,0,90});
  for(std::uint32_t i=0;i<160000;i+=256)engine->render(left.data(),right.data(),std::min<std::uint32_t>(256,160000-i));
  std::uint64_t tempo=0,release=0;std::uint32_t off=0;std::vector<std::uint64_t> beats;xmp::Trace trace;while(engine->traces.pop(trace)){if(trace.kind==4)tempo=trace.frame;if(trace.kind==2&&trace.id==1){release=trace.frame;++off;}if(trace.kind==1&&trace.id>=100&&trace.id<124)beats.push_back(trace.frame);}
  check(beats.size()==24,"Missing tempo fixture events");for(std::size_t i=0;i<beats.size();++i)check(beats[i]==(i<16?i*6000:96000+(i-16)*8000),"Tempo event alignment");
  check(tempo==96000&&release==128000&&off==1,"Tempo boundary or exactly-once note-off failed");
  std::cout<<"{\"tempoFrame\":"<<tempo<<",\"releaseFrame\":"<<release<<",\"noteOffs\":"<<off<<",\"oldStepFrames\":"<<beats[1]-beats[0]<<",\"newStepFrames\":"<<beats[17]-beats[16]<<"}\n";return 0;
 }
 std::sort(times.begin(),times.end());const auto p99=times[static_cast<std::size_t>((times.size()-1)*0.99)];
 std::cout<<"{\"frames\":"<<frames<<",\"callbacks\":"<<callback_count<<",\"allocations\":"<<total.allocations<<",\"frees\":"<<total.frees<<",\"locks\":"<<total.locks<<",\"files\":"<<total.files<<",\"network\":"<<total.network<<",\"nonFinite\":"<<nonfinite<<",\"rangeErrors\":"<<range_errors<<",\"voices\":32,\"tracks\":8,\"refused\":"<<snapshot.refused<<",\"on\":"<<snapshot.on<<",\"off\":"<<snapshot.off<<",\"callbackP99Ns\":"<<p99<<",\"syntheticAudioEndpoint\":true}\n";
 check(total.allocations==0&&total.frees==0&&total.locks==0&&total.files==0&&total.network==0&&nonfinite==0&&range_errors==0,"Unsafe callback or output");
}
