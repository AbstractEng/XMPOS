#pragma once
// Bounded WAV decoding for the device session's sampler track: the owner's own
// samples from the stick (xmp/samples/trackN/). Validates everything before
// use, never trusts sizes in the file, and returns mono float samples at the
// engine's rate. Runs before the audio thread, never on it.
//
// Accepted: RIFF/WAVE, PCM 8/16/24/32-bit integer or 32-bit float (format 1,
// 3, or WAVE_FORMAT_EXTENSIBLE with those), 1 or 2 channels (stereo is mixed
// to mono), 8-192 kHz (linearly resampled), at most 30 s and 48 MB per file.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace xmp::live {

struct WavResult {
  std::vector<float> samples;  // mono, at the requested rate
  std::string error;           // empty on success
  std::uint32_t source_rate = 0, channels = 0, bits = 0;
};

constexpr std::size_t kWavMaxBytes = 48u * 1024 * 1024;
constexpr double kWavMaxSeconds = 30;

inline WavResult decode_wav(const std::vector<std::uint8_t>& data, std::uint32_t rate) {
  WavResult out;
  auto fail = [&](const char* why) {
    out.samples.clear();
    out.error = why;
    return out;
  };
  auto u16 = [&](std::size_t at) { return static_cast<std::uint32_t>(data[at] | data[at + 1] << 8); };
  auto u32 = [&](std::size_t at) {
    return static_cast<std::uint32_t>(data[at]) | static_cast<std::uint32_t>(data[at + 1]) << 8 |
           static_cast<std::uint32_t>(data[at + 2]) << 16 | static_cast<std::uint32_t>(data[at + 3]) << 24;
  };
  if (data.size() > kWavMaxBytes) return fail("file larger than 48 MB");
  if (data.size() < 44 || std::memcmp(data.data(), "RIFF", 4) != 0 || std::memcmp(data.data() + 8, "WAVE", 4) != 0)
    return fail("not a RIFF/WAVE file");
  std::uint32_t format = 0, channels = 0, source_rate = 0, bits = 0, block = 0;
  std::size_t data_at = 0, data_size = 0;
  for (std::size_t at = 12; at + 8 <= data.size();) {
    const std::uint32_t size = u32(at + 4);
    const std::size_t body = at + 8;
    if (size > data.size() - body) {
      if (std::memcmp(data.data() + at, "data", 4) == 0) {
        data_at = body, data_size = data.size() - body;  // tolerate a truncated last chunk
        break;
      }
      return fail("chunk runs past the end of the file");
    }
    if (std::memcmp(data.data() + at, "fmt ", 4) == 0) {
      if (size < 16) return fail("format chunk too short");
      format = u16(body), channels = u16(body + 2), source_rate = u32(body + 4), block = u16(body + 12),
      bits = u16(body + 14);
      if (format == 0xFFFE) {
        if (size < 40) return fail("extensible format chunk too short");
        format = u16(body + 24);  // sub-format GUID starts with the format code
      }
    } else if (std::memcmp(data.data() + at, "data", 4) == 0) {
      data_at = body, data_size = size;
    }
    at = body + size + (size & 1);
  }
  out.source_rate = source_rate, out.channels = channels, out.bits = bits;
  if (!data_at) return fail("no data chunk");
  if (format != 1 && format != 3) return fail("only PCM or float WAV is supported");
  if (channels < 1 || channels > 2) return fail("only mono or stereo WAV is supported");
  if (source_rate < 8000 || source_rate > 192000) return fail("sample rate outside 8-192 kHz");
  const bool is_float = format == 3;
  if (is_float ? bits != 32 : (bits != 8 && bits != 16 && bits != 24 && bits != 32))
    return fail("unsupported bit depth");
  const std::uint32_t bytes = bits / 8;
  if (block != bytes * channels) return fail("inconsistent block size");
  const std::size_t frames = data_size / block;
  if (frames == 0) return fail("no audio");
  if (static_cast<double>(frames) / source_rate > kWavMaxSeconds) return fail("longer than 30 s");

  auto sample = [&](std::size_t frame, std::uint32_t channel) -> double {
    const std::size_t at = data_at + frame * block + channel * bytes;
    if (is_float) {
      float v;
      const std::uint32_t raw = u32(at);
      std::memcpy(&v, &raw, 4);
      return std::isfinite(v) ? std::clamp(static_cast<double>(v), -1.0, 1.0) : 0.0;
    }
    switch (bits) {
      case 8: return (static_cast<int>(data[at]) - 128) / 128.0;
      case 16: return static_cast<std::int16_t>(u16(at)) / 32768.0;
      case 24: {
        std::int32_t v = static_cast<std::int32_t>(data[at] | data[at + 1] << 8 | data[at + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        return v / 8388608.0;
      }
      default: return static_cast<std::int32_t>(u32(at)) / 2147483648.0;
    }
  };
  std::vector<float> mono(frames);
  for (std::size_t f = 0; f < frames; ++f) {
    double v = 0;
    for (std::uint32_t c = 0; c < channels; ++c) v += sample(f, c);
    mono[f] = static_cast<float>(v / channels);
  }
  if (source_rate == rate) {
    out.samples = std::move(mono);
    return out;
  }
  // Linear resampling to the engine's rate.
  const double step = static_cast<double>(source_rate) / rate;
  const auto length = static_cast<std::size_t>(std::floor((frames - 1) / step)) + 1;
  out.samples.resize(length);
  for (std::size_t i = 0; i < length; ++i) {
    const double pos = i * step;
    const auto a = static_cast<std::size_t>(pos);
    const double frac = pos - a;
    const float next = a + 1 < frames ? mono[a + 1] : mono[a];
    out.samples[i] = static_cast<float>(mono[a] * (1 - frac) + next * frac);
  }
  return out;
}

}  // namespace xmp::live
