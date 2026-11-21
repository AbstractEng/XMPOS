#pragma once
// Shared Linux session resources. Never include this in a non-session build.
// All device entrypoints check the Live board; control output is allowlisted.
#include "xmp/engine.hpp"
#include "xmp/live_controls.hpp"
#include "xmp/live_screen.hpp"
#include <alsa/asoundlib.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <cstdarg>
#include <cstdio>
#include <fstream>
#include <sstream>
namespace xmp::live::platform {
using LogSink = void (*)(const char*);
inline LogSink log_sink = nullptr;
inline void say(const char* format, ...) {
  if (!log_sink) return;
  char line[512]; va_list args; va_start(args,format);
  std::vsnprintf(line,sizeof line,format,args); va_end(args); log_sink(line);
}
inline std::string read_text(const std::string& path, std::size_t limit = 65536) {
  std::ifstream input(path, std::ios::binary);
  std::string text;
  char buffer[4096];
  while (input && text.size() < limit) {
    input.read(buffer, sizeof buffer);
    text.append(buffer, static_cast<std::size_t>(input.gcount()));
  }
  if (text.size() > limit) text.resize(limit);
  return text;
}

inline std::string card_identity(int card) {
  const std::string base = "/proc/asound/card" + std::to_string(card);
  return read_text(base + "/id", 256) + " " + read_text(base + "/usbid", 256) + " " +
         read_text(base + "/stream0", 256);
}

inline std::string card_description(int card) {
  std::istringstream entries(read_text("/proc/asound/cards", 4096));
  std::string line;
  while (std::getline(entries, line)) {
    int number = -1;
    if (std::istringstream(line) >> number && number == card && std::getline(entries, line)) return line;
  }
  return {};
}

struct Screen : xmp::live::Canvas {
  int fd = -1;
  fb_var_screeninfo var{};
  fb_fix_screeninfo fix{};

  bool open(const xmp::live::Config& config) {
    if (!is_live_mk1(read_text("/proc/device-tree/compatible",1024))) return false;
    fd = ::open("/dev/fb0", O_RDWR | O_CLOEXEC);
    if (fd < 0) return false;
    if (ioctl(fd, FBIOGET_VSCREENINFO, &var) != 0 || ioctl(fd, FBIOGET_FSCREENINFO, &fix) != 0 ||
        var.bits_per_pixel != 32) {
      ::close(fd);
      fd = -1;
      return false;
    }
    size = fix.smem_len;
    void* mapped = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapped == MAP_FAILED) {
      ::close(fd);
      fd = -1;
      return false;
    }
    memory = static_cast<unsigned char*>(mapped);
    xres = static_cast<int>(var.xres);
    yres = static_cast<int>(var.yres);
    xoffset = static_cast<int>(var.xoffset);
    yoffset = static_cast<int>(var.yoffset);
    line_length = fix.line_length;
    red_offset = var.red.offset, red_length = var.red.length;
    green_offset = var.green.offset, green_length = var.green.length;
    blue_offset = var.blue.offset, blue_length = var.blue.length;
    rotation = xmp::live::effective_rotation(config, static_cast<int>(var.xres), static_cast<int>(var.yres));
    xmp::live::canvas_size(rotation, static_cast<int>(var.xres), static_cast<int>(var.yres), width, height);
    say("screen: %ux%u, %u bpp, rotation %d, canvas %dx%d", var.xres, var.yres, var.bits_per_pixel,
        rotation, width, height);
    return true;
  }

  void close() {
    if (memory) munmap(memory, size);
    if (fd >= 0) ::close(fd);
    memory = nullptr;
    fd = -1;
  }
};

// ---- controller input: the two raw MIDI ports ----

struct Controller {
  int card = -1;
  std::array<snd_rawmidi_t*, 2> in{nullptr, nullptr};
  std::array<xmp::live::Parser, 2> parsers{};
  std::array<snd_rawmidi_t*,2> feedback_out{nullptr,nullptr};
  xmp::live::PanelFeedback feedback;

  bool open_ports() {
    if (!is_live_mk1(read_text("/proc/device-tree/compatible",1024)) || !live_controller_card(card_identity(card))) return false;
    for (int port = 0; port < 2; ++port) {
      char name[32];
      std::snprintf(name, sizeof name, "hw:%d,0,%d", card, port);
      if (snd_rawmidi_open(&in[static_cast<std::size_t>(port)], nullptr, name, SND_RAWMIDI_NONBLOCK) < 0) {
        say("controller: cannot open %s for reading", name);
        in[static_cast<std::size_t>(port)] = nullptr;
      } else {
        say("controller: reading %s (%s)", name, port == 0 ? "Public" : "Private");
      }
    }
    return in[0] || in[1];
  }

  // Sends one of the two authorized messages, byte for byte, and nothing else.
  bool send(int port, const std::uint8_t* bytes, std::size_t size, const char* what) {
    if (card < 0 || port < 0 || port > 1 || !bytes) return false;
    const bool identity = size == kIdentityRequest.size() && std::equal(bytes, bytes+size, kIdentityRequest.begin());
    const bool startup = size == kStartupSequence.size() && std::equal(bytes, bytes+size, kStartupSequence.begin());
    if ((!identity && !startup) || !is_live_mk1(read_text("/proc/device-tree/compatible",1024)) || !live_controller_card(card_identity(card))) return false;
    char name[32];
    std::snprintf(name, sizeof name, "hw:%d,0,%d", card, port);
    snd_rawmidi_t* out = nullptr;
    if (snd_rawmidi_open(nullptr, &out, name, 0) < 0) {
      say("controller: cannot open %s for the %s", name, what);
      return false;
    }
    const auto written = snd_rawmidi_write(out, bytes, size);
    snd_rawmidi_drain(out);
    snd_rawmidi_close(out);
    say("controller: sent %s to %s (%ld of %zu bytes)", what, name, static_cast<long>(written), size);
    return written == static_cast<ssize_t>(size);
  }

  void open_feedback(const std::string& compatible) {
    if (card < 0 || !in[0] || !in[1] ||
        !xmp::live::qlink_led_controller_allowed(compatible, card_identity(card), card_description(card))) {
      say("controller: lights require the internal Live Mk1 controller");
      return;
    }
    for(int port=0;port<2;++port) {
      char name[32];std::snprintf(name,sizeof name,"hw:%d,0,%d",card,port);
      if(snd_rawmidi_open(nullptr,&feedback_out[port],name,SND_RAWMIDI_NONBLOCK)<0) {
        say("controller: cannot open feedback port %d",port);feedback_out[port]=nullptr;
      }
    }
  }

  void update_feedback(const xmp::live::PanelLights& lights) {
    for(int port=0;port<2;++port)if(feedback_out[port]) {
      const auto result=feedback.sync(port,lights,[&](const std::uint8_t* data,std::size_t size) {
        const auto written=snd_rawmidi_write(feedback_out[port],data,size);
        return written==-EAGAIN||written==-EINTR?0:written;
      });
      if(result==xmp::live::PanelFeedback::Result::failed) {
        say("controller: feedback port %d failed; disabled for this session",port);
        snd_rawmidi_close(feedback_out[port]);feedback_out[port]=nullptr;
      }
    }
  }

  void close() {
    // Bounded best effort: complete any short frame, then extinguish all lights.
    for(int i=0;i<16;++i)update_feedback({});
    for(auto& port:feedback_out) {if(port)snd_rawmidi_close(port);port=nullptr;}
    for (auto& port : in)
      if (port) snd_rawmidi_close(port);
    in = {nullptr, nullptr};
  }
};


// ---- touchscreen: the first input device reporting absolute positions ----
struct Touch {
  int fd = -1;
  input_absinfo ax{}, ay{};
  int x = 0, y = 0;
  bool down = false, pending = false;

  static bool has_abs(int fd, int code) {
    unsigned long bits[(ABS_CNT + 8 * sizeof(unsigned long) - 1) / (8 * sizeof(unsigned long))] = {};
    if (ioctl(fd, EVIOCGBIT(EV_ABS, sizeof bits), bits) < 0) return false;
    return bits[code / (8 * sizeof(unsigned long))] >> (code % (8 * sizeof(unsigned long))) & 1;
  }

  // Takes the descriptor if it is a touchscreen; logs its axis ranges.
  bool adopt(int candidate, const std::string& path) {
    if (fd >= 0 || !is_live_mk1(read_text("/proc/device-tree/compatible",1024))) return false;
    const bool mt = has_abs(candidate, ABS_MT_POSITION_X) && has_abs(candidate, ABS_MT_POSITION_Y);
    const bool single = has_abs(candidate, ABS_X) && has_abs(candidate, ABS_Y);
    if (!mt && !single) return false;
    const int cx = mt ? ABS_MT_POSITION_X : ABS_X, cy = mt ? ABS_MT_POSITION_Y : ABS_Y;
    if (ioctl(candidate, EVIOCGABS(cx), &ax) < 0 || ioctl(candidate, EVIOCGABS(cy), &ay) < 0) return false;
    char name[96] = {};
    ioctl(candidate, EVIOCGNAME(sizeof name - 1), name);
    fd = candidate;
    say("touch: %s \"%s\", x %d..%d, y %d..%d", path.c_str(), name, ax.minimum, ax.maximum, ay.minimum, ay.maximum);
    return true;
  }

  // Feeds one event; returns true when a new touch-down is complete.
  enum class Phase { down, move, up };
  Phase phase = Phase::down;
  bool moved = false;
  // Existing downstream clients receive one event per press. XMP's UI opts
  // into move/up phases explicitly so drags work without duplicate clicks.
  bool feed(const input_event& e) { return feed_phase(e) && phase == Phase::down; }
  bool feed_phase(const input_event &e) {
    if (e.type == EV_ABS && (e.code == ABS_MT_POSITION_X || e.code == ABS_X))
      x = e.value, moved = true;
    else if (e.type == EV_ABS && (e.code == ABS_MT_POSITION_Y || e.code == ABS_Y))
      y = e.value, moved = true;
    else if (e.type == EV_KEY && e.code == BTN_TOUCH) {
      if ((e.value != 0) != down)
        pending = true, phase = e.value ? Phase::down : Phase::up;
      down = e.value != 0;
    } else if (e.type == EV_SYN && e.code == SYN_REPORT && (pending || (moved && down))) {
      if (!pending)
        phase = Phase::move;
      pending = moved = false;
      return true;
    }
    return false;
  }
};


// ALSA handle ownership is shared by all downstream session applications.
inline snd_pcm_t* open_pcm(int card, bool capture) {
  if (!live_audio_card_allowed(card_identity(card), read_text("/proc/device-tree/compatible",1024))) return nullptr;
  snd_pcm_t* pcm=nullptr; char device[32]; std::snprintf(device,sizeof device,"plughw:%d,0",card);
  if (snd_pcm_open(&pcm,device,capture?SND_PCM_STREAM_CAPTURE:SND_PCM_STREAM_PLAYBACK,0)<0) return nullptr;
  if (snd_pcm_set_params(pcm,SND_PCM_FORMAT_S16_LE,SND_PCM_ACCESS_RW_INTERLEAVED,2,xmp::kRate,1,capture?50000:16000)<0) {
    snd_pcm_close(pcm); return nullptr;
  }
  return pcm;
}
inline void close_pcm(snd_pcm_t*& pcm) {
  if (pcm) { snd_pcm_drop(pcm); snd_pcm_close(pcm); pcm=nullptr; }
}
} // namespace xmp::live::platform
