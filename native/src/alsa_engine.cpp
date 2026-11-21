// Continuous XMP engine on an ALSA playback device (Linux guests only).
//
// Renders the prepared host graph in 256-frame blocks on a real-time thread
// and writes them to an explicitly numbered ALSA card. There is no default
// device and no discovery: the card index is required, and cards whose
// identity names an Akai/inMusic product are refused (device-specific
// authorization does not exist yet). Nothing here opens MIDI, USB or storage.
#include "xmp/card_policy.hpp"
#include "xmp/engine.hpp"
#include "xmp/host_graph.hpp"
#include "xmp/rt_audit.hpp"
#include "xmp/rt_thread.hpp"

#include <alsa/asoundlib.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

namespace {

volatile std::sig_atomic_t interrupted = 0;
void interrupt(int) { interrupted = 1; }

std::string read_text(const std::string& path) {
  std::ifstream input(path);
  std::string text((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  return text;
}

// Card identity from procfs text only; the card is not opened to read it.
std::string card_identity(int card) {
  const std::string base = "/proc/asound/card" + std::to_string(card);
  return read_text(base + "/id") + " " + read_text(base + "/usbid") + " " +
         read_text(base + "/stream0").substr(0, 256);
}

struct Options {
  std::string graph, report;
  int card = -1;
  int seconds = 0;
};

Options parse(int argc, char** argv) {
  Options options;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string key = argv[i], value = argv[i + 1];
    if (key == "--graph") options.graph = value;
    else if (key == "--report") options.report = value;
    else if (key == "--card") options.card = std::stoi(value);
    else if (key == "--seconds") options.seconds = std::stoi(value);
    else throw std::runtime_error("Unknown option " + key);
  }
  if (argc != 9 || options.graph.empty() || options.report.empty() || options.card < 0 ||
      options.card > 7 || options.seconds < 1 || options.seconds > 600)
    throw std::runtime_error(
        "Usage: xmp_alsa_engine --graph FILE --card 0..7 --seconds 1..600 --report FILE");
  return options;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const auto options = parse(argc, argv);
    const auto identity = card_identity(options.card);
    if (identity.find_first_not_of(" \n") == std::string::npos)
      throw std::runtime_error("ALSA card not present");
    if (xmp::protected_card_identity(identity))
      throw std::runtime_error("Refusing an Akai/inMusic card without device-specific authorization");

    const auto owner = xmp::load_host_graph(options.graph.c_str());
    auto engine = std::make_unique<xmp::Engine>(owner.graph);
    std::signal(SIGTERM, interrupt);
    std::signal(SIGINT, interrupt);

    char device[32];
    std::snprintf(device, sizeof device, "plughw:%d,0", options.card);
    snd_pcm_t* pcm = nullptr;
    if (snd_pcm_open(&pcm, device, SND_PCM_STREAM_PLAYBACK, 0) < 0)
      throw std::runtime_error("Cannot open ALSA playback device");
    // 48 kHz stereo S16, 256-frame periods, four periods of buffering.
    if (snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 2, xmp::kRate,
                           1, static_cast<unsigned>(4 * 256 * 1000000ULL / xmp::kRate)) < 0) {
      snd_pcm_close(pcm);
      throw std::runtime_error("ALSA device rejected 48 kHz stereo S16");
    }
    snd_pcm_uframes_t buffer = 0, period = 0;
    snd_pcm_get_params(pcm, &buffer, &period);

    // Prepare every buffer before the loop; nothing is allocated while playing.
    std::array<float, 256> left{}, right{};
    std::array<std::int16_t, 512> pcm16{};
    std::array<std::uint64_t, 64> histogram{};
    const std::uint64_t total = static_cast<std::uint64_t>(options.seconds) * xmp::kRate;
    const std::uint64_t deadline_ns = 256ULL * 1000000000ULL / xmp::kRate;
    std::uint64_t written = 0, blocks = 0, xruns = 0, late = 0, faults = 0, max_ns = 0;
    // Transient device errors (a USB audio interface can briefly return EIO) are
    // recovered a bounded number of times, counted and reported, never hidden.
    std::uint64_t device_errors = 0;
    unsigned consecutive_device_errors = 0;
    double peak = 0, energy = 0;

    const auto realtime = xmp::promote_audio_thread(deadline_ns);
    engine->critical.push({xmp::Op::start, 1, 0, 0, 0, 0});
    const auto started = std::chrono::steady_clock::now();
    while (written < total && !interrupted) {
      const auto t0 = std::chrono::steady_clock::now();
      xmp::audit::begin();
      engine->render(left.data(), right.data(), 256);
      const auto audit = xmp::audit::end();
      const auto elapsed = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - t0)
              .count());
      faults += audit.allocations + audit.frees + audit.locks + audit.files + audit.network;
      max_ns = std::max(max_ns, elapsed);
      if (elapsed > deadline_ns) ++late;
      std::size_t bin = 0;
      for (auto value = elapsed; value > 1; value >>= 1) ++bin;
      ++histogram[std::min<std::size_t>(bin, histogram.size() - 1)];
      for (std::size_t i = 0; i < 256; ++i) {
        const float l = std::clamp(left[i], -1.0f, 1.0f), r = std::clamp(right[i], -1.0f, 1.0f);
        pcm16[i * 2] = static_cast<std::int16_t>(std::lrint(l * 32767.0f));
        pcm16[i * 2 + 1] = static_cast<std::int16_t>(std::lrint(r * 32767.0f));
        peak = std::max(peak, static_cast<double>(std::max(std::fabs(l), std::fabs(r))));
        energy += static_cast<double>(l) * l + static_cast<double>(r) * r;
      }
      snd_pcm_uframes_t offset = 0;
      while (offset < 256 && !interrupted) {
        const auto result = snd_pcm_writei(pcm, pcm16.data() + offset * 2, 256 - offset);
        if (result == -EPIPE || result == -ESTRPIPE) {
          ++xruns;  // the device ran dry: recover and continue
          if (snd_pcm_recover(pcm, static_cast<int>(result), 1) < 0)
            throw std::runtime_error("ALSA xrun recovery failed");
        } else if (result == -EIO && device_errors < 32 && consecutive_device_errors < 4) {
          ++device_errors;
          ++consecutive_device_errors;
          if (snd_pcm_prepare(pcm) < 0) throw std::runtime_error("ALSA device recovery failed");
        } else if (result < 0) {
          throw std::runtime_error(std::string("ALSA write failed: ") + snd_strerror(static_cast<int>(result)));
        } else {
          consecutive_device_errors = 0;
          offset += static_cast<snd_pcm_uframes_t>(result);
        }
      }
      written += 256;
      ++blocks;
    }
    snd_pcm_drain(pcm);
    snd_pcm_close(pcm);
    const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();

    std::uint64_t counted = 0, p99_bin = 0;
    for (std::size_t bin = 0; bin < histogram.size(); ++bin) {
      counted += histogram[bin];
      if (counted * 100 >= blocks * 99) {
        p99_bin = bin;
        break;
      }
    }
    xmp::Snapshot snapshot;
    engine->snapshot(snapshot);
    std::ofstream report(options.report);
    report << "{\"backend\":\"alsa\",\"device\":\"" << device << "\",\"sampleRate\":" << xmp::kRate
           << ",\"periodFrames\":" << period << ",\"bufferFrames\":" << buffer
           << ",\"realtimeScheduling\":\"" << xmp::scheduling_name(realtime.scheduling)
           << "\",\"memoryLocked\":" << (realtime.memoryLocked ? "true" : "false")
           << ",\"pinnedCpu\":" << realtime.pinnedCpu
           << ",\"framesWritten\":" << written << ",\"blocks\":" << blocks
           << ",\"wallSeconds\":" << wall << ",\"xruns\":" << xruns << ",\"deviceErrors\":" << device_errors << ",\"lateRenders\":" << late
           << ",\"renderMaxNs\":" << max_ns << ",\"renderP99UpperNs\":" << ((1ULL << (p99_bin + 1)) - 1)
           << ",\"auditFaults\":" << faults << ",\"notesOn\":" << snapshot.on
           << ",\"peak\":" << peak << ",\"rms\":" << (written ? std::sqrt(energy / (2.0 * written)) : 0)
           << ",\"interrupted\":" << (interrupted ? "true" : "false") << "}\n";
    std::cout << "XMP-ALSA-ENGINE done frames=" << written << " xruns=" << xruns << "\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "xmp_alsa_engine: " << error.what() << "\n";
    return 2;
  }
}
