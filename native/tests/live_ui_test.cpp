// XMP's interface on the Live (xmp/live_ui.hpp), built natively: the button map,
// the Clips and Play views' actions, launches and live notes through the real
// project player (xmp/live_player.hpp), and the drawing on a memory canvas.
#include "xmp/chop.hpp"
#include "xmp/live_ui.hpp"

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "xmp/live_player.hpp"
#include "xmp/live_kits.hpp"

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
namespace ui = xmp::live::ui;
using ui::Action;

bool one(const std::vector<Action>& out, Action::Kind kind, int track = -2, int scene = -2) {
  return out.size() == 1 && out[0].kind == kind && (track == -2 || out[0].track == track) &&
         (scene == -2 || out[0].scene == scene);
}
}  // namespace

int main() {
  using namespace xmp;
  Str pads;
  for (int i = 0; i < 16; ++i) {
    if (i) pads += ",";
    pads += Str("{\"id\":\"pad-") + int_text(i) + "\",\"name\":\"Pad " + int_text(i) + "\",\"sampleId\":\"s\"}";
  }
  // A kit track with two clips and a synth track with one; two scenes, chained.
  const Str text =
      Str("{\"format\":\"xmp-project\",\"version\":6,\"id\":\"p\",\"name\":\"Night\",\"bpm\":120,\"swing\":0,\"master\":0.6,") +
      "\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0.5,0.25,-0.25,0.1,0.4,0.3,0.2,0.1]}]," +
      "\"tracks\":[{\"id\":\"drums\",\"name\":\"Drums\",\"muted\":false,\"volume\":0.8,\"clips\":[" +
      "{\"id\":\"c1\",\"name\":\"Groove\",\"length\":16,\"steps\":[{\"step\":0,\"pad\":0,\"velocity\":1,\"probability\":1}]}," +
      "{\"id\":\"c2\",\"name\":\"Fill\",\"length\":16,\"steps\":[{\"step\":2,\"pad\":1,\"velocity\":1,\"probability\":1}]}]}," +
      "{\"id\":\"keys\",\"name\":\"Keys\",\"muted\":false,\"volume\":0.6,\"machine\":{\"id\":\"xmp.subtractive\",\"base\":\"audio\"," +
      "\"version\":1,\"state\":{\"name\":\"Warm bass\",\"oscillator\":\"saw\",\"attack\":0.005,\"decay\":0.12,\"sustain\":0.45," +
      "\"release\":0.12,\"cutoff\":750}},\"clips\":[{\"id\":\"k1\",\"name\":\"Bass\",\"length\":32,\"steps\":[{\"step\":2,\"pad\":0," +
      "\"velocity\":0.8,\"probability\":1,\"note\":40,\"duration\":3}],\"sequence\":{\"version\":1,\"notes\":[{\"id\":\"n1\"," +
      "\"pad\":0,\"note\":45,\"position\":6,\"duration\":2,\"velocity\":0.7,\"probability\":1,\"microtiming\":0," +
      "\"condition\":\"always\"}],\"locks\":[],\"lanes\":[],\"modulations\":[]}}]}]," +
      "\"scenes\":[{\"id\":\"a\",\"name\":\"Verse\",\"clips\":{\"drums\":\"c1\",\"keys\":\"k1\"}},{\"id\":\"b\",\"name\":\"Break\",\"clips\":{\"drums\":\"c2\"}}]," +
      "\"seed\":0,\"parameterVersion\":1,\"parameters\":[]," +
      "\"performance\":{\"version\":1,\"chain\":[{\"id\":\"o1\",\"sceneId\":\"a\",\"repeats\":1}],\"end\":\"stop\",\"macros\":[]," +
      "\"mutes\":{},\"solos\":[],\"events\":[],\"delay\":{\"steps\":1,\"feedback\":0.3,\"wet\":0,\"sends\":{}}}}";
  const auto opened = project::open(text);
  check(opened.ok, "project opens");
  if (!opened.ok) std::printf("  %s\n", opened.error.c_str());

  // ---- the board ----
  const ui::Board b = ui::board_of(opened.project);
  {
    namespace E = live::edit;
    auto fresh = opened.project;
    fresh.remove("performance");
    const auto before = json::stringify(fresh);
    E::History history;
    std::string why;
    int at = 0;
    check(!E::song_insert(fresh, at, 99, history, why) && json::stringify(fresh) == before,
          "song: invalid scene leaves a fresh project unchanged");
    ui::Ui face;
    face.open(ui::View::song);
    std::vector<Action> actions;
    face.pad(12, 100, ui::board_of(fresh), ui::Now{}, actions);
    check(one(actions, Action::song_add, -1, 0), "song: physical pad 13 adds the first scene");
    if (!actions.empty()) {
      at = actions[0].step;
      check(E::song_insert(fresh, at, actions[0].scene, history, why),
            "song: adding a scene creates the missing performance in a fresh project");
    }
    check(E::chain_size(fresh) == 1 && project::open(json::stringify(fresh)).ok,
          "song: the first block saves as a valid project");
    const auto added = json::stringify(fresh);
    E::Place place;
    check(history.undo(fresh, place) && json::stringify(fresh) == before,
          "song: undo restores the fresh project without a performance");
    check(history.redo(fresh, place) && json::stringify(fresh) == added,
          "song: redo restores the first block");
  }
  {
    ui::Ui copier;
    ui::Now stopped;
    std::vector<Action> actions;
    copier.button(ui::Button::copy, true, b, stopped, actions);
    copier.button(ui::Button::copy, false, b, stopped, actions);
    copier.pad(9, 100, b, stopped, actions);
    check(actions.size() == 1 && actions[0].kind == Action::copy_clip && actions[0].track == 1 && actions[0].scene == 1 &&
              actions[0].source_track == 0 && actions[0].source_clip == "c1",
          "COPY sends the focused source to the chosen destination without launching it");
  }

  {
    namespace E = live::edit;
    auto doc = opened.project;
    E::History history;
    std::string why;
    // Start with a shared bank with distinct samples, then flatten a copy as a
    // keys Sampler. Choosing Kit must recover the original pad assignments.
    const auto shared = edit::apply_drum_kit(doc, live::drum_machine_kit(live::kDrumMachineKits[0], 8000));
    check(shared.ok, "kit: built-in 808 loads into the project bank");
    doc = shared.project;
    const auto old_clips = json::stringify(project::detail::at(E::track_at(doc, 1), "clips"));
    check(E::choose_instrument(doc, 1, 1, history, why), "kit: switch synth track to keys Sampler");
    const auto sampler = json::stringify(doc);
    const auto &keys = project::detail::track_pads(doc, &E::track_at(doc, 1));
    check(project::detail::str(keys[0], "sampleId") == project::detail::str(keys[1], "sampleId"),
          "kit: keys use the same sample across the pads");
    check(E::choose_instrument(doc, 1, 0, history, why), "kit: switch keys Sampler back to Kit");
    const auto &restored = project::detail::track_pads(doc, &E::track_at(doc, 1));
    check(json::stringify(*E::track_at(doc, 1).get("pads")) == json::stringify(*doc.get("pads")) &&
              project::detail::str(restored[0], "sampleId") != project::detail::str(restored[1], "sampleId") &&
              project::detail::num(project::detail::at(restored[2], "playback"), "chokeGroup") == 1,
          "kit: restores distinct pads and the hat choke group from the shared kit");
    E::Place place;
    check(history.undo(doc, place) && json::stringify(doc) == sampler && history.redo(doc, place),
          "kit: Undo restores the Sampler");
    const auto previous_kit = doc;
    const auto kit_board = ui::board_of(doc);
    ui::Ui face;
    face.select_track(1, kit_board);
    face.open(ui::View::sound);
    const ui::Now stopped;
    auto hit = [&](live::ProjectSound& sound, const ui::Board& board, int pad) {
      std::vector<Action> actions;
      face.pad(pad, 100, board, stopped, actions);
      std::array<float, 256> left{}, right{};
      const bool routed = one(actions, Action::note_on, 1) && actions[0].pad == pad;
      check(routed, "kit: Sound sends the pressed pad index on the selected track");
      if (routed)
        check(sound.play_live(actions[0].track, actions[0].pad, actions[0].note, actions[0].velocity),
              "kit: audio engine accepts a live hit");
      sound.process(left.data(), right.data(), left.size(), 0);
      return left;
    };
    auto audible = [](const std::array<float, 256>& hit) {
      return std::any_of(hit.begin(), hit.end(), [](float sample) { return std::abs(sample) > 0.001f; });
    };
    Str sound_error;
    live::ProjectSound kick_sound, snare_sound;
    check(kick_sound.prepare(doc, sound_error) && snare_sound.prepare(doc, sound_error),
          "kit: prepare the bank immediately after switching from Sampler");
    const auto kick = hit(kick_sound, kit_board, 0), snare = hit(snare_sound, kit_board, 1);
    check(audible(kick) && audible(snare) && kick != snare,
          "kit: immediately after switching from Sampler, pads 1 and 2 play different sounds");

    // Touch Load kit, select the second kit, and use the resulting assignment
    // against the original track. The session fills the catalogue from these descriptors.
    std::vector<Action> actions;
    const auto load = ui::layout::task(3);
    ui::touch_event(face, doc, kit_board, stopped, ui::TouchPhase::down, load.x + 20, load.y + 20, actions);
    auto catalogue = kit_board;
    catalogue.samples.clear();
    for (const auto& kit : live::kDrumMachineKits)
      catalogue.samples.push_back({kit.id, kit.name, "Built-in kit", 2});
    const auto second_row = ui::layout::song_row(1);
    const auto row_hit = ui::hit(face, catalogue, second_row.x + 20, second_row.y + 20);
    check(row_hit.kind == ui::Hit::on_sample && row_hit.block == 1, "kit: touchscreen selects the second kit");
    if (row_hit.kind == ui::Hit::on_sample)
      face.browse_cursor = row_hit.block;
    const auto assign = ui::layout::task(2);
    ui::touch_event(face, doc, catalogue, stopped, ui::TouchPhase::down, assign.x + 20, assign.y + 20, actions);
    const bool selected = face.view == ui::View::browse && face.browse_category == 1 &&
                          one(actions, Action::browse_assign, 1) &&
                          actions[0].sample_id == live::kDrumMachineKits[1].id;
    check(selected, "kit: Sound's Load kit selects a built-in kit for the current track");
    if (selected) {
      const auto replacement = live::drum_machine_kit(live::kDrumMachineKits[1], 8000);
      const Str target(kit_board.track_id[actions[0].track].c_str());
      check(E::load_track_kit(doc, target, replacement, history, why), "kit: the Browse assignment loads the 909");
    }
    check(selected &&
              ui::board_of(doc).pad_name[1][8] == "Ride" && ui::board_of(doc).pad_name[0][8] == "Cowbell" &&
              json::stringify(project::detail::at(E::track_at(doc, 1), "clips")) == old_clips,
          "kit: loading the 909 replaces only the selected track's bank and keeps its clips");
    // Queue each hit before the render block that swaps the kit into the engine.
    face.open(ui::View::sound);
    const auto board = ui::board_of(doc);
    std::array<std::array<float, 256>, 16> hits{};
    for (int pad = 0; pad < 16; ++pad) {
      live::ProjectSound sound;
      check(sound.prepare(previous_kit, sound_error) && sound.reload(doc, sound_error),
            "kit: stage the new bank while the old kit is active");
      hits[pad] = hit(sound, board, pad);
      check(audible(hits[pad]) && std::find(hits.begin(), hits.begin() + pad, hits[pad]) == hits.begin() + pad,
            "kit: each pad produces a distinct audible hit");
    }
    live::ProjectSound fresh_909;
    check(fresh_909.prepare(doc, sound_error) && hits[0] == hit(fresh_909, board, 0) && hits[0] != kick,
          "kit: the first hit after loading plays the new kick");
    check(history.undo(doc, place) && json::stringify(doc) == json::stringify(previous_kit),
          "kit: Undo restores the previous bank");
  }

  check(b.name == "Night" && b.bpm == 120 && b.tracks == 2 && b.scenes == 2 && b.song, "board: project facts");
  check(b.kind[0] == ui::Kind::kit && b.kind[1] == ui::Kind::synth && b.sound[1] == "Warm bass", "board: track kinds");
  check(b.clip[0][0] == "c1" && b.clip[0][1] == "c2" && b.clip[1][0] == "k1" && b.clip[1][1].empty(), "board: clips per scene");
  check(b.clip_name[0][1] == "Fill" && b.clip_steps[1][0] == 32 && b.scene_name[1] == "Break", "board: names and lengths");
  check(b.pad_name[0][3] == "Pad 3" && b.pad_note[0][3] == 60, "board: pads");
  {
    // Project format 7: a track with its own kit shows its own pads; the others the project's.
    json::Value own = opened.project;
    json::Value kit = json::Value::new_array();
    for (int i = 0; i < 16; ++i) {
      json::Value pad = json::Value::new_object();
      pad.set("id", json::Value::of(Str("own-") + int_text(i))), pad.set("name", json::Value::of(Str("Own ") + int_text(i)));
      pad.set("sampleId", json::Value::of("s"));
      if (i == 2) {
        json::Value pb = json::Value::new_object();
        pb.set("mode", json::Value::of("chromatic")), pb.set("rootNote", json::Value::of(48.0)), pb.set("chokeGroup", json::Value::of(0.0));
        pad.set("playback", xmp::move(pb));
      }
      kit.push(xmp::move(pad));
    }
    own.get("tracks")->items()[1].set("pads", xmp::move(kit));
    json::Value checked;
    Str why;
    check(project::canonical(own, checked, why), "board: a track's own kit is a valid project");
    const ui::Board k = ui::board_of(checked);
    check(k.pad_name[0][3] == "Pad 3" && k.pad_name[1][3] == "Own 3" && k.pad_note[1][2] == 48 && k.pad_note[0][2] == 60,
          "board: each track's own pads");
  }

  // Chop points: the same signal and results as tests/chop.test.ts.
  {
    std::uint32_t seed = 12345;
    auto rnd = [&] {
      seed = seed * 1103515245u + 12345u;
      return static_cast<double>(seed) / 4294967296.0 * 2 - 1;
    };
    std::vector<float> pcm(96000);
    for (auto& v : pcm) v = static_cast<float>(rnd() * 0.001);
    for (const int at : {12000, 33600, 52800, 76800})
      for (int i = 0; i < 6000; ++i) pcm[at + i] = static_cast<float>(pcm[at + i] + rnd() * 0.8 * std::exp(-i / 1200.0));
    for (int i = 0; i < 4000; ++i) pcm[64000 + i] = static_cast<float>(pcm[64000 + i] + rnd() * 0.01 * std::exp(-i / 800.0));
    check(chop::transients(pcm, 48000, 0.5) == std::vector<int>{0, 11520, 33280, 52480, 76544}, "chop: hits found");
    check(chop::transients(pcm, 48000, 0.9) == std::vector<int>{0, 11520, 33280, 52480, 63744, 76544},
          "chop: the quiet hit at high sensitivity");
    check(chop::even(96000, 5) == std::vector<int>{0, 19200, 38400, 57600, 76800} && chop::even(96000, 40).size() == 16,
          "chop: even slices");
    check(chop::clean({500, 100, 100, 99999, -4}, 1000) == std::vector<int>{0, 100, 500}, "chop: cleaned points");
  }

  // Clip length: shortening counts the notes it would remove (the session asks first).
  {
    namespace E = live::edit;
    auto doc = opened.project;
    // Keys' clip k1 is 32 steps: a step note at 2 and a sequence note at 6.
    check(E::notes_beyond(doc, {1, 0}, 16) == 0 && E::notes_beyond(doc, {1, 0}, 4) == 1 &&
              E::notes_beyond(doc, {1, 0}, 2) == 2,
          "clip length: notes past a shorter end are counted");
    E::History h;
    std::string why;
    auto f = E::read_field(doc, {1, 0}, E::Field::clip_length);
    check(f.available && f.value == 32 && E::apply_field(doc, f, 64, h, why) &&
              E::read_field(doc, {1, 0}, E::Field::clip_length).value == 64 && E::notes_beyond(doc, {1, 0}, 4) == 1,
          "clip length: a synth clip lengthens to 64 steps, keeping its notes");
    check(E::apply_field(doc, f, 48, h, why) && E::read_field(doc, {1, 0}, E::Field::clip_length).value == 48, "clip length: custom 48 steps");
  }

  // The data wheel moves through each page's items; pressing it acts on the highlighted one.
  {
    ui::Ui face;
    auto doc = opened.project;
    std::vector<Action> a;
    face.open(ui::View::mix);
    face.wheel(1, b);
    check(face.track == 1, "wheel: Mix moves to the next track");
    face.wheel(5, b);
    check(face.track == b.tracks - 1, "wheel: Mix stops at the last track");
    face.track = 1;
    face.open(ui::View::sound);
    ui::fill_strip(face, doc, b);
    face.sound_controls = true;
    face.wheel(2, b);
    face.button(ui::Button::wheel, true, b, ui::Now{}, a);
    check(face.sound_focus == 2 && face.editor_open && face.editor.field == live::edit::Field::resonance,
          "wheel: synth Controls, the third control, pressed, edits Resonance");
    face.editor_open = false, face.sound_controls = false, face.sound_focus = 0;
    face.wheel(17, b);
    face.button(ui::Button::wheel, true, b, ui::Now{}, a);
    check(face.preset_page == 1 && !a.empty() && a.back().kind == Action::choose_preset && a.back().pad == 17,
          "wheel: crossing into bank 2 and pressing chooses the focused preset");
    face.track = 0, a.clear();
    face.wheel(3, b);
    face.button(ui::Button::wheel, true, b, ui::Now{}, a);
    check(face.step_pad == 3 && !a.empty() && a.back().kind == Action::open_sample && a.back().pad == 3,
          "wheel: kit pads, pad 4, pressed, opens its sample");
  }

  // The Sampler machine: keys or slices, kept by keep_sampler; its Sample page chops.
  {
    namespace E = live::edit;
    auto doc = opened.project;
    E::History h;
    std::string why;
    check(E::choose_instrument(doc, 0, 1, h, why) && ui::board_of(doc).kind[0] == ui::Kind::sampler,
          "sampler: choosing Sampler gives keys");
    std::vector<float> pcm(1000);
    for (int i = 0; i < 1000; ++i) pcm[i] = static_cast<float>(std::sin(i * 0.05) * 0.5);
    check(E::keep_sampler(doc, 0, pcm, {300, 0, 100}, true, "Loop", h, why), "sampler: a take kept as slices");
    const auto sliced = ui::board_of(doc);
    const auto& pads = project::detail::track_pads(doc, &project::detail::list(doc, "tracks")[0]);
    check(sliced.slices[0] && sliced.kind[0] == ui::Kind::kit && sliced.sound[0] == "Sampler \xC2\xB7 slices" &&
              project::detail::num(project::detail::at(pads[1], "slice"), "start") == 100 &&
              project::detail::num(project::detail::at(pads[2], "slice"), "end") == 1000 && !pads[3].get("slice") &&
              project::detail::str(project::detail::at(pads[0], "playback"), "mode") == "one-shot",
          "sampler: slices 1-3 on pads 1-3, playing one-shot");
    check(E::keep_sampler(doc, 0, pcm, {}, false, "Loop", h, why) && ui::board_of(doc).kind[0] == ui::Kind::sampler &&
              !ui::board_of(doc).slices[0] &&
              project::detail::str(project::detail::at(project::detail::track_pads(doc, &project::detail::list(doc, "tracks")[0])[15], "playback"), "mode") == "chromatic",
          "sampler: the same take as keys");
    check(!E::keep_sampler(doc, 1, pcm, {}, false, "Loop", h, why), "sampler: a synth track refuses a Sampler take");
    ui::Ui face;
    face.track = 0;
    const auto board = ui::board_of(doc);
    face.view = ui::View::sample;
    face.sample_done(1000);
    face.chop_points = {0, 250, 500, 750};
    std::vector<Action> a;
    face.next_chop(a);
    check(face.chop == ui::Ui::Chop::hand && !a.empty() && a.back().kind == Action::chop_compute, "sampler: the chop key moves on");
    a.clear();
    face.pad(2, 100, board, ui::Now{}, a);
    face.button(ui::Button::plus, true, board, ui::Now{}, a);
    check(face.chop_selected == 2 && face.chop_points[2] == 510, "sampler: By hand moves the picked slice's start");
    face.chop = ui::Ui::Chop::lazy, face.lazy = true;
    face.pad(5, 100, board, ui::Now{}, a);
    check(!a.empty() && a.back().kind == Action::chop_mark, "sampler: lazy chop marks on a pad tap");
    face.lazy = false, face.chop = ui::Ui::Chop::even;
    a.clear();
    face.button(ui::Button::wheel, true, board, ui::Now{}, a);
    check(a.size() == 1 && a[0].kind == Action::sample_keep && a[0].pad == 0, "sampler: the wheel keeps the take");
  }

  // A synth's Sound page: presets, or every control; a kit's keys load sounds.
  {
    ui::Ui face;
    face.track = 1;
    face.open(ui::View::sound);
    auto doc = opened.project;
    ui::fill_strip(face, doc, b);
    std::vector<Action> a;
    ui::touch_event(face, doc, b, ui::Now{}, ui::TouchPhase::down, ui::layout::kRight - 60, ui::layout::kTop + 30, a);
    check(face.sound_controls && a.empty(), "synth sound: the toolbar button opens Controls");
    ui::fill_strip(face, doc, b);
    check(face.synth_fields[2].available && face.synth_fields[2].name == "Resonance" && face.synth_fields[10].name == "Glide",
          "synth sound: Controls lists the later controls too");
    const auto r = ui::layout::cell(2, 0);
    ui::touch_event(face, doc, b, ui::Now{}, ui::TouchPhase::down, r.x + 20, r.y + 20, a);
    check(face.editor_open && face.editor.field == live::edit::Field::resonance, "synth sound: touching Resonance edits it");
    face.editor_open = false;
    std::string why;
    live::edit::History h;
    auto field = live::edit::read_field(doc, {1}, live::edit::Field::glide);
    check(live::edit::apply_field(doc, field, 250, h, why) &&
              std::abs(live::edit::read_field(doc, {1}, live::edit::Field::glide).value - 250) < 1,
          "synth sound: Glide set to 250 ms");
    face.pad(9, 100, b, ui::Now{}, a);
    check(std::none_of(a.begin(), a.end(), [](const Action& x) { return x.kind == Action::choose_preset; }),
          "synth sound: on Controls the top pads play instead of choosing presets");
    const char* keys[5] = {"", "", "", "", ""};
    ui::sound_keys(face, b, keys);
    check(std::string(keys[0]) == "Presets" && std::string(keys[2]) == "Choose machine", "synth sound: keys switch pages");
    face.track = 0;
    ui::sound_keys(face, b, keys);
    check(std::string(keys[3]) == "Load kit" && std::string(keys[0]) == "Edit pad sample", "kit sound: keys edit and load sounds");
  }

  // Footer pad shortcuts must not retrigger notes or lose releases when a
  // performance pad is still held as a menu opens.
  {
    ui::Ui face;
    face.track = 1;
    face.open(ui::View::play);
    std::vector<Action> actions;
    ui::pad_event(face, opened.project, b, {}, 12, 100, actions);
    check(one(actions, Action::note_on, 1), "plain pad 13 on Play plays a note");
    face.button(ui::Button::shift, true, b, {}, actions);
    face.button(ui::Button::menu, true, b, {}, actions);
    actions.clear();
    ui::pad_event(face, opened.project, b, {}, 13, 100, actions);
    check(face.editor_open && face.editor.field == live::edit::Field::scale && actions.empty(),
          "Shift and Menu plus pad 14 opens the Scale button");
    face.button(ui::Button::menu, false, b, {}, actions);
    face.button(ui::Button::shift, false, b, {}, actions);
    face.select_track(0, b);
    ui::pad_event(face, opened.project, b, {}, 12, 0, actions);
    check(one(actions, Action::note_off, 1), "a menu still releases a note on the track that started it");
    actions.clear();
    ui::pad_event(face, opened.project, b, {}, 12, 100, actions);
    check(!face.editor_open && actions.empty(), "option pads choose the scale without playing a note");
  }

  // A track with no machine, no kit of its own and no notes has no machine
  // chosen: its Sound page asks for one, with pads 13-16 or touch.
  {
    namespace E = live::edit;
    auto doc = opened.project;
    auto& tracks = doc.get("tracks")->items();
    json::Value empty = json::Value::new_object();
    empty.set("id", json::Value::of("t3")), empty.set("name", json::Value::of("Track 3"));
    empty.set("muted", json::Value::of(false)), empty.set("volume", json::Value::of(0.8));
    empty.set("clips", json::Value::new_array());
    tracks.push(xmp::move(empty));
    json::Value checked;
    Str why;
    check(project::canonical(doc, checked, why), "machine choice: a track with no machine is a valid project");
    const ui::Board m = ui::board_of(checked);
    check(m.tracks == 3 && !m.unchosen[0] && !m.unchosen[1] && m.unchosen[2] && m.kind[2] == ui::Kind::kit,
          "machine choice: only the empty track has no machine chosen (the old drum track keeps its kit)");
    ui::Ui face;
    face.track = 2;
    face.open(ui::View::sound);
    std::vector<Action> a;
    face.pad(5, 100, m, ui::Now{}, a);
    check(a.empty(), "machine choice: other pads do nothing until a machine is chosen");
    face.pad(14, 100, m, ui::Now{}, a);
    check(a.size() == 1 && a[0].kind == Action::choose_machine && a[0].track == 2 && a[0].pad == 2,
          "machine choice: pad 15 chooses the synth");
    a.clear();
    const auto card = ui::layout::machine_card(0);
    ui::touch_event(face, checked, m, ui::Now{}, ui::TouchPhase::down, card.x + 10, card.y + 10, a);
    check(a.size() == 1 && a[0].kind == Action::choose_machine && a[0].pad == 0, "machine choice: touching Kit chooses it");
    E::History history;
    std::string error;
    check(E::choose_instrument(checked, 2, 2, history, error) && !ui::board_of(checked).unchosen[2] &&
              ui::board_of(checked).kind[2] == ui::Kind::synth,
          "machine choice: once chosen, the track has its machine");
  }

  // Copying replaces only a slot reference, including slots sharing one clip.
  {
    namespace E = live::edit;
    auto doc = opened.project;
    E::scene_at(doc, 1).get("clips")->set("drums", json::Value::of("c1"));
    const auto before = json::stringify(doc);
    E::History history;
    std::string why;
    check(E::copy_slot(doc, 1, "k1", 0, 1, history, why), "copy: cross-track copy succeeds");
    const auto copied = ui::board_of(doc);
    check(copied.clip[0][0] == "c1" && copied.clip[0][1] != "c1" && copied.kind[0] == ui::Kind::kit &&
              copied.clip_steps[0][1] == 32 && copied.clip_notes[0][1] == 2,
          "copy: only destination slot changes; length, steps and detailed notes survive; machine stays");
    check(json::stringify(E::clip_at(doc, E::find(doc, "keys", "k1"))) ==
              json::stringify(E::clip_at(opened.project, E::find(opened.project, "keys", "k1"))),
          "copy: source is untouched");
    const auto after = json::stringify(doc);
    E::Place place;
    check(history.undo(doc, place) && history.structural() && json::stringify(doc) == before,
          "copy: one undo restores the exact project");
    check(history.redo(doc, place) && json::stringify(doc) == after, "copy: redo restores it");
    const int clips = project::detail::list(E::track_at(doc, 0), "clips").size();
    check(E::unlink_slot(doc, 0, 1, history, why) && ui::board_of(doc).clip[0][1].empty() &&
              project::detail::list(E::track_at(doc, 0), "clips").size() == clips,
          "delete: unlinks only the slot and retains clip data");
    check(history.undo(doc, place) && json::stringify(doc) == after, "delete: undo restores the slot");
    auto& all = E::track_at(doc, 0).get("clips")->items();
    while (all.size() < 16) {
      auto extra = all[0];
      extra.set("id", json::Value::of(Str("extra-") + int_text(all.size())));
      all.push(xmp::move(extra));
    }
    const auto full = json::stringify(doc);
    E::History rejected;
    check(!E::copy_slot(doc, 0, "c1", 0, 1, rejected, why) && json::stringify(doc) == full && !rejected.can_undo(),
          "copy: a full track is rejected atomically without overwriting a reused clip");
    check(!E::copy_slot(doc, -1, "c1", 0, 1, rejected, why) &&
              !E::copy_slot(doc, 0, "missing", 1, 1, rejected, why) &&
              !E::unlink_slot(doc, 0, -1, rejected, why), "copy: invalid targets and stale sources are refused");
    ui::Ui held;
    std::vector<Action> actions;
    ui::Now stopped;
    held.button(ui::Button::copy, true, b, stopped, actions);
    held.pad(13, 100, b, stopped, actions);
    held.pad(8, 100, b, stopped, actions);
    held.button(ui::Button::copy, false, b, stopped, actions);
    check(actions.size() == 1 && actions[0].kind == Action::copy_clip && actions[0].source_track == 1 &&
              actions[0].source_clip == "k1" && actions[0].track == 0 && actions[0].scene == 1,
          "COPY held: source pad then target pad; no launch or audition");
  }

  // Browse is a project-only overlay: no filesystem or device access.
  {
    namespace E = live::edit;
    auto doc = opened.project;
    auto extra = doc.get("samples")->items()[0];
    extra.set("id", json::Value::of("new-sound"));
    extra.set("name", json::Value::of("New sound"));
    extra.set("sampleRate", json::Value::of(24000.0));
    doc.get("samples")->items().push(xmp::move(extra));
    const auto sounds = ui::board_of(doc);
    ui::Ui browser;
    ui::Now stopped;
    std::vector<Action> actions;
    browser.open(ui::View::steps);
    browser.button(ui::Button::shift, true, sounds, stopped, actions);
    browser.button(ui::Button::menu, true, sounds, stopped, actions);
    browser.button(ui::Button::shift, false, sounds, stopped, actions); // release order must not lose Browse
    browser.button(ui::Button::menu, false, sounds, stopped, actions);
    check(browser.view == ui::View::browse && !browser.menu, "Browse: SHIFT+MENU opens even when SHIFT is released first");
    browser.wheel(1, sounds);
    browser.pad(3, 100, sounds, stopped, actions);
    browser.button(ui::Button::shift, true, sounds, stopped, actions);
    browser.button(ui::Button::play, true, sounds, stopped, actions);
    browser.button(ui::Button::shift, false, sounds, stopped, actions);
    check(actions.size() == 1 && actions[0].kind == Action::browse_audition && actions[0].sample_id == "new-sound",
          "Browse: SHIFT+PLAY auditions the focused sound without launching transport");
    actions.clear();
    browser.button(ui::Button::wheel, true, sounds, stopped, actions);
    check(actions.size() == 1 && actions[0].kind == Action::browse_assign && actions[0].pad == 3 &&
              actions[0].sample_id == "new-sound", "Browse: wheel assigns the selected sound to the chosen pad");
    const auto before = json::stringify(doc);
    E::History history;
    std::string why;
    check(E::assign_pool_sample(doc, 0, 3, "new-sound", history, why), "Browse: sound assignment succeeds");
    check(project::detail::str(doc.get("pads")->items()[3], "sampleId") == "s" &&
              project::detail::str(E::track_at(doc, 0).get("pads")->items()[3], "sampleId") == "new-sound" &&
              project::detail::list(doc, "samples").size() == 2,
          "Browse: makes an independent kit, keeps the shared kit and reuses sample data");
    E::Place place;
    check(history.undo(doc, place) && json::stringify(doc) == before && history.redo(doc, place),
          "Browse: undo restores everything and redo reapplies");
    check(E::preview_pool_sample(doc, "new-sound").size() == 16 && E::preview_pool_sample(doc, "missing").empty(),
          "Browse: preview resamples to 48kHz and refuses a missing sound");
    check(!E::assign_pool_sample(doc, 1, 0, "new-sound", history, why) &&
              !E::assign_pool_sample(doc, 0, 16, "new-sound", history, why) &&
              !E::assign_pool_sample(doc, 0, 0, "missing", history, why), "Browse: invalid targets are refused");
    ui::fill_strip(browser, doc, sounds);
    check(browser.strip_page == "BROWSE" && browser.strip[0].name == "Sample" && browser.strip[1].value == "4",
          "Browse: knobs have their own labels instead of changing the mix");
    const auto touch = ui::hit(browser, sounds, ui::layout::song_row(1).x + 4, ui::layout::song_row(1).y + 4);
    check(touch.kind == ui::Hit::on_sample && touch.block == 1, "Browse: touchscreen selects a sound");
    browser.button(ui::Button::shift, true, sounds, stopped, actions);
    browser.button(ui::Button::menu, true, sounds, stopped, actions);
    browser.button(ui::Button::menu, false, sounds, stopped, actions);
    browser.button(ui::Button::shift, false, sounds, stopped, actions);
    check(browser.view == ui::View::steps, "Browse: closing returns to the previous view");
  }

  // ---- the button map ----
  check(ui::button_of(0x52) == ui::Button::play && ui::button_of(0x51) == ui::Button::stop &&
            ui::button_of(0x49) == ui::Button::rec && ui::button_of(0x53) == ui::Button::play_start,
        "buttons: transport");
  check(ui::button_of(0x23) == ui::Button::bank_a && ui::button_of(0x26) == ui::Button::bank_d &&
            ui::button_of(0x31) == ui::Button::shift && ui::button_of(0x7B) == ui::Button::menu &&
            ui::button_of(0x34) == ui::Button::main && ui::button_of(0x36) == ui::Button::plus &&
            ui::button_of(0x37) == ui::Button::minus && ui::button_of(0x28) == ui::Button::level16,
        "buttons: the rest");
  check(ui::wheel_steps(0x01) == 1 && ui::wheel_steps(0x7F) == -1, "data wheel steps");

  // ---- the Clips view, stopped ----
  ui::Ui u;
  ui::Now stopped;
  std::vector<Action> out;
  check(u.pad_track(12) == 0 && u.pad_scene(12) == 0 && u.pad_track(13) == 1 && u.pad_scene(8) == 1 &&
            u.pad_scene(0) == 3,
        "pads: the top row is the window's first scene, columns are tracks");
  u.pad(12, 100, b, stopped, out);
  check(one(out, Action::play_clip, 0, 0), "stopped: a clip pad plays that clip alone");
  out.clear();
  u.button(ui::Button::play, true, b, stopped, out);
  check(one(out, Action::play_song), "Play starts the song");
  out.clear();
  u.pad(8, 100, b, stopped, out);  // drums, Break: selects scene 2
  out.clear();
  u.button(ui::Button::play_start, true, b, stopped, out);
  check(one(out, Action::play_scene, -2, 1), "Play Start plays the selected scene");
  out.clear();
  u.button(ui::Button::stop, true, b, stopped, out);
  check(one(out, Action::panic), "Stop while stopped silences everything");
  out.clear();
  u.pad(9, 100, b, stopped, out);  // keys, Break: empty
  check(out.empty() && !u.toast.empty(), "an empty slot says so");
  out.clear();

  // ---- the Clips view, playing scene A ----
  ui::Now playing;
  playing.playing = true;
  playing.clip[0] = "c1";
  playing.clip[1] = "k1";
  u.pad(12, 100, b, playing, out);
  check(one(out, Action::stop_clip, 0), "playing: the playing clip's pad stops its track");
  out.clear();
  u.pad(8, 100, b, playing, out);
  check(one(out, Action::launch_clip, 0, 1), "playing: another clip launches on the next bar");
  out.clear();
  u.pad(9, 100, b, playing, out);
  check(one(out, Action::stop_clip, 1), "playing: an empty slot stops its track");
  out.clear();
  u.button(ui::Button::play, true, b, playing, out);
  check(out.empty(), "Play does nothing while playing");
  u.button(ui::Button::stop, true, b, playing, out);
  check(one(out, Action::stop), "Stop stops");
  out.clear();
  u.select_scene(0, b);
  u.button(ui::Button::wheel, true, b, playing, out);
  check(one(out, Action::launch_scene, -2, 0), "the data wheel press launches the selected scene");
  out.clear();
  u.wheel(5, b);
  check(u.cursor == 1 && u.window == 0, "the wheel moves the scene cursor within the project");

  // ---- track selection ----
  u.button(ui::Button::bank_b, true, b, playing, out);
  check(u.track == 1, "Pad Bank B selects track 2");
  u.button(ui::Button::shift, true, b, playing, out);
  u.button(ui::Button::bank_a, true, b, playing, out);
  u.button(ui::Button::shift, false, b, playing, out);
  check(u.track == 1 && u.toast == "No track 5", "Shift + Pad Bank A asks for track 5, which this project lacks");
  check(out.empty(), "selection makes no actions");

  // ---- views ----
  u.button(ui::Button::menu, true, b, playing, out);
  u.pad(12, 100, b, playing, out);
  u.button(ui::Button::menu, false, b, playing, out);
  check(u.view == ui::View::play && out.empty(), "Menu + pad 13 opens Play");
  u.button(ui::Button::menu, true, b, playing, out);
  u.button(ui::Button::menu, false, b, playing, out);
  check(!u.menu && u.view == ui::View::play, "a tap on Menu stays on the page");
  {
    using namespace std::chrono;
    ui::Ui menu;
    menu.open(ui::View::play);
    ui::Now time;
    std::vector<Action> actions;
    const auto press = [&](bool down) { menu.button(ui::Button::menu, down, b, time, actions); };
    press(true);
    time.input_time += milliseconds(2999);
    press(false);
    check(!menu.menu && menu.view == ui::View::play, "Menu: releasing before three seconds returns to Play");
    press(true);
    time.input_time += seconds(2);
    press(true);  // duplicate button-on events cannot restart the hold
    time.input_time += seconds(1);
    press(false);
    check(menu.menu && !menu.menu_button_held(), "Menu: releasing at three seconds keeps the menu open");
    const auto mix_card = ui::layout::menu_card(ui::pad_option(10));
    ui::touch_event(menu, opened.project, b, time, ui::TouchPhase::down, mix_card.x + 10, mix_card.y + 10, actions);
    check(!menu.menu && menu.view == ui::View::mix && actions.empty(), "Menu: a touch selects a page after release");
    press(true);
    time.input_time += seconds(3);
    press(false);
    press(true);
    press(false);
    check(!menu.menu && menu.view == ui::View::mix, "Menu: the next tap closes the latched menu");
    press(true);
    time.input_time += seconds(4);
    menu.pad(12, 100, b, time, actions);
    press(false);
    check(!menu.menu && menu.view == ui::View::play, "Menu: releasing after a pad choice stays on the chosen page");
    menu.button(ui::Button::shift, true, b, time, actions);
    press(true);
    time.input_time += seconds(3);
    press(false);
    check(!menu.menu && menu.view == ui::View::browse, "Menu: a shifted hold still opens Browse");
  }
  // Track 2 is a synth: it has nothing to sample into, so Sample stays closed.
  u.button(ui::Button::menu, true, b, playing, out);
  u.pad(14, 100, b, playing, out);
  u.button(ui::Button::menu, false, b, playing, out);
  check(u.view == ui::View::play && u.toast.find("Kit and Sampler") != std::string::npos && !u.can_sample(b),
        "Menu + pad 15 refuses Sample on a synth track");
  u.select_track(0, b);
  u.button(ui::Button::menu, true, b, playing, out);
  u.pad(14, 100, b, playing, out);
  u.button(ui::Button::menu, false, b, playing, out);
  check(u.view == ui::View::sample && u.can_sample(b), "Menu + pad 15 opens Sample on the kit track");
  u.button(ui::Button::menu, true, b, playing, out);
  u.button(ui::Button::menu, false, b, playing, out);
  check(u.view == ui::View::sample, "a tap on Menu stays on Sample");
  u.select_track(1, b);
  check(u.view == ui::View::sound, "choosing a synth track leaves Sample for its Sound page");
  // Back to the state the following checks start from: track 2, on Sample.
  u.track = 1, u.view = ui::View::sample;
  u.button(ui::Button::main, true, b, playing, out);
  check(u.view == ui::View::clips, "Main returns to Clips");
  u.button(ui::Button::shift, true, b, playing, out);
  u.button(ui::Button::main, true, b, playing, out);
  u.button(ui::Button::shift, false, b, playing, out);
  check(u.view == ui::View::play, "Shift + Main opens Play");

  // ---- the Play view ----
  u.pad(0, 127, b, playing, out);
  check(one(out, Action::note_on, 1) && out[0].note == 48 && out[0].velocity == 1.0f, "Play: a synth pad plays its note");
  out.clear();
  u.pad(0, 0, b, playing, out);
  check(one(out, Action::note_off, 1) && out[0].note == 48, "Play: letting go releases it");
  out.clear();
  u.button(ui::Button::plus, true, b, playing, out);
  u.button(ui::Button::full_level, true, b, playing, out);
  u.pad(2, 20, b, playing, out);
  check(one(out, Action::note_on, 1) && out[0].note == 64 && out[0].velocity == 1.0f, "Play: + raises an octave; Full Level");
  out.clear();
  u.button(ui::Button::bank_a, true, b, playing, out);
  u.pad(3, 64, b, playing, out);
  check(one(out, Action::note_on, 0) && out[0].pad == 3 && out[0].note == 60, "Play: a kit pad plays its pad");
  out.clear();
  u.pad(3, 0, b, playing, out);
  check(out.empty(), "Play: a kit pad's release does nothing (one-shots play out)");

  // ---- launches and live notes through the real player ----
  live::ProjectSound sound;
  Str error;
  check(sound.prepare(opened.project, error), "sound prepares");
  live::ProjectPlayer player;
  check(player.start(opened.project, sound, Str("a"), false, 0, 0, error), "scene A starts");
  check(player.fill(4 * 6000, error), "fills four steps");  // 120 BPM: 6000 frames a step
  const Str fill("c2");
  check(player.launch_clip(Str("drums"), &fill, error), "launch the fill");
  const auto queued = player.performance()->queued();
  check(queued.size() == 1 && queued[0].track == "drums" && queued[0].clip == "c2", "the launch waits for the bar");
  check(player.launch_clip(Str("keys"), nullptr, error), "stop the keys at the bar");
  check(player.fill(20 * 6000, error), "fills past the bar");
  const auto slots = player.performance()->slots();
  const auto* drums = player.performance()->slot(slots, Str("drums"));
  const auto* keys = player.performance()->slot(slots, Str("keys"));
  check(drums && drums->has_clip && drums->clip == "c2" && drums->anchor == 16, "the fill plays from step 16");
  check(keys && !keys->has_clip, "the keys stopped at step 16");
  check(player.performance()->queued().size() == 0, "nothing waits any more");
  check(std::fabs(player.audible_step(0)) < 1e-9 && std::fabs(player.audible_step(4 * 6000) - 4) < 1e-9 &&
            std::fabs(player.audible_step(4 * 6000 + 3000) - 4.5) < 1e-6,
        "the heard step follows the frames");
  Str scene_b("b");
  check(player.launch_scene(scene_b, error), "launch scene B");
  Str waiting;
  check(player.performance()->queued_scene(waiting) && waiting == "b", "scene B waits for the bar");
  player.stop(20 * 6000);

  // Live notes, while nothing plays: a synth note sounds until released.
  live::ProjectSound live_sound;
  check(live_sound.prepare(opened.project, error), "live sound prepares");
  std::vector<float> left(256), right(256);
  auto energy = [&](uint64_t frame) {
    double e = 0;
    std::fill(left.begin(), left.end(), 0.0f), std::fill(right.begin(), right.end(), 0.0f);
    live_sound.process(left.data(), right.data(), 256, frame);
    for (float v : left) e += v * v;
    return e;
  };
  check(energy(0) == 0, "silent before a note");
  check(live_sound.play_live(1, 0, 48, 1.0), "a live synth note");
  double held = 0;
  for (int i = 1; i < 40; ++i) held = energy(i * 256);
  check(held > 1e-4, "the held note still sounds after 200 ms");
  check(live_sound.release_live(Str("keys"), 48), "release it");
  double after = 1;
  for (int i = 40; i < 120; ++i) after = energy(i * 256);
  check(after < held * 1e-3, "released, it fades");
  check(live_sound.play_live(0, 0, 60, 1.0), "a live kit hit");
  check(energy(200 * 256) > 0, "the kit hit sounds");

  // ---- the drawing ----
  live::Canvas c;
  std::vector<unsigned char> memory(1280 * 800 * 4);
  c.memory = memory.data(), c.size = memory.size(), c.xres = 1280, c.yres = 800, c.line_length = 1280 * 4;
  c.width = 1280, c.height = 800;
  auto pixel = [&](int x, int y) {
    uint32_t v;
    std::memcpy(&v, &memory[(static_cast<size_t>(y) * 1280 + x) * 4], 4);
    return v;
  };
  auto rgb = [&](live::theme::Rgb k) { return c.colour(k.r, k.g, k.b); };
  ui::Ui view;
  ui::Painter painter;
  ui::Now now;
  now.playing = true;
  now.clip[0] = "c1";
  painter.draw(c, view, b, now, 0);
  namespace css = live::gfx::css;
  // A filled cell's gradient (inside its 1 px border) at row y.
  auto gradient = [&](live::Rect r, int y, live::theme::Rgb top, live::theme::Rgb bottom) {
    return rgb(live::gfx::blend_colour(top, bottom, (y - (r.y + 1)) / static_cast<float>(r.h - 3)));
  };
  const auto cell = ui::layout::pad_cell(12), other = ui::layout::pad_cell(8), empty_cell = ui::layout::pad_cell(9),
             none = ui::layout::pad_cell(14);
  const int mid = cell.y + cell.h / 2;
  check(pixel(cell.x + cell.w - 20, mid) == gradient(cell, mid, css::kCellTop, css::kCellBottom), "a clip is the web's emerald card");
  check(pixel(cell.x + 1, mid) == rgb(css::kGold), "the focused clip has the gold ring");
  check(pixel(cell.x + 13, cell.y + cell.h - 5) == rgb(css::kEmeraldBright) &&
            pixel(cell.x + cell.w / 2, cell.y + cell.h - 5) == rgb(css::kEmeraldDeep),
        "a playing clip shows its progress");
  check(pixel(empty_cell.x + empty_cell.w - 20, empty_cell.y + empty_cell.h / 2) == rgb(css::kSurface) &&
            pixel(empty_cell.x + 12, empty_cell.y) == rgb(css::kLine) && pixel(empty_cell.x + 10, empty_cell.y) == rgb(css::kSurface),
        "an empty slot is dashed");
  check(pixel(none.x + none.w - 20, none.y + none.h / 2) == rgb(css::kSurface), "a column with no track has empty slots");
  check(pixel(640, 2) == rgb(live::gfx::blend_colour(css::kSurface, css::kBg, 2 / 70.0f)) && pixel(640, 71) == rgb(css::kGoldDeep),
        "the header's gradient and gold line");
  {
    const auto logo = ui::layout::kHeaderLogo;
    int ivory = 0, gold = 0;
    for (int y = logo.y; y < logo.y + logo.h; ++y)
      for (int x = logo.x; x < logo.x + logo.w; ++x) {
        ivory += pixel(x, y) == rgb(css::kIvory);
        gold += pixel(x, y) == rgb(css::kGoldBright);
      }
    check(logo.x == 24 && logo.y == 19 && ivory > 900 && gold > 20, "the header paints the Orbit mark in ivory and gold");
    check(pixel(logo.x, logo.y) ==
              rgb(live::gfx::blend_colour(css::kSurface, css::kBg, logo.y / 70.0f)),
          "the logo preserves the header behind transparent pixels");
    ui::Ui touches;
    std::vector<ui::Action> actions;
    auto tap = [&](int x, int y) {
      ui::touch_event(touches, opened.project, b, now, ui::TouchPhase::down, x, y, actions);
    };
    tap(logo.x + logo.w / 2, 27);
    check(!touches.rename_kind, "the logo is decorative");
    tap(ui::layout::kHeaderIdentity + 8, 20);
    check(touches.rename_kind == 1 && touches.rename_text == b.name, "the moved project name still opens rename");
    touches.rename_kind = 0;
    tap(ui::layout::kHeaderIdentity + 90, 46);
    check(touches.rename_kind == 2 && touches.rename_text == b.track_name[0], "the moved track name still opens rename");
  }
  {
    // The knobs' panel down the right edge, Q1 at the top, beside the Live's Q-Link knobs.
    const auto q1 = ui::layout::knob(0), q4 = ui::layout::knob(3);
    check(q1.x == 1140 && q1.w == 140 && q1.y == 72 && q4.y + q4.h == 800 && q4.y > q1.y, "the knobs' panel is a column on the right");
    check(pixel(q1.x + q1.w - 10, q1.y + 10) == rgb(css::kBg) && pixel(q1.x, q1.y + 60) == rgb(css::kLine) &&
              pixel(q1.x + 60, q1.y + q1.h - 1) == rgb(css::kLine),
          "the Q-Link panel: dark cells with a line between them");
    check(ui::layout::status().w == 1140 && ui::layout::status().y + ui::layout::status().h == 800, "the status line runs under the page");
  }
  now.clip[0] = "c2";
  painter.draw(c, view, b, now, 0);
  check(pixel(other.x + other.w / 2, other.y + other.h - 1) == rgb(css::kEmeraldBright) &&
            pixel(cell.x + 13, cell.y + cell.h - 5) != rgb(css::kEmeraldBright),
        "a launch repaints both cells");
  const auto hit = ui::hit(view, b, other.x + 10, other.y + 10);
  check(hit.kind == ui::Hit::on_slot && hit.track == 0 && hit.scene == 1, "a touch finds its slot");
  check(ui::hit(view, b, 30, 30).kind == ui::Hit::none && ui::hit(view, b, 1200, 120).kind == ui::Hit::none &&
            ui::hit(view, b, ui::layout::head(1).x + 5, ui::layout::head(1).y + 5).track == 1,
        "touch: no on-screen navigation (the buttons do it); a column head selects its track");
  view.view = ui::View::play;
  painter.draw(c, view, b, now, 0);
  const auto pad = ui::layout::play_pad(5);
  check(pixel(pad.x + pad.w - 20, pad.y + pad.h / 2) == rgb(css::kSurface2), "the Play view draws its pads");
  check(ui::hit(view, b, pad.x + 5, pad.y + 5).pad == 5, "a touch finds its pad");

  // ---- the Steps view ----
  {
    ui::Ui st;
    std::vector<Action> o;
    ui::Now quiet;
    st.button(ui::Button::level16, true, b, quiet, o);
    check(st.view == ui::View::steps, "16 Level opens Steps");
    check(st.pad_step(12) == 0 && st.pad_step(15) == 3 && st.pad_step(0) == 12, "Steps: steps 1-4 on the top row");
    st.pad(13, 90, b, quiet, o);
    check(one(o, Action::toggle_step, 0, 0) && o[0].step == 1 && o[0].pad == 0, "Steps: a pad toggles its step");
    o.clear();
    st.button(ui::Button::shift, true, b, quiet, o);
    st.pad(3, 90, b, quiet, o);
    st.button(ui::Button::shift, false, b, quiet, o);
    check(o.empty() && st.step_pad == 3 && st.toast == "Editing Pad 3", "Steps: Shift + pad chooses the kit pad");
    st.button(ui::Button::erase, true, b, quiet, o);
    st.pad(5, 90, b, quiet, o);
    st.button(ui::Button::erase, false, b, quiet, o);
    check(one(o, Action::erase_row, 0, 0) && o[0].pad == 3, "Steps: Erase + pad clears the pad's steps");
    o.clear();
    st.wheel(1, b);
    check(st.page == 0, "Steps: a 16-step clip has one page");
    st.button(ui::Button::bank_b, true, b, quiet, o);
    st.button(ui::Button::shift, true, b, quiet, o);
    st.button(ui::Button::main, true, b, quiet, o);
    st.button(ui::Button::shift, false, b, quiet, o);
    st.pad(7, 90, b, quiet, o);  // the Play view: G3 on the synth
    st.pad(7, 0, b, quiet, o);
    o.clear();
    check(st.step_note == 60, "the last note played in Play is the one Steps edits");
    st.button(ui::Button::level16, true, b, quiet, o);
    st.wheel(3, b);
    check(st.page == 1 && st.pad_step(12) == 16, "Steps: a 32-step clip has two");
    st.button(ui::Button::shift, true, b, quiet, o);
    st.pad(4, 90, b, quiet, o);
    st.button(ui::Button::shift, false, b, quiet, o);
    check(st.step_note == 55 && st.toast == "Editing G3", "Steps: Shift + pad chooses the synth note");
    st.pad(12, 90, b, quiet, o);
    check(one(o, Action::toggle_step, 1, 0) && o[0].note == 55 && o[0].step == 16, "Steps: a synth step with its note");
    o.clear();
    st.button(ui::Button::undo, true, b, quiet, o);
    check(one(o, Action::undo), "Undo");
    o.clear();
    st.button(ui::Button::shift, true, b, quiet, o);
    st.button(ui::Button::undo, true, b, quiet, o);
    check(one(o, Action::redo), "Shift + Undo is Redo");
    o.clear();
    st.button(ui::Button::shift, false, b, quiet, o);
    st.select_scene(1, b);
    st.pad(13, 90, b, quiet, o);
    check(o.empty(), "Steps: only the labelled pad creates a clip in the empty slot");
    st.pad(12, 90, b, quiet, o);
    check(one(o, Action::create_clip, 1, 1), "Steps: pad 13 creates a clip in the selected track and scene");
    o.clear();
    st.button(ui::Button::wheel, true, b, quiet, o);
    check(one(o, Action::create_clip, 1, 1), "Steps: data dial press creates a clip in the same slot");
  }

  // ---- clip edits, undo and redo ----
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    std::string why;
    const E::Place kit = E::find(doc, Str("drums"), Str("c1")), keys = E::find(doc, Str("keys"), Str("k1"));
    check(kit.track == 0 && kit.clip == 0 && keys.track == 1 && keys.clip == 0, "edit: places");
    check(!E::find(doc, Str("drums"), Str("k1")).ok(), "edit: a clip of another track is not found");
    check(E::row(doc, kit, 0, 0).velocity[0] == 1.0f && E::row(doc, kit, 0, 0).length == 16, "edit: the kit's row");
    check(E::row(doc, keys, 0, 40).velocity[2] == 0.8f && E::row(doc, keys, 0, 45).velocity[6] == 0.7f,
          "edit: a synth row shows steps and sequence notes");
    check(E::toggle(doc, kit, 5, 3, 0, h, why) && std::fabs(E::row(doc, kit, 3, 0).velocity[5] - 0.8f) < 1e-6,
          "edit: a kit step on");
    check(E::toggle(doc, kit, 5, 3, 0, h, why) && E::row(doc, kit, 3, 0).velocity[5] == 0, "edit: and off");
    check(!E::toggle(doc, kit, 16, 3, 0, h, why) && why == "Outside the clip", "edit: no step past the clip");
    check(E::toggle(doc, keys, 2, 0, 40, h, why) && E::row(doc, keys, 0, 40).velocity[2] == 0, "edit: a synth step off");
    check(E::toggle(doc, keys, 6, 0, 45, h, why) && E::row(doc, keys, 0, 45).velocity[6] == 0, "edit: a sequence note off");
    check(E::toggle(doc, keys, 4, 0, 50, h, why) && E::toggle(doc, keys, 4, 0, 53, h, why), "edit: a chord");
    const auto& steps = project::detail::list(E::clip_at(doc, keys), "steps");
    check(steps.size() == 2 && project::detail::num(steps[0], "pad") == 0 && project::detail::num(steps[1], "pad") == 1,
          "edit: the chord's notes take free pads");
    check(E::erase(doc, keys, 0, 53, h, why) && E::row(doc, keys, 0, 53).velocity[4] == 0 &&
              E::row(doc, keys, 0, 50).velocity[4] > 0,
          "edit: erase one pitch");
    check(!E::erase(doc, keys, 0, 99, h, why) && why == "Nothing to erase", "edit: erase nothing");
    const auto reopened = project::open(json::stringify(doc));
    check(reopened.ok, "edit: the edited project still opens");
    if (!reopened.ok) std::printf("  %s\n", reopened.error.c_str());
    E::Place undone;
    int undos = 0;
    while (h.undo(doc, undone)) ++undos;
    check(undos == 7 && json::stringify(doc) == json::stringify(opened.project), "edit: undo returns to the start");
    check(h.redo(doc, undone) && undone.track == 0 && E::row(doc, kit, 3, 0).velocity[5] > 0, "edit: redo");
    check(E::toggle(doc, kit, 7, 2, 0, h, why) && !h.can_redo(), "edit: a new edit forgets what could be redone");
    for (int i = 0; i < E::kHistory + 10; ++i) E::toggle(doc, kit, 9, 4, 0, h, why);
    int depth = 0;
    while (h.undo(doc, undone)) ++depth;
    check(depth == E::kHistory, "edit: undo is bounded");
  }

  // ---- an edit while playing sounds from its step on ----
  {
    namespace E = live::edit;
    json::Value edited = opened.project;
    E::History h;
    std::string why;
    const E::Place kit = E::find(edited, Str("drums"), Str("c1"));
    check(E::toggle(edited, kit, 8, 2, 0, h, why), "live edit: a step on step 8");
    live::ProjectSound a_sound, b_sound;
    live::ProjectPlayer a_player, b_player;
    check(a_sound.prepare(opened.project, error) && b_sound.prepare(opened.project, error), "live edit: sounds");
    check(a_player.start(opened.project, a_sound, Str("a"), false, 0, 0, error) &&
              b_player.start(opened.project, b_sound, Str("a"), false, 0, 0, error),
          "live edit: both play");
    check(a_player.fill(4 * 6000, error) && b_player.fill(4 * 6000, error), "live edit: four steps");
    check(b_player.replace_clip(kit.track, kit.clip, E::clip_at(edited, kit)), "live edit: the player takes the clip");
    json::Value longer = E::clip_at(edited, kit);
    longer.set("length", json::Value::of(32.0));
    check(!b_player.replace_clip(kit.track, kit.clip, longer), "live edit: a clip of another length is refused");
    double before = 0, after = 0;
    std::vector<float> al(256), ar(256), bl(256), br(256);
    for (uint64_t f = 0; f < 11 * 6000; f += 256) {
      check(a_player.fill(f + 4800, error) && b_player.fill(f + 4800, error), "live edit: fill");
      std::fill(al.begin(), al.end(), 0.0f), std::fill(ar.begin(), ar.end(), 0.0f);
      std::fill(bl.begin(), bl.end(), 0.0f), std::fill(br.begin(), br.end(), 0.0f);
      a_sound.process(al.data(), ar.data(), 256, f);
      b_sound.process(bl.data(), br.data(), 256, f);
      for (int i = 0; i < 256; ++i) (f + i < 8 * 6000 ? before : after) += std::fabs(al[i] - bl[i]);
    }
    check(before == 0, "live edit: nothing changes before step 8");
    check(after > 0, "live edit: the new step sounds");
  }

  // ---- the Steps view's drawing ----
  {
    ui::Ui sv;
    std::vector<Action> o;
    sv.button(ui::Button::level16, true, b, ui::Now{}, o);
    live::edit::Row row;
    row.length = 16;
    row.velocity[5] = 1.0f;
    ui::Painter steps_painter;
    ui::Now head;
    head.playing = true, head.clip[0] = "c1", head.step = 2.5;
    steps_painter.draw(c, sv, b, head, 0, &row);
    namespace css = live::gfx::css;
    const auto on = ui::layout::step(5), off = ui::layout::step(6), playing_step = ui::layout::step(2);
    const int y = on.y + on.h / 2;
    check(pixel(on.x + 8, y) == rgb(live::gfx::blend_colour(css::kStepTop, css::kStepBottom, (y - (on.y + 1)) / static_cast<float>(on.h - 3))),
          "Steps: a step that is on is the web's gold");
    check(pixel(off.x + 8, off.y + off.h / 2) == rgb(css::kSurface3), "Steps: one that is off is dark");
    check(pixel(playing_step.x + 1, playing_step.y + playing_step.h / 2) == rgb(css::kEmeraldBright),
          "Steps: the playhead's step is ringed");
    check(ui::layout::step_pad(0) == 12 && ui::layout::step_pad(5) == 9 &&
              ui::hit(sv, b, on.x + 5, on.y + 5).kind == ui::Hit::on_pad && sv.pad_step(ui::hit(sv, b, on.x + 5, on.y + 5).pad) == 5,
          "Steps: a touch on a step is its pad");
  }

  // ---- recording: takes and overdubs, in the editor ----
  {
    namespace E = live::edit;
    check(E::take_length(1) == 16 && E::take_length(15.9) == 16 && E::take_length(16.4) == 32 &&
              E::take_length(40) == 64 && E::take_length(64) == 64,
          "takes: whole bars of 16, 32 or 64 steps");
    json::Value clip = json::Value::new_object();
    clip.set("id", json::Value::of("x")), clip.set("name", json::Value::of("X"));
    clip.set("length", json::Value::of(16.0)), clip.set("steps", json::Value::new_array());
    check(E::add_hit(clip, false, {3.4, 2, 60, 0.5, 1}), "hit: quantized");
    check(!E::add_hit(clip, false, {2.6, 2, 60, 0.9, 1}), "hit: the same pad and step again adds nothing...");
    const auto& st = project::detail::list(clip, "steps");
    check(st.size() == 1 && project::detail::num(st[0], "step") == 3 && project::detail::num(st[0], "velocity") == 0.9,
          "hit: ...but keeps the louder");
    check(E::add_hit(clip, false, {15.6, 1, 60, 1, 1}) && project::detail::num(st[1], "step") == 0,
          "hit: just before the end lands on step 1");
    json::Value synth = clip;
    synth.get("steps")->items().clear();
    check(E::add_hit(synth, true, {5, 0, 50, 1, 0.1}) && E::add_hit(synth, true, {5, 0, 53, 1, 2.3}) &&
              !E::add_hit(synth, true, {5.2, 0, 50, 1, 1}),
          "hit: synth notes, one of each pitch per step");
    const auto& ss = project::detail::list(synth, "steps");
    check(project::detail::num(ss[0], "duration") == 0.25 && project::detail::num(ss[1], "duration") == 2.25 &&
              project::detail::num(ss[1], "pad") == 1,
          "hit: synth lengths in quarter steps, on free pads");

    json::Value doc = opened.project;
    E::History h;
    std::string id, why;
    const std::vector<E::Hit> hits{{0, 0, 48, 0.8, 2}, {4.2, 0, 55, 0.6, 1}};
    check(!E::record_clip(doc, 1, 0, 16, hits, h, id, why) && why == "The slot has a clip", "take: not over a clip");
    check(!E::record_clip(doc, 1, 1, 16, {}, h, id, why) && why == "Nothing recorded", "take: nothing to keep");
    check(E::record_clip(doc, 1, 1, 16, hits, h, id, why) && id == "take-1", "take: into keys' empty Break slot");
    const ui::Board after = ui::board_of(doc);
    check(after.clip[1][1] == "take-1" && after.clip_name[1][1] == "Take 1" && after.clip_steps[1][1] == 16,
          "take: the slot has the new clip");
    const E::Place take = E::find(doc, Str("keys"), Str("take-1"));
    check(E::row(doc, take, 0, 48).velocity[0] == 0.8f && E::row(doc, take, 0, 55).velocity[4] == 0.6f, "take: its notes");
    const auto reopened = project::open(json::stringify(doc));
    check(reopened.ok, "take: the project still opens");
    if (!reopened.ok) std::printf("  %s\n", reopened.error.c_str());
    check(!E::record_clip(doc, 0, 1, 16, {{1, 3, 60, 1, 1}}, h, id, why) && ui::board_of(doc).clip_name[0][1] == "Fill",
          "take: a filled slot is not touched");
    {
      // A clip of another track already called take-1: the new one is take-2.
      json::Value other = opened.project;
      E::History oh;
      std::string oid;
      other.get("tracks")->items()[0].get("clips")->items()[1].set("id", json::Value::of("take-1"));
      other.get("scenes")->items()[1].get("clips")->set("drums", json::Value::of("take-1"));
      check(E::record_clip(other, 1, 1, 16, hits, oh, oid, why) && oid == "take-2", "take: ids are unique in the project");
    }
    E::Place undone;
    check(h.undo(doc, undone) && h.structural() && undone.track == 1 && ui::board_of(doc).clip[1][1].empty(),
          "take: undo removes it");
    check(json::stringify(doc) == json::stringify(opened.project), "take: undo restores the project exactly");
    check(h.redo(doc, undone) && h.structural() && ui::board_of(doc).clip[1][1] == "take-1", "take: redo");
    E::toggle(doc, take, 9, 0, 48, h, why);
    check(h.undo(doc, undone) && !h.structural(), "a step edit's undo is not structural");
  }

  // ---- recording: the controls ----
  {
    ui::Ui r;
    std::vector<Action> o;
    ui::Now stop_now;
    r.button(ui::Button::bank_b, true, b, stop_now, o);
    r.select_scene(1, b);
    r.button(ui::Button::rec, true, b, stop_now, o);
    check(one(o, Action::record_start, 1, 1) && r.view == ui::View::play && r.rec == ui::Ui::Rec::waiting &&
              r.rec_start == 16,
          "Rec while stopped: the scene starts, one bar to count in");
    o.clear();
    ui::Now t;
    t.playing = true;
    auto at = [&](double step) {
      t.step = step;
      r.follow(t, o);
    };
    at(8);
    r.pad(3, 100, b, t, o);  // too early: only heard
    check(r.take.empty() && o.size() == 1 && o[0].kind == Action::note_on, "count-in: hits are heard, not kept");
    o.clear();
    at(15.7);
    r.pad(0, 127, b, t, o);
    check(r.take.size() == 1 && r.take[0].at == 0 && r.take[0].note == 48, "a hit just before the take is its step 1");
    at(16);
    check(r.rec == ui::Ui::Rec::recording, "the take starts on its bar");
    at(17);
    r.pad(0, 0, b, t, o);
    at(20.2);
    r.pad(7, 64, b, t, o);
    at(22.2);
    r.pad(7, 0, b, t, o);
    o.clear();
    check(r.take.size() == 2 && std::fabs(r.take[0].length - 1) < 1e-9 && std::fabs(r.take[1].at - 4.2) < 1e-9 &&
              std::fabs(r.take[1].length - 2) < 1e-9 && r.take[1].note == 60,
          "the take keeps where and how long");
    at(32.3);
    r.button(ui::Button::rec, true, b, t, o);
    check(one(o, Action::record_end, 1, 1) && r.take_length == 16 && r.rec == ui::Ui::Rec::off,
          "Rec ends it: pressed a little late, still one bar");
    o.clear();
    r.button(ui::Button::rec, true, b, t, o);
    check(o.size() == 1 && o[0].kind == Action::record_start && r.rec_start == 48, "Rec while playing: from the next bar");
    o.clear();
    at(49);
    r.pad(1, 90, b, t, o);
    o.clear();
    at(48 + 64);
    check(one(o, Action::record_end) && r.take_length == 64 && r.rec == ui::Ui::Rec::off, "a take ends itself after four bars");
    o.clear();
    r.button(ui::Button::rec, true, b, t, o);
    o.clear();
    r.button(ui::Button::stop, true, b, t, o);
    check(o.size() == 1 && o[0].kind == Action::stop && r.toast == "Nothing recorded", "Stop with an empty take keeps nothing");
    o.clear();
    at(128);
    r.button(ui::Button::rec, true, b, t, o);
    check(r.rec_start == 144, "Rec right on a bar line starts at the next one");
    r.button(ui::Button::stop, true, b, t, o);
    o.clear();
    r.select_scene(0, b);
    r.button(ui::Button::rec, true, b, t, o);
    check(o.empty() && r.toast == "A clip is here: Overdub adds to it", "Rec over a clip says to overdub");

    // Overdub: keys play k1 (32 steps) from step 0.
    t.clip[1] = "k1";
    t.step = 35.3;
    r.button(ui::Button::overdub, true, b, t, o);
    check(o.empty() && r.rec == ui::Ui::Rec::overdub && r.view == ui::View::play, "Overdub on the playing clip");
    r.pad(2, 127, b, t, o);
    check(one(o, Action::note_on), "overdub: a synth note waits for its release");
    o.clear();
    t.step = 36.3;
    r.pad(2, 0, b, t, o);
    check(o.size() == 2 && o[1].kind == Action::overdub_hit && o[1].fresh && std::fabs(o[1].hit.at - 3.3) < 1e-9 &&
              std::fabs(o[1].hit.length - 1) < 1e-9 && o[1].hit.note == 52,
          "overdub: on release, where in the clip and how long");
    o.clear();
    r.pad(4, 100, b, t, o);
    t.step = 37;
    r.pad(4, 0, b, t, o);
    check(o.size() == 3 && o[2].kind == Action::overdub_hit && !o[2].fresh, "overdub: only the first hit is fresh");
    o.clear();
    r.button(ui::Button::overdub, true, b, t, o);
    check(r.rec == ui::Ui::Rec::off && r.toast == "Overdub off", "Overdub again: off");
    t.clip[0] = "c1";
    r.button(ui::Button::bank_a, true, b, t, o);
    r.button(ui::Button::overdub, true, b, t, o);
    r.pad(6, 100, b, t, o);
    check(o.size() == 2 && o[1].kind == Action::overdub_hit && o[1].hit.pad == 6 && o[1].track == 0,
          "overdub: a kit hit lands at once");
    o.clear();
    t.anchor[0] = 40, t.step = 39.5;  // relaunched: the clip's new start is still ahead
    r.pad(6, 0, b, t, o), r.pad(6, 100, b, t, o);
    check(o.size() == 2 && std::fabs(o[1].hit.at - 15.5) < 1e-9, "overdub: a hit before the clip's start wraps to its end");
    o.clear();
    t.clip[0].clear();
    r.follow(t, o);
    check(r.rec == ui::Ui::Rec::off, "overdub ends when its clip stops");
    ui::Ui q;
    q.button(ui::Button::overdub, true, b, ui::Now{}, o);
    check(q.toast == "Overdub needs a playing clip" && q.rec == ui::Ui::Rec::off, "no overdub while stopped");
  }

  // ---- a recorded clip reaches the player while it plays ----
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    std::string id, why;
    live::ProjectSound snd;
    live::ProjectPlayer pl;
    check(snd.prepare(doc, error) && pl.start(doc, snd, Str("b"), false, 0, 0, error), "player: scene B");
    check(pl.fill(4 * 6000, error), "player: four steps");
    check(E::record_clip(doc, 1, 1, 16, {{0, 0, 48, 1, 2}}, h, id, why), "player: a take");
    const Str take_id(id.c_str());
    check(pl.set_project(doc, error) && pl.launch_clip(Str("keys"), &take_id, error), "player: takes the project, launches the take");
    check(pl.fill(20 * 6000, error), "player: past the bar");
    const auto sl = pl.performance()->slots();
    const auto* keys = pl.performance()->slot(sl, Str("keys"));
    check(keys && keys->has_clip && keys->clip == "take-1" && keys->anchor == 16, "player: the take plays from the bar");
    const auto lean = live::lean(doc);
    check(project::detail::list(lean, "samples").size() == 0 && project::detail::list(doc, "samples").size() == 1 &&
              project::detail::list(lean, "tracks").size() == 2,
          "player: its copy has no samples' audio");
  }

  // ---- the Q-Link knobs ----
  {
    ui::Ui k;
    std::vector<Action> o;
    ui::Now quiet;
    k.button(ui::Button::level16, true, b, quiet, o);
    k.knob(0, 3, b, o);
    check(o.empty() && k.toast == "Press a step, then turn a knob", "knobs: Steps needs a step first");
    k.pad(12, 90, b, quiet, o);
    o.clear();
    check(k.selected_step == 0, "knobs: the pressed step is the selected one");
    k.knob(0, -2, b, o);
    check(one(o, Action::turn_knob, 0, 0) && o[0].step == 0 && o[0].knob == 0 && o[0].delta == -2 && o[0].fresh &&
              o[0].pad == 0,
          "knobs: knob 1 on the selected step");
    k.show_knob("Velocity", "98%");
    o.clear();
    k.knob(0, -1, b, o);
    check(one(o, Action::turn_knob) && !o[0].fresh, "knobs: the same turn goes on");
    o.clear();
    k.knob(1, 1, b, o);
    check(one(o, Action::turn_knob) && o[0].knob == 1 && o[0].fresh, "knobs: another knob is a new change");
    o.clear();
    k.knob(3, 3, b, o);
    check(o.empty(), "knobs: Move waits for four clicks");
    k.knob(3, 2, b, o);
    check(one(o, Action::turn_knob) && o[0].knob == 3 && o[0].delta == 1, "knobs: then moves one step");
    o.clear();
    k.knob(3, -9, b, o);
    check(one(o, Action::turn_knob) && o[0].delta == -2, "knobs: and back two");
    o.clear();
    k.button(ui::Button::qlink, true, b, quiet, o);
    check(k.knob_page() == ui::Ui::Knobs::fresh && k.toast == "Knobs: NEW STEPS", "knobs: Q-Link: the NEW STEPS knobs");
    check(k.qlink_led_page() == 1, "knobs: New Steps lights the second Q-Link LED");
    k.knob(0, -30, b, o);
    k.knob(1, -50, b, o);
    check(o.empty() && std::fabs(k.new_velocity - 0.5f) < 1e-6f && std::fabs(k.new_chance - 0.5f) < 1e-6f,
          "knobs: NEW STEPS set velocity and chance for new steps, with no edit");
    k.pad(12, 100, b, quiet, o);
    check(one(o, Action::toggle_step) && std::fabs(o[0].velocity - 0.5f) < 1e-6f && std::fabs(o[0].chance - 0.5f) < 1e-6f,
          "knobs: a new step takes them");
    o.clear();
    k.button(ui::Button::qlink, true, b, quiet, o);
    check(k.knob_page() == ui::Ui::Knobs::track && k.toast == "Knobs: TRACK", "knobs: then the track's knobs");
    check(k.qlink_led_page() == 2, "knobs: Track on Steps lights the third Q-Link LED");
    k.knob(2, 4, b, o);
    check(one(o, Action::turn_knob, 0) && o[0].step == -1 && o[0].knob == 2, "knobs: a track knob in Steps");
    o.clear();
    k.button(ui::Button::main, true, b, quiet, o);
    k.button(ui::Button::bank_b, true, b, quiet, o);
    k.knob(1, 1, b, o);
    check(one(o, Action::turn_knob, 1) && o[0].step == -1, "knobs: elsewhere they are the selected track's");
    o.clear();
    k.knob_touch(0, true, b, o);
    check(one(o, Action::turn_knob, 1) && o[0].delta == 0 && o[0].knob == 0, "knobs: a touch asks for the value");
    k.show_knob("Level", "60%");
    for (int i = 0; i < 200; ++i) k.tick();
    check(k.knob_name == "Level", "knobs: the value stays while the knob is touched");
    k.knob_touch(0, false, b, o);
    for (int i = 0; i < 200; ++i) k.tick();
    check(k.knob_name.empty(), "knobs: and fades once let go");
    o.clear();
    ui::Painter kp;
    k.show_knob("Level", "60%");
    kp.draw(c, k, b, quiet, 0);
    bool gold = false;
    for (int x = 130; x < 550 && !gold; ++x)
      for (int y = 4; y < 56 && !gold; ++y) gold = pixel(x, y) == rgb(live::theme::kGold);
    check(gold, "knobs: the header shows the knob's name");
  }
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    E::Shown shown;
    std::string why;
    const E::Place kit = E::find(doc, Str("drums"), Str("c1")), keys = E::find(doc, Str("keys"), Str("k1"));
    auto entry = [&](E::Place p, int i) -> const json::Value& {
      return project::detail::list(E::clip_at(doc, p), "steps")[i];
    };
    int step = 0;
    check(E::step_knob(doc, kit, step, 0, 0, 0, -5, true, h, shown, why) && project::detail::num(entry(kit, 0), "velocity") == 0.95 &&
              shown.name == "Velocity" && shown.value == "95%",
          "step knob: velocity");
    check(!E::step_knob(doc, kit, step, 0, 0, 0, 0, false, h, shown, why) && shown.value == "95%", "step knob: a touch shows it");
    check(E::step_knob(doc, kit, step, 0, 0, 0, -200, false, h, shown, why) && project::detail::num(entry(kit, 0), "velocity") == 0.01,
          "step knob: velocity stops at 1%");
    check(E::step_knob(doc, kit, step, 0, 0, 1, -30, true, h, shown, why) && project::detail::num(entry(kit, 0), "probability") == 0.7 &&
              shown.value == "70%",
          "step knob: chance");
    check(!E::step_knob(doc, kit, step, 0, 0, 2, 1, true, h, shown, why) && why == "Length is for synth notes", "step knob: no kit length");
    why.clear();
    check(!E::step_knob(doc, kit, step, 3, 0, 0, 1, true, h, shown, why) && why == "No note on step 1", "step knob: needs a note");
    check(E::step_knob(doc, kit, step, 0, 0, 3, 1, true, h, shown, why) && step == 1 && project::detail::num(entry(kit, 0), "step") == 1 &&
              shown.value == "Step 2",
          "step knob: Move takes the step along");
    check(E::step_knob(doc, kit, step, 0, 0, 3, -3, true, h, shown, why) && step == 14, "step knob: Move wraps round the clip");
    check(E::toggle(doc, kit, 13, 0, 0, h, why), "step knob: another step of the pad");
    check(!E::step_knob(doc, kit, step, 0, 0, 3, -1, true, h, shown, why) && why == "Step 14 has this note" && step == 14,
          "step knob: Move won't land on the pad's own step");
    int synth_step = 2;
    check(E::step_knob(doc, keys, synth_step, 0, 40, 2, 2, true, h, shown, why) && project::detail::num(entry(keys, 0), "duration") == 3.5 &&
              shown.value == "3.5 steps",
          "step knob: a synth note's length in quarter steps");
    check(E::toggle(doc, keys, 3, 0, 52, h, why), "step knob: a note on step 4 (pad 0)");
    check(E::step_knob(doc, keys, synth_step, 0, 40, 3, 1, true, h, shown, why) && synth_step == 3 &&
              project::detail::num(entry(keys, 0), "pad") == 1 && project::detail::num(entry(keys, 0), "note") == 40,
          "step knob: a synth note moves onto a free pad of its new step");
    E::Place undone;
    check(h.undo(doc, undone) && project::detail::num(entry(keys, 0), "step") == 2, "step knob: undo takes the move back");
    // Track knobs: level (with a mirrored parameter), pan and sends.
    json::Value assignment = json::Value::new_object();
    assignment.set("id", json::Value::of("track.drums.gain")), assignment.set("base", json::Value::of(0.8));
    doc.get("parameters")->push(assignment);
    { auto fresh = doc; E::History fresh_history;
      check(E::track_knob(fresh, 0, 1, 1, true, fresh_history, shown, why) && fresh.get("mix"), "track knob: pan creates a mixer immediately"); }
    doc.set("mix", json::parse(Str("{\"version\":1,\"tracks\":{},\"returns\":[[],[]],\"tempos\":[]}")).value);
    check(E::track_knob(doc, 0, 0, 5, true, h, shown, why) && project::detail::num(project::detail::list(doc, "tracks")[0], "volume") == rack::fader_gain(0.98) &&
              shown.name == "Level" && shown.value == "-0.5 dB",
          "track knob: level");
    check(project::detail::num(project::detail::list(doc, "parameters")[0], "base") == rack::fader_gain(0.98), "track knob: the gain's base follows");
    check(!doc.get("mix")->get("tracks")->get("drums"), "track knob: no strip yet");
    check(E::track_knob(doc, 0, 1, -10, true, h, shown, why) && shown.value == "L20" &&
              project::detail::num(*doc.get("mix")->get("tracks")->get("drums"), "pan") == 0.4,
          "track knob: pan makes the track's strip");
    check(E::track_knob(doc, 0, 3, 30, true, h, shown, why) &&
              project::detail::list(*doc.get("mix")->get("tracks")->get("drums"), "sends")[1].as_number() == 0.3 && shown.value == "30%",
          "track knob: send 2");
    check(E::pan_text(0.5) == "C" && E::pan_text(0.75) == "R50", "track knob: pan text");
    {
      const auto reopened = project::open(json::stringify(doc));
      check(reopened.ok, "track knob: the edited project is valid");
      if (!reopened.ok) std::printf("  %s\n", reopened.error.c_str());
    }
    check(h.undo(doc, undone) && h.structural() && h.undo(doc, undone), "track knob: undo send and pan");
    check(!doc.get("mix")->get("tracks")->get("drums"), "track knob: undo removes the strip it made");
    check(h.undo(doc, undone) && project::detail::num(project::detail::list(doc, "tracks")[0], "volume") == 0.8 &&
              project::detail::num(project::detail::list(doc, "parameters")[0], "base") == 0.8,
          "track knob: undo restores the level and its base");
    check(h.redo(doc, undone) && project::detail::num(project::detail::list(doc, "tracks")[0], "volume") == rack::fader_gain(0.98), "track knob: redo");
  }
  // ---- a level change reaches the sound while it plays ----
  {
    namespace E = live::edit;
    auto run = [&](bool quieten) {
      json::Value doc = opened.project;
      E::History h;
      E::Shown shown;
      std::string why;
      live::ProjectSound snd;
      live::ProjectPlayer pl;
      Str err;
      if (!snd.prepare(doc, err) || !pl.start(doc, snd, Str("a"), false, 0, 0, err)) return -1.0;
      std::vector<float> l(256), r(256);
      double later = 0;
      for (uint64_t f = 0; f < 36000; f += 256) {
        if (quieten && f == 256 * 20) {
          E::track_knob(doc, 1, 0, -100, true, h, shown, why);
          if (!pl.set_project(doc, err)) return -1.0;
        }
        if (!pl.fill(f + 256, err)) return -1.0;
        std::fill(l.begin(), l.end(), 0.0f), std::fill(r.begin(), r.end(), 0.0f);
        snd.process(l.data(), r.data(), 256, f);
        if (f >= 15000)
          for (float v : l) later += v * v;
      }
      return later;
    };
    const double loud = run(false), quiet = run(true);
    check(loud > 1e-3, "knob level: the synth note sounds");
    check(quiet >= 0 && quiet < loud * 1e-4, "knob level: at 0% it is silent from the next window");
  }

  // ---- the Song view ----
  {
    ui::Ui sg;
    std::vector<Action> o;
    ui::Now quiet;
    check(b.chain.size() == 1 && b.chain[0].id == "o1" && b.chain[0].scene == 0 && b.chain[0].repeats == 1 && !b.loop,
          "song: the board's chain");
    sg.button(ui::Button::menu, true, b, quiet, o);
    sg.pad(9, 100, b, quiet, o);
    sg.button(ui::Button::menu, false, b, quiet, o);
    check(sg.view == ui::View::song && o.empty(), "song: Menu + pad 10 opens Song");
    check(ui::Ui::song_scene(12) == 0 && ui::Ui::song_scene(13) == 1 && ui::Ui::song_scene(0) == 12, "song: scenes 1-4 on the top row");
    sg.pad(13, 100, b, quiet, o);
    check(one(o, Action::song_add, -2, 1) && o[0].step == 1, "song: a scene's pad adds it after the selected block");
    o.clear();
    sg.pad(14, 100, b, quiet, o);
    check(o.empty() && sg.toast == "No scene 3", "song: a pad with no scene says so");
    sg.wheel(5, b);
    check(sg.song_block(b) == 0, "song: the wheel stays within the chain");
    sg.button(ui::Button::wheel, true, b, quiet, o);
    check(one(o, Action::play_song) && o[0].step == 0, "song: the wheel press plays from the selected block");
    o.clear();
    sg.button(ui::Button::play, true, b, quiet, o);
    check(one(o, Action::play_song) && o[0].step == 0, "song: Play plays from the selected block");
    o.clear();
    sg.button(ui::Button::play_start, true, b, quiet, o);
    check(one(o, Action::play_song) && o[0].step == -1, "song: Play Start plays from the top");
    o.clear();
    sg.button(ui::Button::erase, true, b, quiet, o);
    sg.button(ui::Button::wheel, true, b, quiet, o);
    sg.button(ui::Button::erase, false, b, quiet, o);
    check(one(o, Action::song_remove) && o[0].step == 0, "song: Erase + wheel press removes the block");
    o.clear();
    sg.knob(0, 2, b, o);
    check(o.empty(), "song: repeats wait for three clicks");
    sg.knob(0, 1, b, o);
    check(one(o, Action::turn_knob) && o[0].song && o[0].knob == 0 && o[0].delta == 1 && o[0].step == 0 && o[0].fresh,
          "song: knob 1 sets the block's repeats");
    o.clear();
    sg.show_knob("Repeats", "x2");
    sg.knob(0, 3, b, o);
    check(one(o, Action::turn_knob) && !o[0].fresh, "song: the turn goes on while its value shows");
    o.clear();
    for (int i = 0; i < 200; ++i) sg.tick();
    sg.knob(0, 3, b, o);
    check(one(o, Action::turn_knob) && o[0].fresh, "song: after a pause it is a new change");
    o.clear();
    sg.show_knob("Repeats", "x4");
    sg.knob(0, 2, b, o);
    sg.knob(3, 4, b, o);
    sg.knob(0, 1, b, o);
    check(o.size() == 1 && o[0].knob == 3, "song: another knob clears the clicks a turn saved up");
    o.clear();
    ui::Board two = b;
    two.chain.push_back({"song-9", 1, 2});
    sg.block = 0;
    sg.knob(1, 4, two, o);
    sg.show_knob("Move", "Block 2");
    sg.block = 1;  // the session moves the selection with the block
    sg.knob(1, 4, two, o);
    check(o.size() == 2 && o[0].knob == 1 && o[0].fresh && !o[1].fresh && o[1].step == 1,
          "song: one Move turn is one change as the block moves");
    o.clear();
    ui::Board empty = b;
    empty.chain.clear(), empty.song = false;
    sg.knob(0, 3, empty, o);
    check(o.empty() && sg.toast == "Add a scene: press its pad", "song: an empty song asks for a scene");
    sg.knob(2, 4, empty, o);
    check(one(o, Action::turn_knob) && o[0].knob == 2, "song: End works on an empty song");
    o.clear();
    sg.pad(12, 100, empty, quiet, o);
    check(one(o, Action::song_add, -2, 0) && o[0].step == 0, "song: the first block goes first");
    o.clear();
    // Drawing: the selected block in gold, the playing one in emerald.
    ui::Painter sp;
    ui::Now n;
    n.playing = true, n.song = true, n.block = "o1";
    sg.block = 0;
    sp.draw(c, sg, b, n, 0);
    namespace css = live::gfx::css;
    auto lit = [&](live::Rect r, live::theme::Rgb k) {
      for (int y = r.y; y < r.y + r.h; ++y)
        for (int x = r.x; x < r.x + r.w; ++x)
          if (pixel(x, y) == rgb(k)) return true;
      return false;
    };
    const auto r = ui::layout::song_row(0);
    check(pixel(r.x + 1, r.y + r.h / 2) == rgb(css::kGold), "song: the selected block is outlined in gold");
    check(lit(r, css::kEmeraldBright), "song: the playing block is emerald");
    ui::Painter sp2;
    sp2.draw(c, sg, two, n, 0);
    check(!lit(ui::layout::song_row(1), css::kEmeraldBright), "song: only the playing block is emerald");
    sg.block = 45;
    ui::Board long_song = two;
    long_song.chain.resize(64);
    check(ui::layout::song_first(45, 64) == 43 && ui::layout::song_first(1, 64) == 0 && ui::layout::song_first(63, 64) == 59 &&
              ui::hit(sg, long_song, r.x + 10, r.y + 10).block == 43,
          "song: a long song scrolls so the selected block shows");
    sg.block = 0;
    const auto r3 = ui::layout::song_row(3);
    check(ui::hit(sg, b, r.x + 10, r.y + 10).kind == ui::Hit::on_block && ui::hit(sg, b, r.x + 10, r.y + 10).block == 0 &&
              ui::hit(sg, b, r3.x + 5, r3.y + 5).block == 3,
          "song: a touch finds its block");
  }
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    E::Shown shown;
    std::string why;
    auto chain = [&] { return project::detail::list(*doc.get("performance"), "chain"); };
    auto id_at = [&](int i) { return std::string(project::detail::str(chain()[i], "id").c_str()); };
    json::Value position = json::Value::new_object();
    position.set("occurrenceId", json::Value::of("o1")), position.set("offset", json::Value::of(4.0));
    doc.get("performance")->set("position", position);
    int at = 1;
    check(E::song_insert(doc, at, 1, h, why) && at == 1 && chain().size() == 2 && id_at(1) == "song-1" &&
              project::detail::str(chain()[1], "sceneId") == "b" && project::detail::num(chain()[1], "repeats") == 1,
          "song edit: a block of scene B after the first");
    check(!doc.get("performance")->get("position"), "song edit: an edit forgets the stop position");
    at = 0;
    check(E::song_insert(doc, at, 0, h, why) && id_at(0) == "song-2" && chain().size() == 3, "song edit: ids stay unique");
    at = 9;
    check(!E::song_insert(doc, at, 5, h, why) && why == "No scene 6", "song edit: only scenes the project has");
    check(E::song_knob(doc, at = 2, 0, 2, true, h, shown, why) && project::detail::num(chain()[2], "repeats") == 3 &&
              shown.name == "Repeats" && shown.value == "x3",
          "song edit: repeats");
    check(E::song_knob(doc, at = 2, 0, 40, true, h, shown, why) && project::detail::num(chain()[2], "repeats") == 16,
          "song edit: at most 16 repeats");
    check(!E::song_knob(doc, at = 2, 0, 0, false, h, shown, why) && shown.value == "x16", "song edit: a touch shows them");
    at = 2;
    check(E::song_knob(doc, at, 1, -2, true, h, shown, why) && at == 0 && id_at(0) == "song-1" && id_at(1) == "song-2" &&
              id_at(2) == "o1" && shown.value == "Block 1",
          "song edit: Move puts the block earlier; the selection follows");
    check(!E::song_knob(doc, at, 1, -1, true, h, shown, why), "song edit: no further than the start");
    check(E::song_knob(doc, at, 2, 1, true, h, shown, why) && project::detail::str(*doc.get("performance"), "end") == "loop" &&
              shown.value == "Loop",
          "song edit: End loops");
    check(E::song_knob(doc, at, 3, 1, true, h, shown, why) && project::detail::str(chain()[0], "sceneId") == "a" &&
              shown.value == "Verse",
          "song edit: Scene wraps round the scenes");
    check(E::song_remove(doc, 1, h, why) && chain().size() == 2 && id_at(1) == "o1", "song edit: remove a block");
    check(!E::song_remove(doc, 5, h, why) && why == "No block here", "song edit: nothing to remove");
    {
      const auto reopened = project::open(json::stringify(doc));
      check(reopened.ok, "song edit: the edited project is valid");
      if (!reopened.ok) std::printf("  %s\n", reopened.error.c_str());
    }
    E::Place none;
    check(h.undo(doc, none) && h.structural() && chain().size() == 3 && id_at(1) == "song-2", "song edit: undo brings it back");
    check(h.undo(doc, none) && project::detail::str(chain()[0], "sceneId") == "b", "song edit: undo the scene");
    for (int i = 0; i < 6; ++i) h.undo(doc, none);
    check(chain().size() == 1 && id_at(0) == "o1" && doc.get("performance")->get("position"),
          "song edit: undo all the way restores the song and its position");
    check(h.redo(doc, none) && chain().size() == 2, "song edit: redo");
  }
  // ---- playing the song from a block ----
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    std::string why;
    int at = 1;
    check(E::song_insert(doc, at, 1, h, why), "song play: a second block (Break)");
    json::Value from = live::lean(doc);
    json::Value position = json::Value::new_object();
    position.set("occurrenceId", json::Value::of("song-1")), position.set("offset", json::Value::of(0.0));
    from.get("performance")->set("position", position);
    live::ProjectSound snd;
    live::ProjectPlayer pl;
    Str occurrence;
    check(snd.prepare(doc, error) && pl.start(from, snd, Str(), true, 0, 0, error, true), "song play: from block 2");
    check(pl.fill(4 * 6000, error), "song play: four steps");
    check(pl.performance()->occurrence(occurrence) && occurrence == "song-1" && pl.performance()->scene_id() == "b",
          "song play: it plays block 2's scene");
    check(E::song_remove(doc, 1, h, why), "song play: remove the playing block");
    const bool taken = pl.set_project(doc, error);
    check(pl.fill(40 * 6000, error) || !taken, "song play: the player carries on after the change");
    live::ProjectPlayer top;
    live::ProjectSound snd2;
    check(snd2.prepare(doc, error) && top.start(doc, snd2, Str(), true, 0, 0, error) &&
              top.performance()->occurrence(occurrence) && occurrence == "o1",
          "song play: from the top it starts at block 1");
  }

  // ---- text and the Q-Link strip ----
  {
    using live::gfx::Font;
    using live::gfx::Surface;
    check(Surface::width(Font::title, "Foundation") > Surface::width(Font::caption, "Foundation") &&
              std::abs(Surface::width(Font::mono, "0000") - 4 * Surface::width(Font::mono, "1")) <= 2,
          "text: sizes differ; the mono face is monospaced");
    check(Surface::width(Font::title, "AV") < Surface::width(Font::title, "A") + Surface::width(Font::title, "V"),
          "text: kerning pulls A and V together");
    const std::string cut = Surface::fit(Font::title, "A very long clip name indeed", 120);
    check(Surface::width(Font::title, cut) <= 120 && cut.size() > 3 && cut.substr(cut.size() - 3) == "\xE2\x80\xA6",
          "text: a long name is cut with an ellipsis to fit");
    check(Surface::width(Font::body, "1\xE2\x80\x93" "4") > Surface::width(Font::body, "14"), "text: UTF-8 marks are drawn");
    {
      static Surface pic;
      pic.fill({0, 0, 60, 60}, {0, 0, 0});
      pic.round({0, 0, 40, 40}, 7, {200, 100, 50});
      const std::uint32_t full = 200u << 16 | 100u << 8 | 50u, edge = pic.at(1, 2);
      check(pic.at(0, 0) == 0 && pic.at(20, 20) == full && edge != 0 && edge != full,
            "drawing: rounded corners are antialiased");
    }
    json::Value doc = opened.project;
    ui::Ui q;
    ui::fill_strip(q, doc, b);
    check(q.strip_page == "TRACK" && q.strip[0].name == "Level" && q.strip[0].value == "-1.9 dB" && q.strip[1].value == "C",
          "strip: audio level and centre pan before the first mixer edit");
    std::vector<Action> o;
    q.button(ui::Button::level16, true, b, ui::Now{}, o);
    ui::fill_strip(q, doc, b);
    check(q.strip_page == "STEP" && q.strip[0].name == "Velocity" && q.strip[0].value == "\xE2\x80\x93", "strip: no step selected yet");
    q.pad(12, 90, b, ui::Now{}, o);  // step 1 of Groove: pad 0 is on
    ui::fill_strip(q, doc, b);
    check(q.strip[0].value == "100%" && q.strip[1].value == "100%" && q.strip[3].value == "Step 1", "strip: the selected step's values");
    q.menu = false, q.view = ui::View::song;
    ui::fill_strip(q, doc, b);
    check(q.strip_page == "SONG" && q.strip[0].value == "x1" && q.strip[2].value == "Stop" && q.strip[3].value == "Verse",
          "strip: the song block's values");
    check(json::stringify(doc) == json::stringify(opened.project), "strip: reading the values changes nothing");
  }

  // ---- the Mix view ----
  {
    ui::Ui mx;
    std::vector<Action> o;
    ui::Now quiet;
    mx.button(ui::Button::menu, true, b, quiet, o);
    mx.pad(10, 100, b, quiet, o);
    mx.button(ui::Button::menu, false, b, quiet, o);
    check(mx.view == ui::View::mix && o.empty(), "mix: Menu + pad 11 opens Mix");
    mx.pad(13, 100, b, quiet, o);
    check(mx.track == 1 && o.empty(), "mix: a top pad selects its track");
    mx.pad(4, 100, b, quiet, o);
    check(one(o, Action::mute_track, 0), "mix: a bottom pad mutes its track");
    o.clear();
    mx.button(ui::Button::shift, true, b, quiet, o);
    mx.pad(5, 100, b, quiet, o);
    mx.button(ui::Button::shift, false, b, quiet, o);
    check(one(o, Action::solo_track, 1), "mix: Shift + a bottom pad solos");
    o.clear();
    mx.pad(0, 100, b, quiet, o);
    check(o.empty() && mx.toast == "No track 5", "mix: the second row of mutes is tracks 5-8");
    mx.pad(8, 100, b, quiet, o);
    check(mx.toast == "No track 5", "mix: so is the second row of selects");
    mx.knob(0, 2, b, o);
    check(one(o, Action::turn_knob, 1) && o[0].step == -1 && !o[0].song, "mix: the knobs are the selected track's");
    o.clear();
    // Drawing: a muted strip's M in ruby, a soloed one's S in gold, the selected strip ringed.
    ui::Board mb = b;
    mb.muted[0] = true, mb.soloed[1] = true;
    ui::Painter mp;
    mp.draw(c, mx, mb, quiet, 0);
    namespace css = live::gfx::css;
    const auto m0 = ui::layout::mute_button(0), s1 = ui::layout::solo_button(1), s0 = ui::layout::solo_button(0);
    check(pixel(m0.x + 4, m0.y + m0.h / 2) == rgb(live::gfx::blend_colour(css::kSurface2, css::kRuby, 0.55f)), "mix: a muted track's M is ruby");
    check(pixel(s0.x + 4, s0.y + s0.h / 2) == rgb(css::kSurface2), "mix: an unsoloed track's S is plain");
    check(pixel(s1.x, s1.y + s1.h / 2) == rgb(css::kGoldBright), "mix: a soloed track's S is gold");
    const auto strip1 = ui::layout::mix_strip(1);
    check(pixel(strip1.x + 1, strip1.y + strip1.h / 2) == rgb(css::kGold), "mix: the selected strip is ringed");
    const auto bar = ui::layout::level_bar(1);
    check(pixel(bar.x + bar.w / 2, bar.y + bar.h - 3) != rgb(css::kSurface3) && pixel(bar.x + bar.w / 2, bar.y + 3) == rgb(css::kSurface3),
          "mix: the level bar fills from the bottom");
    check(ui::hit(mx, b, m0.x + 3, m0.y + 3).kind == ui::Hit::on_mute && ui::hit(mx, b, s1.x + 3, s1.y + 3).kind == ui::Hit::on_solo &&
              ui::hit(mx, b, s1.x + 3, s1.y + 3).track == 1 && ui::hit(mx, b, strip1.x + 5, strip1.y + 40).kind == ui::Hit::on_track,
          "mix: touch M, S or a strip");
  }
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    std::string why;
    check(!E::is_muted(doc, 0) && E::toggle_mute(doc, 0, h, why) && E::is_muted(doc, 0) &&
              doc.get("performance")->get("mutes")->get("drums")->as_bool(),
          "mute: a saved mute");
    check(ui::board_of(doc).muted[0], "mute: the board shows it");
    check(E::toggle_mute(doc, 0, h, why) && !E::is_muted(doc, 0) && !doc.get("performance")->get("mutes")->get("drums"),
          "mute: and off again");
    E::track_at(doc, 1).set("muted", json::Value::of(true));
    check(E::is_muted(doc, 1) && E::toggle_mute(doc, 1, h, why) && !E::is_muted(doc, 1) &&
              !project::detail::list(doc, "tracks")[1].get("muted")->as_bool(),
          "mute: unmuting clears the track's own mute");
    check(E::toggle_solo(doc, 1, h, why) && E::is_soloed(doc, 1) && project::detail::list(*doc.get("performance"), "solos").size() == 1,
          "solo: on");
    {
      const auto reopened = project::open(json::stringify(doc));
      check(reopened.ok, "mix edit: the edited project is valid");
      if (!reopened.ok) std::printf("  %s\n", reopened.error.c_str());
    }
    E::Place none;
    check(h.undo(doc, none) && h.structural() && !E::is_soloed(doc, 1), "mix edit: undo the solo");
    check(h.undo(doc, none) && E::is_muted(doc, 1) && project::detail::list(doc, "tracks")[1].get("muted")->as_bool(),
          "mix edit: undo puts the track's own mute back");
    check(!E::toggle_mute(doc, 7, h, why) && why == "No track", "mix edit: only tracks the project has");
    json::Value solo = opened.project;
    check(E::toggle_solo(solo, 0, h, why) && ui::board_of(solo).soloed[0] && E::toggle_solo(solo, 0, h, why) &&
              !E::is_soloed(solo, 0) && project::detail::list(*solo.get("performance"), "solos").size() == 0 && !ui::board_of(solo).soloed[0],
          "solo: the board shows it, and a second press turns it off");
  }
  // ---- a mute or solo silences a track while it plays ----
  {
    namespace E = live::edit;
    auto run = [&](int what) {
      json::Value doc = opened.project;
      E::History h;
      std::string why;
      live::ProjectSound snd;
      live::ProjectPlayer pl;
      Str err;
      if (!snd.prepare(doc, err) || !pl.start(doc, snd, Str("a"), false, 0, 0, err)) return -1.0;
      std::vector<float> l(256), r(256);
      double later = 0;
      for (uint64_t f = 0; f < 36000; f += 256) {
        if (what && f == 256 * 20) {
          if (what == 1) E::toggle_mute(doc, 1, h, why);  // mute the synth
          else E::toggle_solo(doc, 0, h, why);          // solo the drums: the synth goes quiet
          if (!pl.set_project(doc, err)) return -1.0;
        }
        if (!pl.fill(f + 256, err)) return -1.0;
        std::fill(l.begin(), l.end(), 0.0f), std::fill(r.begin(), r.end(), 0.0f);
        snd.process(l.data(), r.data(), 256, f);
        if (f >= 15000)
          for (float v : l) later += v * v;
      }
      return later;
    };
    const double loud = run(0), muted = run(1), soloed = run(2);
    check(loud > 1e-3 && muted >= 0 && muted < loud * 1e-3, "mix play: a muted synth goes quiet from the next window");
    check(soloed >= 0 && soloed < loud * 1e-3, "mix play: soloing the drums quiets the synth");
  }

  // ---- the melodic editor: a piano roll for synth and MIDI clips ----
  {
    namespace E = live::edit;
    json::Value doc = opened.project;
    const E::Place keys = E::find(doc, Str("keys"), Str("k1"));
    const E::Roll r = E::roll(doc, keys);
    check(r.length == 32 && r.notes.size() == 2 && r.notes[0].note == 40 && r.notes[0].at == 2 && r.notes[0].length == 3 &&
              !r.notes[0].sequence && r.notes[1].note == 45 && r.notes[1].at == 6 && r.notes[1].length == 2 && r.notes[1].sequence,
          "roll: a synth clip's step and sequence notes, with their lengths");
    check(E::roll(doc, E::find(doc, Str("drums"), Str("c1"))).notes.empty(), "roll: a kit clip has none");
    // A MIDI track: edited by pitch; an entry without its own note plays its pad's root note.
    json::Value midi = opened.project;
    E::track_at(midi, 1).get("machine")->set("id", json::Value::of("xmp.midi"));
    E::History h;
    std::string why;
    check(E::is_melodic(midi, keys) && !E::is_synth(midi, keys), "roll: a MIDI clip is melodic");
    check(E::toggle(midi, keys, 9, 0, 67, h, why) && E::roll(midi, keys).notes.size() == 3 && E::row(midi, keys, 0, 67).velocity[9] > 0,
          "roll: a note on a MIDI clip");
    json::Value bare = json::Value::new_object();
    bare.set("step", json::Value::of(11.0)), bare.set("pad", json::Value::of(3.0)), bare.set("velocity", json::Value::of(1.0));
    bare.set("probability", json::Value::of(1.0));
    E::clip_at(midi, keys).get("steps")->push(bare);
    check(E::row(midi, keys, 0, 60).velocity[11] > 0 && E::row(midi, keys, 0, 51).velocity[11] == 0,
          "roll: a MIDI entry with no note plays its pad's root note (not 48 + pad)");

    // The interface: Steps on a synth track is the roll.
    ui::Ui ro;
    std::vector<Action> o;
    ui::Now quiet;
    ro.button(ui::Button::bank_b, true, b, quiet, o);
    ro.button(ui::Button::level16, true, b, quiet, o);
    check(ro.melodic(b) && ro.view == ui::View::steps, "roll: Steps on the synth track");
    ro.button(ui::Button::plus, true, b, quiet, o);
    check(ro.step_note == 41 && ro.toast == "Editing F2", "roll: + raises the edited note a semitone");
    ro.button(ui::Button::shift, true, b, quiet, o);
    ro.button(ui::Button::minus, true, b, quiet, o);
    ro.button(ui::Button::shift, false, b, quiet, o);
    check(ro.step_note == 29 && ro.roll_low <= 29 && ro.roll_low + ui::layout::kRollRows - 1 >= 29 && o.empty(), "roll: Shift + - drops an octave; the roll follows");
    ro.step_note = 100, ro.fit_roll();
    check(ro.roll_low == 95, "roll: a far jump centres the note");
    ro.step_note = ro.roll_low + ui::layout::kRollRows, ro.fit_roll();
    check(ro.roll_low == 96, "roll: one past the top scrolls the roll one row");
    {
      ui::Board mb = b;
      mb.kind[1] = ui::Kind::midi;
      ui::Ui mu;
      std::vector<Action> mo;
      mu.button(ui::Button::bank_b, true, mb, quiet, mo);
      mu.button(ui::Button::level16, true, mb, quiet, mo);
      mu.pad(12, 90, mb, quiet, mo);
      check(mu.melodic(mb) && one(mo, Action::toggle_step, 1, 0) && mo[0].note == mu.step_note, "roll: Steps pads edit a MIDI track too");
    }
    ro.step_note = 40, ro.fit_roll();
    const auto cell = ui::layout::roll_cell(2, ro.roll_low + ui::layout::kRollRows - 1 - 40);
    const auto h2 = ui::hit(ro, b, cell.x + 5, cell.y + 5);
    check(h2.kind == ui::Hit::on_note && h2.step == 2 && h2.note == 40, "roll: a touch finds its step and pitch");
    ro.roll_touch(5, 43, b, o);
    check(one(o, Action::toggle_step, 1, 0) && o[0].step == 5 && o[0].note == 43 && ro.step_note == 43 && ro.selected_step == 5,
          "roll: touching the roll toggles that note and selects it");
    o.clear();
    // Drawing: the note on step 3 (40) as a gold bar, the edited row lit, the playhead.
    ro.step_note = 40, ro.selected_step = 2, ro.fit_roll();
    ui::Painter rp;
    ui::Now n;
    n.playing = true, n.clip[1] = "k1", n.step = 6.5;
    rp.draw(c, ro, b, n, 0, nullptr, &r);
    namespace css = live::gfx::css;
    const auto bar = ui::layout::roll_cell(3, ro.roll_low + ui::layout::kRollRows - 1 - 40);
    const int y = bar.y + bar.h / 2;
    check(pixel(bar.x + 10, y) != rgb(css::kSurface3) && pixel(bar.x + 10, y) != rgb(css::kSurface), "roll: a note is a bar");
    const auto lane_end = ui::layout::roll_cell(15, ro.roll_low + ui::layout::kRollRows - 1 - 40);
    check(pixel(lane_end.x + 30, lane_end.y + lane_end.h / 2) == rgb(css::kSurface3), "roll: the edited note's row is lit");
    const auto other_lane = ui::layout::roll_cell(15, ro.roll_low + ui::layout::kRollRows - 1 - 41);
    check(pixel(other_lane.x + 30, other_lane.y + other_lane.h / 2) != rgb(css::kSurface3), "roll: other rows are not");
    const auto start = ui::layout::roll_cell(2, ro.roll_low + ui::layout::kRollRows - 1 - 40);
    check(pixel(start.x + 2, start.y + start.h / 2) == rgb(css::kIvory),
          "roll: the selected note is ringed");
    const auto head = ui::layout::roll_cell(6, 0);
    check(pixel(head.x, head.y + 10) == rgb(css::kEmeraldBright), "roll: the playhead");
  }

  // ---- the REC display ----
  {
    ui::Ui rv;
    std::vector<Action> o;
    rv.button(ui::Button::bank_b, true, b, ui::Now{}, o);
    rv.select_scene(1, b);
    rv.button(ui::Button::rec, true, b, ui::Now{}, o);
    ui::Painter rp;
    ui::Now n;
    n.playing = true, n.step = 5;
    rp.draw(c, rv, b, n, 0);
    const auto tag = ui::layout::toolbar_button(live::gfx::Surface::width(live::gfx::Font::base, "REC IN 3"));
    check(pixel(tag.x + tag.w / 2, tag.y + tag.h - 2) == rgb(live::gfx::css::kRuby), "the Play view shows the count-in");
  }

  // ---- the Sample view ----
  {
    namespace S = live::sample;
    // The recorder waits for sound, keeps 10 ms from before it, and stops at its limit.
    S::Recorder rec;
    rec.arm();
    std::vector<float> quiet(4800, 0.001f), loud(2400, 0.5f);
    rec.feed(quiet.data(), static_cast<int>(quiet.size()));
    check(rec.state == S::Recorder::State::armed && rec.pcm().empty(), "sample: quiet input waits");
    rec.feed(loud.data(), static_cast<int>(loud.size()));
    check(rec.state == S::Recorder::State::recording && rec.pcm().size() == S::kPreroll + loud.size(),
          "sample: the first sound starts the take, with 10 ms before it");
    rec.feed(quiet.data(), static_cast<int>(quiet.size()));
    rec.stop();
    check(rec.state == S::Recorder::State::done, "sample: stopping ends the take");
    std::vector<float> take = rec.take();
    S::trim_and_normalize(take);
    float peak = 0;
    for (float v : take) peak = std::max(peak, std::fabs(v));
    check(peak == 1.0f && take.size() == loud.size() + 2 * S::kMargin, "sample: trimmed to the sound and normalized");
    std::vector<float> silent(1000, 0.001f);
    S::trim_and_normalize(silent);
    check(silent.empty(), "sample: a silent take is nothing");
    // Edits: the part between start and end, reversed, retuned, faded, levelled.
    std::vector<float> ramp(4800);
    for (int i = 0; i < 4800; ++i) ramp[static_cast<size_t>(i)] = i / 4800.0f;
    S::Edit e;
    e.start = 100, e.end = 1100, e.reverse = true;
    auto part = S::render(ramp, e);
    check(part.size() == 1000 && std::fabs(part[0] - ramp[1099]) < 1e-6f, "sample: start, end and reverse");
    e = S::Edit{}, e.tune = 12;
    check(S::render(ramp, e).size() == 2400, "sample: an octave up is half as long");
    e = S::Edit{}, e.fade_in = 10, e.level = 0.5f;
    part = S::render(ramp, e);
    check(part[0] == 0 && std::fabs(part[4000] - ramp[4000] * 0.5f) < 1e-6f, "sample: fade in and level");

    // Identical fixture and actions to device-native-sampler.test.ts.
    {
      const std::vector<float> pcm{0.1f,0.2f,0.3f,0.4f,-0.1f,-0.2f,-0.3f,-0.4f};
      ui::Ui shared; shared.open(ui::View::sample);shared.sample_done(8);
      std::vector<ui::Action> actions;ui::Now state;
      shared.button(ui::Button::shift,true,b,state,actions);shared.knob(3,3,b,actions);shared.button(ui::Button::shift,false,b,state,actions);
      check(S::chop_boundaries(8,shared.sample)==std::vector<int>({0,2,4,6,8}),"shared sampler fixture: displayed boundaries");
      shared.pad(2,1,b,state,actions);
      check(actions.size()==1 && actions[0].kind==ui::Action::sample_audition && actions[0].pad==2,"shared sampler fixture: pad 3 auditions chop 3");
      check(S::preview_chop(pcm,shared.sample,2)==std::vector<float>({-0.1f,-0.2f}),"shared sampler fixture: exact chop audio");
      actions.clear();auto fixture=opened.project;const xmp::live::Rect make=ui::layout::sample_make_kit();
      ui::touch_event(shared,fixture,b,state,ui::TouchPhase::down,make.x+make.w/2,make.y+make.h/2,actions);
      check(actions.size()==1 && actions[0].kind==ui::Action::sample_chop,"shared sampler fixture: visible kit action");
    }
    // The controls: REC arms, the wheel keeps on the chosen pad, knobs edit.
    ui::Ui u;
    std::vector<ui::Action> out;
    ui::Now still;
    u.button(ui::Button::menu, true, b, still, out);
    u.pad(14, 100, b, still, out);
    u.button(ui::Button::menu, false, b, still, out);
    check(u.view == ui::View::sample, "sample: Menu + pad 15");
    u.button(ui::Button::rec, true, b, still, out);
    check(out.size() == 1 && out[0].kind == ui::Action::sample_arm && u.sampling, "sample: REC arms");
    out.clear();
    u.button(ui::Button::rec, true, b, still, out);
    check(out.size() == 1 && out[0].kind == ui::Action::sample_stop && !u.sampling, "sample: REC again ends it");
    out.clear();
    u.sample_done(48000);
    u.pad(5, 90, b, still, out);
    check(u.sample_pad == 5 && out.size() == 1 && out[0].kind == ui::Action::sample_audition, "sample: a pad chooses and plays");
    out.clear();
    u.knob(0, 10, b, out);
    u.knob(2, -3, b, out);
    check(u.sample.start == 1200 && u.sample.tune == -3 && u.knob_name == "Tune", "sample: start and tune knobs");
    u.button(ui::Button::shift, true, b, still, out);
    u.knob(2, 1, b, out);
    u.knob(3, 3, b, out);
    u.button(ui::Button::shift, false, b, still, out);
    check(u.sample.reverse && u.sample.slices == 4, "sample: Shift knobs: reverse and slices");
    u.button(ui::Button::wheel, true, b, still, out);
    check(out.size() == 1 && out[0].kind == ui::Action::sample_keep && out[0].pad == 5 && out[0].track == 0,
          "sample: the wheel keeps it on the pad");
    out.clear();
    u.track = 1;
    u.button(ui::Button::wheel, true, b, still, out);
    check(out.empty(), "sample: a synth track takes no sample");
    u.track = 0;

    // Keeping it: the track gets its own kit, the other tracks keep theirs, undo brings it back.
    json::Value doc = opened.project;
    live::edit::History h;
    std::string why;
    std::vector<float> pcm = S::render(ramp, u.sample);
    check(live::edit::keep_sample(doc, 0, 5, pcm, 4, "Rec 1", h, why), "sample: kept");
    const auto& own = doc.get("tracks")->items()[0].get("pads")->items();
    check(project::detail::str(own[5], "sampleId") == "take-0" && own[8].get("slice") &&
              project::detail::str(doc.get("pads")->items()[5], "sampleId") == "s",
          "sample: sliced across the track's own kit, the shared pads untouched");
    json::Value canonical;
    Str problem;
    check(project::canonical(doc, canonical, problem), "sample: the project stays valid");
    live::edit::Place place;
    check(h.undo(doc, place) && !doc.get("tracks")->items()[0].get("pads"), "sample: undo restores the shared kit");

    // Drawn: the waveform and the gold markers.
    ui::SampleScreen shown;
    shown.state = ui::SampleScreen::ready, shown.frames = 48000, shown.revision = 1;
    shown.peaks.assign(300, 0.8f);
    ui::Painter sp;
    sp.draw(c, u, b, still, 0, nullptr, nullptr, &shown);
    const int x = ui::layout::kLeft + 12 + static_cast<int>(std::lround((ui::layout::kRight - ui::layout::kLeft - 24) * 1200.0 / 48000));
    check(pixel(x, 300) == rgb(live::gfx::css::kGold), "sample: the start marker is drawn");
  }

  // ---- the owner's playtest, 2026-11-15 ----
  {
    // Scenes sharing a clip: only the slot it was launched from lights, and a
    // copy in another slot launches instead of stopping the track.
    ui::Board shared = b;
    shared.clip[0][1] = "c1", shared.clip_name[0][1] = "Groove";
    ui::Ui u;
    std::vector<ui::Action> out;
    ui::Now n;
    n.playing = true, n.scene = "a", n.clip[0] = "c1";
    check(u.heard_scene(0, shared, n) == 0, "playtest: the playing scene's slot is the lit one");
    u.slot(0, 1, shared, n, out);
    check(out.size() == 1 && out[0].kind == ui::Action::launch_clip && out[0].scene == 1,
          "playtest: a copy of the playing clip launches from its own slot");
    check(u.heard_scene(0, shared, n) == 1, "playtest: and that slot is lit");
    out.clear();
    u.slot(0, 1, shared, n, out);
    check(out.size() == 1 && out[0].kind == ui::Action::stop_clip, "playtest: pressing the lit slot stops the track");
    out.clear();
    ui::Now quiet;
    u.button(ui::Button::play_start, true, shared, quiet, out);
    check(u.heard_scene(0, shared, n) == 0, "playtest: a scene start lights its own slots again");

    // The Menu: the track's pages on the top row, the project's below.
    ui::View v = ui::View::clips;
    check(ui::menu_view(12, v) && v == ui::View::play && ui::menu_view(15, v) && v == ui::View::sound &&
              ui::menu_view(8, v) && v == ui::View::clips && ui::menu_view(11, v) && v == ui::View::browse &&
              ui::menu_view(4, v) && v == ui::View::project,
          "playtest: Menu rows: Play to Sound on top, Clips to Browse below");
    check(ui::track_page(ui::View::steps) && !ui::track_page(ui::View::mix), "playtest: track and project pages");

    // Slice audition bounds must not restrict the global MENU shortcuts.
    for (const int slices : {2, 4, 8}) {
      for (const int pad : {12, 13, 14, 15, 8, 9, 10, 11, 4}) {
        ui::Ui nav;
        nav.sample.slices = slices;
        std::vector<ui::Action> actions;
        ui::View expected = ui::View::clips;
        check(ui::menu_view(pad, expected), "menu regression: fixture names a page");
        nav.button(ui::Button::menu, true, b, quiet, actions);
        nav.pad(pad, 100, b, quiet, actions);
        nav.button(ui::Button::menu, false, b, quiet, actions);
        check(nav.view == expected, "menu: every page remains reachable after slicing a sample");
      }
    }
    {
      ui::Ui audition;
      audition.view = ui::View::sample;
      audition.sample.slices = 4;
      audition.sample_frames = 1024;
      std::vector<ui::Action> actions;
      audition.pad(7, 100, b, quiet, actions);
      check(actions.empty() && audition.toast == "No chop on this pad",
            "sample: an unavailable chop still refuses audition outside MENU");
    }

    // Each Sound preset bank uses all sixteen pads in the same order as the touchscreen.
    ui::Ui s2;
    out.clear();
    s2.select_track(1, b);
    s2.button(ui::Button::menu, true, b, quiet, out);
    s2.pad(15, 100, b, quiet, out);
    s2.button(ui::Button::menu, false, b, quiet, out);
    check(s2.view == ui::View::sound && s2.knob_page() == ui::Ui::Knobs::sound, "playtest: Menu + pad 16 opens Sound, SOUND knobs");
    for (int bank = 0; bank < 2; ++bank) {
      check(s2.preset_page == bank && s2.sound_focus == bank * 16, "presets: bank change focuses its first preset");
      for (int slot = 0; slot < 16; ++slot) {
        const int preset = bank * 16 + slot;
        const int pad = 12 - 4 * (slot / 4) + slot % 4;
        out.clear();
        s2.pad(pad, 100, b, quiet, out);
        s2.pad(pad, 0, b, quiet, out);
        check(out.size() == 1 && out[0].kind == ui::Action::choose_preset && out[0].pad == preset &&
                  out[0].track == 1 && s2.sound_focus == preset,
              "presets: every pad press selects and focuses its matching preset");
        const auto cell = ui::layout::play_pad(pad);
        out.clear();
        ui::touch_event(s2, opened.project, b, quiet, ui::TouchPhase::down,
                        cell.x + cell.w / 2, cell.y + cell.h / 2, out);
        check(out.size() == 1 && out[0].kind == ui::Action::choose_preset && out[0].pad == preset,
              "presets: tapping each grid cell matches its pad");
      }
      if (bank == 0) {
        out.clear();
        s2.button(ui::Button::minus, true, b, quiet, out);
        s2.button(ui::Button::minus, false, b, quiet, out);
      }
    }
    out.clear();
    s2.button(ui::Button::shift, true, b, quiet, out);
    s2.pad(0, 100, b, quiet, out);
    s2.button(ui::Button::shift, false, b, quiet, out);
    s2.pad(0, 0, b, quiet, out);
    check(out.size() == 2 && out[0].kind == ui::Action::note_on && out[1].kind == ui::Action::note_off &&
              out[0].note == out[1].note && s2.preset_page == 1 && s2.sound_focus == 31,
          "presets: Shift auditions the current sound and the pad releases after Shift is lifted");
    s2.button(ui::Button::plus, true, b, quiet, out);
    s2.button(ui::Button::plus, false, b, quiet, out);
    check(s2.preset_page == 0 && s2.sound_focus == 0, "presets: plus wraps to the first bank");
    out.clear();
    s2.knob(0, 5, b, out);
    check(out.size() == 1 && out[0].kind == ui::Action::turn_knob && out[0].sound && out[0].delta == 5,
          "playtest: the SOUND knobs ask for a sound change");

    namespace E = live::edit;
    json::Value doc = opened.project;
    E::History h;
    std::string why;
    check(E::set_preset(doc, 1, 1, h, why), "playtest: a preset");
    const json::Value& state = *doc.get("tracks")->items()[1].get("machine")->get("state");
    check(project::detail::str(state, "name") == "Soft key" && project::detail::str(state, "oscillator") == "sine" &&
              project::detail::num(state, "cutoff") == 5000,
          "playtest: the synth takes the preset's sound");
    check(!E::set_preset(doc, 0, 1, h, why) && why == "Presets are for synth tracks", "playtest: not on a kit");
    E::Shown shown;
    why.clear();
    check(E::sound_knob(doc, 1, 0, 10, true, h, shown, why) && shown.name == "Tone", "playtest: SOUND knob 1 is the cutoff (Tone)");
    double cutoff = 0;
    Str problem;
    parameters::value(doc, Str("track.keys.machine.xmp.subtractive.v1.cutoff"), cutoff, problem);
    check(std::fabs(cutoff - ((5000.0 - 30) / (16000 - 30) + 0.1)) < 0.002 && shown.value.find(" Hz") != std::string::npos,
          "playtest: ten clicks raise it 10%, shown in Hz");
    json::Value valid;
    check(project::canonical(doc, valid, problem), "playtest: the project stays valid");
    E::Place place;
    check(h.undo(doc, place) && h.undo(doc, place) &&
              project::detail::str(*doc.get("tracks")->items()[1].get("machine")->get("state"), "name") == "Warm bass",
          "playtest: undo takes the knob and the preset back");
    // New steps take the NEW STEPS values.
    const auto kit = E::find(doc, Str("drums"), Str("c1"));
    check(E::toggle(doc, kit, 9, 4, 0, h, why, 0.5, 0.25) && std::fabs(E::row(doc, kit, 4, 0).velocity[9] - 0.5f) < 1e-6f,
          "playtest: a new step at 50% velocity");
  }

  // ---- capturing a jam as the song ----
  {
    ui::Ui u;
    std::vector<ui::Action> out;
    ui::Now quiet;
    u.button(ui::Button::menu, true, b, quiet, out);
    u.pad(9, 100, b, quiet, out);
    u.button(ui::Button::menu, false, b, quiet, out);
    check(u.view == ui::View::song, "capture: the Song view");
    u.button(ui::Button::rec, true, b, quiet, out);
    check(u.capturing && out.empty() && u.toast == "Capture armed: play a scene", "capture: REC arms it in the Song view");
    // A jam: Verse (drums and keys) for two of its 32-step plays, Break for two
    // of its 16, then the groove alone (no scene holds it) for one bar.
    ui::Now n;
    n.playing = true;
    auto play = [&](const char* drums, const char* keys, double from, double to) {
      n.clip[0] = drums, n.clip[1] = keys;
      for (double step = from; step < to; step += 0.25) {
        n.step = step;
        u.follow(n, out);
      }
    };
    play("c1", "k1", 0, 64);
    play("c2", "", 64, 96);
    play("c1", "", 96, 112);
    check(u.captured.size() == 3 && out.empty(), "capture: each change of clips starts a part");
    n.playing = false;
    u.follow(n, out);
    check(!u.capturing && out.size() == 1 && out[0].kind == ui::Action::song_capture, "capture: stopping ends it");
    json::Value doc = opened.project;
    live::edit::History h;
    std::string why;
    int added = 0, blocks = 0;
    check(live::edit::song_capture(doc, u.captured, 1, h, added, blocks, why), "capture: written into the song");
    if (!why.empty()) std::printf("  %s\n", why.c_str());
    const auto& chain = doc.get("performance")->get("chain")->items();
    auto block = [&](int i, const char* scene, double repeats) {
      return i < chain.size() && project::detail::str(chain[i], "sceneId") == scene &&
             project::detail::num(chain[i], "repeats") == repeats;
    };
    check(blocks == 3 && added == 1 && chain.size() == 4 && block(0, "a", 1) && block(1, "a", 2) && block(2, "b", 2) &&
              block(3, "jam-1", 1),
          "capture: Verse twice, Break twice, then a new Jam scene, after the selected block");
    const auto& scenes = doc.get("scenes")->items();
    check(scenes.size() == 3 && project::detail::str(scenes[2], "name") == "Jam 1" &&
              scenes[2].get("clips")->members().size() == 1,
          "capture: the Jam scene holds the groove alone");
    json::Value valid;
    Str problem;
    check(project::canonical(doc, valid, problem), "capture: the project stays valid");
    live::edit::Place place;
    check(h.undo(doc, place) && doc.get("performance")->get("chain")->items().size() == 1 &&
              doc.get("scenes")->items().size() == 2,
          "capture: one undo takes the song and the scene back");
    // Nothing played, or a song playing: nothing to capture.
    ui::Ui v;
    out.clear();
    v.button(ui::Button::menu, true, b, quiet, out);
    v.pad(9, 100, b, quiet, out);
    v.button(ui::Button::menu, false, b, quiet, out);
    v.button(ui::Button::rec, true, b, quiet, out);
    v.button(ui::Button::rec, true, b, quiet, out);
    check(!v.capturing && out.empty() && v.toast == "Nothing captured", "capture: REC twice with no music captures nothing");
    ui::Now song;
    song.playing = song.song = true;
    v.button(ui::Button::rec, true, b, song, out);
    check(!v.capturing, "capture: not while the song plays");
  }

  // Direct editing, gestures and defaults: production code, local memory only.
  {
    namespace E = live::edit;
    const int major[16] = {48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74};
    ui::Ui u;
    u.track = 1;
    for (int p = 0; p < 16; ++p)
      check(u.pad_note(p, b) == major[p], "scale: C major default on every melodic pad");
    u.scale = music::Scale::chromatic;
    check(u.pad_note(2, b) == 50, "scale: chromatic remains selectable");
    // Any root and the modes: D Dorian is D E F G A B C; A melodic minor raises 6 and 7.
    u.scale = music::Scale::dorian, u.root = 2;
    const int dorian[8] = {50, 52, 53, 55, 57, 59, 60, 62};
    for (int p = 0; p < 8; ++p) check(u.pad_note(p, b) == dorian[p], "scale: D Dorian on the pads");
    u.scale = music::Scale::melodic_minor, u.root = 9;
    check(u.pad_note(5, b) == 57 + 9 && u.pad_note(6, b) == 57 + 11, "scale: A melodic minor");
    u.scale = music::Scale::minor, u.root = 0;
    check(u.pad_note(6, b) == 58, "scale: natural minor's flat seventh");
    u.scale = music::Scale::major, u.root = 0;
    auto doc = opened.project;
    E::History h;
    std::string why;
    E::Place undo;
    const auto before = json::stringify(doc);
    auto tempo = E::read_field(doc, {}, E::Field::tempo);
    check(E::apply_field(doc, tempo, 128, h, why) && project::detail::num(doc, "bpm") == 128,
          "touch field: tempo commits");
    check(h.undo(doc, undo) && json::stringify(doc) == before, "touch field: tempo undo is exact");
    check(!E::apply_field(doc, tempo, 301, h, why) && json::stringify(doc) == before,
          "touch field: out of range leaves project intact");
    ui::Ui face;
    std::vector<Action> a;
    ui::Now now;
    ui::touch_event(face, doc, b, now, ui::TouchPhase::down, 1000, 40, a);
    check(face.editor_open && a.empty(), "touch: tapping tempo opens a non-mutating editor");
    ui::touch_event(face, doc, b, now, ui::TouchPhase::down, 550, 640, a);
    check(!face.editor_open && a.empty(), "touch: cancel produces no edit");
    {
      // The wheel moves the sheet's value; Apply must still commit it (it once
      // compared the moved value with itself and dropped the edit).
      E::History wh;
      auto wd = doc;
      const double bpm = project::detail::num(wd, "bpm");
      std::vector<Action> wa;
      ui::touch_event(face, wd, b, now, ui::TouchPhase::down, 1000, 40, wa);
      face.wheel(1, b);
      const auto apply = ui::layout::dialog_apply();
      ui::touch_event(face, wd, b, now, ui::TouchPhase::down, apply.x + 10, apply.y + 10, wa);
      check(one(wa, Action::set_value) && wa[0].value == bpm + 1, "touch: Apply sends the wheel's value");
      std::string wy;
      check(!wa.empty() && E::apply_field(wd, wa[0].field, wa[0].value, wh, wy) &&
                project::detail::num(wd, "bpm") == bpm + 1,
            "touch: a wheel edit in the sheet is kept");
    }
    {
      // Mix's knobs are the track's level, pan and sends, even after the Sound view.
      ui::Ui k;
      k.open(ui::View::sound);
      check(k.qlink_led_page() == 1, "knobs: Sound outside Steps lights the second LED");
      for (auto view : {ui::View::sample, ui::View::song, ui::View::browse}) {
        k.open(view);
        check(k.qlink_led_page() == 0, "knobs: a dedicated knob group lights the first LED");
      }
      k.open(ui::View::mix);
      check(k.knob_page() == ui::Ui::Knobs::track, "knobs: Mix uses TRACK after the Sound view");
      k.open(ui::View::clips);
      check(k.knob_page() == ui::Ui::Knobs::sound, "knobs: other views keep the page they had");
    }
    face.view = ui::View::steps;
    auto step = ui::layout::step(0);
    ui::touch_event(face, doc, b, now, ui::TouchPhase::down, step.x + 20, step.y + 20, a);
    check(face.selected_step == 0 && a.empty(), "touch: Select inspects an existing hit without removing it");
    face.draw_mode = true;
    ui::touch_event(face, doc, b, now, ui::TouchPhase::down, step.x + 20, step.y + 20, a);
    check(one(a, Action::toggle_step), "touch: Draw explicitly toggles an existing hit");
    a.clear();
    face.view = ui::View::sample;
    face.sample_frames = 1000;
    face.sample.start = 100;
    face.sample.end = 900;
    ui::touch_event(face, doc, b, now, ui::TouchPhase::down, 143, 300, a);
    ui::touch_event(face, doc, b, now, ui::TouchPhase::move, 350, 300, a);
    check(face.sample.start > 100 && face.sample.start < face.sample.end && a.empty(),
          "touch: waveform drag changes only the draft");
    ui::touch_event(face, doc, b, now, ui::TouchPhase::cancel, 350, 300, a);
    check(face.sample.start == 100 && a.empty(), "touch: canceled waveform drag restores its boundary");
    check(E::choose_instrument(doc, 0, 1, h, why) && ui::board_of(doc).kind[0] == ui::Kind::sampler,
          "machine: distinct chromatic sampler");
    check(h.undo(doc, undo) && json::stringify(doc) == before,
          "machine: conversion is one undo and preserves shared kit");
    check(E::effect_edit(doc, 0, -1, 0, 0, 2, h, why), "effects: install delay on track");
    check(E::effect_edit(doc, 0, 0, 0, 0, 3, h, why), "effects: install reverb on return A");
    json::Value valid;
    Str problem;
    check(project::canonical(doc, valid, problem), "effects: edited graph is valid");
    check(h.undo(doc, undo) && h.undo(doc, undo) && json::stringify(doc) == before, "effects: both edits undo exactly");
    E::Focus f{0, 0, 0, 60, 0, 0};
    auto condition = E::read_field(doc, f, E::Field::condition);
    check(E::apply_field(doc, condition, 3, h, why), "expression: convert a hit to a fill condition");
    check(E::focused_note(doc, E::focused_clip(doc, f), f) &&
              project::detail::str(*E::focused_note(doc, E::focused_clip(doc, f), f), "condition") == "fill",
          "expression: condition persists on the selected note");
    check(h.undo(doc, undo) && json::stringify(doc) == before,
          "expression: conversion undo restores the original representation");
    check(E::lock_step(doc, f, 0, 0, false, h, why), "locks: set a lock on the selected step");
    check(h.undo(doc, undo) && json::stringify(doc) == before, "locks: undo restores exactly");
  }

  {
    namespace E = xmp::live::edit;
    auto doc = opened.project;
    E::History h;
    std::string why;
    E::Place undo;
    const auto before = json::stringify(doc);
    E::Focus focus{1, 1};
    check(E::create_empty_clip(doc, focus, h, why), "empty slot: create a bounded clip");
    check(E::focused_clip(doc, focus).ok(), "empty slot: assigned to the selected scene");
    check(!E::create_empty_clip(doc, focus, h, why), "empty slot: never replace an occupied slot");
    check(h.undo(doc, undo) && json::stringify(doc) == before, "empty slot: one undo restores the slot");
  }
  {
    ui::Ui u;
    u.view = ui::View::steps;
    u.track = 1;
    u.selected_step = 2;
    u.step_note = 40;
    u.fit_roll();
    auto doc = opened.project;
    ui::fill_strip(u, doc, b);
    const auto place = live::edit::find(doc, Str("keys"), Str("k1"));
    const auto roll = live::edit::roll(doc, place);
    ui::Now n;
    n.playing = true;
    n.clip[1] = "k1";
    n.step = 1;
    ui::Painter p;
    p.draw(c, u, b, n, 0, nullptr, &roll);
    auto fingerprint = [&](live::Rect r) {
      std::uint64_t h = 1469598103934665603ULL;
      for (int y = r.y; y < r.y + r.h; ++y)
        for (int x = r.x; x < r.x + r.w; ++x)
          h = (h ^ pixel(x, y)) * 1099511628211ULL;
      return h;
    };
    const auto inspector = fingerprint(ui::layout::inspector(0)), task = fingerprint(ui::layout::task(0));
    n.step = 2;
    p.draw(c, u, b, n, 1, nullptr, &roll);
    check(inspector == fingerprint(ui::layout::inspector(0)) && task == fingerprint(ui::layout::task(0)),
          "repaint: roll movement preserves inspector and task controls");
  }
  {
    auto empty = b;
    empty.samples.clear();
    ui::Now n;
    ui::Ui u;
    u.view = ui::View::browse;
    u.browse_category = 1;
    ui::Painter p;
    p.draw(c, u, empty, n, 0);
    const auto kit_edge = pixel(244, 120), project_edge = pixel(462, 120);
    std::vector<Action> out;
    ui::touch_event(u, opened.project, empty, n, ui::TouchPhase::down, 500, 120, out);
    p.draw(c, u, empty, n, 1);
    check(u.browse_category == 2 && pixel(244, 120) != kit_edge && pixel(462, 120) != project_edge,
          "Browse repaints the selected tab even when both tabs have no results");
    auto task = ui::layout::task(2);
    out.clear();
    ui::touch_event(u, opened.project, empty, n, ui::TouchPhase::down, task.x + 20, task.y + 20, out);
    check(out.empty() && !ui::workbench_task_available(u, empty, 2), "Empty Browse cannot load a result");
    u.view = ui::View::sample;
    task = ui::layout::task(1);
    ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, task.x + 20, task.y + 20, out);
    check(out.empty() && !ui::workbench_task_available(u, b, 1), "Sample cannot keep an absent take");
    u.view = ui::View::sound;
    u.track = 0;
    u.browse_category = 2;
    u.browse_cursor = 3;
    u.browse_query = "old search";
    task = ui::layout::task(3);
    const auto machine = ui::layout::task(2);
    p.draw(c, u, b, n, 2);
    check(pixel(machine.x + 20, machine.y + 40) == rgb(css::kSurface2) &&
              pixel(task.x + 20, task.y + 40) == rgb(css::kSurface2),
          "Kit Sound framebuffer draws both Choose machine and Load kit");
    ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, task.x + 20, task.y + 20, out);
    check(u.view == ui::View::browse && u.previous == ui::View::sound && u.browse_category == 1 &&
              u.browse_cursor == 0 && u.browse_query.empty() && out.empty(),
          "Sound's Load kit opens the Kits tab with a fresh selection");
    u.open(ui::View::sound);
    u.select_track(1, b);
    p.draw(c, u, b, n, 3);
    check(pixel(task.x + 20, task.y + 40) == rgb(css::kScreen), "Synth Sound framebuffer clears Load kit");
    ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, task.x + 20, task.y + 20, out);
    check(u.view == ui::View::sound && out.empty(), "Synth Sound does not accept a tap on the former Load kit position");
  }
  {
    ui::Ui u;
    u.view = ui::View::play;
    ui::Now n;
    std::vector<Action> out;
    u.editor_open = true;
    u.editor.available = true;
    u.editor.field = live::edit::Field::scale;
    u.editor.max = music::kScales - 1;
    check(ui::choices(u, b).size() == static_cast<std::size_t>(music::kScales), "picker: every scale and mode listed");
    const auto lydian = ui::choice_rect(7);
    ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, lydian.x + 20, lydian.y + 20, out);
    check(u.scale == music::Scale::lydian && out.empty(), "picker: Lydian chosen by touch");
    u.editor_open = true;
    u.editor.field = live::edit::Field::scale_root;
    check(ui::choices(u, b).size() == 12, "picker: twelve root notes");
    const auto g = ui::choice_rect(7);
    ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, g.x + 20, g.y + 20, out);
    check(u.root == 7 && out.empty(), "picker: G chosen as the root, playing layout only");
    u.root = 0;
    u.editor_open = true;
    u.editor.field = live::edit::Field::scale;
    const auto r = ui::choice_rect(0);
    check(ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, r.x + 20, r.y + 20, out) &&
              u.scale == music::Scale::major && !u.editor_open && out.empty(),
          "picker: named C-major choice changes playing layout only");
    u.editor_open = true;
    u.editor = live::edit::read_field(opened.project, {}, live::edit::Field::launch_grid);
    const auto q = ui::choice_rect(1);
    ui::touch_event(u, opened.project, b, n, ui::TouchPhase::down, q.x + 20, q.y + 20, out);
    check(one(out, Action::set_value) && out[0].value == 4, "picker: named Beat emits the bounded launch-grid edit");
  }
  if (failures)
    std::printf("%d failures\n", failures);
  else
    std::printf("live ui: all checks passed\n");
  return failures ? 1 : 0;
}
