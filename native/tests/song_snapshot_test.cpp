#include "xmp/song_snapshot.hpp"
#include "xmp/live_project_import.hpp"
#include "xmp/project_edit.hpp"
#include <cstdio>

int main() {
  using namespace xmp;
  int failed = 0;
  auto check = [&](bool ok, const char* why) { if (!ok) { printf("FAIL %s\n", why); ++failed; } };
  live::SampleBank bank;
  for (int p = 0; p < 16; ++p) bank.set_single(p, {0.25f, -0.125f, 0});
  std::array<const live::SampleBank*, live::kTracks> banks{};
  banks.fill(&bank);
  auto old = live::default_song();
  old.tracks[0].kit_velocity[0][0] = 100;
  old.tracks[1].note[4] = 36, old.tracks[1].velocity[4] = 90;
  json::Value project;
  Str error, whole, referenced;
  check(live::import_pattern_project(old, banks, project, error), "legacy pattern imports with its actual sample banks");
  check(project::detail::list(project, "samples").size() == 17, "shared banks are retained once with silence");
  auto edited = edit::toggle_step(project, "drums", "clip-0", 2, 7);
  check(edited.ok, "imported project is editable by the shared core");
  check(portable::save_song(project, whole, error) && portable::save_song(edited.project, referenced, error, false), "both save modes use portable songs");
  const Str changes = Str(song_snapshot::kEditsHead) + song_snapshot::identity(whole.data(), whole.size()) + "\n" + referenced;
  const auto loaded = song_snapshot::open(whole.data(), whole.size(), changes.data(), changes.size());
  check(loaded.ok && loaded.edits_applied && json::stringify(loaded.project) == json::stringify(edited.project), "Live/emulator autosave opens the latest full project");
  const Str stale = Str(song_snapshot::kEditsHead) + "different-base\n" + referenced;
  const auto ignored = song_snapshot::open(whole.data(), whole.size(), stale.data(), stale.size());
  check(ignored.ok && ignored.stale_edits && !ignored.edits_applied, "old autosave is not applied to a new base");
  const Str bad = Str(song_snapshot::kEditsHead) + song_snapshot::identity(whole.data(), whole.size()) + "\n{}";
  check(!song_snapshot::open(whole.data(), whole.size(), bad.data(), bad.size()).ok, "invalid matching autosave cannot silently revert to the old base");
  const Str future("xmp-edits 2 unknown\n{}");
  check(!song_snapshot::open(whole.data(), whole.size(), future.data(), future.size()).ok, "future journal protocol is refused");
  bank.pads[0].layers[0].takes[0].resize(480001);
  check(!live::import_pattern_project(old, banks, project, error), "oversized legacy samples are refused rather than truncated");
  std::vector<std::string> errors;
  live::parse_song("xmp-live-song=3\n", &errors);
  check(!errors.empty(), "future legacy version is refused");
  return failed ? 1 : 0;
}
