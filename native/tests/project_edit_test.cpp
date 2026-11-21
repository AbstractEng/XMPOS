// XMP's C++ project edits (xmp/project_edit.hpp) built natively with strict
// warnings, and the typed view. Parity with the TypeScript is
// tests/parity/project-edit-parity.test.ts.
#include "xmp/project_edit.hpp"
#include "xmp/portable.hpp"

#include <cstdio>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
xmp::Str legacy() {
  xmp::Str pads;
  for (int i = 0; i < 16; ++i) {
    if (i) pads += ",";
    pads += xmp::Str("{\"id\":\"pad-") + xmp::int_text(i) + "\",\"name\":\"P\",\"sampleId\":\"s\"}";
  }
  return xmp::Str("{\"format\":\"xmp-project\",\"version\":1,\"id\":\"p\",\"name\":\"Test\",\"bpm\":120,\"swing\":0,") +
         "\"master\":0.5,\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0,0.5]}]," +
         "\"tracks\":[{\"id\":\"drums\",\"name\":\"Drums\",\"muted\":false,\"volume\":0.8,\"clips\":[{\"id\":\"c\"," +
         "\"name\":\"C\",\"length\":16,\"steps\":[]}]}],\"scenes\":[{\"id\":\"a\",\"name\":\"A\",\"clips\":{\"drums\":\"c\"}}]}";
}
}  // namespace

int main() {
  using namespace xmp;
  const auto opened = project::open(legacy());
  check(opened.ok, "project opens");
  auto e = edit::toggle_step(opened.project, "drums", "c", 3, 4);
  edit::view::Project view{e.project};
  check(e.ok && view.track(0).clip(0).step_count() == 1 && view.track(0).clip(0).step(0).pad() == 3 &&
            view.track(0).clip(0).step(0).step() == 4 && view.track(0).clip(0).step(0).velocity() == 0.8,
        "toggle a step on");
  check(edit::toggle_step(e.project, "drums", "c", 3, 4).ok &&
            edit::view::Project{edit::toggle_step(e.project, "drums", "c", 3, 4).project}.track(0).clip(0).step_count() == 0,
        "toggle it off");
  check(edit::toggle_step(e.project, "drums", "c", 3, 16).error == "Invalid step edit", "step beyond the clip refused");
  check(edit::delete_track(e.project, "drums").error == "Keep at least one track", "the last track stays");
  auto song = edit::expand_song(e.project);
  edit::view::Project s{song.project};
  check(song.ok && s.track_count() == 8 && s.scene_count() == 16 && s.track(1).id() == "track-1" &&
            s.scene(15).clip_for("track-7") != nullptr,
        "expand to eight tracks and sixteen scenes");
  auto copy = edit::duplicate_clip(e.project, "drums", "c");
  check(copy.ok && edit::view::Project{copy.project}.track(0).clip(1).id() == "copy-0" &&
            edit::view::Project{copy.project}.track(0).clip(1).name() == "C copy",
        "duplicate a clip");
  {
    auto hit = [](int step, int pad, double velocity, int note = -1) {
      json::Value v = json::Value::new_object();
      v.set("step", json::Value::of(static_cast<double>(step)));
      v.set("pad", json::Value::of(static_cast<double>(pad)));
      v.set("velocity", json::Value::of(velocity));
      v.set("probability", json::Value::of(1.0));
      if (note >= 0) v.set("note", json::Value::of(static_cast<double>(note))), v.set("duration", json::Value::of(1.0));
      return v;
    };
    Vec<json::Value> hits;
    hits.push(hit(4, 3, 1)), hits.push(hit(4, 3, 0.5)), hits.push(hit(5, 4, 0.8));
    auto take = edit::overdub_steps(e.project, "drums", "c", hits);
    check(take.ok && edit::view::Project{take.project}.track(0).clip(0).step_count() == 2 &&
              edit::view::Project{take.project}.track(0).clip(0).step(0).velocity() == 1,
          "overdub: repeated drum hits merge at the louder velocity and retain the rest of the take");
    const auto before = json::stringify(e.project);
    hits.push(hit(4, 3, 2));
    check(!edit::overdub_steps(e.project, "drums", "c", hits).ok && json::stringify(e.project) == before,
          "overdub: invalid duplicate input is rejected atomically");
    Vec<json::Value> chord;
    chord.push(hit(4, 3, 0.8, 48)), chord.push(hit(4, 3, 0.8, 50)), chord.push(hit(4, 3, 0.8, 48));
    auto pitched = edit::overdub_steps(e.project, "drums", "c", chord);
    check(pitched.ok && edit::view::Project{pitched.project}.track(0).clip(0).step_count() == 3,
          "overdub: different pitches get free pad cells; the same pitch plays once");
    Vec<json::Value> oversized;
    for (int i = 0; i < 1025; ++i) oversized.push(hit(4, 3, 0.8));
    check(!edit::overdub_steps(e.project, "drums", "c", oversized).ok,
          "overdub: the input pass is bounded even when every hit repeats");
  }
  auto resized = edit::resize_clip(e.project, "drums", "c", 48);
  check(resized.ok && edit::view::Project{resized.project}.track(0).clip(0).length() == 48, "custom 48-step length");
  auto deleted = edit::delete_track(song.project, "drums");
  check(deleted.ok && edit::view::Project{deleted.project}.find_track("drums") < 0 &&
            !edit::view::Project{deleted.project}.scene(0).clip_for("drums"),
        "delete a track and its scene slots");
  check(Str("🎛🎛").utf16_prefix(3).utf16_length() == 3 && Str("🎛🎛").utf16_prefix(3).code_points() == 2, "half a pair kept");
  {
    auto future = opened.project;
    const auto extensions = json::parse(
        R"json({"com.example.future":{"version":42,"data":{"tracks":{"drums":{"curve":[0,0.5,1],"extra":null}}}}})json");
    check(extensions.ok, "extension fixture parses");
    future.set("extensions", extensions.value);
    const auto changed = edit::toggle_step(future, "drums", "c", 2, 7);
    check(changed.ok && json::stringify(*changed.project.get("extensions")) == json::stringify(extensions.value),
          "native edits preserve unknown future feature data");
    Str song, error;
    check(changed.ok && portable::save_song(changed.project, song, error), "extended native project saves");
    const auto reopened = portable::open(song);
    check(reopened.ok && json::stringify(*reopened.project.get("extensions")) == json::stringify(extensions.value),
          "native save and reopen preserve unknown extensions");
    future.get("extensions")->get("com.example.future")->set("required", json::Value::of(true));
    json::Value checked;
    check(!project::canonical(future, checked, error) && error.starts_with("Required project extension com.example.future v42"),
          "unsupported required feature is refused explicitly");
  }
  {
    Vec<double> pcm,points;
    const float fixture[]={0.1f,0.2f,0.3f,0.4f,-0.1f,-0.2f,-0.3f,-0.4f};
    for(float value:fixture) pcm.push(value);
    const int bounds[]={0,2,4,6,8};for(int at:bounds) points.push(at);
    const auto kit=edit::chop_sample_to_kit(song.project,"drums","Fixture",48000,pcm,points);
    check(kit.ok,"native shared chop fixture commits");
    if(kit.ok) {
      const auto& tracks=project::detail::list(kit.project,"tracks");
      const auto& pads=project::detail::track_pads(kit.project,&tracks[0]);
      check(project::detail::num(project::detail::at(pads[2],"slice"),"start")==4 && project::detail::num(project::detail::at(pads[2],"slice"),"end")==6,"native shared chop fixture assigns exact pad bounds");
      check(project::detail::str(project::detail::at(pads[2],"playback"),"mode")=="one-shot" && project::detail::str(pads[4],"name")=="Empty","native shared chop fixture uses one shots and silent spare pads");
      for(int t=1;t<tracks.size();++t) check(json::stringify(tracks[t])==json::stringify(project::detail::list(song.project,"tracks")[t]),"chopping leaves other tracks intact");
      Str text,error;check(portable::save_song(kit.project,text,error),"native chopped kit saves");
      const auto reopened=portable::open(text);check(reopened.ok && json::stringify(reopened.project)==json::stringify(kit.project),"native chopped kit survives reopening");
      uint32_t frames=0;check(edit::sampler_plan(kit.project,4,frames,error) && frames==384000,"native four-bar plan");
      Vec<double> take;take.reserve(frames);for(uint32_t f=0;f<frames;++f) take.push(0);
      const auto loop=edit::record_loop(kit.project,"drums","a",7,"Live loop",take,4);
      check(loop.ok,"native timed loop commits to selected sample and clip");
      if(loop.ok) {
        const auto& clip=project::detail::list(project::detail::list(loop.project,"tracks")[0],"clips")[0];
        check(project::detail::num(clip,"length")==64 && project::detail::num(project::detail::list(clip,"steps")[0],"pad")==7,"native recorded clip has four bars and selected pad");
        check(portable::save_song(loop.project,text,error),"native live loop saves");
        check(portable::open(text).ok,"native live loop reopens");
      }
    }
  }
  if (failures) return 1;
  std::printf("project edits: steps, song, clips, tracks and the typed view ok\n");
  return 0;
}
