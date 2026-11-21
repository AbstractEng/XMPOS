// xmp-live-input: the MPC Live Mk1's controls for the XMP Device app (phase 3;
// AGENTS.md authorization 2). The only process that opens the internal
// "MPC Live Controller" (USB 09e8:003b). Like the session it reads both raw
// MIDI ports, and after a passive listening period sends only the universal
// identity request and Akai's start-up sequence. Nothing else is ever sent.
//
// It also decides the audio card: it writes /tmp/xmp-audio-card with the index
// of the "MPC Live Audio" card (09e8:203b) only on the Live's own board, and
// live-init builds the capped ALSA chain for that index only.
//
// Events go to the Device app's service as JSON lines over a local Unix socket
// (/tmp/xmp-input.sock): pads, front-panel buttons by name, knobs, the data
// wheel, and the power button.
#include "xmp/live_controls.hpp"

#include <alsa/asoundlib.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <array>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
const auto started = Clock::now();
FILE* log_file = nullptr;

void say(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void say(const char* fmt, ...) {
  char line[400];
  va_list a;
  va_start(a, fmt);
  std::vsnprintf(line, sizeof line, fmt, a);
  va_end(a);
  std::printf("XMP-INPUT %s\n", line);
  std::fflush(stdout);
  if (log_file) {
    std::fprintf(log_file, "%9.3f %s\n", std::chrono::duration<double>(Clock::now() - started).count(), line);
    std::fflush(log_file);
  }
}

std::string read_text(const std::string& path, std::size_t limit = 4096) {
  std::ifstream in(path, std::ios::binary);
  std::string text(limit, '\0');
  in.read(text.data(), static_cast<std::streamsize>(limit));
  text.resize(static_cast<std::size_t>(in.gcount()));
  return text;
}

// Front-panel buttons by note number (channel 1). Positions from the owner's
// session 4 log and the Device app's panel order (os/live-mk1/hardware.json).
struct Button {
  std::uint8_t note;
  const char* name;
};
constexpr std::array<Button, 22> kButtons{{
    {0x23, "bank-a"},     {0x24, "bank-b"},      {0x25, "bank-c"},    {0x26, "bank-d"},
    {0x0B, "note-repeat"}, {0x27, "full-level"}, {0x28, "16-level"},  {0x09, "erase"},
    {0x00, "q-link"},     {0x31, "shift"},       {0x7B, "menu"},      {0x34, "main"},
    {0x43, "undo"},       {0x7A, "copy"},        {0x36, "plus"},      {0x35, "tap"},
    {0x49, "rec"},        {0x50, "overdub"},     {0x51, "stop"},      {0x52, "play"},
    {0x53, "play-start"}, {0x37, "minus"},
}};
const char* button_name(std::uint8_t note) {
  for (const auto& b : kButtons)
    if (b.note == note) return b.name;
  return nullptr;
}

int client = -1;
void emit(const std::string& json) {
  if (client < 0) return;
  const std::string line = json + "\n";
  if (::send(client, line.data(), line.size(), MSG_NOSIGNAL | MSG_DONTWAIT) < 0 && errno != EAGAIN) {
    ::close(client);
    client = -1;
  }
}

}  // namespace

int main(int argc, char** argv) {
  for (int i = 1; i + 1 < argc; i += 2)
    if (std::strcmp(argv[i], "--log") == 0) log_file = std::fopen(argv[i + 1], "a");

  const auto compatible = read_text("/proc/device-tree/compatible", 1024);
  if (!xmp::live::is_live_mk1(compatible)) {
    say("refusing: this board is not the MPC Live Mk1");
    return 3;
  }
  // Cards by procfs identity only.
  int controller = -1;
  for (int card = 0; card < 8; ++card) {
    const std::string base = "/proc/asound/card" + std::to_string(card);
    const auto identity = read_text(base + "/id", 256) + " " + read_text(base + "/usbid", 256) + " " +
                          read_text(base + "/stream0", 256);
    if (identity.find_first_not_of(" \n") == std::string::npos) continue;
    if (xmp::live::live_audio_card_allowed(identity, compatible)) {
      std::ofstream("/tmp/xmp-audio-card.new") << card << "\n";
      ::rename("/tmp/xmp-audio-card.new", "/tmp/xmp-audio-card");
      say("audio card %d allowed (MPC Live Audio)", card);
    }
    if (controller < 0 && xmp::live::live_controller_card(identity)) controller = card;
  }
  std::array<snd_rawmidi_t*, 2> in{nullptr, nullptr};
  if (controller >= 0) {
    for (int port = 0; port < 2; ++port) {
      char name[32];
      std::snprintf(name, sizeof name, "hw:%d,0,%d", controller, port);
      if (snd_rawmidi_open(&in[static_cast<std::size_t>(port)], nullptr, name, SND_RAWMIDI_NONBLOCK) < 0)
        in[static_cast<std::size_t>(port)] = nullptr;
      say("controller %s %s", name, in[static_cast<std::size_t>(port)] ? "open for reading" : "unavailable");
    }
  } else {
    say("MPC Live Controller not found");
  }

  // Local Unix socket for the app service.
  ::unlink("/tmp/xmp-input.sock");
  const int listener = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::snprintf(address.sun_path, sizeof address.sun_path, "/tmp/xmp-input.sock");
  if (listener < 0 || ::bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof address) != 0 ||
      ::listen(listener, 1) != 0) {
    say("cannot open /tmp/xmp-input.sock");
    return 1;
  }
  ::chmod("/tmp/xmp-input.sock", 0600);

  std::vector<pollfd> fds{{listener, POLLIN, 0}};
  std::vector<int> kind{-1};  // -1 listener, 0/1 controller port, 2 input device
  for (int port = 0; port < 2; ++port) {
    auto* midi = in[static_cast<std::size_t>(port)];
    if (!midi) continue;
    std::vector<pollfd> some(static_cast<std::size_t>(std::max(0, snd_rawmidi_poll_descriptors_count(midi))));
    snd_rawmidi_poll_descriptors(midi, some.data(), static_cast<unsigned>(some.size()));
    for (auto& p : some) {
      fds.push_back(p);
      kind.push_back(port);
    }
  }
  for (int i = 0; i < 16; ++i) {
    const int fd = ::open(("/dev/input/event" + std::to_string(i)).c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) continue;
    fds.push_back({fd, POLLIN, 0});  // read only, never grabbed: the touchscreen stays with the compositor
    kind.push_back(2);
  }
  say("ready: %d controller ports, events on /tmp/xmp-input.sock", (in[0] ? 1 : 0) + (in[1] ? 1 : 0));

  std::array<xmp::live::Parser, 2> parsers{};
  bool startup_sent = false;
  char json[160];
  for (;;) {
    if (!startup_sent && controller >= 0 &&
        std::chrono::duration<double>(Clock::now() - started).count() >= 2.0) {
      startup_sent = true;
      char name[32];
      std::snprintf(name, sizeof name, "hw:%d,0,1", controller);
      snd_rawmidi_t* out = nullptr;
      if (snd_rawmidi_open(nullptr, &out, name, 0) == 0) {
        // The only two messages XMP may send the controller (authorization 2).
        snd_rawmidi_write(out, xmp::live::kIdentityRequest.data(), xmp::live::kIdentityRequest.size());
        snd_rawmidi_write(out, xmp::live::kStartupSequence.data(), xmp::live::kStartupSequence.size());
        snd_rawmidi_drain(out);
        snd_rawmidi_close(out);
        say("sent identity request and start-up sequence to %s", name);
      }
    }
    if (::poll(fds.data(), fds.size(), 100) <= 0) continue;
    for (std::size_t i = 0; i < fds.size(); ++i) {
      if (!(fds[i].revents & (POLLIN | POLLERR | POLLHUP))) continue;
      if (kind[i] == -1) {
        const int c = ::accept4(listener, nullptr, nullptr, SOCK_CLOEXEC);
        if (c >= 0) {
          if (client >= 0) ::close(client);
          client = c;
          say("app service connected");
        }
      } else if (kind[i] == 2) {
        input_event e{};
        while (::read(fds[i].fd, &e, sizeof e) == static_cast<ssize_t>(sizeof e))
          if (e.type == EV_KEY && e.code == KEY_POWER && e.value == 1) {
            say("power button");
            emit("{\"t\":\"power\"}");
          }
      } else {
        std::uint8_t bytes[256];
        auto* midi = in[static_cast<std::size_t>(kind[i])];
        for (int reads = 0; reads < 16; ++reads) {
          const auto n = snd_rawmidi_read(midi, bytes, sizeof bytes);
          if (n <= 0) break;
          for (ssize_t b = 0; b < n; ++b) {
            xmp::live::Event e;
            if (!parsers[static_cast<std::size_t>(kind[i])].feed(bytes[b], e)) continue;
            using xmp::live::Kind;
            if (e.kind == Kind::pad_on || e.kind == Kind::pad_off) {
              std::snprintf(json, sizeof json, "{\"t\":\"pad\",\"index\":%d,\"velocity\":%u,\"down\":%s}", e.pad,
                            e.data2, e.kind == Kind::pad_on ? "true" : "false");
              emit(json);
            } else if (e.kind == Kind::button_on || e.kind == Kind::button_off) {
              if (const char* name = button_name(e.data1)) {
                std::snprintf(json, sizeof json, "{\"t\":\"button\",\"name\":\"%s\",\"down\":%s}", name,
                              e.kind == Kind::button_on ? "true" : "false");
                emit(json);
              }
            } else if (e.kind == Kind::control && (e.status & 0x0F) == 0) {
              const int delta = e.data2 < 64 ? e.data2 : e.data2 - 128;
              if (e.data1 == 0x64) std::snprintf(json, sizeof json, "{\"t\":\"dial\",\"delta\":%d}", delta);
              else if (e.data1 >= 0x10 && e.data1 <= 0x13)
                std::snprintf(json, sizeof json, "{\"t\":\"knob\",\"knob\":%d,\"delta\":%d}", e.data1 - 0x0F, delta);
              else continue;
              emit(json);
            }
          }
        }
      }
    }
  }
}
