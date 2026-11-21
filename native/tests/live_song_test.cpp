// Phase 2 device session: the eight-track song model and the synth's timing and
// bounds in the session's engine (live_engine.hpp). (The synth's sound is compared with the browser synth in
// tests/live-synth-parity.test.ts.)
#include "xmp/live_song.hpp"
#include "xmp/live_engine.hpp"
#include "xmp/live_synth.hpp"

#include <memory>

#include <cmath>
#include <cstdio>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
}  // namespace

int main() {
  using namespace xmp::live;

  // Default song: kits on 1 and 5, the three synth patches on 2-4 and 6-8.
  {
    const auto song = default_song();
    check(song.tracks[0].kind == Track::kit && song.tracks[4].kind == Track::kit, "kits on tracks 1 and 5");
    check(song.tracks[1].kind == Track::synth && std::string(track_label(song.tracks[1])) == "BASS" &&
              std::string(track_label(song.tracks[2])) == "KEYS" && std::string(track_label(song.tracks[3])) == "LEAD",
          "synth patches on 2-4");
    check(song.tracks[1].pad_note(0) == 36 && song.tracks[3].pad_note(15) == 75, "chromatic pads from each root");
  }

  // Round trip with every field, and the phase 1 pattern files.
  {
    auto song = default_song();
    song.bpm = 131;
    song.tracks[0].kit_velocity[2][5] = 0x40;
    song.tracks[1].note[0] = 36;
    song.tracks[1].velocity[0] = 100;
    song.tracks[1].level = 0.55f;
    song.tracks[1].mute = true;
    song.tracks[1].cutoff = 1200;
    song.tracks[6].note[15] = 72;
    song.tracks[6].velocity[15] = 90;
    std::vector<std::string> errors;
    const auto back = parse_song(song_text(song), &errors);
    check(errors.empty(), "round trip has no errors");
    check(back.bpm == 131 && back.tracks[0].kit_velocity[2][5] == 0x40 && back.tracks[1].note[0] == 36 &&
              back.tracks[1].velocity[0] == 100 && std::fabs(back.tracks[1].level - 0.55f) < 1e-6f &&
              back.tracks[1].mute && back.tracks[1].cutoff == 1200 && back.tracks[6].note[15] == 72,
          "round trip keeps every field");
    const auto legacy = parse_song("bpm=97\npad8=64 64 64 64 64 64 64 64 64 64 64 64 64 64 64 64\n", &errors);
    check(legacy.bpm == 97 && legacy.tracks[0].kit_velocity[7][15] == 0x64 && legacy.tracks[1].kind == Track::synth,
          "phase 1 pattern files load into track 1");
    errors.clear();
    const auto bad = parse_song(
        "track9=kit\ntrack2=organ\ntrack2.notes=FF 00\ntrack3=synth preset=8 level=300\ntrack1.pad17=00\nrm -rf\n",
        &errors);
    check(errors.size() >= 6 && bad.tracks[1].kind == Track::synth && bad.tracks[2].preset == 1, "bad lines rejected");
    check(parse_song(std::string(40000, 'x'), &errors).bpm == 120, "oversized song rejected");
  }

  // Eight synth presets, each with a label; knob 3 cycles them on synth tracks.
  {
    check(synth_presets().size() == 32 && preset_count(Track::synth) == 8 && preset_count(Track::kit) == 3 &&
              preset_count(Track::sampler) == 1,
          "preset counts");
    Track t;
    t.kind = Track::synth;
    const char* labels[] = {"BASS", "KEYS", "LEAD", "PLCK", "PAD", "SUB", "ORGN", "BRAS"};
    for (int i = 0; i < 8; ++i) {
      t.preset = i;
      check(std::string(track_label(t)) == labels[i], "synth preset label");
      check(std::string(track_patch(t).name) == synth_presets()[static_cast<std::size_t>(i)].name, "track patch");
    }
    std::vector<std::string> errors;
    const auto song = parse_song("track2=synth preset=7 root=48\n", &errors);
    check(errors.empty() && song.tracks[1].preset == 7 && std::string(track_label(song.tracks[1])) == "BRAS",
          "preset 7 loads");
  }

  // Synth (XMP's engine through live_engine.hpp): a note queued for frame 1000
  // starts exactly there and ends after its release.
  SampleBank kit;
  kit.set_single(0, std::vector<float>(16, 0.0f));
  std::array<const SampleBank*, kBanks> banks{};
  banks[0] = &kit;
  std::array<LiveEngine::TrackSound, kLiveTracks> sounds{};
  sounds[0] = {true, synth_presets()[0]};
  {
    auto synth = std::make_unique<LiveEngine>(48000);
    check(synth->prepare(banks, sounds), "engine prepared");
    check(synth->play_note(1000, 0, 48, 1.0f, 2400), "queue a note");
    std::vector<float> left(16000), right(16000);
    for (std::uint32_t at = 0; at < left.size(); at += 256)
      synth->process(&left[at], &right[at], std::min<std::uint32_t>(256, left.size() - at), at);
    float before = 0, during = 0, after = 0;
    for (std::size_t i = 0; i < 1000; ++i) before = std::max(before, std::fabs(left[i]));
    for (std::size_t i = 1001; i < 3400; ++i) during = std::max(during, std::fabs(left[i]));
    for (std::size_t i = 1000 + 2400 + 5760 + 8; i < left.size(); ++i) after = std::max(after, std::fabs(left[i]));
    check(before == 0, "silent before its frame");
    check(during > 0.01f, "sounds after its frame");
    check(after == 0, "silent once the release has finished");
    check(left == right, "mono into both channels");
    check(synth->active_voices() == 0, "voice freed");
  }
  // Bounded: more notes than voices are refused, never allocated.
  {
    auto synth = std::make_unique<LiveEngine>(48000);
    synth->prepare(banks, sounds);
    for (int n = 0; n < 80; ++n) synth->play_note(0, 0, 30 + n, 0.5f, 0);
    std::vector<float> l(256), r(256);
    synth->process(l.data(), r.data(), 256, 0);
    check(synth->active_voices() == kEngineVoices, "voice pool is fixed");
    check(synth->refused() == 80 - kEngineVoices, "extra notes refused");
    synth->release_synths();
    std::vector<float> l2(48000), r2(48000);
    synth->process(l2.data(), r2.data(), 48000, 256);
    check(synth->active_voices() == 0, "releasing the synths frees every voice");
  }

  if (failures) return 1;
  std::printf("live song: tracks, file format and synth timing ok\n");
  return 0;
}
