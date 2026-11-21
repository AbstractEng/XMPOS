// XMP's instrument engine (xmp/rack.hpp) built natively: the same header the
// browser runs as WebAssembly, checked here with the system compiler so it
// stays ready for the device. Browser parity is tests/engine-parity.test.ts.
#include "xmp/rack.hpp"

#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
using namespace xmp::rack;

double peak(const Rack& r, int frames) {
  double p = 0;
  for (int i = 0; i < frames; ++i) p = std::fmax(p, std::fabs(r.left[i]));
  return p;
}

// Two tracks (a sampler with a choked pair of pads, a saw synth) and a MIDI track routed to the synth.
void configure(Rack& r, std::vector<float>& tone) {
  r.stage_begin(3, 4);
  for (int i = 0; i < 3; ++i) {
    Track* t = r.stage_track(i);
    t->uid = i;
    t->key = i + 1;
    t->gain = 0.8;
  }
  r.stage_track(0)->kind = sampler;
  r.stage_track(1)->kind = subtractive;
  r.stage_track(1)->patch = Patch{saw, 0.005, 0.12, 0.45, 0.12, 750};
  Track* m = r.stage_track(2);
  m->kind = midi;
  m->base_midi = m->midi_machine = true;
  m->route = 1;
  for (int p = 0; p < 4; ++p) {
    float* pcm = r.stage_pad(p, static_cast<uint32_t>(tone.size()), 48000, p == 1 ? loop : one_shot, 60,
                             p >= 2 ? 1 : 0);
    for (std::size_t i = 0; i < tone.size(); ++i) pcm[i] = tone[i];
  }
  r.stage_delay(0, 0, 0, 0);
  r.stage_master(1);
  r.stage_mixer(0, 120);
  r.commit();
}
}  // namespace

int main() {
  std::vector<float> tone(4800);
  for (std::size_t i = 0; i < tone.size(); ++i)
    tone[i] = static_cast<float>(0.5 * std::sin(2 * kPi * 220 * static_cast<double>(i) / 48000));
  auto rack = std::make_unique<Rack>(48000);
  Rack& r = *rack;
  configure(r, tone);

  check(r.note_on(1, 0, 0, 60, 1, 0) == 1, "sampler note plays");
  r.process(256);
  check(peak(r, 256) > 0.3, "sampler is audible");
  check(r.active() == 1, "one voice");

  // Pads 3 and 4 share choke group 1: the second fades the first out within 5 ms.
  r.note_on(2, 2, 0, 60, 1, 0);
  r.note_on(3, 3, 0, 60, 1, 0);
  for (int i = 0; i < 4; ++i) r.process(128);
  check(r.active() == 2, "choked pad released, the other plays");

  // A gated synth note releases after its gate and goes silent.
  r.panic();
  r.process(512);
  check(r.active() == 0, "panic silences every voice");
  check(r.note_on(4, 0, 1, 57, 0.9, 2400) == 1, "synth note plays");
  r.process(1024);
  check(peak(r, 1024) > 0.05, "synth is audible");
  for (int i = 0; i < 40; ++i) r.process(256);
  check(r.active() == 0, "gated synth note released and finished");

  // The MIDI track plays the synth and reports its notes.
  r.midi_count = 0;
  check(r.note_on(5, 0, 2, 64, 0.5, 480) == 1, "routed MIDI note plays");
  check(r.midi_count == 1 && r.midi[0].kind == 1 && r.midi[0].note == 64, "MIDI note-on reported");
  for (int i = 0; i < 20; ++i) r.process(256);
  check(r.midi_count == 2 && r.midi[1].kind == 0, "MIDI note-off reported after the gate");

  // The voice pool is bounded: the 33rd looping note is refused, not allocated.
  for (int i = 0; i < 10; ++i) r.process(256);  // the synth's 120 ms release tail
  check(r.active() == 0, "routed note finished its release");
  for (int i = 0; i < 33; ++i) r.note_on(100 + i, 1, 0, 60, 0.2, 0);
  check(r.refused == 1 && r.active() == 32, "voice pool refuses past 32 voices");

  // Output never leaves [-1, 1], even with every voice stacked.
  r.process(4096);
  check(peak(r, 4096) <= 1, "output is limited to full scale");

  {
    // A multi-sampled pad (project format 8): two velocity layers, the hard one
    // with two round-robin takes, each a constant level that names it.
    auto layered = std::make_unique<Rack>(48000);
    Rack& l = *layered;
    const auto stage = [&](float own_level, bool layers) {
      l.stage_begin(1, 1);
      Track* t = l.stage_track(0);
      t->uid = 0, t->key = 1, t->gain = 1, t->kind = sampler;
      float* own = l.stage_pad(0, 64, 48000, one_shot, 60, 0);
      for (int i = 0; i < 64; ++i) own[i] = own_level;
      const float levels[3] = {0.1f, 0.5f, 0.7f};
      for (int k = 0; layers && k < 3; ++k) {
        float* take = l.stage_pad_take(0, k == 0 ? 0 : 1, k == 0 ? 0 : k - 1, 64, 48000, k == 0 ? 0.5 : 1);
        check(take != nullptr, "layer take staged");
        for (int i = 0; take && i < 64; ++i) take[i] = levels[k];
      }
      if (layers) check(l.stage_pad_take(0, 3, 0, 64, 48000, 1) == nullptr, "layers are staged in order");
      l.stage_delay(0, 0, 0, 0);
      l.stage_master(1);
      l.stage_mixer(0, 120);
      l.commit();
    };
    stage(0.9f, true);
    const auto play = [&](double id, double velocity) {
      l.note_on(id, 0, 0, 60, velocity, 0);
      l.process(16);
      const double level = l.left[8];
      l.panic();
      l.process(512);
      return level;
    };
    const double soft = play(1, 0.25), hard1 = play(2, 1), hard2 = play(3, 1), hard3 = play(4, 1);
    check(soft > 0 && hard1 > soft * 3, "velocity picks the layer");
    check(std::fabs(hard1 / hard2 - 0.5 / 0.7) < 0.01, "the layer's takes play in turn");
    check(std::fabs(hard3 - hard1) < 1e-9, "the takes rotate");
    // Restaging frees the layers nothing plays; a playing take keeps sounding.
    l.note_on(5, 0, 0, 60, 1, 0);
    stage(0.2f, false);
    l.process(16);
    check(l.active() == 1 && l.left[4] > 0.3, "a playing take keeps sounding after a restage");
    l.process(512);
    l.note_on(6, 0, 0, 60, 1, 0);
    l.process(16);
    check(std::fabs(l.left[8] - 0.2) < 0.01, "a pad without layers plays its own sound");
  }

  if (failures) return 1;
  std::printf("rack: sampler, choke, layers and takes, synth gate, MIDI routing, voice budget and limits OK\n");
  return 0;
}
