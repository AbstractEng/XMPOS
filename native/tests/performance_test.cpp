// Playing an XMP project in C++ (xmp/play.hpp, xmp/performance.hpp), built
// natively with strict warnings: a scene's notes, then a performance stepping
// through a bar. Parity with the TypeScript is tests/parity/play-parity.test.ts and
// tests/parity/performance-play-parity.test.ts.
#include "xmp/performance.hpp"

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
  // A kick on every beat of a 16-step clip.
  const Str text =
      Str("{\"format\":\"xmp-project\",\"version\":6,\"id\":\"p\",\"name\":\"T\",\"bpm\":120,\"swing\":0,\"master\":0.5,") +
      "\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0]}]," +
      "\"tracks\":[{\"id\":\"drums\",\"name\":\"Drums\",\"muted\":false,\"volume\":0.8,\"clips\":[{\"id\":\"c\",\"name\":\"C\"," +
      "\"length\":16,\"steps\":[{\"step\":0,\"pad\":0,\"velocity\":1,\"probability\":1},{\"step\":4,\"pad\":0,\"velocity\":1," +
      "\"probability\":1},{\"step\":8,\"pad\":0,\"velocity\":1,\"probability\":1},{\"step\":12,\"pad\":0,\"velocity\":1," +
      "\"probability\":1}]}]}],\"scenes\":[{\"id\":\"a\",\"name\":\"A\",\"clips\":{\"drums\":\"c\"}}],\"seed\":0," +
      "\"parameterVersion\":1,\"parameters\":[]}";
  const auto opened = project::open(text);
  check(opened.ok, "project opens");
  Vec<play::Note> notes;
  Str error;
  check(play::timeline(opened.project, "a", 0, 16, false, 0, 48000, notes, error) && notes.size() == 4 &&
            notes[1].position == 4 && notes[1].frame == 24000 && notes[0].id == "drums:c:legacy:step-0-0:0",
        "four kicks, half a second apart at 120 BPM");
  Vec<Value> events;
  check(play::events_at_step(opened.project, "a", 20, events, error) && events.size() == 1 &&
            project::detail::num(events[0], "velocity") == 0.8,
        "step 20 plays the second kick at the track's gain");
  play::Performance perf(opened.project);
  check(perf.ok() && perf.start(error), "the performance starts");
  int32_t heard = 0;
  for (int s = 0; s < 16; ++s) {
    Value w;
    check(play::performance_window(perf, s, false, 0, 48000, w, error), "a window");
    heard += project::detail::list(w, "notes").size();
  }
  check(heard == 4, "a bar of windows plays the four kicks");
  Value mute = Value::new_object();
  mute.set("id", Value::of("x")), mute.set("at", Value::of(16.0)), mute.set("kind", Value::of("mute"));
  mute.set("trackId", Value::of("drums")), mute.set("value", Value::of(true));
  check(perf.control(mute, error), "a live mute");
  Value w;
  check(play::performance_window(perf, 16, false, 0, 48000, w, error) && project::detail::list(w, "notes").size() == 0,
        "a muted track is silent");
  if (failures) return 1;
  std::printf("playing a project: timeline, step events, performance windows and live mutes ok\n");
  return 0;
}
