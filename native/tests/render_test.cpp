// Rendering an XMP project in C++ (xmp/render.hpp, xmp/files.hpp) built natively
// with strict warnings: a scene to a WAV, and a MIDI file that reads back.
// Parity with the TypeScript is tests/parity/render-parity.test.ts and tests/parity/files-parity.test.ts.
#include "xmp/render.hpp"

#include <cstdio>

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
  using namespace xmp;
  using json::Value;
  Str pads;
  for (int i = 0; i < 16; ++i) {
    if (i) pads += ",";
    pads += Str("{\"id\":\"pad-") + int_text(i) + "\",\"name\":\"P\",\"sampleId\":\"s\"}";
  }
  // One pad: a 0.5 click; a kick on beats 1 and 3 of a 16-step clip at 120 BPM.
  const Str text =
      Str("{\"format\":\"xmp-project\",\"version\":6,\"id\":\"p\",\"name\":\"T\",\"bpm\":120,\"swing\":0,\"master\":1,") +
      "\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0.5,0.25]}]," +
      "\"tracks\":[{\"id\":\"drums\",\"name\":\"Drums\",\"muted\":false,\"volume\":0.5,\"clips\":[{\"id\":\"c\",\"name\":\"C\"," +
      "\"length\":16,\"steps\":[{\"step\":0,\"pad\":0,\"velocity\":1,\"probability\":1},{\"step\":8,\"pad\":0,\"velocity\":1," +
      "\"probability\":1}]}]}],\"scenes\":[{\"id\":\"a\",\"name\":\"A\",\"clips\":{\"drums\":\"c\"}}],\"seed\":0," +
      "\"parameterVersion\":1,\"parameters\":[{\"id\":\"master.gain\",\"base\":1}]}";
  const auto opened = project::open(text);
  check(opened.ok, "project opens");
  Str error;
  Vec<float> pcm;
  check(render::render_plan_scene(opened.project, "a", pcm, error), "the pad-sampler renderer runs");
  // Beat 3 is step 8: one second in at 120 BPM.
  check(pcm.size() >= 96000 && pcm[0] == 0.25f && pcm[48000] == 0.25f && pcm[48001] == 0.125f && pcm[2] == 0,
        "two clicks on beats 1 and 3, at the track's gain (0.5 x 0.5 effect x 2 x 0.5)");
  files::Bytes wav;
  check(render::render_project_scene(opened.project, "a", wav, error) && wav.size() > 44 && memcmp(wav.begin(), "RIFF", 4) == 0,
        "a scene as a WAV");
  files::Sample back;
  check(files::decode_sample_wav(wav.begin(), static_cast<size_t>(wav.size()), back, error) && back.rate == 48000 &&
            fabs(back.pcm[48000] - 0.25f) < 1e-4f,
        "the WAV reads back");
  files::MidiDocument d;
  double steps = 0;
  check(files::exchange_plan(opened.project, "scene", "a", d, steps, error) && d.notes.size() == 2 && steps == 16 &&
            d.notes[1].tick == 1920 && d.notes[0].note == 36,
        "a MIDI plan: two notes on pad 1's note (36), the second on beat 3");
  files::Bytes midi;
  files::MidiDocument read;
  check(files::encode_midi(d, midi, error) && files::decode_midi(midi.begin(), static_cast<size_t>(midi.size()), read, error) &&
            read.notes.size() == 2 && read.tempos[0].micros == 500000,
        "the MIDI file reads back at 120 BPM");
  if (failures) return 1;
  std::printf("rendering: pad sampler, WAV and MIDI files ok\n");
  return 0;
}
