#include "xmp/live_platform.hpp"
#include <fstream>
#include <stdexcept>
namespace xmp::live::platform {
LocalEmulator::LocalEmulator(int width,int height) {
  if(width<64 || height<64 || width>4096 || height>4096) throw std::invalid_argument("framebuffer dimensions");
  pixels_.resize(static_cast<std::size_t>(width)*height*4);
  canvas_.memory=pixels_.data(); canvas_.size=pixels_.size();
  canvas_.width=canvas_.xres=width; canvas_.height=canvas_.yres=height; canvas_.line_length=static_cast<std::size_t>(width)*4;
  reset();
}
void LocalEmulator::reset() {
  selected_=0; parser_=Parser{};
  canvas_.fill({0,0,canvas_.width,canvas_.height},theme::kBackground);
  for(std::size_t i=0;i<kPadNotes.size();++i) canvas_.pad(static_cast<int>(i),0,false,std::to_string(i+1));
}
bool LocalEmulator::feed(std::uint8_t byte,Event& event) {
  if(!parser_.feed(byte,event)) return false;
  if(event.kind==Kind::pad_on) {
    selected_=event.pad+1;
    for(std::size_t i=0;i<kPadNotes.size();++i) canvas_.pad(static_cast<int>(i),0,selected_==static_cast<int>(i)+1,std::to_string(i+1));
  }
  return true;
}
bool screenshot(const Canvas& canvas,const std::string& path) {
  if(!canvas.memory || canvas.width<=0 || canvas.height<=0) return false;
  if(canvas.red_length!=8 || canvas.green_length!=8 || canvas.blue_length!=8) return false;
  std::ofstream out(path,std::ios::binary); out<<"P6\n"<<canvas.width<<' '<<canvas.height<<"\n255\n";
  for(int y=0;y<canvas.height;++y) for(int x=0;x<canvas.width;++x) {
    int fx=0,fy=0; to_framebuffer(canvas.rotation,canvas.xres,canvas.yres,x,y,fx,fy);
    if(fx<0 || fy<0) return false;
    const std::size_t at=(static_cast<std::size_t>(fy)+canvas.yoffset)*canvas.line_length+(static_cast<std::size_t>(fx)+canvas.xoffset)*4;
    if(at+4>canvas.size) return false;
    std::uint32_t value=0;std::memcpy(&value,canvas.memory+at,4);
    out.put(static_cast<char>((value>>canvas.red_offset)&255));
    out.put(static_cast<char>((value>>canvas.green_offset)&255));
    out.put(static_cast<char>((value>>canvas.blue_offset)&255));
  }
  return bool(out);
}
bool LocalEmulator::screenshot(const std::string& path) const { return platform::screenshot(canvas_,path); }
}
