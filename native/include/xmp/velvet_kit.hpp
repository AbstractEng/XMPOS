#pragma once
// XMP Velvet: an original, multi-sampled drum kit for groove playing: a dry,
// warm, deadened soul and psych-funk kit (muffled kick, towelled snare,
// side stick, dark hats and ride) with hand percussion (bongos, congas,
// shaker, tambourine, finger cymbal). Every sound is synthesized here from
// formulas (decaying modes, filtered noise, metallic clusters, a little tape
// saturation and a small room); no recording of any instrument is used.
//
// Each pad has velocity layers that change the tone as well as the level
// (soft hits are darker, with less attack; hard hits bring the beater, the
// rim and the crack), and round-robin takes inside each layer that differ
// slightly in pitch, decay and noise, so repeated hits do not sound copied.
// The low drums are made at 24 or 32 kHz to keep the kit inside a project's
// sample budget; the engine plays every sound at its own rate.
//
// native/src/velvet_kit.cpp writes the kit as an .xmpkit file (drum-kit JSON,
// project format 8 layers) that both the browser and the Live load.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace xmp::kits::velvet {

constexpr double kPi = 3.14159265358979323846;

struct Rng {
  uint32_t s;
  explicit Rng(uint32_t seed) : s(seed * 2654435761u + 0x9E3779B9u) {}
  double next() {  // -1..1
    s = s * 1664525u + 1013904223u;
    return static_cast<double>(s >> 8) / 8388608.0 - 1.0;
  }
};

// RBJ biquads.
struct Biquad {
  enum Type { lp, hp, bp };
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
  Biquad(Type type, double hz, double q, double rate) {
    const double w = 2 * kPi * std::min(hz, rate * 0.45) / rate, c = std::cos(w), alpha = std::sin(w) / (2 * q);
    const double a0 = 1 + alpha;
    a1 = -2 * c / a0, a2 = (1 - alpha) / a0;
    if (type == lp) b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0;
    if (type == hp) b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = b0;
    if (type == bp) b0 = alpha / a0, b1 = 0, b2 = -alpha / a0;
  }
  double run(double x) {
    const double y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
};

using Buffer = std::vector<double>;

struct Hit {
  double v = 0.5;          // intensity of the layer, 0..1
  double j1 = 0, j2 = 0, j3 = 0;  // the take's small differences, -1..1
  uint32_t seed = 1;
};

inline void filter(Buffer& b, Biquad f) {
  for (auto& x : b) x = f.run(x);
}
// A decaying partial, its pitch falling from (1 + drop) times `hz` towards `hz`.
inline void partial(Buffer& b, double rate, double hz, double decay, double amp, double drop = 0,
                    double drop_time = 0.01, double delay = 0) {
  double phase = 0;
  const auto start = static_cast<std::size_t>(delay * rate);
  for (std::size_t i = start; i < b.size(); ++i) {
    const double t = (i - start) / rate;
    phase += 2 * kPi * hz * (1 + drop * std::exp(-t / drop_time)) / rate;
    b[i] += amp * std::sin(phase) * std::exp(-t / decay);
  }
}
// A noise burst through `shape` filters, with an attack and an exponential decay.
template <class... Filters>
inline void noise(Buffer& b, double rate, Rng& rng, double attack, double decay, double amp, double delay,
                  Filters... shape) {
  Buffer n(b.size(), 0.0);
  const auto start = static_cast<std::size_t>(delay * rate);
  for (std::size_t i = start; i < n.size(); ++i) {
    const double t = (i - start) / rate;
    const double env = (t < attack ? t / attack : 1.0) * std::exp(-std::max(0.0, t - attack) / decay);
    n[i] = rng.next() * env;
  }
  (filter(n, shape), ...);
  for (std::size_t i = 0; i < n.size(); ++i) b[i] += amp * n[i];
}
// Six detuned square waves: the metallic core of hats.
inline void metal(Buffer& b, double rate, double scale, double attack, double decay, double amp) {
  static constexpr double kSquares[] = {317.0, 471.5, 593.2, 787.4, 921.8, 1103.6};
  double phase[6] = {};
  for (std::size_t i = 0; i < b.size(); ++i) {
    const double t = i / rate;
    double sum = 0;
    for (int k = 0; k < 6; ++k) {
      phase[k] = std::fmod(phase[k] + kSquares[k] * scale / rate, 1.0);
      sum += phase[k] < 0.5 ? 1 : -1;
    }
    const double env = (t < attack ? t / attack : 1.0) * std::exp(-std::max(0.0, t - attack) / decay);
    b[i] += amp * sum / 6 * env;
  }
}

// Tape and room: gentle saturation, a dark low-pass, two early reflections of
// a small dry room, the tail trimmed where it falls silent, a short fade, and
// the peak set to `peak`. Values are rounded to 1/10000, as the kit file keeps them.
inline std::vector<float> finish(Buffer b, double rate, double peak, double lowpass, double drive) {
  for (auto& x : b) x = std::tanh(drive * x) / std::tanh(drive);
  filter(b, Biquad(Biquad::lp, lowpass, 0.707, rate));
  Buffer room(b.size(), 0.0);
  const auto add = [&](double seconds, double gain) {
    const auto d = static_cast<std::size_t>(seconds * rate);
    for (std::size_t i = d; i < b.size(); ++i) room[i] += gain * b[i - d];
  };
  add(0.0067, 0.11), add(0.0113, 0.07);
  filter(room, Biquad(Biquad::lp, 3500, 0.707, rate));
  for (std::size_t i = 0; i < b.size(); ++i) b[i] += room[i];
  double top = 0;
  for (const double x : b) top = std::max(top, std::fabs(x));
  if (top <= 0) return std::vector<float>(1, 0.0f);
  std::size_t end = b.size();
  while (end > 1 && std::fabs(b[end - 1]) < top * 3e-4) --end;
  const auto fade = std::min<std::size_t>(end, static_cast<std::size_t>(0.003 * rate));
  std::vector<float> out(end);
  for (std::size_t i = 0; i < end; ++i) {
    double x = b[i] / top * peak;
    if (i + fade >= end) x *= static_cast<double>(end - 1 - i) / fade;
    out[i] = static_cast<float>(std::round(x * 10000) / 10000);
  }
  return out;
}
inline double level(double v) { return 0.28 + 0.66 * std::pow(v, 1.2); }
inline Buffer blank(double rate, double seconds) { return Buffer(static_cast<std::size_t>(rate * seconds), 0.0); }

// ---- the sounds ----

inline std::vector<float> kick(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.42);
  const double f0 = 54 * (1 + 0.012 * h.j1), decay = (0.1 + 0.06 * h.v) * (1 + 0.06 * h.j2);
  partial(b, r, f0, decay, 1.0, 0.5 + 0.9 * h.v, 0.012);
  partial(b, r, f0 * 1.6, 0.035, 0.18 + 0.1 * h.v, 0.3, 0.01);
  noise(b, r, rng, 0.0005, 0.004 + 0.002 * h.v, 0.12 + 0.45 * std::pow(h.v, 1.5), 0,
        Biquad(Biquad::lp, 900 + 2600 * h.v, 0.707, r));  // the felt beater
  noise(b, r, rng, 0.001, 0.02, 0.25, 0, Biquad(Biquad::lp, 220, 0.707, r));  // the blanket's thump
  return finish(b, r, level(h.v), 3500 + 5000 * h.v, 1.2 + 1.8 * h.v);
}

inline std::vector<float> snare(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.32);
  const double p = 1 + 0.01 * h.j1, body = 0.5 + 0.5 * h.v;
  partial(b, r, 182 * p, 0.05, 0.9 * body, 0.06, 0.006);
  partial(b, r, 316 * p, 0.035, 0.5 * body, 0.06, 0.006);
  partial(b, r, 455 * p, 0.022, 0.3 * body, 0.06, 0.006);
  noise(b, r, rng, 0.0008, (0.055 + 0.07 * h.v) * (1 + 0.08 * h.j2), 0.45 + 0.45 * h.v, 0,
        Biquad(Biquad::bp, 4200 * (1 + 0.03 * h.j3), 0.8, r), Biquad(Biquad::hp, 1800, 0.707, r));  // wires
  noise(b, r, rng, 0.0002, 0.0025, 0.5 * h.v * h.v, 0, Biquad(Biquad::hp, 3000, 0.707, r));  // the stick
  if (h.v > 0.55) partial(b, r, 880 * p, 0.012, 0.5 * (h.v - 0.55));                          // the rim
  return finish(b, r, level(h.v), 5200 + 4800 * h.v, 1.3 + 1.5 * h.v);
}

inline std::vector<float> side_stick(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.14);
  const double p = 1 + 0.01 * h.j1;
  partial(b, r, 1240 * p, 0.022, 0.7);
  partial(b, r, 1690 * p, 0.016, 0.45);
  partial(b, r, 2580 * p, 0.009, 0.3);
  partial(b, r, 205 * p, 0.03 * (1 + 0.05 * h.j2), 0.5);
  noise(b, r, rng, 0.0001, 0.0015, 0.25 + 0.5 * h.v, 0, Biquad(Biquad::bp, 3500, 1.2, r));
  return finish(b, r, level(h.v), 6000 + 4000 * h.v, 1.2);
}

// Hats: `decay` sets closed, pedal or open.
inline std::vector<float> hat(double r, const Hit& h, double seconds, double decay, double band) {
  Rng rng(h.seed);
  Buffer b = blank(r, seconds);
  const double d = decay * (1 + 0.1 * h.j2);
  metal(b, r, 4.0 * (1 + 0.004 * h.j1), 0.0003, d, 1.0);
  noise(b, r, rng, 0.0003, d * 0.8, 0.45, 0, Biquad(Biquad::hp, 7000, 0.707, r));
  filter(b, Biquad(Biquad::bp, band * (1 + 0.12 * h.v), 1.1, r));
  filter(b, Biquad(Biquad::hp, 5200, 0.707, r));
  noise(b, r, rng, 0.0002, 0.0015, 0.25 * h.v, 0, Biquad(Biquad::bp, 3000, 1.5, r));  // stick on the bow
  return finish(b, r, level(h.v), 9000 + 3000 * h.v, 1.1);
}

inline std::vector<float> pedal_hat(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.12);
  metal(b, r, 3.6 * (1 + 0.004 * h.j1), 0.002, 0.02 * (1 + 0.1 * h.j2), 1.0);
  filter(b, Biquad(Biquad::bp, 4500, 1.0, r));
  filter(b, Biquad(Biquad::hp, 3000, 0.707, r));
  noise(b, r, rng, 0.001, 0.01, 0.2, 0, Biquad(Biquad::lp, 800, 0.707, r));  // the plates meeting
  return finish(b, r, level(h.v) * 0.9, 9000, 1.1);
}

inline std::vector<float> ride(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.55);
  static constexpr double kModes[] = {412, 587, 781, 1049, 1377, 1723, 2188, 2702, 3317, 4051, 4893};
  for (int k = 0; k < 11; ++k)
    partial(b, r, kModes[k] * (1 + 0.004 * h.j1) * (1 + 0.003 * rng.next()), (0.5 - 0.025 * k) * (1 + 0.05 * h.j2),
            0.35 / std::sqrt(1.0 + k));
  noise(b, r, rng, 0.0002, 0.006, 0.5 + 0.4 * h.v, 0, Biquad(Biquad::bp, 5200, 2.0, r));  // the ping
  noise(b, r, rng, 0.002, 0.25, 0.08 + 0.12 * h.v, 0, Biquad(Biquad::bp, 6000, 0.7, r));  // the wash
  filter(b, Biquad(Biquad::hp, 300, 0.707, r));
  return finish(b, r, level(h.v) * 0.85, 7000 + 3000 * h.v, 1.1);
}

inline std::vector<float> shaker(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.13);
  const double grains[] = {0, 0.006 + 0.003 * h.j1, 0.014 + 0.004 * h.j2};
  for (int g = 0; g < 3; ++g)
    noise(b, r, rng, 0.004, 0.03 + 0.02 * h.v, 1.0 / (1 + g), grains[g], Biquad(Biquad::bp, 6800, 1.4, r),
          Biquad(Biquad::hp, 3500, 0.707, r));
  return finish(b, r, level(h.v) * 0.8, 12000, 1.0);
}

inline std::vector<float> tambourine(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.3);
  noise(b, r, rng, 0.001, 0.02, 0.3, 0, Biquad(Biquad::lp, 900, 0.707, r));  // the hand on the head
  const double spread = 0.012 + 0.02 * (1 - h.v);  // a harder hit rings the jingles together
  for (int j = 0; j < 7; ++j) {
    const double at = (rng.next() + 1) / 2 * spread, gain = 0.5 + 0.5 * std::fabs(rng.next());
    for (const double hz : {4300.0, 6100.0, 8900.0, 11200.0})
      partial(b, r, hz * (1 + 0.03 * rng.next()), 0.05 + 0.04 * std::fabs(rng.next()), 0.12 * gain, 0, 0.01, at);
    noise(b, r, rng, 0.0005, 0.03, 0.15 * gain, at, Biquad(Biquad::hp, 7000, 0.707, r));
  }
  return finish(b, r, level(h.v) * 0.85, 13000, 1.0);
}

// Hand drums and toms: a membrane's modes, the pitch settling as the head relaxes.
inline std::vector<float> membrane(double r, const Hit& h, double seconds, double f0, const double* ratios,
                                   const double* decays, const double* amps, int modes, double drop,
                                   double slap_band, double slap, double lowpass) {
  Rng rng(h.seed);
  Buffer b = blank(r, seconds);
  const double p = 1 + 0.012 * h.j1;
  for (int k = 0; k < modes; ++k)
    partial(b, r, f0 * ratios[k] * p, decays[k] * (1 + 0.07 * h.j2), amps[k] * (k ? 0.6 + 0.4 * h.v : 1.0),
            drop * (0.6 + 0.8 * h.v), 0.015);
  noise(b, r, rng, 0.0003, 0.004 + 0.004 * (1 - h.v), slap * (0.35 + 0.65 * h.v), 0,
        Biquad(Biquad::bp, slap_band * (1 + 0.05 * h.j3), 1.0, r));
  return finish(b, r, level(h.v), lowpass * (0.75 + 0.35 * h.v), 1.1 + 0.8 * h.v);
}
inline std::vector<float> bongo(double r, const Hit& h, double f0, double seconds) {
  static constexpr double ratios[] = {1, 1.59, 2.14, 2.65}, decays[] = {0.09, 0.05, 0.03, 0.02},
                          amps[] = {1, 0.4, 0.25, 0.15};
  return membrane(r, h, seconds, f0, ratios, decays, amps, 4, 0.05, 2200, 0.5, 8000);
}
inline std::vector<float> conga(double r, const Hit& h) {
  static constexpr double ratios[] = {1, 1.5, 1.98, 2.44}, decays[] = {0.2, 0.08, 0.05, 0.03},
                          amps[] = {1, 0.35, 0.2, 0.12};
  return membrane(r, h, 0.38, 196, ratios, decays, amps, 4, 0.02, 1500, 0.4, 6500);
}
inline std::vector<float> conga_slap(double r, const Hit& h) {
  static constexpr double ratios[] = {1, 1.52, 2.1}, decays[] = {0.04, 0.025, 0.015}, amps[] = {0.7, 0.4, 0.25};
  return membrane(r, h, 0.15, 330, ratios, decays, amps, 3, 0.03, 3200, 1.0, 11000);
}
inline std::vector<float> tom(double r, const Hit& h, double f0, double seconds, double decay) {
  const double ratios[] = {1, 1.59, 2.14}, decays[] = {decay, 0.06, 0.04}, amps[] = {1, 0.3, 0.15};
  return membrane(r, h, seconds, f0, ratios, decays, amps, 3, 0.1, 2500, 0.45, 5000);
}

inline std::vector<float> finger_cymbal(double r, const Hit& h) {
  Rng rng(h.seed);
  Buffer b = blank(r, 0.7);
  static constexpr double kHz[] = {2930, 2948, 4410, 6680, 8120}, kDecay[] = {0.6, 0.55, 0.4, 0.25, 0.18},
                          kAmp[] = {1, 0.8, 0.5, 0.3, 0.2};
  for (int k = 0; k < 5; ++k)
    partial(b, r, kHz[k] * (1 + 0.002 * h.j1), kDecay[k] * (1 + 0.05 * h.j2), kAmp[k] * (k > 1 ? 0.5 + 0.5 * h.v : 1));
  noise(b, r, rng, 0.0002, 0.002, 0.3 * h.v, 0, Biquad(Biquad::hp, 5000, 0.707, r));
  return finish(b, r, level(h.v) * 0.8, 12000, 1.0);
}

// ---- the kit ----

struct Take {
  int rate = 48000;
  std::vector<float> pcm;
};
struct Layer {
  double up_to = 1;
  std::vector<Take> takes;
};
struct Sound {
  std::string name;
  int choke = 0;
  std::vector<Layer> layers;  // softest first; the loudest layer's first take is the pad's own sound
};

inline constexpr const char* kName = "XMP Velvet";

// Pad 1 is bottom left.
inline std::vector<Sound> make() {
  struct Spec {
    const char* name;
    int rate, layers, takes, choke;
    std::vector<float> (*sound)(double, const Hit&);
  };
  static const Spec kSpecs[16] = {
      {"Kick", 24000, 3, 2, 0, kick},
      {"Snare", 32000, 3, 3, 0, snare},
      {"Closed hat", 48000, 3, 3, 1, [](double r, const Hit& h) { return hat(r, h, 0.1, 0.018 + 0.03 * h.v, 7600); }},
      {"Open hat", 48000, 2, 1, 1, [](double r, const Hit& h) { return hat(r, h, 0.45, 0.25 + 0.1 * h.v, 7200); }},
      {"Side stick", 32000, 2, 2, 0, side_stick},
      {"Pedal hat", 48000, 2, 1, 1, pedal_hat},
      {"Low tom", 24000, 2, 1, 0, [](double r, const Hit& h) { return tom(r, h, 92, 0.45, 0.17); }},
      {"High tom", 24000, 2, 1, 0, [](double r, const Hit& h) { return tom(r, h, 140, 0.38, 0.14); }},
      {"Ride", 48000, 2, 1, 0, ride},
      {"Shaker", 48000, 2, 3, 0, shaker},
      {"Tambourine", 32000, 2, 2, 0, tambourine},
      {"Finger cymbal", 32000, 2, 1, 0, finger_cymbal},
      {"Low bongo", 24000, 2, 2, 0, [](double r, const Hit& h) { return bongo(r, h, 285, 0.26); }},
      {"High bongo", 24000, 2, 2, 0, [](double r, const Hit& h) { return bongo(r, h, 410, 0.22); }},
      {"Conga", 24000, 2, 2, 0, conga},
      {"Conga slap", 32000, 2, 2, 0, conga_slap},
  };
  std::vector<Sound> kit;
  for (int pad = 0; pad < 16; ++pad) {
    const Spec& spec = kSpecs[pad];
    Sound sound{spec.name, spec.choke, {}};
    for (int l = 0; l < spec.layers; ++l) {
      // Three layers: soft (ghost notes), medium, hard; two: soft, hard.
      const double v = spec.layers == 3 ? (l == 0 ? 0.3 : l == 1 ? 0.62 : 0.95) : (l == 0 ? 0.42 : 0.92);
      Layer layer{spec.layers == 3 ? (l == 0 ? 0.4 : l == 1 ? 0.75 : 1.0) : (l == 0 ? 0.6 : 1.0), {}};
      for (int t = 0; t < spec.takes; ++t) {
        Rng jitter(static_cast<uint32_t>(pad * 1000 + l * 10 + t + 1));
        Hit hit{v, jitter.next(), jitter.next(), jitter.next(), static_cast<uint32_t>(pad * 7919 + l * 131 + t * 17 + 3)};
        layer.takes.push_back({spec.rate, spec.sound(spec.rate, hit)});
      }
      sound.layers.push_back(std::move(layer));
    }
    kit.push_back(std::move(sound));
  }
  return kit;
}

// The kit as an .xmpkit file: drum-kit JSON (packages/core/src/drum-kits.ts).
inline std::string number_text(float value) {
  char text[32];
  std::snprintf(text, sizeof text, "%.4f", static_cast<double>(value));
  std::string s = text;
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  if (s == "-0" || s.empty()) s = "0";
  return s;
}
inline std::string to_json(const std::vector<Sound>& kit) {
  std::string out = std::string("{\"name\":\"") + kName + "\",\"samples\":[";
  const auto pcm = [&](const std::vector<float>& values) {
    out += '[';
    for (std::size_t i = 0; i < values.size(); ++i) {
      if (i) out += ',';
      out += number_text(values[i]);
    }
    out += ']';
  };
  for (std::size_t p = 0; p < kit.size(); ++p) {
    const Sound& s = kit[p];
    const Take& own = s.layers.back().takes.front();
    if (p) out += ',';
    out += "{\"name\":\"" + s.name + "\",\"sampleRate\":" + std::to_string(own.rate) + ",\"pcm\":";
    pcm(own.pcm);
    if (s.choke) out += ",\"choke\":" + std::to_string(s.choke);
    out += ",\"layers\":[";
    for (std::size_t l = 0; l < s.layers.size(); ++l) {
      if (l) out += ',';
      out += "{\"upTo\":" + number_text(static_cast<float>(s.layers[l].up_to)) + ",\"takes\":[";
      for (std::size_t t = 0; t < s.layers[l].takes.size(); ++t) {
        if (t) out += ',';
        out += "{\"sampleRate\":" + std::to_string(s.layers[l].takes[t].rate) + ",\"pcm\":";
        pcm(s.layers[l].takes[t].pcm);
        out += '}';
      }
      out += "]}";
    }
    out += "]}";
  }
  out += "]}\n";
  return out;
}

}  // namespace xmp::kits::velvet
