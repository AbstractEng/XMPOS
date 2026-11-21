#pragma once
// Portable local client for the same parser, layout and renderer used on Linux.
// No hardware access. The Linux session resources are in live_platform_linux.hpp.
#include "xmp/live_controls.hpp"
#include "xmp/live_screen.hpp"
#include <string>
#include <vector>
namespace xmp::live::platform {
bool screenshot(const Canvas& canvas, const std::string& path);
class LocalEmulator {
 public:
  explicit LocalEmulator(int width=640, int height=400);
  LocalEmulator(const LocalEmulator&) = delete;
  LocalEmulator& operator=(const LocalEmulator&) = delete;
  void reset();
  bool feed(std::uint8_t byte, Event& event);
  int selected_pad() const { return selected_; }
  Canvas& canvas() { return canvas_; }
  bool screenshot(const std::string& path) const;
 private:
  std::vector<unsigned char> pixels_;
  Canvas canvas_;
  Parser parser_;
  int selected_=0;
};
}
