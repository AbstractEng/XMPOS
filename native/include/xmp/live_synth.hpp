#pragma once
// The device session's synth patches: the browser's "xmp.subtractive" presets
// (instrument-schema.ts synthPresets), in the same order. The synth itself is
// XMP's engine (rack.hpp), through live_engine.hpp.
#include <algorithm>
#include <array>
#include <cstdint>
#include <string_view>

#include "xmp/synth_presets.hpp"

namespace xmp::live {

struct SynthPatch {
  enum Oscillator : std::uint8_t { sine, saw, square };
  const char* name = "Warm bass";
  Oscillator oscillator = saw;
  float attack = 0.005f, decay = 0.12f, sustain = 0.45f, release = 0.12f, cutoff = 750;
  float resonance = 0, env_amount = 0, env_decay = 0.3f, detune = 0, glide = 0;
};

// The browser's presets (synth_presets.hpp, instrument-schema.ts synthPresets), in the same order.
constexpr int kSynthPresets = synth::kPresets;
inline const std::array<SynthPatch, kSynthPresets>& synth_presets() {
  static const std::array<SynthPatch, kSynthPresets> presets = [] {
    std::array<SynthPatch, kSynthPresets> out{};
    for (int i = 0; i < kSynthPresets; ++i) {
      const synth::Preset& p = synth::presets()[i];
      SynthPatch& s = out[static_cast<std::size_t>(i)];
      const std::string_view osc = p.oscillator;
      s.name = p.name;
      s.oscillator = osc == "sine" ? SynthPatch::sine : osc == "square" ? SynthPatch::square : SynthPatch::saw;
      s.attack = static_cast<float>(p.attack), s.decay = static_cast<float>(p.decay);
      s.sustain = static_cast<float>(p.sustain), s.release = static_cast<float>(p.release);
      s.cutoff = static_cast<float>(p.cutoff), s.resonance = static_cast<float>(p.resonance);
      s.env_amount = static_cast<float>(p.env_amount), s.env_decay = static_cast<float>(p.env_decay);
      s.detune = static_cast<float>(p.detune), s.glide = static_cast<float>(p.glide);
    }
    return out;
  }();
  return presets;
}

}  // namespace xmp::live
