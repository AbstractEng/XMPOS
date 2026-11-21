// XMP session on the owner's MPC Live Mk1 (AGENTS.md, "Device-specific
// authorization 2"). Started by the session init in xmp/system.img on the
// owner's USB stick. It:
//   - reads everything the internal "MPC Live Controller" (USB 09e8:003b) sends
//     on its two raw MIDI ports, and after a passive listening period sends it
//     the universal identity request and Akai's start-up SysEx sequence;
//   - updates only the four authorized Q-Link page LEDs over the Private port;
//   - plays eight tracks (synthesized kits in XMP, 808 and 909 styles, the
//     synth, and samplers of the owner's own WAVs from the stick) with XMP's
//     engine (rack.hpp, as in the browser) through the "MPC Live Audio" card (USB 09e8:203b) only, hard-limited to -12 dBFS peak;
//   - draws the pad grid on the screen and lights pads as they are hit;
//   - logs every controller message to the stick, and switches off at the
//     power button or after a period without pad input.
// It never opens storage other than the log on the stick, never opens any other
// sound card, and sends nothing else to the controller.
//
// There is one build. The emulator test runs this same binary against the Live
// twin (os/live-mk1/live-twin.c), which presents USB gadgets with the Live's
// controller and audio card IDs on QEMU's virtual USB host.
#include "xmp/chop.hpp"
#include "xmp/engine.hpp"
#include "xmp/live_controls.hpp"
#include "xmp/live_platform_linux.hpp"
#include "xmp/live_kits.hpp"
#include "xmp/live_sample_folder.hpp"
#include "xmp/live_engine.hpp"
#include "xmp/live_player.hpp"
#include "xmp/live_loop.hpp"
#include "xmp/portable.hpp"
#include "xmp/live_workbench.hpp"
#include "xmp/live_project_import.hpp"
#include "xmp/song_snapshot.hpp"
#include "xmp/live_library.hpp"
#include "xmp/project_edit.hpp"
#include "xmp/live_sampler.hpp"
#include "xmp/live_sample.hpp"
#include "xmp/live_session.hpp"
#include "xmp/live_sequencer.hpp"
#include "xmp/live_song.hpp"
#include "xmp/live_screen.hpp"
#include "xmp/live_theme.hpp"
#include "xmp/rt_thread.hpp"

#include <alsa/asoundlib.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <cmath>
#include <csignal>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
volatile std::sig_atomic_t interrupted = 0;
void interrupt(int) { interrupted = 1; }

using xmp::live::platform::read_text;

// ---- log: the serial console and a bounded file on the stick ----
// The main loop only queues lines; a writer thread prints them, writes them to
// the stick and syncs about once a second. A slow console (115200 baud) or a
// slow stick then never delays a pad hit, and the file survives the stick being
// pulled or the power going, up to the last second.
constexpr std::size_t kLogLimit = 4 * 1024 * 1024;
Clock::time_point started;

class Log {
 public:
  std::atomic<unsigned> pending_saves{0};
  std::atomic<bool> save_failed{false};
  void open(const std::string& path) {
    file_ = std::fopen(path.c_str(), "w");
    writer_ = std::thread([this] { run(); });
  }
  // Replaces a small file on the stick (write, sync, rename) on the writer
  // thread. With `previous`, the file it replaces is kept under that name.
  void save(std::string path, std::string text, std::string previous = {}) {
    ++pending_saves;
    save_failed=false;
    std::lock_guard<std::mutex> hold(mutex_);
    saves_.push_back(Save{std::move(path), std::move(text), std::move(previous)});
    wake_.notify_one();
  }
  void line(std::string text) {
    std::lock_guard<std::mutex> hold(mutex_);
    if (queue_.size() >= 4096) {
      ++dropped_;
      return;
    }
    queue_.push_back(std::move(text));
    wake_.notify_one();
  }
  // Blocks until everything queued so far (lines and saves) is on the stick.
  void flush() {
    std::unique_lock<std::mutex> hold(mutex_);
    ++flush_wanted_;
    wake_.notify_one();
    const auto ticket = flush_wanted_;
    done_.wait_for(hold, std::chrono::seconds(10), [&] { return flush_done_ >= ticket; });
  }
  void close() {
    {
      std::lock_guard<std::mutex> hold(mutex_);
      closing_ = true;
      wake_.notify_one();
    }
    if (writer_.joinable()) writer_.join();
  }

 private:
  void run() {
    std::unique_lock<std::mutex> hold(mutex_);
    auto synced = Clock::now();
    bool dirty = false;
    for (;;) {
      wake_.wait_for(hold, std::chrono::milliseconds(500), [this] {
        return closing_ || !queue_.empty() || !saves_.empty() || flush_wanted_ > flush_done_;
      });
      const auto flushing = flush_wanted_;
      std::deque<std::string> batch;
      batch.swap(queue_);
      std::deque<Save> saves;
      saves.swap(saves_);
      const auto dropped = dropped_;
      dropped_ = 0;
      const bool closing = closing_;
      hold.unlock();
      if (dropped) batch.push_back("log: " + std::to_string(dropped) + " lines dropped (queue full)");
      for (const auto& text : batch) {
        std::printf("XMP-SESSION %s\n", text.c_str() + text.find(' ', text.find_first_not_of(' ')) + 1);
        if (file_ && bytes_ < kLogLimit) {
          bytes_ += text.size() + 1;
          std::fputs(text.c_str(), file_);
          std::fputc('\n', file_);
          if (bytes_ >= kLogLimit) std::fputs("log limit reached\n", file_);
          dirty = true;
        }
      }
      std::fflush(stdout);
      for (const auto& [path, text, previous] : saves) {
        const auto temporary = path + ".new";
        bool saved=false;
        if (FILE* f = std::fopen(temporary.c_str(), "w")) {
          bool ok = std::fwrite(text.data(), 1, text.size(), f) == text.size() && std::fflush(f) == 0 &&
                          fsync(fileno(f)) == 0;
          std::fclose(f);
          if(ok&&!previous.empty()&&std::rename(path.c_str(),previous.c_str())!=0&&errno!=ENOENT)ok=false;
          saved=ok&&std::rename(temporary.c_str(),path.c_str())==0;
        }
        if(!saved)save_failed=true;
        --pending_saves;
      }
      if (file_ && dirty && (closing || Clock::now() - synced >= std::chrono::seconds(1))) {
        std::fflush(file_);
        fsync(fileno(file_));
        dirty = false;
        synced = Clock::now();
      }
      {
        std::lock_guard<std::mutex> done(mutex_);
        flush_done_ = std::max(flush_done_, flushing);
      }
      done_.notify_all();
      if (closing) {
        if (file_) std::fclose(file_);
        file_ = nullptr;
        return;
      }
      hold.lock();
    }
  }
  FILE* file_ = nullptr;
  std::size_t bytes_ = 0, dropped_ = 0;
  bool closing_ = false;
  std::deque<std::string> queue_;
  struct Save {
    std::string path, text, previous;
  };
  std::deque<Save> saves_;
  std::mutex mutex_;
  std::condition_variable wake_, done_;
  std::uint64_t flush_wanted_ = 0, flush_done_ = 0;
  std::thread writer_;
};
Log session_log;

void say(const char* format, ...) {
  char line[512];
  va_list args;
  va_start(args, format);
  std::vsnprintf(line, sizeof line, format, args);
  va_end(args);
  char stamped[540];
  std::snprintf(stamped, sizeof stamped, "%9.3f %s",
                std::chrono::duration<double>(Clock::now() - started).count(), line);
  session_log.line(stamped);
}

std::string hex(const std::uint8_t* bytes, std::size_t size) {
  std::string out;
  char b[4];
  for (std::size_t i = 0; i < size && i < 96; ++i) {
    std::snprintf(b, sizeof b, "%02X ", bytes[i]);
    out += b;
  }
  if (size > 96) out += "...";
  if (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

// ---- board and card rules ----
bool board_allowed(const std::string& compatible) {
  return xmp::live::is_live_mk1(compatible);
}

using xmp::live::platform::card_identity;

bool audio_card_allowed(const std::string& identity, const std::string& compatible) {
  return xmp::live::live_audio_card_allowed(identity, compatible);
}

// ---- audio: the engine on a real-time thread, nothing allocated while playing ----
struct Audio {
  snd_pcm_t* pcm = nullptr;
  std::atomic<bool> stop{false};
  std::atomic<std::uint64_t> frame_now{0};  // frames sent so far: the session's clock
  std::atomic<std::uint64_t> blocks{0}, xruns{0}, errors{0};
  std::atomic<std::uint32_t> peak_bits{0};
  // Load: the time spent making each block of 256 frames (5.33 ms of audio),
  // as a running total and the worst block, in microseconds.
  std::atomic<std::uint64_t> busy_us{0}, worst_us{0};
  // Bridge audio tap: a copy of what is sent to the card (after the limiter),
  // into a buffer allocated before playback. The audio thread only copies.
  static constexpr std::size_t kTapFrames = 10 * xmp::kRate;
  std::vector<std::int16_t> tap = std::vector<std::int16_t>(kTapFrames * 2);
  std::atomic<std::size_t> tap_wanted{0}, tap_frames{0};
  // XMP's engine (rack.hpp, as in the browser), with every kit and sample
  // take prepared before the audio thread starts (live_engine.hpp).
  xmp::live::LiveEngine engine{xmp::kRate};
  // False once a project is open: nothing reaches the pattern session's
  // engine then, so the audio thread does not run it. Set before the thread starts.
  std::atomic<bool> pattern_engine{true};
  // A full XMP project from the stick (live_player.hpp), mixed with the session's own sound.
  xmp::live::ProjectSound project;
  xmp::live::sample::InputRing<> input;
  xmp::live::sample::LoopTake loop_take;
  std::atomic<bool> monitor{false}, private_audio{false};
  bool input_ready = false;  // audio thread only, a bounded cushion for input bursts
  xmp::RealtimeResult realtime{};
  std::thread thread;
  bool running = false;
  // The Sample view's audition: an edited take, written by the main thread
  // only while nothing plays it (length 0), then played once by the audio
  // thread at -12 dB. The buffer is allocated here, before playback.
  std::vector<float> preview = std::vector<float>(xmp::live::sample::kMaxFrames);
  std::atomic<std::size_t> preview_length{0};
  std::atomic<bool> preview_stop{false};
  std::size_t preview_at = 0;  // audio thread only

  // Main thread: plays `pcm` once. False while an earlier one is still being
  // stopped; try again on the next frame.
  bool audition(const std::vector<float>& pcm) {
    if (preview_length.load(std::memory_order_acquire) != 0) {
      preview_stop.store(true, std::memory_order_release);
      return false;
    }
    preview_stop.store(false, std::memory_order_relaxed);
    const std::size_t n = std::min(pcm.size(), preview.size());
    std::copy(pcm.begin(), pcm.begin() + static_cast<std::ptrdiff_t>(n), preview.begin());
    preview_length.store(n, std::memory_order_release);
    return true;
  }

  void loop() {
    realtime = xmp::promote_audio_thread(256ULL * 1000000000ULL / xmp::kRate);
    std::array<float, 256> left{}, right{};
    std::array<std::int16_t, 512> pcm16{};
    float peak = 0;
    unsigned consecutive = 0;
    std::uint64_t frame = 0;
    while (!stop.load(std::memory_order_relaxed)) {
      left.fill(0);
      right.fill(0);
      const auto began = std::chrono::steady_clock::now();
      std::array<float,256> incoming{};
      std::array<uint8_t,256> valid{};
      if (!input_ready && input.available() >= 512) input_ready = true;
      const bool overflow = input.overflowed();
      for (size_t i=0;i<256;++i) {
        if (input_ready && input.pop(incoming[i]) && !overflow) valid[i]=1;
        else input_ready = false;
      }
      if (pattern_engine.load(std::memory_order_relaxed)) engine.process(left.data(), right.data(), 256, frame);
      project.process(left.data(), right.data(), 256, frame, &loop_take, incoming.data(), valid.data());
      const auto spent = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - began).count());
      busy_us.fetch_add(spent, std::memory_order_relaxed);
      if (spent > worst_us.load(std::memory_order_relaxed)) worst_us.store(spent, std::memory_order_relaxed);
      if (const std::size_t length = preview_length.load(std::memory_order_acquire); length != 0) {
        if (preview_stop.load(std::memory_order_acquire)) {
          preview_at = 0, preview_stop.store(false, std::memory_order_relaxed);
          preview_length.store(0, std::memory_order_release);
        } else {
          for (std::size_t i = 0; i < 256 && preview_at < length; ++i, ++preview_at) {
            const float v = preview[preview_at] * 0.25f;
            left[i] += v, right[i] += v;
          }
          if (preview_at >= length) preview_at = 0, preview_length.store(0, std::memory_order_release);
        }
      }
      if (monitor.load(std::memory_order_relaxed)) for (size_t i=0;i<256;++i) if (valid[i]) {
        left[i] += incoming[i]*0.25f, right[i] += incoming[i]*0.25f;
      }
      frame += 256;
      frame_now.store(frame, std::memory_order_release);
      for (std::size_t i = 0; i < 256; ++i) {
        const float l = xmp::live::limit(left[i]), r = xmp::live::limit(right[i]);
        peak = std::max(peak, std::max(std::fabs(l), std::fabs(r)));
        pcm16[i * 2] = static_cast<std::int16_t>(std::lrint(l * 32767.0f));
        pcm16[i * 2 + 1] = static_cast<std::int16_t>(std::lrint(r * 32767.0f));
      }
      const auto wanted = tap_wanted.load(std::memory_order_acquire);
      const auto have = tap_frames.load(std::memory_order_relaxed);
      if (have < wanted && !private_audio.load(std::memory_order_acquire)) {
        const std::size_t n = std::min<std::size_t>(256, wanted - have);
        std::copy(pcm16.begin(), pcm16.begin() + static_cast<std::ptrdiff_t>(n * 2),
                  tap.begin() + static_cast<std::ptrdiff_t>(have * 2));
        tap_frames.store(have + n, std::memory_order_release);
      }
      std::uint32_t bits = 0;
      std::memcpy(&bits, &peak, 4);
      peak_bits.store(bits, std::memory_order_relaxed);
      snd_pcm_uframes_t offset = 0;
      while (offset < 256 && !stop.load(std::memory_order_relaxed)) {
        const auto result = snd_pcm_writei(pcm, pcm16.data() + offset * 2, 256 - offset);
        if (result == -EPIPE || result == -ESTRPIPE) {
          xruns.fetch_add(1, std::memory_order_relaxed);
          if (snd_pcm_recover(pcm, static_cast<int>(result), 1) < 0) return;
        } else if (result < 0) {
          errors.fetch_add(1, std::memory_order_relaxed);
          if (++consecutive > 8 || snd_pcm_prepare(pcm) < 0) return;  // card gone: stop playing
        } else {
          consecutive = 0;
          offset += static_cast<snd_pcm_uframes_t>(result);
        }
      }
      blocks.fetch_add(1, std::memory_order_relaxed);
    }
  }

  bool open(int card) {
    char device[32];
    std::snprintf(device, sizeof device, "plughw:%d,0", card);
    pcm = xmp::live::platform::open_pcm(card, false);
    if (!pcm) { say("audio: verified card open failed"); return false; }
    snd_pcm_uframes_t buffer = 0, period = 0;
    snd_pcm_get_params(pcm, &buffer, &period);
    say("audio: %s open, period %lu, buffer %lu frames", device, static_cast<unsigned long>(period),
        static_cast<unsigned long>(buffer));
    thread = std::thread([this] { loop(); });
    running = true;
    return true;
  }

  void close() {
    if (!running) return;
    stop = true;
    thread.join();
    xmp::live::platform::close_pcm(pcm);
    running = false;
  }

  float peak() const {
    float value = 0;
    const auto bits = peak_bits.load(std::memory_order_relaxed);
    std::memcpy(&value, &bits, 4);
    return value;
  }
};

// ---- sampling: the inputs of the "MPC Live Audio" card (AGENTS.md authorization 7) ----
// Opened only while the Sample view records, on the card the session plays
// through (the same identity rules). A thread copies the input, mixed to
// mono, into a ring allocated before it starts; the main thread reads it. The
// recording stays in memory, and reaches the stick only inside the project.
// The two inputs are summed, not averaged, so a source on one input (a cable
// into Input L) keeps its full level.
// The card's capture controls (names, switches and levels), logged when the
// inputs open, to see why a take hears nothing. Read only: nothing is set.
inline void log_capture_controls(int card) {
  snd_mixer_t* mixer = nullptr;
  char name[32];
  std::snprintf(name, sizeof name, "hw:%d", card);
  if (snd_mixer_open(&mixer, 0) < 0) return;
  if (snd_mixer_attach(mixer, name) < 0 || snd_mixer_selem_register(mixer, nullptr, nullptr) < 0 || snd_mixer_load(mixer) < 0) {
    snd_mixer_close(mixer);
    say("sample: no mixer controls on %s", name);
    return;
  }
  int count = 0;
  for (snd_mixer_elem_t* e = snd_mixer_first_elem(mixer); e; e = snd_mixer_elem_next(e)) {
    if (!snd_mixer_selem_is_active(e)) continue;
    const bool cvol = snd_mixer_selem_has_capture_volume(e), cswitch = snd_mixer_selem_has_capture_switch(e);
    long value = 0, low = 0, high = 0;
    int on = 1;
    if (cvol) {
      snd_mixer_selem_get_capture_volume_range(e, &low, &high);
      snd_mixer_selem_get_capture_volume(e, SND_MIXER_SCHN_FRONT_LEFT, &value);
    }
    if (cswitch) snd_mixer_selem_get_capture_switch(e, SND_MIXER_SCHN_FRONT_LEFT, &on);
    say("sample: control \"%s\": %s%s%s", snd_mixer_selem_get_name(e),
        cvol ? ("capture " + std::to_string(value) + " of " + std::to_string(low) + ".." + std::to_string(high)).c_str() : "",
        cvol && cswitch ? ", " : "", cswitch ? (on ? "capture on" : "capture OFF") : (cvol ? "" : "playback only"));
    ++count;
  }
  if (count == 0) say("sample: %s has no mixer controls", name);
  snd_mixer_close(mixer);
}

struct Capture {
  static constexpr std::size_t kRing = 1 << 18;  // 5.4 s at 48 kHz
  snd_pcm_t* pcm = nullptr;
  std::thread thread;
  std::atomic<bool> stop{false}, failed{false};
  xmp::live::sample::InputRing<kRing> ring;
  xmp::live::sample::InputRing<>* audio_input = nullptr;
  bool running = false;

  bool open(int card) {
    if (!audio_card_allowed(card_identity(card), read_text("/proc/device-tree/compatible",1024))) return false;
    char device[32];
    std::snprintf(device, sizeof device, "plughw:%d,0", card);
    if (snd_pcm_open(&pcm, device, SND_PCM_STREAM_CAPTURE, 0) < 0) {
      say("sample: cannot open the inputs of %s", device);
      pcm = nullptr;
      return false;
    }
    if (snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 2, xmp::kRate, 1, 16000) < 0) {
      say("sample: %s refused 48 kHz stereo input", device);
      snd_pcm_close(pcm);
      pcm = nullptr;
      return false;
    }
    log_capture_controls(card);
    stop = false, failed = false;
    thread = std::thread([this] { loop(); });
    running = true;
    say("sample: recording from the inputs of %s", device);
    return true;
  }
  void loop() {
    std::array<std::int16_t, 512> in{};
    unsigned consecutive = 0;
    while (!stop.load(std::memory_order_relaxed)) {
      const auto got = snd_pcm_readi(pcm, in.data(), 256);
      if (got == -EPIPE || got == -ESTRPIPE) {
        if (snd_pcm_recover(pcm, static_cast<int>(got), 1) < 0) break;
        continue;
      }
      if (got < 0) {
        if (++consecutive > 8 || snd_pcm_prepare(pcm) < 0) break;
        continue;
      }
      consecutive = 0;
      for (long i = 0; i < got; ++i) {
        const float value = std::clamp((static_cast<float>(in[static_cast<size_t>(i)*2])+in[static_cast<size_t>(i)*2+1])/32768.0f,-1.0f,1.0f);
        if (!ring.push(value)) failed.store(true,std::memory_order_release);
        if (audio_input && !audio_input->push(value)) failed.store(true,std::memory_order_release);
      }
    }
    if (!stop.load()) failed = true;
  }
  // Main thread: what arrived since the last call (the newest, if it fell behind).
  int drain(float* out, int max) {
    int n = 0;
    while (n < max && ring.pop(out[n])) ++n;
    return n;
  }
  void close() {
    if (!running) return;
    stop = true;
    thread.join();
    xmp::live::platform::close_pcm(pcm);
    pcm = nullptr;
    running = false;
  }
};

// ---- screen: direct framebuffer drawing ----
using xmp::live::platform::Screen;
using xmp::live::platform::Controller;
using xmp::live::platform::Touch;

// ---- control socket: local Unix socket for the bridge daemon on the unit ----
// (AGENTS.md authorization 3). Line commands, bounded; nothing is executed.
constexpr const char* kControlSocket = "/tmp/xmp-session.sock";

int open_control_socket() {
  ::unlink(kControlSocket);
  const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::snprintf(address.sun_path, sizeof address.sun_path, "%s", kControlSocket);
  if (::bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof address) != 0 || ::listen(fd, 2) != 0) {
    ::close(fd);
    return -1;
  }
  ::chmod(kControlSocket, 0600);
  return fd;
}

// What identifies one saved project.xmpsong: its size and a hash of its text.
// project.edits names the save it belongs to with this.
std::string file_identity(const std::string& text) {
  const auto id = xmp::song_snapshot::identity(text.data(), text.size());
  return std::string(id.c_str(), id.size());
}
// The Live's saves (docs/performance-audit.md finding 5). project.xmpsong is
// the whole song with its samples, as the browser opens it. Rewriting it for
// every edit put 1.3 MB on the stick each time, nearly all of it samples that
// had not changed; so an edit that changes no sample writes project.edits
// instead: one line naming the project.xmpsong it belongs to, then the song
// without its audio (the format's "referenced" mode). The whole song is
// written when a sample changes and when the session ends. At start,
// project.edits is applied only when it names the project.xmpsong that is
// there, with its audio taken from that file. Touched by one saver thread at a
// time, and by the main thread before the first.
struct SaveState {
  std::string base_id;                  // the project.xmpsong on the stick ("" before there is one)
  std::vector<std::string> base_hashes; // its samples' audio
  bool kept_previous = false;
};
const char* const kEditsHead = xmp::song_snapshot::kEditsHead;

std::string wav_bytes(const std::int16_t* samples, std::size_t frames, std::uint32_t rate) {
  std::string out(44 + frames * 4, '\0');
  auto put32 = [&](std::size_t at, std::uint32_t v) { std::memcpy(&out[at], &v, 4); };
  auto put16 = [&](std::size_t at, std::uint16_t v) { std::memcpy(&out[at], &v, 2); };
  std::memcpy(&out[0], "RIFF", 4);
  put32(4, static_cast<std::uint32_t>(36 + frames * 4));
  std::memcpy(&out[8], "WAVEfmt ", 8);
  put32(16, 16);
  put16(20, 1);
  put16(22, 2);
  put32(24, rate);
  put32(28, rate * 4);
  put16(32, 4);
  put16(34, 16);
  std::memcpy(&out[36], "data", 4);
  put32(40, static_cast<std::uint32_t>(frames * 4));
  std::memcpy(&out[44], samples, frames * 4);
  return out;
}

struct Options {
  std::string log, conf, pattern;
};

}  // namespace

int main(int argc, char** argv) {
  started = Clock::now();
  xmp::live::platform::log_sink = [](const char* line) { say("%s",line); };
  Options options;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string key = argv[i], value = argv[i + 1];
    if (key == "--log") options.log = value;
    else if (key == "--conf") options.conf = value;
    else if (key == "--pattern") options.pattern = value;
    else {
      std::fprintf(stderr, "xmp-live-session: unknown option %s\n", key.c_str());
      return 2;
    }
  }
  if (argc % 2 != 1 || options.log.empty()) {
    std::fprintf(stderr, "Usage: xmp-live-session --log FILE [--conf FILE]\n");
    return 2;
  }
  session_log.open(options.log);
  say("XMP session (one build for the Live and its emulator twin)");
  std::signal(SIGTERM, interrupt);
  std::signal(SIGINT, interrupt);

  const auto compatible = read_text("/proc/device-tree/compatible", 1024);
  std::string printable = compatible;
  for (auto& c : printable)
    if (c == '\0') c = ' ';
  say("board: %s", printable.c_str());
  if (!board_allowed(compatible)) {
    say("refusing: this board is not the MPC Live Mk1");
    session_log.close();
    return 3;
  }

  xmp::live::Config config;
  if (!options.conf.empty()) {
    const auto text = read_text(options.conf, 8192);
    if (!text.empty()) config = xmp::live::parse_config(text);
  }
  for (const auto& error : config.errors) say("session.conf: %s", error.c_str());

  // Cards by procfs identity only; nothing is opened to identify them.
  int audio_card = -1;
  Controller controller;
  for (int card = 0; card < 8; ++card) {
    const auto identity = card_identity(card);
    if (identity.find_first_not_of(" \n") == std::string::npos) continue;
    std::string flat = identity.substr(0, 160);
    for (auto& c : flat)
      if (c == '\n') c = ' ';
    say("card %d: %s", card, flat.c_str());
    if (audio_card < 0 && audio_card_allowed(identity, compatible)) audio_card = card;
    if (controller.card < 0 && xmp::live::live_controller_card(identity)) controller.card = card;
  }

  Screen screen;
  const bool have_screen = screen.open(config);
  if (!have_screen) {
    say("screen: no 32-bit framebuffer; continuing without one");
    screen.width = 1280;  // touch and layout still use the Live's canvas size
    screen.height = 800;
  }

  xmp::live::Song song = xmp::live::default_song();

  // Sounds, all prepared before the audio thread starts and kept for the whole
  // session: the three synthesized kits, and each track's own samples from
  // xmp/samples/trackN/ on the stick (bounded; see live_sample_folder.hpp).
  std::array<xmp::live::SampleBank, xmp::live::kKitStyles> kit_banks{};
  for (int style = 0; style < xmp::live::kKitStyles; ++style)
    for (int pad = 0; pad < 16; ++pad)
      kit_banks[static_cast<std::size_t>(style)].set_single(
          pad, xmp::live::make_kit_sound(style, pad, xmp::kRate),
          static_cast<std::uint8_t>(xmp::live::kit_choke(style, pad)));
  std::array<xmp::live::SampleBank, xmp::live::kTracks> sample_banks{};
  // The engine's banks: the kits (0-2), then each track's own samples (3-10).
  static_assert(xmp::live::kKitStyles == xmp::live::kKitBanks && xmp::live::kTracks == xmp::live::kLiveTracks);
  auto bank_index = [&](int t) {
    const auto& track = song.tracks[static_cast<std::size_t>(t)];
    if (track.kind == xmp::live::Track::kit) return std::clamp(track.preset, 0, xmp::live::kKitStyles - 1);
    if (track.kind == xmp::live::Track::sampler) return xmp::live::kKitBanks + t;
    return -1;
  };
  auto sound_of = [&](const xmp::live::Track& track) {
    return xmp::live::LiveEngine::TrackSound{track.kind == xmp::live::Track::synth, xmp::live::track_patch(track)};
  };

  Audio audio;
  // A full XMP project next to the pattern on the stick (project.xmpsong or
  // project.xmp.json, as the browser studio saves them), prepared before the
  // audio thread starts. Play and Stop then play its song or first scene.
  // The Live saves its edits as project.xmpsong; when both files are there
  // the newer opens, so a project.xmp.json copied from the browser later still
  // wins.
  xmp::json::Value project_doc;
  SaveState save_state;
  bool have_project = false, project_refused = false, migrated_pattern = false;
  std::string project_dir;
  if (!options.pattern.empty()) {
    const auto slash = options.pattern.rfind('/');
    const std::string dir = slash == std::string::npos ? std::string(".") : options.pattern.substr(0, slash);
    project_dir = dir;
    std::array<const char*, 2> names{"project.xmpsong", "project.xmp.json"};
    struct stat song_st {}, saved_st {};
    if (stat((dir + "/project.xmp.json").c_str(), &saved_st) == 0 &&
        (stat((dir + "/project.xmpsong").c_str(), &song_st) != 0 || saved_st.st_mtime > song_st.st_mtime))
      std::swap(names[0], names[1]);
    for (const char* name : names) {
      const std::string path = dir + "/" + name;
      struct stat st {};
      if (stat(path.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) continue;
      const auto text = read_text(path, xmp::project_limits::kSongBytes + 1);
      const auto edits = std::string(name) == "project.xmpsong" ?
          read_text(dir + "/project.edits", xmp::song_snapshot::kMaxEditsBytes) : std::string();
      const auto opened = xmp::song_snapshot::open(text.data(), text.size(), edits.data(), edits.size());
      if (!opened.ok) {
        say("project: %s refused: %s; saved files retained", name, opened.error.c_str());
        project_refused = true;
        break;
      }
      xmp::json::Value doc = opened.project;
      const bool edits_applied = opened.edits_applied;
      if (opened.stale_edits) say("project: project.edits is from an earlier save of the song; not used");
      if (std::string(name) == "project.xmpsong") {
        save_state.base_id = file_identity(text);
        for (const auto& sample : xmp::project::detail::list(doc, "samples")) {
          xmp::Vec<double> pcm;
          for (const auto& v : xmp::project::detail::list(sample, "pcm")) pcm.push(v.as_number());
          xmp::Str hash, why;
          if (xmp::portable::hash_sample(xmp::project::detail::num(sample, "sampleRate"), pcm, hash, why))
            save_state.base_hashes.emplace_back(hash.c_str());
        }
      }
      xmp::Str error;
      if (!audio.project.prepare(doc, error)) {
        say("project: %s cannot play: %s; saved files retained", name, error.c_str());
        project_refused = true;
        break;
      }
      if (edits_applied) say("project: the edits since the last whole save (project.edits) are applied");
      project_doc = doc;
      have_project = true;
      say("project: %s \"%s\", %d tracks, %d scenes", name, xmp::project::detail::str(project_doc, "name").c_str(),
          xmp::project::detail::list(project_doc, "tracks").size(), xmp::project::detail::list(project_doc, "scenes").size());
      break;
    }
  }

  if (project_refused) {
    session_log.close();
    return 4;  // Never replace an unsupported or unreadable saved song with a fallback.
  }
  // The pattern session's sample folders are read only when no project opened:
  // a project brings its own sounds, and the folders (169 files on the owner's
  // stick) took 3.7 of the 4.1 seconds the session needed to start.
  if (!have_project) {
    if (!options.pattern.empty()) {
      const auto text = read_text(options.pattern, 40000);
      if (!text.empty()) {
        std::vector<std::string> errors;
        song = xmp::live::parse_song(text, &errors);
        if (!errors.empty()) {
          for (const auto& error : errors) say("pattern.txt refused: %s; original retained", error.c_str());
          session_log.close();
          return 4;
        }
      }
    }

    std::string samples_dir = "/media/xmp/xmp/samples";
    const auto slash = options.pattern.rfind('/');
    if (slash != std::string::npos) samples_dir = options.pattern.substr(0, slash) + "/samples";
    std::size_t budget = xmp::live::kSampleBudgetFrames;
    for (int t = 0; t < xmp::live::kTracks; ++t) {
      const auto dir = samples_dir + "/track" + std::to_string(t + 1);
      struct stat st {};
      if (stat(dir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) continue;
      const auto loaded = xmp::live::load_sample_folder(dir, xmp::kRate, sample_banks[static_cast<std::size_t>(t)], budget);
      say("samples: track %d, %zu files on %zu pads, %.1f s", t + 1, loaded.files, loaded.pads,
          static_cast<double>(loaded.frames) / xmp::kRate);
      for (std::size_t i = 0; i < loaded.notes.size() && i < 20; ++i) say("samples: skipped %s", loaded.notes[i].c_str());
    }
  }
  if (!have_project) {
    std::array<const xmp::live::SampleBank*, xmp::live::kTracks> banks{};
    for (int t = 0; t < xmp::live::kTracks; ++t) {
      const auto& track = song.tracks[static_cast<std::size_t>(t)];
      banks[static_cast<std::size_t>(t)] = track.kind == xmp::live::Track::kit ?
          &kit_banks[static_cast<std::size_t>(track.preset)] :
          track.kind == xmp::live::Track::sampler ? &sample_banks[static_cast<std::size_t>(t)] : nullptr;
    }
    xmp::Str error;
    if (!xmp::live::import_pattern_project(song, banks, project_doc, error) || !audio.project.prepare(project_doc, error)) {
      say("project: legacy import refused: %s; original files retained", error.c_str());
      session_log.close();
      return 4;
    }
    have_project = migrated_pattern = true;
    say("project: legacy/default pattern imported; future saves use project.xmpsong");
  }
  audio.pattern_engine.store(false, std::memory_order_relaxed);
  {
    std::array<const xmp::live::SampleBank*, xmp::live::kBanks> banks{};
    for (int b = 0; b < xmp::live::kKitBanks; ++b) banks[static_cast<std::size_t>(b)] = &kit_banks[static_cast<std::size_t>(b)];
    for (int t = 0; t < xmp::live::kTracks; ++t)
      banks[static_cast<std::size_t>(xmp::live::kKitBanks + t)] = &sample_banks[static_cast<std::size_t>(t)];
    std::array<xmp::live::LiveEngine::TrackSound, xmp::live::kLiveTracks> sounds{};
    for (int t = 0; t < xmp::live::kTracks; ++t) sounds[static_cast<std::size_t>(t)] = sound_of(song.tracks[static_cast<std::size_t>(t)]);
    if (!audio.engine.prepare(banks, sounds)) say("audio: engine refused the session's sounds");
  }
  namespace ui = xmp::live::ui;
  Capture capture;
  bool input_allowed = true;
  capture.audio_input = &audio.input;
  constexpr const char* factory_root = "/usr/share/xmp/factory-kits";
  std::vector<xmp::live::library::Entry> factory_kits;
  const auto factory_index = xmp::json::parse(xmp::Str(read_text(std::string(factory_root) + "/index.json", 8192).c_str()));
  if (factory_index.ok && factory_index.value.is_array()) {
    for (const auto& item : factory_index.value.items()) {
      using namespace xmp::project::detail;
      const std::string file = str(item, "file").c_str();
      const std::string name = str(item, "name").c_str();
      const double bytes = num(item, "bytes");
      if (file.empty() || name.empty() || file.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-.") != std::string::npos ||
          file == "." || file == ".." || bytes < 1 || bytes > 24 * 1024 * 1024) continue;
      factory_kits.push_back({file, name, 2, static_cast<std::size_t>(bytes), true});
    }
  }
  xmp::live::Workbench workbench(project_doc, audio.project, false, {
      [&] { return audio.frame_now.load(std::memory_order_acquire); },
      [&](const auto& pcm) { return audio.audition(pcm); },
      [&] { if(!input_allowed) return false; audio.private_audio.store(true,std::memory_order_release); return capture.running || (audio_card >= 0 && capture.open(audio_card)); },
      [&] { return capture.running; },
      [&] { capture.close(); },
      [&] {
        auto found = factory_kits;
        auto stick = xmp::live::library::scan(project_dir);
        stick.erase(std::remove_if(stick.begin(), stick.end(), [](const auto& entry) {
          return entry.relative == "project.xmpsong" || entry.relative == "project.previous.xmpsong" ||
                 entry.relative == "project.xmp.json";
        }), stick.end());
        found.insert(found.end(), stick.begin(), stick.end());
        return found;
      },
      [&](const auto& entry, auto& bytes) {
        return xmp::live::library::read(entry.factory ? factory_root : project_dir, entry, bytes);
      },
      [&](const char* line) { say("%s", line); },
      {},
  });
  workbench.loop = &audio.loop_take;
  auto& player = workbench.player;
  auto& board = workbench.board;
  auto& face = workbench.face;
  auto& actions = workbench.actions;
  auto& project_dirty = workbench.project_dirty;
  auto& project_changed = workbench.project_changed;
  auto run_actions = [&](const char* source) { workbench.run_actions(source); };
  auto now_state = [&] { return workbench.now_state(); };
  std::uint64_t reported_drops = 0, reported_xruns = 0;
  double window_ms_total = 0, window_ms_worst = 0, window_count = 0;
  std::uint64_t reported_late = 0;
  auto late_said = Clock::now();
  workbench.project_dirty = migrated_pattern;
  // The project, written to the stick as project.xmpsong, the browser's song
  // format (portable::save_song: the audio as base64 float32, 37 ms on the Mac
  // for Night Shift where writing its samples as JSON numbers took 2.6 s). A
  // copy is still written by a low-priority thread so the controls and screen
  // never wait; the log thread then writes the file (write, sync, rename). The
  // first save of a session keeps the song it replaces as
  // project.previous.xmpsong.
  std::thread saver;
  std::atomic<bool> saving{false};
  std::atomic<bool> serialize_failed{false};
  bool edits_since_whole = false;  // main thread: project.xmpsong is behind project.edits
  auto save_project = [&](const char* why, bool whole = false, const std::string& name = {}) {
    if (project_dir.empty()) return false;
    if (saver.joinable()) {
      if (saving.load()) return false;  // the last save is still being written: try again later
      saver.join();
    }
    auto copy = std::make_shared<xmp::json::Value>(project_doc);
    if (name.empty()) {
      project_dirty = false;
      edits_since_whole = !whole;
    }
    saving = true;
    serialize_failed = false;
    const std::string dir = project_dir, reason = why;
    saver = std::thread([copy, dir, whole, reason, name, &saving, &serialize_failed, &save_state] {
      setpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)), 10);
      const auto started_at = Clock::now();
      const auto took = [&] {
        return static_cast<long long>(
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started_at).count());
      };
      xmp::Str text, error;
      if (!name.empty()) {
        const bool saved = xmp::portable::save_song(*copy, text, error) &&
            xmp::live::library::save_copy(dir, name, text.data(), text.size());
        serialize_failed = !saved;
        say("project: %s named copy", saved ? "saved" : "could not save");
        saving = false;
        return;
      }
      xmp::Vec<xmp::Str> hashes;
      // The song without its audio first: it says which samples the project has.
      bool ok = xmp::portable::save_song(*copy, text, error, false, &hashes);
      std::vector<std::string> now;
      for (const auto& h : hashes) now.emplace_back(h.c_str());
      const bool full = whole || save_state.base_id.empty() || now != save_state.base_hashes;
      if (ok && full) ok = xmp::portable::save_song(*copy, text, error);
      if (!ok) {
        serialize_failed=true;
        say("project: not saved: %s", error.c_str());
      } else if (full) {
        std::string body(text.c_str(), text.size());
        save_state.base_id = file_identity(body), save_state.base_hashes = now;
        const std::string previous = save_state.kept_previous ? std::string() : dir + "/project.previous.xmpsong";
        save_state.kept_previous = true;
        const std::size_t bytes = body.size();
        session_log.save(dir + "/project.xmpsong", std::move(body), previous);
        say("project: saved to the stick as project.xmpsong, %zu bytes in %lld ms (%s)", bytes, took(), reason.c_str());
      } else {
        std::string body = kEditsHead + save_state.base_id + "\n";
        body.append(text.c_str(), text.size());
        const std::size_t bytes = body.size();
        session_log.save(dir + "/project.edits", std::move(body));
        say("project: edits saved to the stick as project.edits, %zu bytes in %lld ms (%s)", bytes, took(),
            reason.c_str());
      }
      saving = false;
    });
    return true;
  };
  bool manual_save_pending = false;
  std::string manual_save_name;
  workbench.hooks.save = [&](const std::string& name) -> std::string {
    if (project_dir.empty()) return "Storage is unavailable";
    if (saving.load() || session_log.pending_saves.load()) return "Save in progress";
    if (!name.empty()) {
      const auto path = "Projects/" + xmp::live::library::lower(name) + ".xmpsong";
      for (const auto& entry : xmp::live::library::scan(project_dir))
        if (xmp::live::library::lower(entry.relative) == xmp::live::library::lower(path))
          return "A project file with this name already exists";
    }
    if (!save_project("manual", true, name)) return "Could not save";
    manual_save_pending = true;
    manual_save_name = name;
    return "";
  };

  const bool have_audio = audio_card >= 0 && audio.open(audio_card);
  workbench.have_audio = have_audio;
  if (audio_card < 0) say("audio: no allowed audio card found");

  bool have_controller = false;
  if (controller.card >= 0) have_controller = controller.open_ports();
  else say("controller: MPC Live Controller not found");

  std::vector<pollfd> fds;
  std::vector<int> fd_port;  // controller port for each pollfd, -1 for an input device
  for (int port = 0; port < 2; ++port) {
    auto* midi = controller.in[static_cast<std::size_t>(port)];
    if (!midi) continue;
    const int count = snd_rawmidi_poll_descriptors_count(midi);
    std::vector<pollfd> some(static_cast<std::size_t>(std::max(count, 0)));
    snd_rawmidi_poll_descriptors(midi, some.data(), static_cast<unsigned>(some.size()));
    for (auto& p : some) {
      fds.push_back(p);
      fd_port.push_back(port);
    }
  }
  Touch touch;
  for (int i = 0; i < 16; ++i) {
    const std::string path = "/dev/input/event" + std::to_string(i);
    const int fd = ::open(path.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) continue;
    touch.adopt(fd, path);
    fds.push_back({fd, POLLIN, 0});
    fd_port.push_back(-1);
  }
  const int touch_rotation = config.touch_rotation >= 0 ? config.touch_rotation : screen.rotation;
  const int control_fd = open_control_socket();
  if (control_fd >= 0) {
    fds.push_back({control_fd, POLLIN, 0});
    fd_port.push_back(-2);
  } else {
    say("control socket unavailable (errno %d)", errno);
  }
  struct ControlClient {
    int fd;
    std::string pending;
  };
  std::vector<ControlClient> clients;
  int tap_client = -1, tap_number = 0;
  int exit_code = 0;  // 0 power off, 10 restart the session, 11 restart the unit

  // ---- sequencer state (main thread only) ----
  using xmp::live::Control;
  xmp::live::Sequencer sequencer(xmp::kRate);
  sequencer.set_bpm(song.bpm);
  int selected = 0;        // selected pad (kit tracks)
  int track_index = 0;     // selected track
  std::array<int, xmp::live::kTracks> last_note{};  // synth: note used for step entry
  for (int t = 0; t < xmp::live::kTracks; ++t) last_note[static_cast<std::size_t>(t)] = song.tracks[static_cast<std::size_t>(t)].pad_note(0);
  bool recording = false;
  // [track][pad, or 0 for a synth][step]: a recorded hit is not doubled on that pass.
  std::array<std::array<std::array<bool, xmp::live::kSteps>, 16>, xmp::live::kTracks> skip_once{};
  // Synth output level: one note at full velocity peaks near the kit's -18 dBFS.
  constexpr float kSynthMaster = 0.3f;
  auto current = [&]() -> xmp::live::Track& { return song.tracks[static_cast<std::size_t>(track_index)]; };
  constexpr std::uint64_t kLead = 2400, kLookahead = 4800;  // 50 ms start lead, 100 ms scheduling horizon
  std::uint64_t scheduled_notes = 0, late_notes = 0, recorded = 0, touches = 0;

  std::array<float, 16> level{}, shown_level{};
  int shown_pad_key = -1;
  std::array<bool, 16> held{}, shown_selected{};
  std::array<std::uint8_t, xmp::live::kSteps> shown_steps{};
  int shown_playhead = -2;
  std::array<int, xmp::live::kTracks> shown_tracks{};  // packed track button state
  shown_tracks.fill(-1);
  bool shown_input = false;
  int shown_bridge = -1;
  auto bridge_checked = Clock::now() - std::chrono::seconds(2);
  bool redraw = true, first_draw = true, shown_playing = false, shown_recording = false;
  int shown_bpm = -1;
  std::array<std::uint32_t, 16> hits{};
  std::uint64_t messages = 0, pressure = 0, buttons = 0, controls = 0, sysex = 0, other = 0;
  bool startup_done = config.startup == xmp::live::Startup::none, seen_input = false, startup_ok = false;
  auto last_activity = Clock::now();
  const char* reason = "interrupted";

  auto engine_frame = [&]() -> std::uint64_t {
    return have_audio ? audio.frame_now.load(std::memory_order_acquire) : 0;
  };
  // A pad hit on a kit or sampler track, at the track's level (0 = now).
  auto play_note = [&](int pad, std::uint8_t velocity, std::uint64_t at, int t = 0) {
    if (!have_audio) return false;
    const auto& track = song.tracks[static_cast<std::size_t>(t)];
    const int bank = bank_index(t);
    return bank < 0 || audio.engine.play_pad(at, t, bank, pad, velocity, track.level);
  };
  auto pad_name = [&](const xmp::live::Track& t, int pad) -> const char* {
    if (t.kind == xmp::live::Track::sampler) {
      const auto& name = sample_banks[static_cast<std::size_t>(&t - song.tracks.data())].pads[static_cast<std::size_t>(pad)].name;
      return name.empty() ? "sample" : name.c_str();
    }
    return xmp::live::kit_pad_name(t.preset, pad);
  };
  // What each pad plays on the selected track, for the screen.
  auto pad_label = [&](int pad) -> std::string {
    const auto& t = current();
    if (t.kind == xmp::live::Track::kit) return xmp::live::kit_pad_label(t.preset, pad);
    if (t.kind == xmp::live::Track::synth) return xmp::live::note_label(t.pad_note(pad));
    return xmp::live::short_label(sample_banks[static_cast<std::size_t>(track_index)].pads[static_cast<std::size_t>(pad)].name);
  };
  // Knobs 3 and 4 change sounds and types: one change per few clicks.
  std::array<int, 2> knob_clicks{};
  auto clicks = [&](int knob, int steps) {
    auto& acc = knob_clicks[static_cast<std::size_t>(knob)];
    acc += steps;
    const int changes = acc / 6;
    acc -= changes * 6;
    return changes;
  };
  // A synth note at a track's level; gate 0 holds until note_off.
  auto play_synth = [&](int t, int note, std::uint8_t velocity, std::uint64_t at, std::uint32_t gate) {
    if (!have_audio) return false;
    const auto& track = song.tracks[static_cast<std::size_t>(t)];
    return audio.engine.play_note(at, t, note, velocity / 127.0f * track.level * kSynthMaster, gate);
  };
  auto mark_changed = [&] {
    redraw = true;
  };
  auto act = [&](Control c, int index, const char* source) {
    last_activity = Clock::now();
    switch (c) {
      case Control::play:
        if (have_project) {
          if (player.playing()) {
            player.stop(engine_frame());
            say("project stop (%s)", source);
          } else if (have_audio) {
            const auto* perf = project_doc.get("performance");
            const bool song = perf && xmp::project::detail::list(*perf, "chain").size() > 0;
            const auto& scenes = xmp::project::detail::list(project_doc, "scenes");
            const xmp::Str scene = scenes.size() ? xmp::project::detail::str(scenes[0], "id") : xmp::Str();
            xmp::Str error;
            if (player.start(project_doc, audio.project, scene, song, engine_frame() + kLead, 0, error))
              say("project play: %s (%s)", song ? "the song" : scene.c_str(), source);
            else
              say("project play refused: %s (%s)", error.c_str(), source);
          } else {
            say("play ignored: no audio (%s)", source);
          }
          break;
        }
        if (sequencer.playing()) {
          sequencer.stop();
          audio.engine.release_synths();
          say("stop (%s)", source);
        } else if (have_audio) {
          sequencer.start(engine_frame() + kLead, song.bpm);
          say("play at %d BPM (%s)", song.bpm, source);
        } else {
          say("play ignored: no audio (%s)", source);
        }
        break;
      case Control::record:
        recording = !recording;
        say("record %s (%s)", recording ? "on" : "off", source);
        break;
      case Control::clear: {
        // Kit: the selected pad's steps, then the whole track. Synth: the whole track.
        // A track that is already empty clears every track.
        auto& t = current();
        const char* what = "whole song";
        if (t.pads()) {
          auto& row = t.kit_velocity[static_cast<std::size_t>(selected)];
          if (std::any_of(row.begin(), row.end(), [](std::uint8_t v) { return v != 0; })) {
            row.fill(0);
            what = "selected pad";
          } else if (t.has_steps()) {
            t.kit_velocity = {};
            what = "track";
          }
        } else if (t.has_steps()) {
          t.note.fill(0);
          t.velocity.fill(0);
          what = "track";
        }
        if (std::string(what) == "whole song")
          for (auto& any : song.tracks) {
            any.kit_velocity = {};
            any.note.fill(0);
            any.velocity.fill(0);
          }
        say("clear %s, track %d (%s)", what, track_index + 1, source);
        mark_changed();
        break;
      }
      case Control::bpm_down:
      case Control::bpm_up:
        song.bpm = std::clamp(song.bpm + (c == Control::bpm_up ? 5 : -5), xmp::live::kMinBpm, xmp::live::kMaxBpm);
        sequencer.set_bpm(song.bpm);
        say("tempo %d BPM (%s)", song.bpm, source);
        mark_changed();
        break;
      case Control::step: {
        auto& t = current();
        const auto at = static_cast<std::size_t>(index);
        if (t.pads()) {
          auto& v = t.kit_velocity[static_cast<std::size_t>(selected)][at];
          v = v ? 0 : 100;
          say("step %d %s for pad %d on track %d (%s)", index + 1, v ? "on" : "off", selected + 1, track_index + 1,
              source);
        } else {
          const int note = last_note[static_cast<std::size_t>(track_index)];
          const bool on = t.note[at] != note;
          t.note[at] = on ? static_cast<std::uint8_t>(note) : 0;
          t.velocity[at] = on ? 100 : 0;
          say("step %d %s note %d on track %d (%s)", index + 1, on ? "on" : "off", note, track_index + 1, source);
        }
        mark_changed();
        break;
      }
      case Control::pad:
        if (current().pads()) {
          selected = index;
          say("selected pad %d (%s, %s)", index + 1, pad_name(current(), index), source);
        } else {
          last_note[static_cast<std::size_t>(track_index)] = current().pad_note(index);
          say("selected note %d (%s)", current().pad_note(index), source);
        }
        redraw = true;
        break;
      case Control::track:
        if (index == track_index) {
          current().mute = !current().mute;
          say("track %d %s (%s)", index + 1, current().mute ? "muted" : "unmuted", source);
          mark_changed();
        } else {
          track_index = index;
          say("track %d %s selected (%s)", index + 1, xmp::live::track_label(current()), source);
          redraw = true;
        }
        break;
      default:
        break;
    }
  };
  auto touch_at = [&](int x, int y, const char* source, ui::TouchPhase phase = ui::TouchPhase::down) {
    ++touches;
    const auto hit = xmp::live::hit_test(x, y, screen.width, screen.height);
    say("touch %d,%d (%s)", x, y, source);
    if (have_project) {
      workbench.touch(phase, x, y);
      return;
    }
    if (hit.control != Control::none) act(hit.control, hit.index, "touch");
  };

  auto handle = [&](int port, const xmp::live::Event& e) {
    ++messages;
    using xmp::live::Kind;
    if (have_project && (e.kind == Kind::pad_on || e.kind == Kind::pad_off || e.kind == Kind::button_on ||
                         e.kind == Kind::button_off || e.kind == Kind::control)) {
      last_activity = Clock::now();
      const auto now = now_state();
      if (e.kind == Kind::pad_on || e.kind == Kind::pad_off) {
        const bool on = e.kind == Kind::pad_on;
        if (on) {
          ++hits[static_cast<std::size_t>(e.pad)];
          say("pad %d on velocity %u port %d (%s view)", e.pad + 1, e.data2, port, ui::view_name(face.view));
        }
        ui::pad_event(face, project_doc, board, now, e.pad, on ? e.data2 : 0, actions);
      } else if (e.kind == Kind::control) {
        ++controls;
        if ((e.status & 0x0F) == 0 && e.data1 == ui::kWheelControl) face.wheel(ui::wheel_steps(e.data2), board);
        else if ((e.status & 0x0F) == 0 && e.data1 >= 0x10 && e.data1 <= 0x13)
          face.knob(e.data1 - 0x10, ui::wheel_steps(e.data2), board, actions);  // Q-Link knobs 1-4, relative
        else say("control %02X %02X %02X port %d", e.status, e.data1, e.data2, port);
      } else if (e.data1 >= 0x54 && e.data1 <= 0x57) {
        face.knob_touch(e.data1 - 0x54, e.kind == Kind::button_on, board, actions);  // knob touch notes
      } else {
        ++buttons;
        const auto b = ui::button_of(e.data1);
        const bool down = e.kind == Kind::button_on;
        say("button %02X %s (%s) port %d", e.data1, down ? "down" : "up", ui::button_name(b), port);
        face.button(b, down, board, now, actions);
      }
      run_actions("controls");
      return;
    }
    switch (e.kind) {
      case Kind::pad_on: {
        const auto pad = static_cast<std::size_t>(e.pad);
        ++hits[pad];
        held[pad] = true;
        level[pad] = 0.35f + 0.65f * e.data2 / 127.0f;
        last_activity = Clock::now();
        auto& t = current();
        const bool kit = t.pads();
        const int note = kit ? 0 : t.pad_note(e.pad);
        const char* name = kit ? pad_name(t, e.pad) : xmp::live::track_label(t);
        if (kit) {
          if (have_audio && !play_note(e.pad, e.data2, 0, track_index)) say("audio: command queue full, pad %d dropped", e.pad + 1);
          if (selected != e.pad) {
            selected = e.pad;
            redraw = true;
          }
        } else {
          if (!play_synth(track_index, note, e.data2, 0, 0)) say("audio: synth queue full, pad %d dropped", e.pad + 1);
          last_note[static_cast<std::size_t>(track_index)] = note;
        }
        if (recording && sequencer.playing()) {
          const int step = sequencer.nearest_step(engine_frame());
          const auto at = static_cast<std::size_t>(step);
          if (kit) t.kit_velocity[pad][at] = e.data2;
          else {
            t.note[at] = static_cast<std::uint8_t>(note);
            t.velocity[at] = e.data2;
          }
          // Just heard: if that step is still to be scheduled, skip it once so it is not doubled.
          if (step == sequencer.next_step())
            skip_once[static_cast<std::size_t>(track_index)][kit ? pad : 0][at] = true;
          ++recorded;
          mark_changed();
          say("pad %d on velocity %u (%s) port %d, recorded on step %d of track %d", e.pad + 1, e.data2, name, port,
              step + 1, track_index + 1);
        } else {
          say("pad %d on velocity %u (%s) port %d", e.pad + 1, e.data2, name, port);
        }
        break;
      }
      case Kind::pad_off:
        held[static_cast<std::size_t>(e.pad)] = false;
        if (current().kind == xmp::live::Track::synth) audio.engine.note_off(track_index, current().pad_note(e.pad));
        say("pad %d off port %d", e.pad + 1, port);
        break;
      case Kind::pad_pressure:
        ++pressure;  // aftertouch is frequent: counted, not logged line by line
        break;
      case Kind::button_on:
      case Kind::button_off: {
        ++buttons;
        last_activity = Clock::now();
        say("button %02X %s port %d", e.data1, e.kind == Kind::button_on ? "down" : "up", port);
        if (e.kind == Kind::button_on) {
          // Play only starts and Stop only stops, as on the MPC; the touch PLAY toggles.
          // With a project from the stick they start and stop the project.
          const bool running = have_project ? player.playing() : sequencer.playing();
          if (e.data1 == config.button_play) {
            if (!running) act(Control::play, -1, "Play button");
          } else if (e.data1 == config.button_stop) {
            if (running) act(Control::play, -1, "Stop button");
          } else if (e.data1 == config.button_record) {
            act(Control::record, -1, "Rec button");
          } else if (e.data1 == config.button_clear) {
            act(Control::clear, -1, "button");
          } else {
            // Track select: the four pad bank buttons are tracks 1-4, the four
            // buttons below them 5-8 (os/live-mk1/hardware.json).
            static constexpr std::array<std::uint8_t, 8> kTrackButtons{0x23, 0x24, 0x25, 0x26, 0x0B, 0x27, 0x28, 0x09};
            for (int t = 0; t < 8; ++t)
              if (e.data1 == kTrackButtons[static_cast<std::size_t>(t)] && t != track_index)
                act(Control::track, t, "track button");
          }
        }
        break;
      }
      case Kind::control:
        ++controls;
        last_activity = Clock::now();
        // Relative encoders: 1..63 clockwise steps, 65..127 anticlockwise (two's complement).
        if ((e.status & 0x0F) == 0 && e.data1 == config.tempo_control) {
          const int steps = e.data2 < 64 ? e.data2 : e.data2 - 128;
          song.bpm = std::clamp(song.bpm + steps, xmp::live::kMinBpm, xmp::live::kMaxBpm);
          sequencer.set_bpm(song.bpm);
          mark_changed();
          say("tempo %d BPM (data wheel)", song.bpm);
        } else if ((e.status & 0x0F) == 0 && e.data1 == 0x10) {
          // Knob 1: the selected track's level.
          const int steps = e.data2 < 64 ? e.data2 : e.data2 - 128;
          current().level = std::clamp(current().level + steps * 0.01f, 0.0f, 1.0f);
          mark_changed();
          say("track %d level %d%% (knob 1)", track_index + 1, static_cast<int>(std::lround(current().level * 100)));
        } else if ((e.status & 0x0F) == 0 && e.data1 == 0x11 && current().kind == xmp::live::Track::synth) {
          // Knob 2: the selected synth's tone (cutoff), in 3% steps on a log scale.
          const int steps = e.data2 < 64 ? e.data2 : e.data2 - 128;
          auto& t = current();
          const float base = t.cutoff >= 30 ? t.cutoff : xmp::live::track_patch(t).cutoff;
          t.cutoff = std::clamp(base * std::pow(1.03f, static_cast<float>(steps)), 30.0f, 16000.0f);
          audio.engine.set_cutoff(track_index, t.cutoff);
          mark_changed();
          say("track %d tone %d Hz (knob 2)", track_index + 1, static_cast<int>(t.cutoff));
        } else if ((e.status & 0x0F) == 0 && e.data1 == 0x12) {
          // Knob 3: the selected track's sound (kit style or synth patch).
          const int n = clicks(0, e.data2 < 64 ? e.data2 : e.data2 - 128);
          auto& t = current();
          if (n && t.kind != xmp::live::Track::sampler) {
            const int count = xmp::live::preset_count(t.kind);
            t.preset = ((std::clamp(t.preset, 0, count - 1) + n) % count + count) % count;
            // A kit plays from its new bank on the next hit; a synth gets the new patch.
            if (t.kind == xmp::live::Track::synth) {
              t.cutoff = 0;
              audio.engine.set_sound(track_index, sound_of(t));
            }
            mark_changed();
            say("track %d sound %s (knob 3)", track_index + 1, xmp::live::track_label(t));
          }
        } else if ((e.status & 0x0F) == 0 && e.data1 == 0x13) {
          // Knob 4: the selected track's type, kit -> synth -> sampler.
          const int n = clicks(1, e.data2 < 64 ? e.data2 : e.data2 - 128);
          auto& t = current();
          if (n) {
            const int kind = ((static_cast<int>(t.kind) + n) % 3 + 3) % 3;
            if (t.kind == xmp::live::Track::synth) audio.engine.release_synths(track_index);
            t.kind = static_cast<xmp::live::Track::Kind>(kind);
            t.preset = std::clamp(t.preset, 0, xmp::live::preset_count(t.kind) - 1);
            audio.engine.set_sound(track_index, sound_of(t));
            mark_changed();
            say("track %d type %s, %s (knob 4)", track_index + 1,
                t.kind == xmp::live::Track::kit ? "kit" : t.kind == xmp::live::Track::synth ? "synth" : "sampler",
                xmp::live::track_label(t));
          }
        } else {
          say("control %02X %02X %02X port %d", e.status, e.data1, e.data2, port);
        }
        break;
      case Kind::sysex: {
        ++sysex;
        const auto& parser = controller.parsers[static_cast<std::size_t>(port)];
        // An identity reply (F0 7E .. 06 02) carries the unit's serial number after
        // the version bytes: log only manufacturer, family, model and version.
        const auto* bytes = parser.sysex();
        const bool identity = parser.sysex_size() > 14 && bytes[1] == 0x7E && bytes[3] == 0x06 && bytes[4] == 0x02;
        say("sysex port %d: %s%s", port, hex(bytes, identity ? 14 : parser.sysex_size()).c_str(),
            identity ? " ... (identity reply; serial number not logged)" : "");
        break;
      }
      default:
        ++other;
        say("message %02X %02X %02X port %d", e.status, e.data1, e.data2, port);
        break;
    }
  };
  auto feed = [&](int port, const std::uint8_t* bytes, std::size_t size) {
    seen_input = true;
    xmp::live::Event e;
    for (std::size_t i = 0; i < size; ++i)
      if (controller.parsers[static_cast<std::size_t>(port)].feed(bytes[i], e)) handle(port, e);
  };

  say("ready: %s, %s, %s, %s. Pads play XMP's kit; touch PLAY to run the pattern; the power button switches off.",
      have_audio ? "audio on" : "NO audio", have_controller ? "controller on" : "NO controller",
      have_screen ? "screen on" : "no screen", touch.fd >= 0 ? "touch on" : "no touch");

  auto frame = Clock::now();
  while (!interrupted) {
    const double now = std::chrono::duration<double>(Clock::now() - started).count();
    if (!startup_done && now >= config.listen_seconds) {
      startup_done = true;
      const auto port = config.startup_port;
      startup_ok = controller.send(port, xmp::live::kIdentityRequest.data(), xmp::live::kIdentityRequest.size(),
                                   "identity request");
      if (config.startup == xmp::live::Startup::full)
        startup_ok = controller.send(port, xmp::live::kStartupSequence.data(), xmp::live::kStartupSequence.size(),
                                     "start-up sequence") && startup_ok;
      if (startup_ok && have_project && config.startup == xmp::live::Startup::full &&
          port == xmp::live::kQLinkLedPort)
        controller.open_feedback(compatible);
      redraw = true;
    }
    controller.update_feedback(face.panel_lights(board, workbench.now_state()));
    if (std::chrono::duration<double>(Clock::now() - last_activity).count() > config.idle_minutes * 60.0) {
      reason = "idle";
      break;
    }

    // The project's next 100 ms, window by window, on exact sample frames.
    if (player.playing()) {
      xmp::Str error;
      const auto began = Clock::now();
      const double before = player.step();
      const bool filled = player.fill(engine_frame() + kLookahead, error);
      const double steps = player.step() - before;
      if (steps > 0) {
        const double ms = std::chrono::duration<double, std::milli>(Clock::now() - began).count() / steps;
        window_ms_total += ms * steps, window_count += steps, window_ms_worst = std::max(window_ms_worst, ms);
      }
      // Late notes: the main thread fell behind the audio (said once a second at most).
      if (const auto late = audio.project.late(); late > reported_late && Clock::now() - late_said >= std::chrono::seconds(1)) {
        say("project: %llu notes played late so far (worst %.1f ms); a step takes %.1f ms to prepare (worst %.1f ms)",
            static_cast<unsigned long long>(late), audio.project.worst_late_frames() / 48.0,
            window_count ? window_ms_total / window_count : 0.0, window_ms_worst);
        reported_late = late, late_said = Clock::now();
      }
      if (!filled) {
        say("project stopped: %s", error.c_str());
        player.stop(engine_frame());
      } else if (!player.playing())
        say("project: finished at step %d", static_cast<int>(player.step()));
    }
    // Each new xrun, with what the session was doing, for diagnosis on the Live.
    if (have_audio && audio.xruns.load() > reported_xruns) {
      reported_xruns = audio.xruns.load();
      say("audio: xrun (%llu so far)%s%s", static_cast<unsigned long long>(reported_xruns),
          player.playing() ? ", playing" : "", saving.load() ? ", while saving" : "");
    }
    if (audio.project.dropped() > reported_drops) {
      reported_drops = audio.project.dropped();
      say("project: %llu commands dropped (queue full)", static_cast<unsigned long long>(reported_drops));
    }
    // Schedule every step due in the next 100 ms on its exact sample frame.
    if (sequencer.playing()) {
      const auto current = engine_frame();
      const auto gate = static_cast<std::uint32_t>(sequencer.step_frames(song.bpm) * 0.8);
      sequencer.due_steps(current + kLookahead, [&](std::uint64_t frame, int step) {
        if (frame < current + 256) ++late_notes;  // too close to the audio thread: play as soon as possible
        const auto at = std::max<std::uint64_t>(frame, current + 256);
        const auto s_ = static_cast<std::size_t>(step);
        for (int t = 0; t < xmp::live::kTracks; ++t) {
          const auto& track = song.tracks[static_cast<std::size_t>(t)];
          auto& skips = skip_once[static_cast<std::size_t>(t)];
          if (track.mute) continue;
          if (track.pads()) {
            for (int pad = 0; pad < 16; ++pad) {
              const auto v = track.kit_velocity[static_cast<std::size_t>(pad)][s_];
              if (!v) continue;
              if (skips[static_cast<std::size_t>(pad)][s_]) {
                skips[static_cast<std::size_t>(pad)][s_] = false;
                continue;
              }
              if (play_note(pad, v, at, t)) ++scheduled_notes;
            }
          } else if (track.note[s_]) {
            if (skips[0][s_]) {
              skips[0][s_] = false;
              continue;
            }
            if (play_synth(t, track.note[s_], track.velocity[s_] ? track.velocity[s_] : 100, at, gate)) ++scheduled_notes;
          }
        }
      });
    }

    const int ready = fds.empty() ? (usleep(8000), 0) : poll(fds.data(), fds.size(), 8);
    bool power = false;
    if (ready > 0) {
      for (std::size_t i = 0; i < fds.size(); ++i) {
        if (!(fds[i].revents & (POLLIN | POLLERR | POLLHUP))) continue;
        if (fd_port[i] == -2) {
          const int client = ::accept4(control_fd, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
          if (client >= 0 && clients.size() < 4) clients.push_back({client, {}});
          else if (client >= 0) ::close(client);
          continue;
        }
        if (fd_port[i] >= 0) {
          std::uint8_t bytes[256];
          auto* midi = controller.in[static_cast<std::size_t>(fd_port[i])];
          for (int reads = 0; reads < 16; ++reads) {
            const auto n = snd_rawmidi_read(midi, bytes, sizeof bytes);
            if (n <= 0) break;
            feed(fd_port[i], bytes, static_cast<std::size_t>(n));
          }
        } else {
          input_event event{};
          while (read(fds[i].fd, &event, sizeof event) == static_cast<ssize_t>(sizeof event)) {
            if (event.type == EV_KEY && event.code == KEY_POWER && event.value == 1) power = true;
            if (fds[i].fd == touch.fd && touch.feed_phase(event) && have_screen) {
              const int fx = xmp::live::scale_axis(touch.x, touch.ax.minimum, touch.ax.maximum,
                                                   static_cast<int>(screen.var.xres));
              const int fy = xmp::live::scale_axis(touch.y, touch.ay.minimum, touch.ay.maximum,
                                                   static_cast<int>(screen.var.yres));
              int x = 0, y = 0;
              xmp::live::from_framebuffer(touch_rotation, static_cast<int>(screen.var.xres),
                                          static_cast<int>(screen.var.yres), fx, fy, x, y);
              char raw[48];
              std::snprintf(raw, sizeof raw, "raw %d,%d", touch.x, touch.y);
              touch_at(x, y, raw, touch.phase == Touch::Phase::up ? ui::TouchPhase::up :
                       touch.phase == Touch::Phase::move ? ui::TouchPhase::move : ui::TouchPhase::down);
            }
          }
        }
      }
    }
    // Bridge commands, one line each (at most 256 bytes).
    bool quit = false;
    for (auto it = clients.begin(); it != clients.end();) {
      char buffer[512];
      const auto n = ::read(it->fd, buffer, sizeof buffer);
      if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
        if (tap_client == it->fd) tap_client = -1;
        ::close(it->fd);
        it = clients.erase(it);
        continue;
      }
      if (n > 0) it->pending.append(buffer, static_cast<std::size_t>(n));
      if (it->pending.size() > 4096) it->pending.clear();
      std::size_t eol;
      while ((eol = it->pending.find('\n')) != std::string::npos) {
        const std::string line = it->pending.substr(0, std::min<std::size_t>(eol, 256));
        it->pending.erase(0, eol + 1);
        std::istringstream words(line);
        std::string command;
        words >> command;
        std::string reply = "ok";
        unsigned a = 0, b = 0;
        int x = 0, y = 0;
        if (command == "pad" && (words >> a >> b) && a >= 1 && a <= 16 && b <= 127) {
          handle(2, xmp::live::classify(0x99, xmp::live::kPadNotes[a - 1], static_cast<std::uint8_t>(b)));
        } else if (command == "button" && (words >> std::hex >> a) && a <= 127) {
          // "button HH" presses and lets go; "button HH down" / "up" holds it
          // (Menu or Shift held while a pad is pressed).
          std::string state;
          words >> state;
          if (state != "up") handle(2, xmp::live::classify(0x90, static_cast<std::uint8_t>(a), 0x7F));
          if (state != "down") handle(2, xmp::live::classify(0x80, static_cast<std::uint8_t>(a), 0));
          if (!state.empty() && state != "down" && state != "up") reply = "button state is down or up";
        } else if (command == "control" && (words >> std::hex >> a >> b) && a <= 127 && b <= 127) {
          handle(2, xmp::live::classify(0xB0, static_cast<std::uint8_t>(a), static_cast<std::uint8_t>(b)));
        } else if (command == "touch" && (words >> x >> y) && x >= 0 && y >= 0 && x < screen.width &&
                   y < screen.height) {
          touch_at(x, y, "bridge");
          touch_at(x, y, "bridge", ui::TouchPhase::up);
        } else if (command == "status") {
          char text[768];
          std::snprintf(text, sizeof text,
                        "{\"playing\":%s,\"recording\":%s,\"bpm\":%g,\"selected\":%d,\"audio\":%s,"
                        "\"controller\":%s,\"screen\":%s,\"touch\":%s,\"blocks\":%llu,\"xruns\":%llu,"
                        "\"peak\":%.5f,\"messages\":%llu,\"cpu\":%d,\"track\":%d,\"saveState\":\"%s\"}",
                        (have_project ? player.playing() : sequencer.playing()) ? "true" : "false",
                        (face.sampling || (have_project ? face.rec != ui::Ui::Rec::off : recording)) ? "true" : "false",
                        have_project ? board.bpm : song.bpm,
                        selected + 1, have_audio ? "true" : "false", have_controller ? "true" : "false",
                        have_screen ? "true" : "false", touch.fd >= 0 ? "true" : "false",
                        static_cast<unsigned long long>(audio.blocks.load()),
                        static_cast<unsigned long long>(audio.xruns.load()), static_cast<double>(audio.peak()),
                        static_cast<unsigned long long>(messages), audio.realtime.pinnedCpu,
                        (have_project ? face.track : track_index) + 1,
                        serialize_failed.load() || session_log.save_failed.load() ? "failed" :
                        saving.load() || session_log.pending_saves.load() ? "saving" :
                        project_dirty ? "unsaved" : "saved");
          reply = text;
          {
            // Load: the audio thread's share of its time (average and worst
            // block), a step's preparation time, and notes that played late.
            const double blocks = static_cast<double>(std::max<std::uint64_t>(1, audio.blocks.load()));
            char load[256];
            std::snprintf(load, sizeof load,
                          ",\"audioLoad\":%.3f,\"audioWorstMs\":%.2f,\"stepMs\":%.2f,\"stepWorstMs\":%.2f,"
                          "\"lateNotes\":%llu,\"lateWorstMs\":%.1f}",
                          audio.busy_us.load() / blocks / (256.0 / xmp::kRate * 1e6), audio.worst_us.load() / 1000.0,
                          window_count ? window_ms_total / window_count : 0.0, window_ms_worst,
                          static_cast<unsigned long long>(audio.project.late()),
                          audio.project.worst_late_frames() / 48.0);
            reply.pop_back();  // the closing brace
            reply += load;
          }
          if (have_project) {
            reply.pop_back();  // the closing brace
            reply += std::string(",\"view\":\"") + ui::view_name(face.view) + "\",\"scene\":" +
                     std::to_string(face.cursor + 1) + ",\"project\":true}";
          }
        } else if (command == "tap" && (words >> a) && a >= 1 && a <= 10 && have_audio && tap_client < 0 && !audio.private_audio.load(std::memory_order_acquire)) {
          audio.tap_frames.store(0, std::memory_order_release);
          audio.tap_wanted.store(static_cast<std::size_t>(a) * xmp::kRate, std::memory_order_release);
          input_allowed = false;
          tap_client = it->fd;
          reply.clear();  // answered when the capture is complete
        } else if (command == "quit" && (words >> command) &&
                   (command == "poweroff" || command == "restart" || command == "reboot")) {
          exit_code = command == "poweroff" ? 0 : command == "restart" ? 10 : 11;
          reason = command == "poweroff" ? "bridge power-off" : command == "restart" ? "bridge restart" : "bridge reboot";
          quit = true;
        } else {
          reply = "error: unknown or out-of-range command";
        }
        if (!reply.empty()) {
          reply += '\n';
          if (::write(it->fd, reply.data(), reply.size()) < 0) {}
        }
      }
      ++it;
    }
    // A finished tap is written to the stick, then announced to its client.
    if (tap_client >= 0 && audio.tap_frames.load(std::memory_order_acquire) >= audio.tap_wanted.load()) {
      const auto frames = audio.tap_wanted.load();
      const std::string path = "/media/xmp/xmp/captures/tap-" + std::to_string(++tap_number) + ".wav";
      ::mkdir("/media/xmp/xmp/captures", 0755);
      // Written by the log thread (write, sync, rename); the bridge waits for the
      // file at its final size, so the main loop never blocks on the stick.
      session_log.save(path, wav_bytes(audio.tap.data(), frames, xmp::kRate));
      const std::string reply = "tap " + path + " " + std::to_string(44 + frames * 4) + "\n";
      if (::write(tap_client, reply.data(), reply.size()) < 0) {}
      audio.tap_wanted.store(0);
      tap_client = -1;
    }
    if (quit) break;
    if (power) {
      reason = "power button";
      break;
    }

    if (manual_save_pending && !saving.load() && !session_log.pending_saves.load()) {
      manual_save_pending = false;
      if (serialize_failed.load() || session_log.save_failed.load()) face.say("Could not save");
      else face.say(manual_save_name.empty() ? "Project saved" : "Saved " + manual_save_name + ".xmpsong");
    }
    // Autosave waits until the music stops.
    if (project_dirty && !player.playing() && Clock::now() - project_changed > std::chrono::seconds(2) &&
        save_project("edited"))
      face.say("Saving to the stick");


    if (Clock::now() - frame >= std::chrono::milliseconds(16)) {
      frame = Clock::now();
      // The whole screen is cleared once, at start-up. After that only what
      // changed is repainted (a full repaint showed as a flash on the Live).
      if (have_screen && first_draw) {
        screen.clear();
        shown_level.fill(-1);
        shown_playhead = -2;
        shown_bpm = -1;
        shown_playing = !sequencer.playing();
        shown_recording = !recording;
        shown_steps.fill(255);
        screen.control(Control::clear, false);
        screen.control(Control::bpm_down, false);
        screen.control(Control::bpm_up, false);
        first_draw = false;
      }
      if (have_project) {
        input_allowed = tap_client < 0;
        if (xmp::project::detail::at(project_doc,"extensions").get("xmp.sampler-input")) audio.private_audio.store(true,std::memory_order_release);
        audio.monitor.store(workbench.monitor_input(),std::memory_order_release);
        if(workbench.input_needed() && !capture.running && audio_card >= 0 && input_allowed) {
          if(capture.open(audio_card)) audio.private_audio.store(true,std::memory_order_release);
        } else if(!workbench.input_needed() && capture.running) capture.close();
        if(capture.running) {
          std::array<float,4096> chunk{};
          for(int n;(n=capture.drain(chunk.data(),static_cast<int>(chunk.size())))>0;)
            if(workbench.recorder.state != xmp::live::sample::Recorder::State::idle) workbench.recorder.feed(chunk.data(),n);
          if(capture.failed && workbench.recorder.state != xmp::live::sample::Recorder::State::idle) workbench.finish_sampling("the inputs went away");
        }
        workbench.input_failed = capture.failed;
        workbench.tick();
        if (Clock::now() - bridge_checked >= std::chrono::seconds(1)) {
          bridge_checked = Clock::now();
          const auto state = read_text("/tmp/xmp-bridge-state", 32);
          const int light = state.rfind("connected", 0) == 0 ? 1 : state.rfind("ready", 0) == 0 ? 3 : 0;
          if (light != shown_bridge) {
            if (shown_bridge >= -1) say("bridge light: %s", light == 1 ? "connected" : light == 3 ? "ready" : "off");
            shown_bridge = light;
          }
        }
        workbench.painter.lights = {have_audio ? 1 : 2, have_controller ? 1 : 2, startup_done ? (startup_ok ? 1 : 2) : 0,
                                    seen_input ? 1 : 0, std::max(0, shown_bridge)};
        face.save_status = serialize_failed.load() || session_log.save_failed.load() ? "Save failed"
            : saving.load() || session_log.pending_saves.load() ? "Saving to stick"
            : project_dirty ? "Unsaved changes" : "Saved on stick";
        if (have_screen) workbench.draw(screen);
        continue;
      }
      if (have_screen && redraw) {
        screen.light(0, have_audio ? 1 : 2);
        screen.light(1, have_controller ? 1 : 2);
        screen.light(2, startup_done ? (startup_ok ? 1 : 2) : 0);
        screen.light(3, seen_input ? 1 : 0);
        redraw = false;
      }
      // Pad names follow the selected track, its type and its sound.
      const int pad_key = track_index * 1000 + static_cast<int>(current().kind) * 100 + current().preset * 10;
      if (pad_key != shown_pad_key) {
        shown_level.fill(-1);
        shown_pad_key = pad_key;
      }
      for (std::size_t p = 0; p < 16; ++p) {
        if (!held[p]) level[p] *= 0.86f;
        if (level[p] < 0.02f) level[p] = 0;
        const bool is_selected = static_cast<int>(p) == selected;
        if (have_screen && (std::fabs(level[p] - shown_level[p]) > 0.015f || shown_selected[p] != is_selected)) {
          screen.pad(static_cast<int>(p), level[p], is_selected, pad_label(static_cast<int>(p)));
          shown_level[p] = level[p];
          shown_selected[p] = is_selected;
        }
      }
      if (have_screen) {
        const int playhead = sequencer.step_at(engine_frame());
        // Steps of the selected track: the selected pad's row on a kit, the notes on a synth.
        const auto& t = current();
        std::array<std::uint8_t, xmp::live::kSteps> row{};
        for (int s = 0; s < xmp::live::kSteps; ++s) {
          const auto idx = static_cast<std::size_t>(s);
          row[idx] = t.pads() ? t.kit_velocity[static_cast<std::size_t>(selected)][idx]
                     : t.note[idx]                   ? std::max<std::uint8_t>(t.velocity[idx], 1)
                                                     : 0;
        }
        for (int s = 0; s < xmp::live::kSteps; ++s) {
          const auto idx = static_cast<std::size_t>(s);
          const bool head_changed = (s == playhead) != (s == shown_playhead);
          if (row[idx] != shown_steps[idx] || head_changed) {
            screen.step(s, row[idx], s == playhead);
            shown_steps[idx] = row[idx];
          }
        }
        // Track strip: number and name, level bar, mute and selection.
        for (int i = 0; i < xmp::live::kTracks; ++i) {
          const auto& tr = song.tracks[static_cast<std::size_t>(i)];
          const int state = static_cast<int>(std::lround(tr.level * 100)) | (tr.mute ? 1 << 8 : 0) |
                            (i == track_index ? 1 << 9 : 0) | static_cast<int>(tr.kind) << 10 | tr.preset << 12;
          if (state != shown_tracks[static_cast<std::size_t>(i)]) {
            screen.track(i, std::to_string(i + 1) + " " + xmp::live::track_label(tr), tr.level, tr.mute,
                         i == track_index);
            shown_tracks[static_cast<std::size_t>(i)] = state;
          }
        }
        shown_playhead = playhead;
        if (shown_playing != sequencer.playing()) {
          screen.control(Control::play, sequencer.playing());
          shown_playing = sequencer.playing();
        }
        if (shown_recording != recording) {
          screen.control(Control::record, recording);
          shown_recording = recording;
        }
        if (shown_bpm != song.bpm) {
          screen.bpm(song.bpm);
          shown_bpm = song.bpm;
        }
        // Fifth light: the control bridge (grey off, amber ready, green connected).
        if (Clock::now() - bridge_checked >= std::chrono::seconds(1)) {
          bridge_checked = Clock::now();
          const auto state = read_text("/tmp/xmp-bridge-state", 32);
          const int light = state.rfind("connected", 0) == 0 ? 1 : state.rfind("ready", 0) == 0 ? 3 : 0;
          if (light != shown_bridge) {
            screen.light(4, light);
            if (shown_bridge >= -1) say("bridge light: %s", light == 1 ? "connected" : light == 3 ? "ready" : "off");
            shown_bridge = light;
          }
        }
        if (seen_input && !shown_input) {
          screen.light(3, 1);
          shown_input = true;
        }
      }
    }
  }

  sequencer.stop();
  if (saver.joinable()) saver.join();
  // The session ends with the whole song on the stick, whatever project.edits holds.
  if (project_dirty || edits_since_whole) save_project("session end", true);
  if (saver.joinable()) saver.join();
  capture.close();
  audio.close();
  controller.close();
  for (std::size_t i = 0; i < fds.size(); ++i)
    if (fd_port[i] < 0) ::close(fds[i].fd);
  const float peak = audio.peak();
  std::string per_pad;
  for (int p = 0; p < 16; ++p) per_pad += (p ? "," : "") + std::to_string(hits[static_cast<std::size_t>(p)]);
  say("done (%s): messages %llu, pad hits [%s], pressure %llu, buttons %llu, controls %llu, sysex %llu, other %llu",
      reason, static_cast<unsigned long long>(messages), per_pad.c_str(), static_cast<unsigned long long>(pressure),
      static_cast<unsigned long long>(buttons), static_cast<unsigned long long>(controls),
      static_cast<unsigned long long>(sysex), static_cast<unsigned long long>(other));
  say("sequencer: %llu notes scheduled, %llu late, %llu recorded, %llu touches, %d BPM",
      static_cast<unsigned long long>(scheduled_notes), static_cast<unsigned long long>(late_notes),
      static_cast<unsigned long long>(recorded), static_cast<unsigned long long>(touches), song.bpm);
  say("audio: blocks %llu, xruns %llu, errors %llu, peak %.1f dBFS, %s, cpu %d",
      static_cast<unsigned long long>(audio.blocks.load()), static_cast<unsigned long long>(audio.xruns.load()),
      static_cast<unsigned long long>(audio.errors.load()), peak > 0 ? 20 * std::log10(peak) : -999.0,
      xmp::scheduling_name(audio.realtime.scheduling), audio.realtime.pinnedCpu);
  say("load: audio thread %.1f%% of its time (worst block %.2f ms of 5.33); a step takes %.2f ms to prepare (worst %.2f ms); "
      "%llu notes late (worst %.1f ms)",
      100.0 * audio.busy_us.load() / std::max<double>(1, audio.blocks.load()) / (256.0 / xmp::kRate * 1e6),
      audio.worst_us.load() / 1000.0, window_count ? window_ms_total / window_count : 0.0, window_ms_worst,
      static_cast<unsigned long long>(audio.project.late()), audio.project.worst_late_frames() / 48.0);
  for (auto& c : clients) ::close(c.fd);
  if (control_fd >= 0) ::close(control_fd);
  ::unlink(kControlSocket);
  screen.close();
  session_log.close();
  return exit_code;
}
