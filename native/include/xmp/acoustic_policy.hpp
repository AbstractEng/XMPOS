#pragma once
#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>
namespace xmp {
struct AcousticDevice {
  unsigned id = 0;
  std::string uid, name;
  bool built_in = false, alive = false;
  unsigned input_channels = 0, output_channels = 0;
  double rate = 0;
};
inline bool acoustic_device_allowed(const AcousticDevice& device, bool input) {
  std::string name = device.name;
  std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  const auto channels = input ? device.input_channels : device.output_channels;
  return device.id != 0 && device.built_in && device.alive &&
    device.uid == (input ? "BuiltInMicrophoneDevice" : "BuiltInSpeakerDevice") &&
    name.find("macbook") != std::string::npos &&
    name.find(input ? "microphone" : "speaker") != std::string::npos &&
    name.find("akai") == std::string::npos && name.find("force") == std::string::npos &&
    name.find("mpc") == std::string::npos && name.find("inmusic") == std::string::npos &&
    channels > 0 && channels <= 8 && std::isfinite(device.rate) &&
    std::floor(device.rate) == device.rate && device.rate >= 32000 && device.rate <= 96000;
}
}
