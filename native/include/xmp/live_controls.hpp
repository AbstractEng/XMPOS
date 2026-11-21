#pragma once
// MPC Live Mk1 internal controller ("MPC Live Controller", USB 09e8:003b) and
// audio card ("MPC Live Audio", USB 09e8:203b) rules for XMP sessions on the
// owner's Live (AGENTS.md, "Device-specific authorization 2"). Header-only and
// allocation-free so the parser can run on the session's input thread and be
// tested on the Mac.
#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <string>
#include "xmp/live_feedback.hpp"

namespace xmp::live {

// Pad notes on MIDI channel 10, pad 1 = bottom left, pad 13 = top left
// (published hwremap map for the MPC Live / Live II).
constexpr std::array<std::uint8_t, 16> kPadNotes{0x25, 0x24, 0x2A, 0x52, 0x28, 0x26, 0x2E, 0x2C,
                                                 0x30, 0x2F, 0x2D, 0x2B, 0x31, 0x37, 0x33, 0x35};

// Existing controller startup: identity request and the exact MPC-LiveXplore
// capture of Akai's startup SysEx. Q-Link feedback uses the separate allowlist below.
constexpr std::array<std::uint8_t, 6> kIdentityRequest{0xF0, 0x7E, 0x00, 0x06, 0x01, 0xF7};
constexpr std::array<std::uint8_t, 83> kStartupSequence{
    0xF0, 0x47, 0x7F, 0x3B, 0x62, 0x00, 0x01, 0x65, 0xF7,              //
    0xF0, 0x47, 0x7F, 0x3B, 0x64, 0x00, 0x03, 0x00, 0x01, 0x01, 0xF7,  //
    0xF0, 0x47, 0x7F, 0x3B, 0x64, 0x00, 0x03, 0x01, 0x01, 0x01, 0xF7,  //
    0xF0, 0x47, 0x7F, 0x3B, 0x64, 0x00, 0x03, 0x02, 0x00, 0x00, 0xF7,  //
    0xF0, 0x47, 0x7F, 0x3B, 0x64, 0x00, 0x03, 0x03, 0x00, 0x00, 0xF7,  //
    0xF0, 0x47, 0x7F, 0x3B, 0x63, 0x00, 0x03, 0x00, 0x00, 0x00, 0xF7,  //
    0xF0, 0x47, 0x7F, 0x3B, 0x63, 0x00, 0x03, 0x01, 0x00, 0x00, 0xF7,  //
    0xF0, 0x47, 0x7F, 0x3B, 0x41, 0x00, 0x00, 0xF7};

// MPC-LiveXplore-libs df1be83: tkgl_midimapper.h maps 5A–5D, and
// tmm-IamForce2.c uses channel 1 CC, value 3 or 0, on the MPC Private port.
constexpr int kQLinkLedPort = 1;
class QLinkLeds {
 public:
  enum class Result { idle, pending, sent, failed };

  // Write at most one bounded frame per call. Finish a partial write before
  // switching pages, so a newer page cannot splice bytes into a MIDI message.
  template <typename Write>
  Result sync(int page, Write write) {
    if (page < 0 || page >= 4) return Result::idle;
    if (offset_ == frame_.size()) {
      if (page == page_) return Result::idle;
      page_ = page;
      offset_ = 0;
      std::size_t at = 0;
      const auto add = [&](int led, std::uint8_t value) {
        frame_[at++] = 0xB0;
        frame_[at++] = static_cast<std::uint8_t>(0x5A + led);
        frame_[at++] = value;
      };
      // Clear the other lights before lighting the selected page.
      for (int led = 0; led < 4; ++led)
        if (led != page) add(led, 0);
      add(page, 3);
    }
    const auto remaining = frame_.size() - offset_;
    const auto written = write(frame_.data() + offset_, remaining);
    if (written < 0 || static_cast<std::size_t>(written) > remaining) return Result::failed;
    offset_ += static_cast<std::size_t>(written);
    return offset_ == frame_.size() ? Result::sent : Result::pending;
  }

  int page() const { return page_; }

 private:
  std::array<std::uint8_t, 12> frame_{};
  std::size_t offset_ = frame_.size();
  int page_ = -1;
};

enum class Kind : std::uint8_t { none, pad_on, pad_off, pad_pressure, button_on, button_off, control, other, sysex };

struct Event {
  Kind kind = Kind::none;
  std::uint8_t status = 0, data1 = 0, data2 = 0;
  int pad = -1;  // 0..15 for pad events
};

inline int pad_index(std::uint8_t note) {
  for (std::size_t i = 0; i < kPadNotes.size(); ++i)
    if (kPadNotes[i] == note) return static_cast<int>(i);
  return -1;
}

inline Event classify(std::uint8_t status, std::uint8_t d1, std::uint8_t d2) {
  Event e{Kind::other, status, d1, d2, -1};
  const std::uint8_t type = status & 0xF0, channel = status & 0x0F;
  if (channel == 9 && (type == 0x90 || type == 0x80 || type == 0xA0)) {
    e.pad = pad_index(d1);
    if (e.pad < 0) return e;
    e.kind = type == 0xA0 ? Kind::pad_pressure : (type == 0x90 && d2 > 0) ? Kind::pad_on : Kind::pad_off;
  } else if (channel == 0 && (type == 0x90 || type == 0x80)) {
    e.kind = (type == 0x90 && d2 > 0) ? Kind::button_on : Kind::button_off;
  } else if (type == 0xB0) {
    e.kind = Kind::control;
  }
  return e;
}

// Byte-stream MIDI parser with running status and bounded SysEx capture.
class Parser {
 public:
  // Feeds one byte; returns true when `out` holds a complete event.
  bool feed(std::uint8_t byte, Event& out) {
    if (byte >= 0xF8) return false;  // real-time bytes are ignored
    if (byte == 0xF0) {
      sysex_ = true;
      sysex_size_ = 0;
      push_sysex(byte);
      return false;
    }
    if (sysex_) {
      push_sysex(byte);
      if (byte == 0xF7) {
        sysex_ = false;
        out = Event{Kind::sysex, 0xF0, 0, 0, -1};
        return true;
      }
      if (byte < 0x80) return false;
      sysex_ = false;  // a status byte ends an unterminated SysEx
    }
    if (byte >= 0x80) {
      status_ = byte >= 0xF0 ? 0 : byte;  // system common clears running status
      count_ = 0;
      return false;
    }
    if (!status_) return false;
    data_[count_++] = byte;
    const std::uint8_t type = status_ & 0xF0;
    const std::size_t need = (type == 0xC0 || type == 0xD0) ? 1 : 2;
    if (count_ < need) return false;
    count_ = 0;
    out = classify(status_, data_[0], need == 2 ? data_[1] : 0);
    return true;
  }
  const std::uint8_t* sysex() const { return sysex_bytes_.data(); }
  std::size_t sysex_size() const { return sysex_size_; }

 private:
  void push_sysex(std::uint8_t byte) {
    if (sysex_size_ < sysex_bytes_.size()) sysex_bytes_[sysex_size_++] = byte;
  }
  std::uint8_t status_ = 0;
  std::array<std::uint8_t, 2> data_{};
  std::size_t count_ = 0;
  bool sysex_ = false;
  std::array<std::uint8_t, 256> sysex_bytes_{};
  std::size_t sysex_size_ = 0;
};

inline std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return text;
}

// The live device tree must be the MPC Live (ACV8) and nothing may name the Force.
inline bool is_live_mk1(const std::string& compatible) {
  const auto c = lower(compatible);
  return c.find("inmusic,acv8") != std::string::npos && c.find("force") == std::string::npos &&
         c.find("ada2") == std::string::npos;
}

// Identity is procfs text: "<id> <usbid> <stream0 head>". Only the Live's own
// audio card, by USB ID and name, on a board that is the Live.
inline bool live_audio_card_allowed(const std::string& identity, const std::string& compatible) {
  const auto id = lower(identity);
  return is_live_mk1(compatible) && id.find("09e8:203b") != std::string::npos &&
         id.find("mpc live audio") != std::string::npos && id.find("force") == std::string::npos &&
         id.find("ada2") == std::string::npos;
}

inline bool live_controller_card(const std::string& identity) {
  const auto id = lower(identity);
  return id.find("09e8:003b") != std::string::npos && id.find("force") == std::string::npos &&
         id.find("ada2") == std::string::npos;
}

inline bool qlink_led_controller_allowed(const std::string& compatible, const std::string& identity,
                                         const std::string& description) {
  if (!is_live_mk1(compatible) || !live_controller_card(identity)) return false;
  const auto name = lower(description);
  if (name.find("force") != std::string::npos || name.find("ada2") != std::string::npos) return false;
  if (compatible.find("linux,dummy-virt") != std::string::npos)
    return name.find("xmp emulator mpc live controller at usb-") != std::string::npos;
  return name.find("mpc live controller at usb-ff500000.usb-1.6,") != std::string::npos;
}

// Output ceiling: -12 dBFS peak.
constexpr float kPeakLimit = 0.25118864f;
inline float limit(float sample) { return std::clamp(sample, -kPeakLimit, kPeakLimit); }

}  // namespace xmp::live
