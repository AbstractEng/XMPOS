#include "xmp/engine.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
// The entire callback graph is in this translation unit. Forbidden APIs cannot
// be introduced here, including accidental direct calls in future changes.
#pragma GCC poison malloc calloc realloc free fopen fclose fread fwrite open read write socket send recv connect pthread_mutex_lock pthread_rwlock_rdlock pthread_rwlock_wrlock
namespace xmp {
namespace {double swung_tick(std::uint32_t tick,double swing) noexcept {const double pair=(tick/480)*480,local=tick%480;return pair+(local<=240?local*(1+swing):240*(1+swing)+(local-240)*(1-swing));}}
Engine::Engine(const PreparedGraph& graph) noexcept:graph_(graph),bpm_(graph.bpm),swing_(graph.swing){publish();}
void Engine::trace(std::uint32_t id,std::uint32_t kind) noexcept {if(!traces.push({frame_,tick_,id,kind}))++trace_drops_;}
void Engine::release(Voice& voice) noexcept {if(!voice.active)return;voice.active=false;++off_;trace(voice.id,2);}
void Engine::note(std::uint32_t id,std::uint32_t sample,float gain,std::uint32_t duration,std::uint32_t track) noexcept {
 if(track>=8||sample>=graph_.sample_count||!std::isfinite(gain)||gain<0||gain>1){++refused_;return;}
 for(auto& voice:voices_)if(voice.active&&voice.id==id)release(voice);
 for(auto& voice:voices_)if(!voice.active){voice={graph_.samples[sample],0,id,track,tick_+duration,gain,true,duration!=0};++on_;trace(id,1);return;}
 ++refused_;trace(id,3);
}
void Engine::ack(const Ack& value) noexcept {if(!acknowledgements.push(value))++trace_drops_;}
void Engine::apply(const Command& command) noexcept {
 if(safe_&&(command.op==Op::start||command.op==Op::note_on||command.op==Op::tempo)){ack({command.ticket,revision_,frame_,Status::unsupported});return;}
 if(!running_&&command.op==Op::note_on){ack({command.ticket,revision_,frame_,Status::unsupported});return;}
 if(command.op==Op::stop||command.op==Op::backend_lost){groove_pending_=false;Command canceled;for(std::size_t i=0;i<64&&commands.pop(canceled);++i)ack({canceled.ticket,revision_,frame_,Status::unsupported});for(std::size_t i=0;i<scheduled_size_;++i)ack({scheduled_[i].ticket,revision_,frame_,Status::unsupported});scheduled_size_=0;for(std::size_t i=0;i<future_critical_size_;++i)ack({future_critical_[i].ticket,revision_,frame_,Status::unsupported});future_critical_size_=0;}
 const auto refusals_before=refused_;
 switch(command.op){
  case Op::start: if(!safe_)running_=true;break;
  case Op::stop:running_=false;for(auto& voice:voices_)release(voice);break;
  case Op::note_on:note(command.a,command.b&65535,static_cast<float>(command.value),0,command.b>>16);break;
  case Op::note_off:for(auto& voice:voices_)if(voice.active&&voice.id==command.a)release(voice);break;
  case Op::tempo:tempo_anchor_tick_=tick_;tempo_anchor_frame_=play_frame_;bpm_=command.value;trace(0,4);break;
  case Op::backend_lost:running_=false;safe_=true;for(auto& voice:voices_)release(voice);scheduled_size_=0;break;
  case Op::reconnect:if(command.a==kRate&&command.b==kBlock)safe_=false;break;
  default:break;
 }
 ++revision_;ack({command.ticket,revision_,frame_,refused_>refusals_before?Status::voice_refused:Status::applied});
}
void Engine::publish() noexcept {
 published_[0].fetch_add(1,std::memory_order_acq_rel);
 std::uint64_t tick_bits=0,bpm_bits=0;std::memcpy(&tick_bits,&tick_,8);std::memcpy(&bpm_bits,&bpm_,8);
 const std::uint64_t fields[]={revision_,frame_,tick_bits,bpm_bits,on_,off_,refused_,trace_drops_,running_?1u:0u,safe_?1u:0u,scheduled_size_+future_critical_size_+(groove_pending_?1:0)};
 for(std::size_t i=0;i<11;++i)published_[i+1].store(fields[i],std::memory_order_relaxed);
 published_[0].fetch_add(1,std::memory_order_release);
}
bool Engine::snapshot(Snapshot& out) const noexcept {
 for(int attempt=0;attempt<4;++attempt){const auto before=published_[0].load(std::memory_order_acquire);if(before&1)continue;std::array<std::uint64_t,11> value{};for(std::size_t i=0;i<11;++i)value[i]=published_[i+1].load(std::memory_order_relaxed);if(before!=published_[0].load(std::memory_order_acquire))continue;
  out.revision=value[0];out.frame=value[1];std::memcpy(&out.tick,&value[2],8);std::memcpy(&out.bpm,&value[3],8);out.on=value[4];out.off=value[5];out.refused=value[6];out.trace_drops=value[7];out.running=static_cast<std::uint32_t>(value[8]);out.safe=static_cast<std::uint32_t>(value[9]);out.pending=static_cast<std::uint32_t>(value[10]);return true;}
 return false;
}
void Engine::render(float* left,float* right,std::uint32_t frames) noexcept {
 if(!left||!right||frames>4096)return;
 Command command;
 for(std::size_t i=0;i<16&&critical.pop(command);++i){if(command.op==Op::note_off&&command.timestamp>frame_){if(future_critical_size_<16)future_critical_[future_critical_size_++]=command;else ack({command.ticket,revision_,frame_,Status::queue_full});}else apply(command);}
 for(std::size_t i=0;i<64&&commands.pop(command);++i){if(command.op==Op::groove){if(safe_||!graph_.allow_groove||command.a!=1||command.b!=0||!std::isfinite(command.value)||command.value<0||command.value>0.5||command.timestamp%3840!=0||command.timestamp<tick_||command.timestamp>tick_+115200){ack({command.ticket,revision_,frame_,Status::invalid});}else{groove_=command;groove_pending_=true;ack({command.ticket,revision_,frame_,Status::ok});}continue;}if((command.op==Op::tempo&&command.timestamp<tick_)||(command.op!=Op::tempo&&command.timestamp&&command.timestamp<frame_)){ack({command.ticket,revision_,frame_,Status::invalid});continue;}if(scheduled_size_==scheduled_.size()){ack({command.ticket,revision_,frame_,Status::queue_full});continue;}scheduled_[scheduled_size_++]=command;}
 for(std::uint32_t i=0;i<frames;++i){
  for(std::size_t j=0;j<future_critical_size_;){if(future_critical_[j].timestamp<=frame_){const auto ready=future_critical_[j];for(auto k=j;k+1<future_critical_size_;++k)future_critical_[k]=future_critical_[k+1];--future_critical_size_;apply(ready);}else ++j;}
  for(std::size_t j=0;j<scheduled_size_;){const auto& item=scheduled_[j];const bool due=item.op==Op::tempo?tick_+1e-8>=static_cast<double>(item.timestamp):frame_>=item.timestamp;if(due){const auto ready=item;for(auto k=j;k+1<scheduled_size_;++k)scheduled_[k]=scheduled_[k+1];--scheduled_size_;apply(ready);}else ++j;}
  if(groove_pending_&&tick_+1e-8>=groove_.timestamp){swing_=groove_.value;groove_pending_=false;++revision_;trace(0,5);}
  float mixed=0;
  if(running_&&!safe_){
   const auto loop=static_cast<std::uint64_t>(tick_/graph_.loop_ticks);if(loop!=last_loop_){last_loop_=loop;next_event_=0;}
   const double local=tick_-static_cast<double>(loop)*graph_.loop_ticks;
   for(auto& voice:voices_)if(voice.active&&voice.gated&&tick_+1e-8>=voice.release)release(voice);
   while(next_event_<graph_.event_count&&local+1e-8>=swung_tick(graph_.events[next_event_].tick,swing_)){const auto& event=graph_.events[next_event_++];note(event.id,event.sample,event.velocity,event.duration,event.track);}
   std::array<float,8> buses{};
   for(auto& voice:voices_)if(voice.active){buses[voice.track]+=voice.sample.data[voice.cursor++]*voice.gain;if(voice.cursor==voice.sample.frames){if(voice.gated)voice.cursor=0;else release(voice);}}
   for(std::size_t bus=0;bus<8;++bus) { mixed+=buses[bus]*graph_.track_gain[bus]; }
   mixed*=graph_.master;
   ++play_frame_;tick_=tempo_anchor_tick_+static_cast<double>(play_frame_-tempo_anchor_frame_)*bpm_*kPpq/(60.0*kRate);
  }
  left[i]=right[i]=std::isfinite(mixed)?std::clamp(mixed,-1.0f,1.0f):0; ++frame_;
 }
 publish();
}
}
