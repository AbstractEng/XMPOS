#pragma once
// XMP's drum kits for the device session. Every sound is synthesized here from
// formulas, in the manner of classic analog drum machines (tuned sines with
// pitch drops, metallic square clusters through filters, noise bursts); no
// recordings or samples of any instrument are used. Kit 1 is XMP's own kit;
// kits 2 and 3 follow the 808 and 909 style of analog synthesis. The names
// describe a style only.
//
// Pads: pad 1 is bottom left. Each sound is mono, peak-normalized to 1, and at
// most 2 s long. Choke groups: a pad in a group stops the others in it (the
// closed hat chokes the open hat).
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <vector>

#include "xmp/json.hpp"
#include "xmp/live_session.hpp"

namespace xmp::live {

enum class KitStyle : std::uint8_t { xmp = 0, style808 = 1, style909 = 2 };
constexpr int kKitStyles = 3;

inline const char* kit_label(int style) {
  static constexpr std::array<const char*, 3> labels{"KIT", "808", "909"};
  return labels[static_cast<std::size_t>(std::clamp(style, 0, 2))];
}

inline const char* kit_pad_name(int style, int pad) {
  static constexpr std::array<std::array<const char*, 16>, 2> names{{
      {"kick", "snare", "closed hat", "open hat", "clap", "rimshot", "low tom", "high tom", "cowbell",
       "cymbal", "clave", "maracas", "low conga", "mid conga", "high conga", "long kick"},
      {"kick", "snare", "closed hat", "open hat", "clap", "rimshot", "low tom", "high tom", "ride", "crash",
       "mid tom", "hard kick", "low tom 2", "snare 2", "shaker", "long kick"},
  }};
  if (style <= 0) return kit_name(pad);
  return pad >= 0 && pad < 16 ? names[static_cast<std::size_t>(style - 1)][static_cast<std::size_t>(pad)] : "?";
}

// Short pad labels for the screen (at most 7 characters).
inline const char* kit_pad_label(int style, int pad) {
  static constexpr std::array<std::array<const char*, 16>, 3> labels{{
      {"KICK", "SNARE", "CL HAT", "OP HAT", "CLAP", "LO TOM", "HI TOM", "RIM", "PLK C", "PLK D", "PLK E", "PLK G",
       "PLK A", "PLK C+", "PLK D+", "PLK E+"},
      {"KICK", "SNARE", "CL HAT", "OP HAT", "CLAP", "RIM", "LO TOM", "HI TOM", "COWBELL", "CYMBAL", "CLAVE", "MARACAS",
       "LO CONG", "MI CONG", "HI CONG", "LONG K"},
      {"KICK", "SNARE", "CL HAT", "OP HAT", "CLAP", "RIM", "LO TOM", "HI TOM", "RIDE", "CRASH", "MI TOM", "HARD K",
       "LO TOM2", "SNARE 2", "SHAKER", "LONG K"},
  }};
  return pad >= 0 && pad < 16 ? labels[static_cast<std::size_t>(std::clamp(style, 0, 2))][static_cast<std::size_t>(pad)]
                              : "";
}

// Choke group per pad (0 = none): closed hat (pad 3) chokes open hat (pad 4).
inline int kit_choke(int style, int pad) {
  (void)style;
  return pad == 2 || pad == 3 ? 1 : 0;
}

namespace kit_detail {
constexpr double kPi = 3.14159265358979323846;

struct Noise {
  std::uint32_t state;
  double next() {
    state = state * 1664525u + 1013904223u;
    return static_cast<double>(state >> 8) / 8388608.0 - 1.0;
  }
};

// Two-pole state-variable filter (Chamberlin), for band- and high-pass colour.
struct Svf {
  double low = 0, band = 0, f = 0, q = 1;
  // Chamberlin: stable only while f < sqrt(4 + q*q) - q (as drum-machines.ts).
  Svf(double hz, double resonance, double rate)
      : f(std::min(2 * std::sin(kPi * std::min(hz, rate / 6) / rate),
                   0.999 * (std::sqrt(4 + 1 / (resonance * resonance)) - 1 / resonance))),
        q(1 / resonance) {}
  double high(double in) {
    low += f * band;
    const double h = in - low - q * band;
    band += f * h;
    return h;
  }
  double bandpass(double in) {
    high(in);
    return band;
  }
};

inline void finish(std::vector<float>& s) {
  float peak = 0;
  for (float v : s) peak = std::max(peak, std::fabs(v));
  if (peak > 0)
    for (float& v : s) v /= peak;
  const std::size_t fade = std::min<std::size_t>(s.size(), 96);
  for (std::size_t i = 0; i < fade; ++i) s[s.size() - 1 - i] *= static_cast<float>(i) / fade;
}

// A sine whose pitch falls from `start` to `end` Hz with time constant `drop`
// seconds, under an exponential decay of `decay` seconds.
inline std::vector<float> swept(double rate, double seconds, double start, double end, double drop, double decay,
                                double click = 0, std::uint32_t seed = 1) {
  std::vector<float> s(static_cast<std::size_t>(seconds * rate));
  Noise noise{seed};
  double phase = 0;
  for (std::size_t i = 0; i < s.size(); ++i) {
    const double t = i / rate;
    phase += 2 * kPi * (end + (start - end) * std::exp(-t / drop)) / rate;
    double v = std::sin(phase) * std::exp(-t / decay);
    if (click > 0 && t < 0.004) v += click * noise.next() * (1 - t / 0.004);
    s[i] = static_cast<float>(v);
  }
  return s;
}

// Six detuned square waves (the classic metallic cluster) through a band-pass
// and high-pass, under an exponential decay.
inline std::vector<float> metallic(double rate, double seconds, double decay, double band, double scale) {
  static constexpr std::array<double, 6> base{205.3, 304.4, 369.6, 522.7, 540.0, 800.0};
  std::vector<float> s(static_cast<std::size_t>(seconds * rate));
  std::array<double, 6> phase{};
  Svf bp(band, 2.0, rate), hp(band * 0.8, 0.7, rate);
  for (std::size_t i = 0; i < s.size(); ++i) {
    double sum = 0;
    for (std::size_t k = 0; k < base.size(); ++k) {
      phase[k] = std::fmod(phase[k] + base[k] * scale / rate, 1.0);
      sum += phase[k] < 0.5 ? 1 : -1;
    }
    const double t = i / rate;
    s[i] = static_cast<float>(hp.high(bp.bandpass(sum / 6)) * std::exp(-t / decay));
  }
  return s;
}

inline std::vector<float> noise_hit(double rate, double seconds, double decay, double band, double resonance,
                                    std::uint32_t seed, bool high = false) {
  std::vector<float> s(static_cast<std::size_t>(seconds * rate));
  Noise noise{seed};
  Svf filter(band, resonance, rate);
  for (std::size_t i = 0; i < s.size(); ++i) {
    const double t = i / rate, n = noise.next();
    s[i] = static_cast<float>((high ? filter.high(n) : filter.bandpass(n)) * std::exp(-t / decay));
  }
  return s;
}

// Hand clap: three quick noise bursts then a longer tail, band-passed near 1 kHz.
inline std::vector<float> clap(double rate, double tail, std::uint32_t seed, double band) {
  std::vector<float> s(static_cast<std::size_t>((0.04 + tail * 4) * rate));
  Noise noise{seed};
  Svf filter(band, 1.5, rate);
  for (std::size_t i = 0; i < s.size(); ++i) {
    const double t = i / rate;
    const double env = t < 0.03 ? std::exp(-std::fmod(t, 0.01) * 400) : std::exp(-(t - 0.03) / tail);
    s[i] = static_cast<float>(filter.bandpass(noise.next()) * env);
  }
  return s;
}

inline std::vector<float> mix(std::vector<float> a, const std::vector<float>& b, float gain_b) {
  if (b.size() > a.size()) a.resize(b.size());
  for (std::size_t i = 0; i < b.size(); ++i) a[i] += gain_b * b[i];
  return a;
}

inline std::vector<float> saturate(std::vector<float> s, double drive) {
  for (float& v : s) v = static_cast<float>(std::tanh(drive * v) / std::tanh(drive));
  return s;
}
}  // namespace kit_detail

// 808-style: round, boomy and soft-edged.
inline std::vector<float> make_808(int pad, double r) {
  using namespace kit_detail;
  std::vector<float> s;
  switch (pad) {
    case 0: s = swept(r, 1.2, 110, 49, 0.02, 0.45); break;                              // kick
    case 1: s = mix(mix(swept(r, 0.3, 238, 180, 0.03, 0.08), swept(r, 0.3, 476, 330, 0.03, 0.05), 0.6f),
                    noise_hit(r, 0.3, 0.07, 5000, 0.8, 11, true), 0.9f);
      break;                                                                             // snare
    case 2: s = metallic(r, 0.12, 0.025, 8500, 1.0); break;                              // closed hat
    case 3: s = metallic(r, 0.8, 0.22, 8500, 1.0); break;                                // open hat
    case 4: s = clap(r, 0.09, 21, 1100); break;                                          // clap
    case 5: s = mix(swept(r, 0.05, 1700, 1600, 0.01, 0.006), noise_hit(r, 0.05, 0.004, 3000, 3, 31), 0.4f); break;
    case 6: s = swept(r, 0.6, 120, 85, 0.06, 0.2); break;                                // low tom
    case 7: s = swept(r, 0.5, 220, 160, 0.06, 0.16); break;                              // high tom
    case 8: {                                                                            // cowbell
      std::vector<float> c(static_cast<std::size_t>(0.5 * r));
      Svf bp(2600, 3.0, r);
      double a = 0, b = 0;
      for (std::size_t i = 0; i < c.size(); ++i) {
        a = std::fmod(a + 540 / r, 1.0), b = std::fmod(b + 800 / r, 1.0);
        const double t = i / r, env = t < 0.02 ? std::exp(-t / 0.01) : 0.5 * std::exp(-(t - 0.02) / 0.15);
        c[i] = static_cast<float>(bp.bandpass((a < 0.5 ? 1 : -1) + (b < 0.5 ? 1 : -1)) * env);
      }
      s = c;
      break;
    }
    case 9: s = metallic(r, 2.0, 0.6, 7000, 0.9); break;                                 // cymbal
    case 10: s = swept(r, 0.08, 2500, 2500, 1, 0.015); break;                            // clave
    case 11: s = noise_hit(r, 0.08, 0.02, 9000, 0.7, 41, true); break;                   // maracas
    case 12: s = swept(r, 0.4, 190, 165, 0.02, 0.12); break;                             // low conga
    case 13: s = swept(r, 0.35, 300, 260, 0.02, 0.1); break;                             // mid conga
    case 14: s = swept(r, 0.3, 420, 370, 0.02, 0.08); break;                             // high conga
    default: s = swept(r, 2.0, 90, 41, 0.03, 0.9); break;                                // long kick
  }
  finish(s);
  return s;
}

// 909-style: punchy and bright, with a click on the kick and noisy snares.
inline std::vector<float> make_909(int pad, double r) {
  using namespace kit_detail;
  std::vector<float> s;
  switch (pad) {
    case 0: s = saturate(swept(r, 0.6, 330, 52, 0.012, 0.22, 0.5, 51), 2.0); break;       // kick
    case 1: s = mix(swept(r, 0.3, 300, 190, 0.02, 0.06), noise_hit(r, 0.3, 0.12, 7000, 0.7, 61, true), 1.2f);
      break;                                                                             // snare
    case 2: s = mix(metallic(r, 0.1, 0.02, 9500, 1.2), noise_hit(r, 0.1, 0.02, 10000, 0.7, 71, true), 0.5f); break;
    case 3: s = mix(metallic(r, 0.7, 0.18, 9500, 1.2), noise_hit(r, 0.7, 0.16, 10000, 0.7, 81, true), 0.5f); break;
    case 4: s = clap(r, 0.12, 91, 1300); break;                                          // clap
    case 5: s = mix(swept(r, 0.06, 1800, 1700, 0.01, 0.008), noise_hit(r, 0.06, 0.01, 4000, 2, 101), 0.7f); break;
    case 6: s = mix(swept(r, 0.5, 160, 90, 0.04, 0.16), noise_hit(r, 0.5, 0.02, 2000, 1, 111), 0.15f); break;
    case 7: s = mix(swept(r, 0.4, 280, 170, 0.04, 0.12), noise_hit(r, 0.4, 0.02, 3000, 1, 121), 0.15f); break;
    case 8: s = metallic(r, 1.5, 0.45, 6000, 1.4); break;                                // ride
    case 9: s = mix(metallic(r, 2.0, 0.7, 7500, 1.1), noise_hit(r, 2.0, 0.6, 9000, 0.7, 131, true), 0.6f); break;
    case 10: s = mix(swept(r, 0.45, 210, 125, 0.04, 0.14), noise_hit(r, 0.45, 0.02, 2500, 1, 141), 0.15f); break;
    case 11: s = saturate(swept(r, 0.5, 400, 55, 0.008, 0.15, 0.8, 151), 4.0); break;    // hard kick
    case 12: s = mix(swept(r, 0.6, 120, 70, 0.05, 0.2), noise_hit(r, 0.6, 0.02, 1500, 1, 161), 0.15f); break;
    case 13: s = mix(swept(r, 0.25, 330, 220, 0.02, 0.05), noise_hit(r, 0.25, 0.09, 8000, 0.7, 171, true), 1.6f);
      break;                                                                             // snare 2
    case 14: s = noise_hit(r, 0.12, 0.03, 7000, 0.6, 181, true); break;                  // shaker
    default: s = saturate(swept(r, 1.6, 250, 45, 0.015, 0.7, 0.4, 191), 1.5); break;     // long kick
  }
  finish(s);
  return s;
}

inline std::vector<float> make_kit_sound(int style, int pad, double rate) {
  if (style == 1) return make_808(pad, rate);
  if (style == 2) return make_909(pad, rate);
  return make_sound(pad, static_cast<std::uint32_t>(rate));
}

struct DrumMachineKit {
  const char* id;
  const char* name;
  KitStyle style;
};
inline constexpr DrumMachineKit kDrumMachineKits[] = {
    {"builtin:xmp-808", "XMP 808 style", KitStyle::style808},
    {"builtin:xmp-909", "XMP 909 style", KitStyle::style909},
    {"builtin:xmp-demo", "Original XMP demo kit", KitStyle::xmp},
};

// The same project kit format and synthesized sounds as the browser's library.
inline json::Value drum_machine_kit(const DrumMachineKit& kit, int rate) {
  using json::Value;
  const int style = static_cast<int>(kit.style);
  Value samples = Value::new_array();
  for (int pad = 0; pad < 16; ++pad) {
    std::string name = kit_pad_name(style, pad);
    name[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(name[0])));
    const auto pcm = make_kit_sound(style, pad, rate);
    Value frames = Value::new_array();
    frames.items().reserve(static_cast<int32_t>(pcm.size()));
    for (float frame : pcm)
      frames.push(Value::of(static_cast<double>(frame)));
    Value sound = Value::new_object();
    sound.set("name", Value::of(Str(name.c_str())));
    sound.set("sampleRate", Value::of(static_cast<double>(rate)));
    sound.set("pcm", xmp::move(frames));
    sound.set("choke", Value::of(static_cast<double>(kit_choke(style, pad))));
    samples.push(xmp::move(sound));
  }
  Value value = Value::new_object();
  value.set("name", Value::of(kit.name));
  value.set("samples", xmp::move(samples));
  return value;
}

}  // namespace xmp::live
