#pragma once
#include "xmp/engine.hpp"
#include <cstdint>
#include <memory>
#include <string>
namespace xmp {
// Only explicit built-in output is currently supported by the physical Mac port.
// No default device selection, input capture, USB/MIDI or Akai transport exists.
bool safe_builtin_selection(const std::string& name,bool built_in,std::uint32_t rate,std::uint32_t frames) noexcept;
class HostAudioBackend {
 struct Impl;std::unique_ptr<Impl> impl_;
 public:
 HostAudioBackend();~HostAudioBackend();
 bool open_builtin(Engine& engine,std::uint32_t device_id,const std::string& expected_name,std::uint32_t rate,std::uint32_t frames);
 bool open_linux_null(Engine& engine,std::uint32_t rate,std::uint32_t frames);
 bool start();void stop();bool poll_lost();bool pump_linux_null();
 const char* status() const noexcept;
};
}
