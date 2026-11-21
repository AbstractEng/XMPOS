#pragma once
#include <algorithm>
#include <cmath>
namespace xmp {
// Replace base with automation, then step lock; add macro/LFO, clamp.
inline bool resolve_parameter(double base, bool has_automation, double automation,
                              bool has_lock, double lock, double macro, double lfo,
                              double& output) noexcept {
  const auto normalized=[](double value){return std::isfinite(value)&&value>=0&&value<=1;};
  if(!normalized(base)||(has_automation&&!normalized(automation))||
     (has_lock&&!normalized(lock))||!std::isfinite(macro)||macro < -1||macro > 1||
     !std::isfinite(lfo)||lfo < -1||lfo > 1)return false;
  output=std::clamp((has_lock?lock:has_automation?automation:base)+macro+lfo,0.0,1.0);
  return true;
}
inline bool smooth_parameter(double current,double target,double rate,double milliseconds,
                             double frames,double& output) noexcept {
 if(!std::isfinite(current)||!std::isfinite(target)||!std::isfinite(rate)||
    !std::isfinite(milliseconds)||!std::isfinite(frames)||current<0||current>1||
    target<0||target>1||rate<8000||rate>192000||milliseconds<0||milliseconds>10000||
    frames<0||frames>2100000||std::floor(frames)!=frames)return false;
 output=frames==0?current:milliseconds==0?target:target+(current-target)*std::exp(-frames/(rate*milliseconds/1000));
 return true;
}

}
