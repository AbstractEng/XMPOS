// Device session kits and sampler track: the synthesized 808/909-style kits,
// bounded WAV decoding, the session's sound through XMP's engine (frame-exact
// pads with velocity layers, round-robin takes and choke groups, the synth), the stick folder loader, and the song
// text for the new track types.
#include "xmp/live_engine.hpp"
#include "xmp/live_kits.hpp"
#include "xmp/live_sample_folder.hpp"
#include "xmp/live_sampler.hpp"
#include "xmp/live_song.hpp"
#include "xmp/live_sample.hpp"
#include "xmp/live_loop.hpp"
#include "xmp/rt_audit.hpp"
#include "xmp/live_wav.hpp"

#include <sys/stat.h>
#include <unistd.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}

std::vector<std::uint8_t> wav(std::uint16_t format, std::uint16_t channels, std::uint32_t rate, std::uint16_t bits,
                              const std::vector<std::uint8_t>& body, bool extensible = false) {
  std::vector<std::uint8_t> out;
  auto put = [&](std::uint32_t v, int n) {
    for (int i = 0; i < n; ++i) out.push_back(static_cast<std::uint8_t>(v >> (8 * i)));
  };
  auto tag = [&](const char* t) { out.insert(out.end(), t, t + 4); };
  const std::uint32_t fmt_size = extensible ? 40 : 16;
  tag("RIFF");
  put(4 + 8 + fmt_size + 8 + static_cast<std::uint32_t>(body.size()), 4);
  tag("WAVE");
  tag("fmt ");
  put(fmt_size, 4);
  put(extensible ? 0xFFFE : format, 2);
  put(channels, 2);
  put(rate, 4);
  put(rate * channels * bits / 8, 4);
  put(channels * bits / 8, 2);
  put(bits, 2);
  if (extensible) {
    put(22, 2);
    put(bits, 2);
    put(0, 4);
    put(format, 2);
    for (int i = 0; i < 14; ++i) out.push_back(0);
  }
  tag("data");
  put(static_cast<std::uint32_t>(body.size()), 4);
  out.insert(out.end(), body.begin(), body.end());
  return out;
}

std::vector<std::uint8_t> pcm16(const std::vector<int>& values) {
  std::vector<std::uint8_t> b;
  for (int v : values) {
    b.push_back(static_cast<std::uint8_t>(v & 0xFF));
    b.push_back(static_cast<std::uint8_t>((v >> 8) & 0xFF));
  }
  return b;
}

void write_file(const std::string& path, const std::vector<std::uint8_t>& data) {
  std::FILE* f = std::fopen(path.c_str(), "wb");
  std::fwrite(data.data(), 1, data.size(), f);
  std::fclose(f);
}

// A constant-valued sound, so the output tells which take played.
std::vector<float> dc(float value, std::size_t frames) { return std::vector<float>(frames, value); }
}  // namespace

int main() {
  using namespace xmp::live;
  constexpr std::uint32_t kRate = 48000;

  // ---- kits: synthesized, normalized, bounded, distinct ----
  {
    for (int style = 0; style < kKitStyles; ++style)
      for (int pad = 0; pad < 16; ++pad) {
        const auto s = make_kit_sound(style, pad, kRate);
        float peak = 0;
        bool finite = true;
        for (float v : s) {
          peak = std::max(peak, std::fabs(v));
          finite = finite && std::isfinite(v);
        }
        check(!s.empty() && s.size() <= 2 * kRate, "kit sound at most 2 s");
        check(finite && peak > 0.99f && peak <= 1.0001f, "kit sound normalized and finite");
        check(std::fabs(s.back()) < 1e-3f, "kit sound ends silent");
      }
    const auto a = make_808(0, kRate), b = make_909(0, kRate);
    check(a.size() != b.size() || a[1000] != b[1000], "808 and 909 kicks differ");
    check(std::string(kit_label(1)) == "808" && std::string(kit_label(2)) == "909", "kit labels");
    check(kit_choke(1, 2) == kit_choke(1, 3) && kit_choke(1, 2) != 0 && kit_choke(1, 0) == 0, "hats choke");
  }

  // ---- WAV decoding: formats, bounds, refusals ----
  {
    auto r = decode_wav(wav(1, 1, kRate, 16, pcm16({0, 16384, -32768, 32767})), kRate);
    check(r.error.empty() && r.samples.size() == 4, "16-bit mono decodes");
    check(std::fabs(r.samples[1] - 0.5f) < 1e-4f && r.samples[2] == -1.0f, "16-bit values");
    r = decode_wav(wav(1, 2, kRate, 16, pcm16({16384, -16384, 8192, 8192})), kRate);
    check(r.error.empty() && r.samples.size() == 2 && std::fabs(r.samples[0]) < 1e-6f &&
              std::fabs(r.samples[1] - 0.25f) < 1e-4f,
          "stereo mixes to mono");
    r = decode_wav(wav(1, 1, kRate, 24, {0x00, 0x00, 0x40, 0x00, 0x00, 0xC0}), kRate);
    check(r.error.empty() && std::fabs(r.samples[0] - 0.5f) < 1e-5f && std::fabs(r.samples[1] + 0.5f) < 1e-5f,
          "24-bit decodes");
    std::vector<std::uint8_t> f32(8);
    const float half = 0.5f, nan = std::nanf("");
    std::memcpy(f32.data(), &half, 4);
    std::memcpy(f32.data() + 4, &nan, 4);
    r = decode_wav(wav(3, 1, kRate, 32, f32, true), kRate);
    check(r.error.empty() && r.samples[0] == 0.5f && r.samples[1] == 0.0f, "extensible float, NaN silenced");
    r = decode_wav(wav(1, 1, 24000, 16, pcm16({0, 32767 / 2, 32767})), kRate);
    check(r.error.empty() && r.samples.size() == 5 && std::fabs(r.samples[1] - 0.25f) < 1e-3f, "resampled 24k->48k");
    check(!decode_wav(wav(2, 1, kRate, 16, pcm16({0})), kRate).error.empty(), "ADPCM refused");
    check(!decode_wav(wav(1, 6, kRate, 16, pcm16({0, 0, 0, 0, 0, 0})), kRate).error.empty(), "6 channels refused");
    check(!decode_wav(wav(1, 1, 4000, 16, pcm16({0})), kRate).error.empty(), "4 kHz refused");
    check(!decode_wav({'R', 'I', 'F', 'F'}, kRate).error.empty(), "short file refused");
    auto bad = wav(1, 1, kRate, 16, pcm16({1, 2, 3}));
    bad[16] = 0xFF, bad[17] = 0xFF, bad[18] = 0xFF, bad[19] = 0x7F;  // fmt chunk claims 2 GB
    check(!decode_wav(bad, kRate).error.empty(), "chunk past the end refused");
    // 31 s at 8 kHz: too long.
    check(!decode_wav(wav(1, 1, 8000, 8, std::vector<std::uint8_t>(8000 * 31, 128)), kRate).error.empty(),
          "longer than 30 s refused");
  }

  // ---- the session's sound: XMP's engine (live_engine.hpp over rack.hpp) ----
  // Exact start frame, levels, layers, round-robin, choke, bounded voices, the synth.
  {
    // An engine whose bank 0 is `bank0` (the other kits empty) and whose track 1 is a synth.
    auto engine_with = [&](const SampleBank* bank0, const SampleBank* bank1 = nullptr) {
      auto e = std::make_unique<LiveEngine>(kRate);
      std::array<const SampleBank*, kBanks> banks{};
      banks[0] = bank0;
      banks[1] = bank1;
      std::array<LiveEngine::TrackSound, kLiveTracks> sounds{};
      sounds[1] = {true, synth_presets()[1]};
      check(e->prepare(banks, sounds), "engine prepared");
      return e;
    };
    constexpr float kM = LiveEngine::kSamplerMaster;
    SampleBank bank;
    bank.set_single(0, dc(1.0f, 1000));
    auto s = engine_with(&bank);
    std::vector<float> l(512, 0), r(512, 0);
    check(s->play_pad(300, 0, 0, 0, 127, 1.0f), "pad queued");
    s->process(l.data(), r.data(), 256, 0);
    s->process(l.data() + 256, r.data() + 256, 256, 256);
    check(l[299] == 0 && std::fabs(l[300] - kM) < 1e-6f, "starts on its exact frame");
    check(std::fabs(r[400] - l[400]) < 1e-9f, "mono to both sides");

    // One layer: velocity scales the level (as the phase 1 kit did).
    auto s2 = engine_with(&bank);
    std::fill(l.begin(), l.end(), 0.0f);
    s2->play_pad(0, 0, 0, 0, 64, 0.5f);
    s2->process(l.data(), r.data(), 16, 0);
    check(std::fabs(l[5] - kM * 0.5f * 64 / 127) < 1e-6f, "single-layer velocity and level");

    // Three layers, two takes in the loudest: the layer follows velocity, the takes alternate.
    SampleBank layered;
    auto& pad = layered.pads[1];
    pad.layers.push_back({42, {dc(0.1f, 100)}});
    pad.layers.push_back({84, {dc(0.2f, 100)}});
    pad.layers.push_back({127, {dc(0.3f, 100), dc(0.4f, 100)}});
    auto s3 = engine_with(&layered);
    std::uint64_t at = 0;
    auto hit = [&](int velocity) {
      std::vector<float> a(200, 0), b(200, 0);
      s3->play_pad(at, 0, 0, 1, velocity, 1.0f);
      s3->process(a.data(), b.data(), 200, at);
      at += 200;
      return std::make_pair(static_cast<int>(s3->last_layer()), static_cast<int>(s3->last_take()));
    };
    check(hit(10) == std::make_pair(0, 0), "soft hit plays layer 1");
    check(hit(60) == std::make_pair(1, 0), "medium hit plays layer 2");
    check(hit(120) == std::make_pair(2, 0) && hit(127) == std::make_pair(2, 1) && hit(100) == std::make_pair(2, 0),
          "loud hits rotate through the takes");
    {
      std::vector<float> a(4, 0), b(4, 0);
      s3->play_pad(at, 0, 0, 1, 127, 1.0f);  // take 2 of the loudest layer
      s3->process(a.data(), b.data(), 4, at);
      check(std::fabs(a[1] - 0.4f * kM) < 1e-6f, "the chosen take sounds");
    }
    check(layer_for(pad, 42) == 0 && layer_for(pad, 43) == 1 && layer_for(pad, 127) == 2, "layer boundaries");
    check(velocity_gain(3, 127) == 1.0f && velocity_gain(3, 1) > 0.6f && velocity_gain(1, 127) == 1.0f,
          "multi-layer velocity scales gently");

    // Choke: the closed hat fades out the open hat (the engine's 5 ms).
    SampleBank hats;
    hats.set_single(2, dc(0.5f, 10000), 1);
    hats.set_single(3, dc(1.0f, 10000), 1);
    auto s4 = engine_with(&hats);
    std::vector<float> a(2000, 0), b(2000, 0);
    s4->play_pad(0, 0, 0, 3, 127, 1.0f);    // open hat
    s4->play_pad(500, 0, 0, 2, 127, 1.0f);  // closed hat
    for (std::uint32_t f = 0; f < 2000; f += 250) s4->process(a.data() + f, b.data() + f, 250, f);
    const auto fade = static_cast<std::size_t>(xmp::rack::kPanicSeconds * kRate);
    check(std::fabs(a[499] - kM) < 1e-6f, "open hat sounding");
    check(a[500 + fade / 2] > 0.5f * kM && a[500 + fade / 2] < 1.5f * kM, "open hat fading");
    check(std::fabs(a[500 + fade + 10] - 0.5f * kM) < 1e-6f, "open hat choked, closed hat alone");
    check(s4->active_voices() == 1, "choked voice freed");

    // Bounded: a fixed voice pool, extra notes are refused (never allocated).
    auto s5 = engine_with(&bank);
    for (int i = 0; i < 70; ++i) s5->play_pad(static_cast<std::uint64_t>(i), 0, 0, 0, 100, 1.0f);
    std::vector<float> c(128, 0), d(128, 0);
    s5->process(c.data(), d.data(), 128, 0);
    check(s5->active_voices() == kEngineVoices && s5->refused() == 70 - kEngineVoices, "voice pool bounded");
    check(!s5->play_pad(0, 0, 0, 16, 100, 1) && !s5->play_pad(0, 0, 0, 0, 0, 1) && !s5->play_pad(0, 8, 0, 0, 100, 1),
          "bad pad, velocity or track refused");
    check(s5->play_pad(0, 0, 0, 5, 100, 1), "an empty pad is silent, not an error");

    // Switching banks (kit style) while sounding: both sound.
    auto s6 = engine_with(&bank, &hats);
    s6->play_pad(0, 0, 0, 0, 127, 1);
    s6->process(c.data(), d.data(), 8, 0);
    s6->play_pad(8, 0, 1, 3, 127, 1);
    s6->process(c.data(), d.data(), 8, 8);
    check(s6->active_voices() == 2, "bank switch keeps sounding voices");

    // The synth on track 1: held until note off, then its release; the tone glides.
    auto s7 = engine_with(&bank);
    std::vector<float> e(48000, 0), f(48000, 0);
    s7->play_note(100, 1, 60, 0.5f, 0);
    s7->process(e.data(), f.data(), 4800, 0);
    float peak = 0;
    for (std::size_t i = 0; i < 4800; ++i) peak = std::max(peak, std::fabs(e[i]));
    check(e[99] == 0 && peak > 0.01f, "synth note starts on its frame");
    // The tone knob on the held note (preset 1's cutoff is 5 kHz): darker within its glide.
    auto energy = [&](std::size_t from, std::size_t n) {
      double sum = 0;
      for (std::size_t i = from; i < from + n; ++i) sum += static_cast<double>(e[i]) * e[i];
      return sum;
    };
    const double bright = energy(3800, 1000);
    s7->set_cutoff(1, 60);
    s7->process(e.data() + 4800, f.data() + 4800, 4800, 4800);
    check(energy(8600, 1000) < bright * 0.5, "the tone changes a sounding note");
    s7->note_off(1, 60);
    s7->process(e.data() + 9600, f.data() + 9600, 24000, 9600);
    check(s7->active_voices() == 0, "note off releases the synth note");
    // A track switched to synth plays its next note on the synth.
    auto s8 = engine_with(&bank);
    s8->set_sound(0, {true, synth_presets()[0]});
    s8->play_note(0, 0, 48, 0.5f, 480);
    s8->process(e.data(), f.data(), 4800, 0);
    float synth_peak = 0;
    for (std::size_t i = 0; i < 4800; ++i) synth_peak = std::max(synth_peak, std::fabs(e[i]));
    check(synth_peak > 0.01f, "type change applies to the next note");
    s8->release_synths();
    s8->process(e.data(), f.data(), 24000, 4800);
    check(s8->active_voices() == 0, "stop releases the synths");
  }

  // ---- the stick folder loader ----
  {
    char templ[] = "/tmp/xmp-sampler-test-XXXXXX";
    const std::string root = mkdtemp(templ);
    const auto one = wav(1, 1, kRate, 16, pcm16(std::vector<int>(480, 1000)));
    // Per-pad layout: pad 1 tagged layers with two takes in v2; pad 3 untagged
    // (each file a layer) and in choke group 1; a bad file is skipped.
    mkdir((root + "/01 kick").c_str(), 0700);
    write_file(root + "/01 kick/kick_v1.wav", one);
    write_file(root + "/01 kick/kick_v2_rr1.wav", one);
    write_file(root + "/01 kick/kick_v2_rr2.wav", one);
    write_file(root + "/01 kick/notes.txt", {'h', 'i'});
    mkdir((root + "/03 hat_c1").c_str(), 0700);
    write_file(root + "/03 hat_c1/a soft.wav", one);
    write_file(root + "/03 hat_c1/b hard.WAV", one);
    write_file(root + "/03 hat_c1/c broken.wav", {'R', 'I', 'F', 'F', 0, 0});
    mkdir((root + "/99 ignored").c_str(), 0700);
    SampleBank bank;
    std::size_t budget = kSampleBudgetFrames;
    auto loaded = load_sample_folder(root, kRate, bank, budget);
    check(loaded.pads == 2 && loaded.files == 5, "per-pad folders load");
    check(bank.pads[0].layers.size() == 2 && bank.pads[0].layers[1].takes.size() == 2, "tagged layers and takes");
    check(bank.pads[0].layers[0].top == 64 && bank.pads[0].layers[1].top == 127, "layers spread over velocity");
    check(bank.pads[2].layers.size() == 2 && bank.pads[2].choke == 1, "untagged layers, choke group");
    check(loaded.notes.size() == 1, "broken file reported");
    check(bank.pads[0].name == "kick" && bank.pads[2].name == "hat", "pad names from folders, tags removed");
    check(folder_detail::pad_name_from("16 half hat_c1") == "half hat" &&
              folder_detail::pad_name_from("kick_v2_rr1", false) == "kick" &&
              folder_detail::pad_name_from("conga_low_v1", false) == "conga low",
          "pad name tags");
    check(budget == kSampleBudgetFrames - 5 * 480, "budget reduced");

    // Budget: refuses what does not fit.
    SampleBank tight;
    std::size_t small = 700;
    loaded = load_sample_folder(root, kRate, tight, small);
    check(loaded.files == 1 && small == 220, "budget enforced");

    // Flat layout.
    const std::string flat = root + "/flat";
    mkdir(flat.c_str(), 0700);
    write_file(flat + "/b.wav", one);
    write_file(flat + "/a.wav", wav(1, 1, kRate, 16, pcm16(std::vector<int>(96, 1000))));
    SampleBank flat_bank;
    budget = kSampleBudgetFrames;
    loaded = load_sample_folder(flat, kRate, flat_bank, budget);
    check(loaded.pads == 2 && flat_bank.pads[0].layers[0].takes[0].size() == 96 && flat_bank.pads[0].name == "a",
          "flat files by name");
    std::system(("rm -rf '" + root + "'").c_str());
  }

  // ---- song text: kit styles and sampler tracks ----
  {
    auto song = default_song();
    check(song.tracks[4].kind == Track::kit && std::string(track_label(song.tracks[4])) == "808", "track 5 is 808");
    song.tracks[2].kind = Track::sampler;
    song.tracks[2].kit_velocity[3][5] = 90;
    song.tracks[0].preset = 2;
    std::vector<std::string> errors;
    const auto back = parse_song(song_text(song), &errors);
    check(errors.empty(), "song text parses");
    check(back.tracks[2].kind == Track::sampler && back.tracks[2].kit_velocity[3][5] == 90, "sampler steps round-trip");
    check(std::string(track_label(back.tracks[2])) == "SMPL" && std::string(track_label(back.tracks[0])) == "909",
          "labels");
    check(back.tracks[2].pads() && !back.tracks[1].pads(), "pad tracks");
  }

  {
    sample::Edit edit;
    const std::vector<float> pcm{0.1f, 0.2f, 0.3f, 0.4f, -0.1f, -0.2f, -0.3f, -0.4f};
    edit.end = 8, edit.slices = 4;
    check(sample::preview_chop(pcm, edit, 0) == std::vector<float>({0.1f,0.2f}), "first pad auditions only the first chop");
    check(sample::preview_chop(pcm, edit, 3) == std::vector<float>({-0.3f,-0.4f}), "last pad auditions only its chop");
    check(sample::preview_chop(pcm, edit, 4).empty(), "unused chop pads are silent");
    edit.chop_mode = 3, edit.markers = {0.125, 0.5}, edit.slices = 3;
    check(sample::preview_chop(pcm, edit, 1) == std::vector<float>({0.2f,0.3f,0.4f}), "manual markers define pad audio exactly");
  }
  {
    sample::InputRing<4> ring;
    check(ring.push(1) && ring.push(2) && ring.push(3) && ring.push(4) && !ring.push(5) && ring.overflowed(), "input ring refuses overwrite");
    float value = 0;
    check(ring.pop(value) && value == 1, "input ring retains unread audio");
    sample::LoopTake take(64);
    std::array<float,128> in{}, left{}, right{};
    std::array<uint8_t,128> valid{};
    for (int i=0;i<128;++i) in[i] = static_cast<float>(i)/128, valid[i]=1;
    check(take.queue(10,64,0,0), "loop queues without allocating");
    take.process(0,in.data(),valid.data(),128,left.data(),right.data(),1);
    check(take.state()==sample::LoopTake::State::looping && take.frames()==64, "loop records the exact musical duration");
    check(left[73]==0 && left[74]==in[10] && left[100]==in[36], "loop begins on the sample immediately after capture ends");
    check(sample::next_record_bar(17.5)==32 && sample::loop_frames(120)==384000 && sample::loop_frames(30)==1536000, "next-bar start and four-bar defaults cover the tempo range");
  }
  {
    sample::Recorder recorder;recorder.arm();
    std::array<float,256> input{};input.fill(0.5f);
    xmp::audit::begin();
    for(int block=0;block<1876;++block) recorder.feed(input.data(),256);
    const auto audit=xmp::audit::end();
    check(audit.allocations==0 && audit.frees==0 && audit.locks==0 && audit.files==0 && audit.network==0,"prepared threshold recorder allocates nothing while processing audio");
    check(recorder.state==sample::Recorder::State::done && recorder.pcm().size()==480000,"threshold recording ends at its fixed ten-second budget");
  }
  if (failures) return 1;
  std::printf("live sampler: all checks passed\n");
  return 0;
}
