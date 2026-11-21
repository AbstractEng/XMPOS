#pragma once
// Display-only controller feedback. No raw output or device access here.
#include <array>
#include <cstddef>
#include <cstdint>
#include <algorithm>

namespace xmp::live {
// MPC-LiveXplore-libs df1be83: tkgl_midimapper.h and DeviceSetPadColorRGB.
// Channel 1 CC on Private; 7-bit RGB SysEx on Public, product 3B only.
constexpr std::array<std::uint8_t, 17> kFeedbackButtons{
  0x23,0x24,0x25,0x26,0x0B,0x27,0x28,0x35,0x49,0x50,0x51,0x52,0x53,0x5A,0x5B,0x5C,0x5D
};
struct PadColour {
  std::uint8_t r=0, g=0, b=0;
  bool operator==(const PadColour& other) const { return r==other.r && g==other.g && b==other.b; }
  bool operator!=(const PadColour& other) const { return !(*this==other); }
};
struct PanelLights {
  std::array<std::uint8_t,17> buttons{};
  std::array<PadColour,16> pads{};
  void button(int code, bool on) {
    for (std::size_t i=0;i<kFeedbackButtons.size();++i) if (kFeedbackButtons[i]==code) buttons[i]=on?3:0;
  }
};
static_assert(sizeof(PanelLights)==65, "Browser feedback is 17 button bytes and 16 RGB triples");

// Soft hits are blue, medium hits green, harder hits amber, full hits red.
// Hue represents the strike velocity, never the fading brightness.
inline PadColour velocity_colour(int velocity, double brightness=1) {
  velocity=std::clamp(velocity,1,127); brightness=std::clamp(brightness,0.0,1.0);
  const double at=(velocity-1)*3.0/126;
  const PadColour colours[4]={{16,48,127},{8,127,50},{127,92,8},{127,12,8}};
  const int i=std::min(2,static_cast<int>(at)); const double mix=at-i;
  const auto channel=[&](int a,int b){return static_cast<std::uint8_t>((a+(b-a)*mix)*brightness+.5);};
  return {channel(colours[i].r,colours[i+1].r),channel(colours[i].g,colours[i+1].g),channel(colours[i].b,colours[i+1].b)};
}

// Fixed, bounded delta frames, prepared and written on the control thread.
// Never interleave a newer snapshot into a partially written MIDI message.
class PanelFeedback {
 public:
  enum class Result { idle, pending, sent, failed };
  template<class Write> Result sync(int port, const PanelLights& wanted, Write write) {
    if(port<0||port>1) return Result::idle;
    if(port==1) {for(auto value:wanted.buttons)if(value!=0&&value!=3)return Result::failed;}
    else {for(auto c:wanted.pads)if(c.r>127||c.g>127||c.b>127)return Result::failed;}
    auto& f=frames_[port];
    if(f.offset==f.size) {
      f.offset=f.size=0;
      if(port==1) {
        for(std::size_t i=0;i<kFeedbackButtons.size();++i) {
          if(wanted.buttons[i]!=0 && wanted.buttons[i]!=3) return Result::failed;
          if(!f.initialized||wanted.buttons[i]!=f.state.buttons[i]) {
            f.bytes[f.size++]=0xB0;f.bytes[f.size++]=kFeedbackButtons[i];f.bytes[f.size++]=wanted.buttons[i];
          }
        }
      } else {
        for(int i=0;i<16;++i) {
          const auto c=wanted.pads[i];
          if(c.r>127||c.g>127||c.b>127) return Result::failed;
          if(!f.initialized||c!=f.state.pads[i]) {
            const std::uint8_t message[]={0xF0,0x47,0x7F,0x3B,0x65,0,4,static_cast<std::uint8_t>(i),c.r,c.g,c.b,0xF7};
            for(auto byte:message)f.bytes[f.size++]=byte;
          }
        }
      }
      f.state=wanted;f.initialized=true;
      if(!f.size)return Result::idle;
    }
    const auto n=write(f.bytes.data()+f.offset,f.size-f.offset);
    if(n<0||static_cast<std::size_t>(n)>f.size-f.offset)return Result::failed;
    f.offset+=static_cast<std::size_t>(n);
    return f.offset==f.size?Result::sent:Result::pending;
  }
 private:
  struct Frame { std::array<std::uint8_t,192> bytes{};std::size_t offset=0,size=0;bool initialized=false;PanelLights state{}; };
  std::array<Frame,2> frames_{};
};
}
