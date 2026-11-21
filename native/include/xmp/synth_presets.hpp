#pragma once
// The subtractive synth's presets: the same list, in the same order, as the
// browser's (packages/core/src/instrument-schema.ts synthPresets), as the
// exact decimals a project stores. Four pages of eight; the first page is the
// original eight, which use only the first six controls.
// tests/synth-presets.test.ts checks this list against the browser's.

namespace xmp::synth {

struct Preset {
  const char* name;
  const char* oscillator;
  double attack, decay, sustain, release, cutoff;
  // The later controls (rack.hpp Patch); `extended` presets store them all.
  bool extended = false;
  double resonance = 0, env_amount = 0, env_decay = 0.3, detune = 0, glide = 0;
};

constexpr int kPresets = 32, kPresetsPerPage = 16, kPresetPages = kPresets / kPresetsPerPage;
inline const char* preset_page_name(int page) {
  static const char* names[kPresetPages] = {"Classic · Pop & rock", "Electronic & dance · House & acid"};
  return page >= 0 && page < kPresetPages ? names[page] : "";
}

inline const Preset* presets() {
  static const Preset list[kPresets] = {
      // Classic
      {"Warm bass", "saw", 0.005, 0.12, 0.45, 0.12, 750},
      {"Soft key", "sine", 0.01, 0.4, 0.25, 0.3, 5000},
      {"Bright lead", "square", 0.01, 0.18, 0.6, 0.15, 4500},
      {"Pluck", "saw", 0.002, 0.18, 0, 0.1, 2400},
      {"Soft pad", "saw", 0.4, 0.8, 0.7, 0.9, 1400},
      {"Sub bass", "sine", 0.005, 0.3, 0.8, 0.1, 400},
      {"Organ", "square", 0.005, 0.05, 0.9, 0.08, 2200},
      {"Brass", "saw", 0.06, 0.25, 0.7, 0.2, 2800},
      // Pop & rock
      {"Pop piano", "square", 0.002, 0.9, 0.15, 0.35, 1800, true, 0.1, 2.5, 0.35, 4, 0},
      {"Electric piano", "sine", 0.003, 0.8, 0.3, 0.4, 3000, true, 0, 1.5, 0.15, 3, 0},
      {"Rock organ", "square", 0.004, 0.06, 0.95, 0.06, 3200, true, 0.15, 0.8, 0.08, 6, 0},
      {"Power lead", "saw", 0.008, 0.3, 0.75, 0.18, 2600, true, 0.25, 1.5, 0.4, 10, 0.03},
      {"Synth strings", "saw", 0.35, 0.9, 0.8, 0.9, 2200, true, 0.05, 0.5, 1.2, 14, 0},
      {"Picked bass", "saw", 0.002, 0.35, 0.3, 0.12, 600, true, 0.2, 2.5, 0.12, 0, 0},
      {"Pop pluck", "saw", 0.002, 0.25, 0, 0.2, 1200, true, 0.35, 3, 0.18, 8, 0},
      {"Ballad pad", "saw", 0.6, 1.2, 0.75, 1, 1100, true, 0.1, 0.6, 1.5, 12, 0},
      // Electronic & dance
      {"Supersaw", "saw", 0.01, 0.4, 0.85, 0.4, 5000, true, 0.1, 0.5, 0.5, 22, 0},
      {"Trance pluck", "saw", 0.002, 0.2, 0, 0.25, 900, true, 0.45, 3.5, 0.15, 16, 0},
      {"Reese bass", "saw", 0.01, 0.5, 0.9, 0.15, 700, true, 0.3, 0.3, 0.6, 35, 0},
      {"Big room lead", "square", 0.005, 0.3, 0.8, 0.2, 3500, true, 0.3, 1.2, 0.3, 18, 0},
      {"Chip lead", "square", 0.001, 0.1, 0.85, 0.05, 12000, true, 0, 0, 0.3, 0, 0.04},
      {"Synthwave bass", "saw", 0.003, 0.25, 0.55, 0.1, 500, true, 0.35, 2.5, 0.2, 8, 0},
      {"Arp synth", "square", 0.002, 0.15, 0.25, 0.12, 1500, true, 0.5, 2.5, 0.12, 5, 0},
      {"Dark pad", "saw", 0.8, 1.5, 0.8, 1, 600, true, 0.35, 1, 1.8, 18, 0},
      // House & acid
      {"Acid bass", "saw", 0.002, 0.3, 0.6, 0.06, 280, true, 0.85, 3.8, 0.22, 0, 0.08},
      {"Acid square", "square", 0.002, 0.3, 0.6, 0.06, 320, true, 0.8, 3.5, 0.25, 0, 0.08},
      {"Acid squelch", "saw", 0.002, 0.2, 0.4, 0.06, 200, true, 0.93, 4.8, 0.15, 0, 0.06},
      {"Organ bass", "square", 0.002, 0.2, 0.3, 0.08, 900, true, 0.2, 1.5, 0.12, 0, 0},
      {"Chord stab", "saw", 0.003, 0.25, 0.1, 0.18, 1100, true, 0.35, 2.8, 0.2, 12, 0},
      {"Deep bass", "saw", 0.004, 0.4, 0.6, 0.12, 320, true, 0.15, 1, 0.25, 0, 0},
      {"Rave stab", "square", 0.002, 0.3, 0.2, 0.25, 1800, true, 0.4, 2, 0.3, 25, 0},
      {"Filter pad", "saw", 0.5, 1.2, 0.8, 1, 500, true, 0.6, 2.5, 1.6, 10, 0},
  };
  return list;
}

}  // namespace xmp::synth
