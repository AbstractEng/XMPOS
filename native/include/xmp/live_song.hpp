#pragma once
// Song model for the device session: eight tracks, each a drum kit (XMP's own,
// 808-style or 909-style, all synthesized), the subtractive synth (one of the
// browser's three patches) or a sampler (the owner's WAVs from the stick, with
// velocity layers), with a 16-step pattern, a level and a mute. Legacy bounded
// text is imported once; all session saves now use the shared portable song.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "xmp/live_sequencer.hpp"
#include "xmp/live_synth.hpp"

namespace xmp::live {

constexpr int kTracks = 8;
// The song format's synth sounds: the first eight presets (the Classic page).
constexpr int kSongSynthPresets = 8;

struct Track {
  enum Kind : std::uint8_t { kit, synth, sampler };
  Kind kind = kit;
  int preset = 0;     // kit: style (0 XMP, 1 808, 2 909); synth: index into synth_presets() (0-7, the Classic page)
  float cutoff = 0;   // synth: 0 = the preset's own cutoff
  float level = 0.8f; // 0..1
  bool mute = false;
  // kit and sampler: velocity[pad][step]; synth: note[step] (0 = rest) and velocity[step].
  std::array<std::array<std::uint8_t, kSteps>, 16> kit_velocity{};
  std::array<std::uint8_t, kSteps> note{}, velocity{};
  int root = 36;  // synth: note of pad 1; pads are chromatic from here

  int pad_note(int pad) const { return std::clamp(root + pad, 1, 127); }
  // Kit and sampler tracks play pads; synth tracks play notes.
  bool pads() const { return kind != synth; }
  bool has_steps() const {
    for (int s = 0; s < kSteps; ++s) {
      if (kind == synth && note[static_cast<std::size_t>(s)]) return true;
      if (pads())
        for (const auto& row : kit_velocity)
          if (row[static_cast<std::size_t>(s)]) return true;
    }
    return false;
  }
};

struct Song {
  int bpm = 120;
  std::array<Track, kTracks> tracks{};
};

inline const char* track_label(const Track& t) {
  if (t.kind == Track::kit) {
    static constexpr std::array<const char*, 3> kits{"KIT", "808", "909"};
    return kits[static_cast<std::size_t>(std::clamp(t.preset, 0, 2))];
  }
  if (t.kind == Track::sampler) return "SMPL";
  static constexpr std::array<const char*, kSongSynthPresets> names{"BASS", "KEYS", "LEAD", "PLCK",
                                                                    "PAD",  "SUB",  "ORGN", "BRAS"};
  return names[static_cast<std::size_t>(std::clamp(t.preset, 0, kSongSynthPresets - 1))];
}

// How many sounds knob 3 cycles through on a track of this kind.
inline int preset_count(Track::Kind kind) { return kind == Track::synth ? kSongSynthPresets : kind == Track::kit ? 3 : 1; }

// Tracks 1 and 5 are kits (XMP's and the 808-style); 2-4 and 6-8 the three synth patches.
inline Song default_song() {
  Song song;
  for (int i = 0; i < kTracks; ++i) {
    auto& t = song.tracks[static_cast<std::size_t>(i)];
    const int slot = i % 4;
    t.kind = slot == 0 ? Track::kit : Track::synth;
    t.preset = slot == 0 ? (i == 4 ? 1 : 0) : slot - 1;
    t.root = slot == 1 ? 36 : slot == 2 ? 48 : 60;
  }
  return song;
}

inline SynthPatch track_patch(const Track& t) {
  auto patch = synth_presets()[static_cast<std::size_t>(std::clamp(t.preset, 0, kSongSynthPresets - 1))];
  if (t.cutoff >= 30 && t.cutoff <= 16000) patch.cutoff = t.cutoff;
  return patch;
}

// ---- text form: xmp/pattern.txt ----
namespace song_detail {
inline std::string hex_row(const std::array<std::uint8_t, kSteps>& row) {
  std::string out;
  char cell[4];
  for (int s = 0; s < kSteps; ++s) {
    std::snprintf(cell, sizeof cell, "%02X", row[static_cast<std::size_t>(s)]);
    out += cell;
    if (s + 1 < kSteps) out += ' ';
  }
  return out;
}
inline bool parse_row(const std::string& value, std::array<std::uint8_t, kSteps>& row) {
  if (value.size() != kSteps * 3 - 1) return false;
  std::array<std::uint8_t, kSteps> out{};
  for (int s = 0; s < kSteps; ++s) {
    const auto cell = value.substr(static_cast<std::size_t>(s) * 3, 2);
    if (cell.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) return false;
    if (s + 1 < kSteps && value[static_cast<std::size_t>(s) * 3 + 2] != ' ') return false;
    const auto v = std::stoul(cell, nullptr, 16);
    if (v > 127) return false;
    out[static_cast<std::size_t>(s)] = static_cast<std::uint8_t>(v);
  }
  row = out;
  return true;
}
inline bool small_number(const std::string& text, int lo, int hi, int& out) {
  if (text.empty() || text.size() > 5 || text.find_first_not_of("0123456789") != std::string::npos) return false;
  const int v = std::stoi(text);
  if (v < lo || v > hi) return false;
  out = v;
  return true;
}
}  // namespace song_detail

inline std::string song_text(const Song& song) {
  using song_detail::hex_row;
  std::string out = "# XMP song for the MPC Live: tempo, then 8 tracks (kit, synth or sampler), 16 steps each\n";
  out += "xmp-live-song=2\nbpm=" + std::to_string(song.bpm) + "\n";
  for (int i = 0; i < kTracks; ++i) {
    const auto& t = song.tracks[static_cast<std::size_t>(i)];
    const std::string n = std::to_string(i + 1);
    char head[160];
    std::snprintf(head, sizeof head, "track%s=%s preset=%d root=%d level=%d mute=%d cutoff=%d\n", n.c_str(),
                  t.kind == Track::kit ? "kit" : t.kind == Track::synth ? "synth" : "sampler", t.preset, t.root,
                  static_cast<int>(std::lround(t.level * 100)), t.mute ? 1 : 0, static_cast<int>(t.cutoff));
    out += head;
    if (t.pads()) {
      for (int pad = 0; pad < 16; ++pad) {
        const auto& row = t.kit_velocity[static_cast<std::size_t>(pad)];
        if (std::any_of(row.begin(), row.end(), [](std::uint8_t v) { return v != 0; }))
          out += "track" + n + ".pad" + std::to_string(pad + 1) + "=" + hex_row(row) + "\n";
      }
    } else if (t.has_steps()) {
      out += "track" + n + ".notes=" + hex_row(t.note) + "\n";
      out += "track" + n + ".velocity=" + hex_row(t.velocity) + "\n";
    }
  }
  return out;
}

inline Song parse_song(const std::string& text, std::vector<std::string>* errors = nullptr) {
  using song_detail::parse_row;
  using song_detail::small_number;
  Song song = default_song();
  auto fail = [&](const std::string& what) {
    if (errors) errors->push_back(what);
  };
  if (text.size() > 32768) {
    fail("song file is larger than 32 KiB");
    return song;
  }
  std::size_t start = 0;
  int lines = 0;
  while (start < text.size() && lines < 256) {
    const auto end = std::min(text.find('\n', start), text.size());
    std::string line = text.substr(start, end - start);
    start = end + 1;
    ++lines;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    const auto eq = line.find('=');
    if (eq == std::string::npos) {
      fail("line without '='");
      continue;
    }
    const std::string key = line.substr(0, eq), value = line.substr(eq + 1);
    int n = 0;
    if (key == "xmp-live-song") {
      if (value != "1" && value != "2") fail("unsupported legacy song version");
      continue;
    }
    if (key == "bpm") {
      if (small_number(value, kMinBpm, kMaxBpm, n)) song.bpm = n;
      else fail("bpm out of range");
      continue;
    }
    // Phase 1 files: "padN=" rows belong to track 1's kit.
    if (key.rfind("pad", 0) == 0 && small_number(key.substr(3), 1, 16, n)) {
      if (!parse_row(value, song.tracks[0].kit_velocity[static_cast<std::size_t>(n - 1)]))
        fail("bad step values in " + key);
      continue;
    }
    if (key.rfind("track", 0) != 0) {
      fail("unknown key " + key);
      continue;
    }
    const auto dot = key.find('.');
    if (!small_number(key.substr(5, dot == std::string::npos ? std::string::npos : dot - 5), 1, kTracks, n)) {
      fail("bad track number in " + key);
      continue;
    }
    auto& t = song.tracks[static_cast<std::size_t>(n - 1)];
    if (dot == std::string::npos) {
      // "kit|synth|sampler preset=P root=R level=L mute=M cutoff=C"
      std::size_t at = 0;
      const auto kind_end = value.find(' ');
      const auto kind = value.substr(0, kind_end);
      if (kind == "kit") t.kind = Track::kit;
      else if (kind == "synth") t.kind = Track::synth;
      else if (kind == "sampler") t.kind = Track::sampler;
      else fail("track kind must be kit, synth or sampler");
      at = kind_end == std::string::npos ? value.size() : kind_end + 1;
      while (at < value.size()) {
        const auto next = std::min(value.find(' ', at), value.size());
        const auto field = value.substr(at, next - at);
        at = next + 1;
        const auto fe = field.find('=');
        if (fe == std::string::npos) continue;
        const auto fk = field.substr(0, fe), fv = field.substr(fe + 1);
        int v = 0;
        if (fk == "preset" && small_number(fv, 0, kSongSynthPresets - 1, v)) t.preset = v;
        else if (fk == "root" && small_number(fv, 1, 111, v)) t.root = v;
        else if (fk == "level" && small_number(fv, 0, 100, v)) t.level = static_cast<float>(v) / 100;
        else if (fk == "mute" && small_number(fv, 0, 1, v)) t.mute = v == 1;
        else if (fk == "cutoff" && small_number(fv, 0, 16000, v)) t.cutoff = static_cast<float>(v);
        else fail("bad track field " + field);
      }
      continue;
    }
    const auto field = key.substr(dot + 1);
    int pad = 0;
    if (field.rfind("pad", 0) == 0 && small_number(field.substr(3), 1, 16, pad)) {
      if (!parse_row(value, t.kit_velocity[static_cast<std::size_t>(pad - 1)])) fail("bad step values in " + key);
    } else if (field == "notes") {
      if (!parse_row(value, t.note)) fail("bad notes in " + key);
    } else if (field == "velocity") {
      if (!parse_row(value, t.velocity)) fail("bad velocities in " + key);
    } else {
      fail("unknown key " + key);
    }
  }
  if (start < text.size()) fail("legacy song exceeds line budget");
  return song;
}

}  // namespace xmp::live
