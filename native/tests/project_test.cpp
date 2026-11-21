// XMP's C++ project model (xmp/project.hpp) built natively with strict
// warnings: opening, migrating and refusing small projects. Parity with the
// TypeScript is tests/parity/project-parity.test.ts.
#include "xmp/portable.hpp"
#include "xmp/project.hpp"

#include <cstdio>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
// A minimal version 1 project: 16 pads on one sample, one track, one scene.
xmp::Str legacy(const char* track_name = "Drums", const char* extra = "") {
  xmp::Str pads;
  for (int i = 0; i < 16; ++i) {
    if (i) pads += ",";
    pads += xmp::Str("{\"id\":\"pad-") + xmp::int_text(i) + "\",\"name\":\"P\",\"sampleId\":\"s\"}";
  }
  return xmp::Str("{\"format\":\"xmp-project\",\"version\":1,\"id\":\"p\",\"name\":\"Test\",\"bpm\":120,\"swing\":0,") +
         "\"master\":0.5,\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0,0.5]}]," +
         "\"tracks\":[{\"id\":\"drums\",\"name\":\"" + track_name + "\",\"muted\":false,\"volume\":0.8,\"clips\":[{\"id\":\"c\"," +
         "\"name\":\"C\",\"length\":16,\"steps\":[{\"step\":0,\"pad\":0,\"velocity\":1,\"probability\":1}]}]}]," +
         "\"scenes\":[{\"id\":\"a\",\"name\":\"A\",\"clips\":{\"drums\":\"c\"}}]" + extra + "}";
}
}  // namespace

int main() {
  using namespace xmp;
  auto r = project::open(legacy());
  check(r.ok && r.migrated, "a version 1 project opens and is migrated");
  check(project::detail::num(r.project, "version") == 8 && project::detail::num(r.project, "seed") == 0 &&
            r.project.get("parameters") && r.project.members()[11].key == "seed",
        "migrated to version 7 with seed and parameters in place");
  const Str text = json::stringify(r.project);
  auto again = project::open(text);
  check(again.ok && !again.migrated && json::stringify(again.project) == text, "the canonical form reopens unchanged");

  check(!project::open(legacy("", "")).ok, "an empty track name is refused");
  auto unknown = project::open(legacy("Drums", ",\"extra\":1"));
  check(!unknown.ok && unknown.error.starts_with("Could not open project: "), "an unknown key is refused");
  Str bad = legacy();
  // Point the scene at a clip that does not exist.
  auto at = strstr(bad.c_str(), "\"drums\":\"c\"}");
  Str broken = bad.slice(0, static_cast<size_t>(at - bad.c_str())) + "\"drums\":\"missing\"}" +
               bad.slice(static_cast<size_t>(at - bad.c_str()) + 12, bad.size());
  auto missing = project::open(broken);
  check(!missing.ok && missing.error == "Could not open project: Scene references a missing track or clip",
        "XMP's own check names the problem");
  check(project::open("{\"version\":9}").error ==
            "Could not open project: Unsupported project version 9; use a compatible XMP release. Current edits are unchanged.",
        "unsupported version");
  Str deep;
  for (int i = 0; i < 33; ++i) deep += "[";
  for (int i = 0; i < 33; ++i) deep += "]";
  check(project::open(deep).error == "Project structure exceeds import budget", "preflight refuses deep nesting");
  check(schema::is_parameter_id(Str("track.t1.machine.xmp.subtractive.v1.cutoff")) &&
            schema::is_parameter_id(Str("return.1.insert.verb.wet")) && !schema::is_parameter_id(Str("track.t1.foo")) &&
            !schema::is_parameter_id(Str("track.t1.machine.xmp.v0.cutoff")),
        "parameter IDs");
  // The Live's split save (live_session.cpp): the whole song once, then edits
  // as the song without its audio, opened against the whole song's samples.
  {
    Str whole, error;
    Vec<Str> hashes;
    check(portable::save_song(r.project, whole, error, true, &hashes) && hashes.size() == 1, "the whole song saves");
    const auto base = portable::open(whole);
    portable::Library library;
    for (const auto& s : project::detail::list(base.project, "samples")) {
      portable::Library::Asset asset;
      asset.rate = project::detail::num(s, "sampleRate");
      for (const auto& v : project::detail::list(s, "pcm")) asset.pcm.push(v.as_number());
      check(portable::hash_sample(asset.rate, asset.pcm, asset.hash, error) && asset.hash == hashes[0],
            "a sample's hash is the one the save reports");
      library.assets.push(xmp::move(asset));
    }
    json::Value edited = base.project;
    edited.set("name", json::Value::of(Str("Edited")));
    Str edits;
    Vec<Str> later;
    check(portable::save_song(edited, edits, error, false, &later) && later.size() == 1 && later[0] == hashes[0] &&
              edits.size() < whole.size(),
          "an edit saves without the audio, naming the same sample");
    const auto opened = portable::open(edits.data(), edits.size(), &library);
    check(opened.ok && project::detail::str(opened.project, "name") == "Edited" &&
              json::stringify(project::detail::at(opened.project, "samples")) ==
                  json::stringify(project::detail::at(base.project, "samples")),
          "the edits open against the whole song's samples");
    check(!portable::open(edits.data(), edits.size()).ok, "the edits alone do not open");
  }
  if (failures) return 1;
  std::printf("project model: open, migrate, canonical form and refusals ok\n");
  return 0;
}
