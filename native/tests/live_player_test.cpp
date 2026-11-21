// The Live's real-time project player (xmp/live_player.hpp), built natively:
// a project played through ProjectSound and ProjectPlayer in 256-frame blocks
// must sound exactly as render.hpp renders it offline, sample for sample.
#include "xmp/live_player.hpp"
#include "xmp/rt_audit.hpp"
#include "xmp/project_edit.hpp"
#include "xmp/wave_export.hpp"
#include "xmp/files.hpp"

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
  // A kit track and a synth track, two scenes chained into a song, a tempo change.
  const Str text =
      Str("{\"format\":\"xmp-project\",\"version\":6,\"id\":\"p\",\"name\":\"T\",\"bpm\":120,\"swing\":0.1,\"master\":0.6,") +
      "\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0.5,0.25,-0.25,0.1]}]," +
      "\"tracks\":[{\"id\":\"drums\",\"name\":\"Drums\",\"muted\":false,\"volume\":0.8,\"clips\":[" +
      "{\"id\":\"c1\",\"name\":\"A\",\"length\":16,\"steps\":[{\"step\":0,\"pad\":0,\"velocity\":1,\"probability\":1}," +
      "{\"step\":4,\"pad\":0,\"velocity\":0.7,\"probability\":1},{\"step\":10,\"pad\":0,\"velocity\":0.9,\"probability\":1}]}]}," +
      "{\"id\":\"keys\",\"name\":\"Keys\",\"muted\":false,\"volume\":0.6,\"machine\":{\"id\":\"xmp.subtractive\",\"base\":\"audio\"," +
      "\"version\":1,\"state\":{\"name\":\"Warm bass\",\"oscillator\":\"saw\",\"attack\":0.005,\"decay\":0.12,\"sustain\":0.45," +
      "\"release\":0.12,\"cutoff\":750}},\"clips\":[{\"id\":\"k1\",\"name\":\"K\",\"length\":16,\"steps\":[{\"step\":2,\"pad\":0," +
      "\"velocity\":0.8,\"probability\":1,\"note\":40,\"duration\":3},{\"step\":9,\"pad\":3,\"velocity\":0.5,\"probability\":1}]}]}]," +
      "\"scenes\":[{\"id\":\"a\",\"name\":\"A\",\"clips\":{\"drums\":\"c1\",\"keys\":\"k1\"}},{\"id\":\"b\",\"name\":\"B\",\"clips\":{\"drums\":\"c1\"}}]," +
      "\"seed\":0,\"parameterVersion\":1,\"parameters\":[]," +
      "\"performance\":{\"version\":1,\"chain\":[{\"id\":\"o1\",\"sceneId\":\"a\",\"repeats\":2},{\"id\":\"o2\",\"sceneId\":\"b\",\"repeats\":1}]," +
      "\"end\":\"stop\",\"position\":{\"occurrenceId\":\"o1\",\"offset\":21},\"macros\":[],\"mutes\":{},\"solos\":[],\"events\":[{\"id\":\"e1\",\"at\":20,\"kind\":\"mute\",\"trackId\":\"keys\"," +
      "\"value\":true}],\"delay\":{\"steps\":1,\"feedback\":0.3,\"wet\":0.2,\"sends\":{\"drums\":0.5}}}," +
      // A tempo-synced delay on the drums: it follows the effect clock.
      "\"mix\":{\"version\":1,\"tracks\":{\"drums\":{\"pan\":0.4,\"sends\":[0,0],\"inserts\":[{\"id\":\"echo\",\"kind\":\"delay\"," +
      "\"bypass\":false,\"params\":{\"time\":0.125,\"feedback\":0.4,\"wet\":0.5},\"sync\":{\"division\":0.5,\"sequence\":[1]," +
      "\"phase\":\"transport\",\"loss\":\"hold-last-tempo\"}}]}," +
      // A filter stepping through a sequence on the transport's position: it follows the effect clock.
      "\"keys\":{\"pan\":0.6,\"sends\":[0,0],\"inserts\":[{\"id\":\"sweep\",\"kind\":\"filter\",\"bypass\":false," +
      "\"params\":{\"cutoff\":0.6},\"sync\":{\"division\":1,\"sequence\":[0.2,0.9,0.4],\"phase\":\"transport\"," +
      "\"loss\":\"hold-last-tempo\"}}]}},\"returns\":[[],[]],\"tempos\":[{\"step\":32,\"bpm\":90}]}}";
  const auto opened = project::open(text);
  check(opened.ok, "project opens");
  Str error;
  // A song from the top, the same song resumed from its saved position (step 21
  // of its first scene: the effect clock starts there), and a scene.
  static const char* kModes[] = {"song", "resume", "scene"};
  for (const char* which : kModes) {
    const bool song = Str(which) != "scene", resume = Str(which) == "resume";
    const char* mode = song ? "song" : "scene";
    const double steps = song ? 64 : 24, tail = 0.5;
    render::Performance offline;
    check(render::render_performance(opened.project, "a", mode, steps, tail, resume, offline, error), "offline render");
    live::ProjectSound sound;
    check(sound.prepare(opened.project, error), "sound prepared");
    live::ProjectPlayer player;
    check(player.start(opened.project, sound, "a", song, 0, steps, error, resume), "player starts");
    const int32_t total = offline.left.size();
    Vec<float> left, right;
    float l[256], r[256];
    for (int32_t at = 0; at < total; at += 256) {
      // The main thread fills 100 ms ahead of the audio clock, as the session does.
      check(player.fill(static_cast<uint64_t>(at) + 4800, error), "player fills");
      const uint32_t n = static_cast<uint32_t>(total - at < 256 ? total - at : 256);
      for (uint32_t i = 0; i < n; ++i) l[i] = r[i] = 0;
      sound.process(l, r, n, static_cast<uint64_t>(at));
      for (uint32_t i = 0; i < n; ++i) left.push(l[i]), right.push(r[i]);
    }
    bool same = left.size() == offline.left.size();
    int32_t first = -1;
    for (int32_t i = 0; same && i < left.size(); ++i)
      if (left[i] != offline.left[i] || right[i] != offline.right[i]) same = false, first = i;
    if (!same) std::printf("  %s: first difference at frame %d\n", which, first);
    float peak = 0;
    for (const float v : left) peak = fmaxf(peak, fabsf(v));
    check(same && peak > 0.01f, song ? "the song plays sample for sample as rendered offline"
                                     : "the scene plays sample for sample as rendered offline");
    check(sound.dropped() == 0, "no command dropped");
  }
  // A prepared sound update must preserve sustained synth voices, sampler
  // buffers and effect tails bit for bit, even after the retired rack is freed.
  {
    live::ProjectSound control, updated;
    live::ProjectPlayer a, b;
    check(control.prepare(opened.project,error) && updated.prepare(opened.project,error), "continuity prepare");
    check(a.start(opened.project,control,"a",false,0,0,error) && b.start(opened.project,updated,"a",false,0,0,error), "continuity start");
    float al[256], ar[256], bl[256], br[256];
    bool same = true;
    for (uint64_t frame = 0; frame < 120000; frame += 256) {
      a.fill(frame+4800,error), b.fill(frame+4800,error);
      if (frame == 17920) check(updated.reload(opened.project,error,frame+113,true), "stage seamless update");
      for (int i=0;i<256;++i) al[i]=ar[i]=bl[i]=br[i]=0;
      control.process(al,ar,256,frame);
      audit::begin(); updated.process(bl,br,256,frame); const auto counts=audit::end();
      check(counts.allocations==0 && counts.frees==0 && counts.locks==0 && counts.files==0 && counts.network==0,"live update callback is realtime safe");
      updated.collect();
      for (int i=0;i<256;++i) if (al[i]!=bl[i] || ar[i]!=br[i]) same=false;
    }
    check(same,"live update keeps sounding voices and effect tails sample for sample");
  }
  {
    Value base=opened.project;
    base.get("tracks")->items()[0].set("muted",Value::of(true));
    Vec<double> pcm,points;pcm.push(0.25),pcm.push(-0.25);points.push(0),points.push(1),points.push(2);
    const auto chopped=edit::chop_sample_to_kit(base,"drums","Chops",48000,pcm,points);
    check(chopped.ok,"prepare changed sampler graph");
    live::ProjectSound control,updated;live::ProjectPlayer a,b;
    check(control.prepare(base,error)&&updated.prepare(base,error),"changed graph prepare");
    check(a.start(base,control,"a",false,0,0,error)&&b.start(base,updated,"a",false,0,0,error),"changed graph start");
    float al[256],ar[256],bl[256],br[256];bool same=true;
    for(uint64_t frame=0;frame<96000;frame+=256) {
      a.fill(frame+4800,error),b.fill(frame+4800,error);
      if(frame==17920) check(updated.reload(chopped.project,error,frame+113,true),"a chopped sampler updates while music plays");
      for(int i=0;i<256;++i) al[i]=ar[i]=bl[i]=br[i]=0;
      control.process(al,ar,256,frame);audit::begin();updated.process(bl,br,256,frame);const auto counts=audit::end();
      check(counts.allocations==0&&counts.frees==0&&counts.locks==0&&counts.files==0&&counts.network==0,"changed graph swaps without realtime allocation or I/O");
      updated.collect();for(int i=0;i<256;++i) if(al[i]!=bl[i]||ar[i]!=br[i]) same=false;
    }
    check(same,"chopping preserves another track's sustained voices and effects exactly");
  }
  {
    live::ProjectSound sound;
    check(sound.prepare(opened.project, error), "temporary loop audio prepares");
    live::sample::LoopTake loop(256);
    check(loop.queue(0, 256, 0, 0), "temporary loop queues outside callback");
    float input[256], left[256]{}, right[256]{}; uint8_t valid[256];
    std::fill_n(input, 256, .01f); std::fill_n(valid, 256, 1);
    audit::begin();
    sound.process(left, right, 256, 0, &loop, input, valid);
    sound.process(left, right, 256, 256, &loop, input, valid);
    const auto counts = audit::end();
    check(counts.allocations == 0 && counts.frees == 0 && counts.locks == 0 && counts.files == 0 && counts.network == 0,
          "temporary loop capture and mixer playback allocate nothing and perform no locks or I/O");
  }
  // Native streaming WAV and Wasm use this exact bounded renderer.
  {
    files::WaveExport stream;
    check(stream.begin(opened.project, true, "a", .5), "stream export starts");
    render::Performance reference;
    check(render::render_performance(opened.project, "a", "song", 64, .5, false, reference, error), "stream reference render");
    Vec<Vec<float>> channels; channels.push(reference.left); channels.push(reference.right);
    files::Bytes expected; check(files::encode_wav(channels, 48000, expected, error), "stream reference WAV");
    int at = 0, bytes = 0; bool same = true;
    while ((bytes = stream.next()) > 0) {
      check(bytes <= files::WaveExport::kBlock * 4, "stream chunks remain bounded");
      for (int i = 0; i < bytes; ++i) if (at + i >= expected.size() || stream.bytes[i] != expected[at + i]) same = false;
      at += bytes;
    }
    check(bytes == 0 && same && at == expected.size(), "native streamed WAV exactly matches finite song with swing tempo changes and clock-synced effects");
  }
  // Stop cancels what is already scheduled: the synth note queued for step 9
  // (frame 54000) never starts, and every voice is released.
  {
    live::ProjectSound sound;
    live::ProjectPlayer player;
    check(sound.prepare(opened.project, error) && player.start(opened.project, sound, "a", false, 0, 0, error), "start again");
    float l[256], r[256];
    const uint64_t stop = 52992;  // a block boundary just before step 9
    for (uint64_t at = 0; at < stop; at += 256) {
      player.fill(at + 4800, error);
      for (int i = 0; i < 256; ++i) l[i] = r[i] = 0;
      sound.process(l, r, 256, at);
    }
    player.stop(stop);
    float tail = 0;
    uint32_t after_note = 1;
    for (uint64_t at = stop; at < 144000; at += 256) {
      for (int i = 0; i < 256; ++i) l[i] = r[i] = 0;
      sound.process(l, r, 256, at);
      if (at == 55040) after_note = sound.active_voices();
      if (at >= 144000 - 12000)
        for (const float v : l) tail = fmaxf(tail, fabsf(v));
    }
    check(after_note == 0 && !player.playing(), "stop cancels the queued note and releases every voice");
    check(tail < 1e-3f, "the effect tail dies away");
  }
  if (failures) return 1;
  std::printf("live player: song and scene play as rendered offline; stop releases every voice\n");
  return 0;
}
