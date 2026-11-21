#include <cstdio>
#include "xmp/live_loop.hpp"
#include "xmp/live_sample.hpp"
#define EXPORT(name) extern "C" __attribute__((export_name(#name)))
namespace {
xmp::live::sample::LoopTake take;
xmp::live::sample::Recorder recorder;
std::vector<float> threshold_take;
bool threshold=false, prepared=false, seen_input=false;
float input[128],left[128],right[128];uint8_t valid[128];
}
EXPORT(lp_input) float* lp_input() { return input; }
EXPORT(lp_left) float* lp_left() { return left; }
EXPORT(lp_right) float* lp_right() { return right; }
EXPORT(lp_queue) int lp_queue(double first, int frames) {
  if(!std::isfinite(first) || first<0 || first>9007199254740991.0 || !take.queue(static_cast<uint64_t>(first),frames,0,0)) return 0;
  threshold=false;return 1;
}
// Preparation and final trimming run between callbacks, on message delivery.
EXPORT(lp_arm_threshold) void lp_arm_threshold() {recorder.arm();threshold=true;prepared=false;seen_input=false;}
EXPORT(lp_stop_threshold) void lp_stop_threshold() {if(threshold) recorder.stop();}
EXPORT(lp_prepare_take) void lp_prepare_take() {
  if(threshold && !prepared && recorder.state==xmp::live::sample::Recorder::State::done) {
    threshold_take=recorder.take();xmp::live::sample::trim_and_normalize(threshold_take);prepared=true;
  }
}
EXPORT(lp_process) void lp_process(double frame, int has_input, int monitor, float gain) {
  for (int i=0;i<128;++i) { valid[i]=has_input ? 1 : 0; left[i]=right[i]=has_input && monitor ? input[i]*0.25f : 0; }
  if(threshold) {
    if(has_input) {seen_input=true;recorder.feed(input,128);}
    else if(seen_input) recorder.stop();
  } else take.process(static_cast<uint64_t>(frame),input,valid,128,left,right,gain);
  for(int i=0;i<128;++i) left[i]=right[i]=std::clamp(left[i],-0.25f,0.25f);
}
EXPORT(lp_cancel) void lp_cancel() {if(threshold) recorder.clear(),prepared=false;else take.cancel();}
EXPORT(lp_handoff) void lp_handoff(double frame) { if (std::isfinite(frame) && frame>=0) take.handoff_at(static_cast<uint64_t>(frame)); }
EXPORT(lp_state) int lp_state() {
  if(!threshold) return static_cast<int>(take.state());
  using S=xmp::live::sample::Recorder::State;
  return prepared ? (threshold_take.empty()?5:3) : recorder.state==S::armed ? 1 : recorder.state==S::recording ? 2 : recorder.state==S::done ? 3 : 5;
}
EXPORT(lp_frames) int lp_frames() { return threshold ? static_cast<int>(prepared?threshold_take.size():recorder.pcm().size()) : static_cast<int>(take.frames()); }
EXPORT(lp_pcm) const float* lp_pcm() { return threshold ? threshold_take.data() : take.pcm(); }
EXPORT(lp_length) int lp_length() { return threshold ? static_cast<int>(threshold_take.size()) : static_cast<int>(take.length()); }
