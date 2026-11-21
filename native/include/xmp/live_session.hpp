#pragma once
// Pure parts of the XMP session on the MPC Live Mk1 (AGENTS.md, "Device-specific
// authorization 2"): XMP's own synthesized pad kit, the on-screen pad grid and
// the bounded stick configuration. Nothing here opens a device, so all of it is
// tested on the Mac. Everything is prepared before the audio thread starts.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace xmp::live {

// ---- the kit: 16 original sounds, synthesized from formulas (no samples) ----

namespace detail {
struct Noise {
  std::uint32_t state;
  float next() {
    state = state * 1664525u + 1013904223u;
    return static_cast<float>(state >> 8) / 8388608.0f - 1.0f;
  }
};
constexpr double kPi = 3.14159265358979323846;
inline void normalize(std::vector<float>& s) {
  float peak = 0;
  for (float v : s) peak = std::max(peak, std::fabs(v));
  if (peak > 0)
    for (float& v : s) v /= peak;
  // 2 ms fade-out so no sound ends with a click.
  const std::size_t fade = std::min<std::size_t>(s.size(), 96);
  for (std::size_t i = 0; i < fade; ++i) s[s.size() - 1 - i] *= static_cast<float>(i) / fade;
}
}  // namespace detail

// Pad order follows the hardware: pad 0 bottom left, pad 15 top right.
// Pads 0-7 are drums, pads 8-15 a plucked pentatonic scale.
inline const char* kit_name(int pad) {
  static constexpr std::array<const char*, 16> names{
      "kick", "snare", "closed hat", "open hat", "clap", "low tom", "high tom", "rim",
      "pluck C", "pluck D", "pluck E", "pluck G", "pluck A", "pluck C+", "pluck D+", "pluck E+"};
  return pad >= 0 && pad < 16 ? names[static_cast<std::size_t>(pad)] : "?";
}

inline std::vector<float> make_sound(int pad, std::uint32_t rate) {
  using detail::kPi;
  const double r = rate;
  detail::Noise noise{0x584D5000u + static_cast<std::uint32_t>(pad)};
  auto frames = [&](double seconds) { return static_cast<std::size_t>(seconds * r); };
  std::vector<float> s;
  double phase = 0;
  switch (pad) {
    case 0:  // kick: sine falling 150 -> 45 Hz
      s.resize(frames(0.5));
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = i / r;
        phase += 2 * kPi * (45 + 105 * std::exp(-t * 30)) / r;
        s[i] = static_cast<float>(std::sin(phase) * std::exp(-t * 7));
      }
      break;
    case 1:  // snare: tone + noise
      s.resize(frames(0.3));
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = i / r;
        s[i] = static_cast<float>(0.5 * std::sin(2 * kPi * 185 * t) * std::exp(-t * 25) +
                                  noise.next() * std::exp(-t * 14));
      }
      break;
    case 2:
    case 3: {  // hats: differentiated noise, short or long
      s.resize(frames(pad == 2 ? 0.08 : 0.45));
      float last = 0;
      const double decay = pad == 2 ? 60 : 8;
      for (std::size_t i = 0; i < s.size(); ++i) {
        const float n = noise.next();
        s[i] = static_cast<float>((n - last) * std::exp(-(i / r) * decay));
        last = n;
      }
      break;
    }
    case 4:  // clap: three noise bursts then a tail
      s.resize(frames(0.35));
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = i / r, local = std::fmod(t, 0.011);
        const double env = t < 0.033 ? std::exp(-local * 300) : std::exp(-(t - 0.033) * 18);
        s[i] = static_cast<float>(noise.next() * env);
      }
      break;
    case 5:
    case 6: {  // toms
      const double base = pad == 5 ? 95 : 160;
      s.resize(frames(0.45));
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = i / r;
        phase += 2 * kPi * base * (1 + 0.6 * std::exp(-t * 25)) / r;
        s[i] = static_cast<float>(std::sin(phase) * std::exp(-t * 9));
      }
      break;
    }
    case 7:  // rim: short square click
      s.resize(frames(0.06));
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = i / r;
        s[i] = static_cast<float>((std::sin(2 * kPi * 1700 * t) > 0 ? 1 : -1) * std::exp(-t * 90));
      }
      break;
    default: {  // plucks: two detuned saws with a falling brightness
      static constexpr std::array<double, 8> semis{0, 2, 4, 7, 9, 12, 14, 16};
      const double f = 130.81 * std::pow(2.0, semis[static_cast<std::size_t>(pad - 8)] / 12.0);
      s.resize(frames(0.9));
      double a = 0, b = 0, low = 0;
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = i / r;
        a = std::fmod(a + f / r, 1.0);
        b = std::fmod(b + f * 1.004 / r, 1.0);
        const double raw = (a - 0.5) + (b - 0.5);
        const double k = 0.05 + 0.6 * std::exp(-t * 6);  // one-pole low-pass
        low += k * (raw - low);
        s[i] = static_cast<float>(low * std::exp(-t * 3.5));
      }
      break;
    }
  }
  detail::normalize(s);
  return s;
}

// Master gain applied by the engine: one sound at full velocity peaks at
// about -18 dBFS, so a few at once stay under the -12 dBFS ceiling before the
// hard limiter (kPeakLimit in live_controls.hpp) is needed.
constexpr float kKitMaster = 0.125f;

// ---- the screen: a 4x4 pad grid on a landscape canvas, any panel rotation ----

struct Rect {
  int x = 0, y = 0, w = 0, h = 0;
};

// Pad rectangle on a logical landscape canvas (width >= height).
inline Rect pad_rect(int pad, int width, int height) {
  const int side = std::min(height * 9 / 10, width * 6 / 10);
  const int cell = side / 4, gap = std::max(2, cell / 12);
  const int left = (width - cell * 4) / 2, top = (height - cell * 4) / 2;
  const int col = pad % 4, row = 3 - pad / 4;  // pad 0 is bottom left
  return {left + col * cell + gap, top + row * cell + gap, cell - 2 * gap, cell - 2 * gap};
}

// Status lights in the top left corner: audio, controller, start-up sent, input seen.
inline Rect status_rect(int index, int width, int height) {
  const int size = std::max(8, std::min(width, height) / 25);
  return {size / 2 + index * size * 3 / 2, size / 2, size, size};
}

// Logical canvas size for a framebuffer and rotation (degrees).
inline void canvas_size(int rotation, int xres, int yres, int& width, int& height) {
  const bool turned = rotation == 90 || rotation == 270;
  width = turned ? yres : xres;
  height = turned ? xres : yres;
}

// Maps a logical canvas pixel to the framebuffer pixel for a panel rotation.
inline void to_framebuffer(int rotation, int xres, int yres, int x, int y, int& fx, int& fy) {
  switch (rotation) {
    case 90: fx = xres - 1 - y; fy = x; break;
    case 180: fx = xres - 1 - x; fy = yres - 1 - y; break;
    case 270: fx = y; fy = yres - 1 - x; break;
    default: fx = x; fy = y; break;
  }
}

// ---- stick configuration: xmp/session.conf, "key=value" lines, bounded ----

enum class Startup : std::uint8_t { none, identity, full };

struct Config {
  int rotation = -1;      // -1: 270 on a portrait panel, 0 on a landscape one
  Startup startup = Startup::full;  // what XMP may send the controller (authorization 2)
  int startup_port = 1;   // controller raw MIDI subdevice: 0 Public, 1 Private
  int idle_minutes = 30;  // switch off after this long without pad input
  int listen_seconds = 2; // passive listening before anything is sent
  int touch_rotation = -1;  // -1: same as the screen
  // Hardware buttons (note numbers on MIDI channel 1). Defaults are the Live
  // Mk1's own, named by the owner (os/live-mk1/hardware.json): second row below
  // the screen, Rec 2nd, Stop 4th, Play 5th. -1 = not assigned.
  int button_play = 0x52, button_stop = 0x51, button_record = 0x49, button_clear = -1;
  // Relative encoder (control change on channel 1) that changes the tempo: the
  // data wheel, B0 64 (01 = one step clockwise, 7F = one step anticlockwise).
  int tempo_control = 0x64;
  std::vector<std::string> errors;
};

inline Config parse_config(const std::string& text) {
  Config c;
  if (text.size() > 4096) {
    c.errors.push_back("session.conf is larger than 4 KiB; using defaults");
    return c;
  }
  std::size_t start = 0;
  int line_number = 0;
  while (start <= text.size() && line_number < 64) {
    const auto end = std::min(text.find('\n', start), text.size());
    std::string line = text.substr(start, end - start);
    start = end + 1;
    ++line_number;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') {
      if (end == text.size()) break;
      continue;
    }
    const auto eq = line.find('=');
    const std::string key = eq == std::string::npos ? line : line.substr(0, eq);
    const std::string value = eq == std::string::npos ? "" : line.substr(eq + 1);
    auto number = [&](int lo, int hi, int& out) {
      if (value.empty() || value.size() > 4 || value.find_first_not_of("0123456789") != std::string::npos) {
        c.errors.push_back("line " + std::to_string(line_number) + ": " + key + " needs a number");
        return;
      }
      const int v = std::stoi(value);
      if (v < lo || v > hi)
        c.errors.push_back("line " + std::to_string(line_number) + ": " + key + " out of range");
      else
        out = v;
    };
    if (key == "rotation") {
      int v = c.rotation;
      number(0, 270, v);
      if (v == 0 || v == 90 || v == 180 || v == 270) c.rotation = v;
      else if (v != c.rotation) c.errors.push_back("rotation must be 0, 90, 180 or 270");
    } else if (key == "startup") {
      if (value == "none") c.startup = Startup::none;
      else if (value == "identity") c.startup = Startup::identity;
      else if (value == "full") c.startup = Startup::full;
      else c.errors.push_back("startup must be none, identity or full");
    } else if (key == "startup_port") {
      number(0, 1, c.startup_port);
    } else if (key == "idle_minutes") {
      number(1, 120, c.idle_minutes);
    } else if (key == "listen_seconds") {
      number(0, 30, c.listen_seconds);
    } else if (key == "touch_rotation") {
      int v = c.touch_rotation;
      number(0, 270, v);
      if (v == 0 || v == 90 || v == 180 || v == 270) c.touch_rotation = v;
      else if (v != c.touch_rotation) c.errors.push_back("touch_rotation must be 0, 90, 180 or 270");
    } else if (key == "button_play" || key == "button_stop" || key == "button_record" || key == "button_clear" ||
               key == "tempo_control") {
      int& slot = key == "button_play"     ? c.button_play
                  : key == "button_stop"   ? c.button_stop
                  : key == "button_record" ? c.button_record
                  : key == "button_clear"  ? c.button_clear
                                           : c.tempo_control;
      // Hex as the session log prints it (0x52 or 52h), decimal otherwise; "none" unassigns.
      if (value == "none") {
        slot = -1;
      } else if (value.size() >= 3 && value.size() <= 4 && (value.rfind("0x", 0) == 0 || value.back() == 'h') &&
                 value.find_first_not_of("0123456789abcdefABCDEFxh") == std::string::npos) {
        const auto digits = value.back() == 'h' ? value.substr(0, value.size() - 1) : value.substr(2);
        const int v = digits.empty() || digits.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos
                          ? -2
                          : std::stoi(digits, nullptr, 16);
        if (v >= 0 && v <= 127) slot = v;
        else c.errors.push_back("line " + std::to_string(line_number) + ": " + key + " out of range");
      } else {
        number(0, 127, slot);
      }
    } else {
      c.errors.push_back("line " + std::to_string(line_number) + ": unknown key " + key);
    }
    if (end == text.size()) break;
  }
  return c;
}

inline int effective_rotation(const Config& c, int xres, int yres) {
  if (c.rotation >= 0) return c.rotation;
  return xres < yres ? 270 : 0;
}

}  // namespace xmp::live
