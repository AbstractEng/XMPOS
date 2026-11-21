// Software-only end-to-end regressions: visible actions, transport and actual PCM.
#include "xmp/live_workbench.hpp"
#include <memory>
#include <cstdio>

namespace {
using namespace xmp;
namespace ui = live::ui;
namespace E = live::edit;
int failures = 0;
void check(bool ok, const char* name) { if (!ok) { ++failures; std::printf("FAIL %s\n", name); } }
struct Session {
  json::Value doc = live::blank_project().project;
  live::ProjectSound sound;
  std::unique_ptr<live::Workbench> w;
  uint64_t frame = 0;
  Str error;
  Session(int length = 16) {
    E::History history; std::string why;
    E::create_empty_clip(doc, {0, 0}, history, why);
    E::track_at(doc, 0).get("clips")->items()[0].set("length", json::Value::of(static_cast<double>(length)));
    E::toggle(doc, {0, 0}, 0, 0, 36, history, why);
    check(sound.prepare(doc, error), "fixture audio prepares");
    w = std::make_unique<live::Workbench>(doc, sound, true, live::WorkbenchHooks{
      [&] { return frame; }, [](const auto&) { return true; }, [] { return false; }, [] { return false; }, [] {},
      [] { return std::vector<live::library::Entry>{}; }, [](const auto&, auto&) { return false; },
      [](const char*) {}, [](const auto&) { return std::string{}; },
    });
  }
  void action(ui::Action a) { w->actions.push_back(a); w->run_actions("regression"); }
  void key(ui::Button b) { w->face.button(b, true, w->board, w->now_state(), w->actions); w->run_actions("button"); }
  std::vector<float> advance(int frames) {
    std::vector<float> out; float l[256], r[256];
    for (int i = 0; i < frames; i += 256) {
      const int n = std::min(256, frames - i);
      w->tick();
      if (w->player.playing()) check(w->player.fill(frame + 4800, error), "player fills");
      std::fill_n(l, n, 0.f); std::fill_n(r, n, 0.f);
      sound.process(l, r, n, frame); frame += n;
      out.insert(out.end(), l, l + n);
    }
    return out;
  }
  void start() { key(ui::Button::play_start); advance(8192); }
  void synth() { ui::Action a{ui::Action::choose_machine, 1}; a.pad = 2; action(a); }
  void note(int pitch) { ui::Action a{ui::Action::note_on, 1, -1, 0, pitch}; a.velocity = .8f; action(a); }
};
double difference(const std::vector<float>& a, const std::vector<float>& b) {
  double sum = 0; for (size_t i = 0; i < a.size(); ++i) sum += std::fabs(a[i] - b[i]); return sum;
}
}
int main(int argc, char** argv) {
  auto run = [&](const char* name) { return argc == 1 || !std::strcmp(argv[1], name); };
  if (run("loop-level")) {
    for (bool mixer : {false, true}) {
      auto doc = live::blank_project().project;
      doc.set("bpm", json::Value::of(300.0));
      doc.set("master", json::Value::of(.4));
      E::History history; std::string why;
      check(E::choose_instrument(doc, 0, 1, history, why), "loop level: sampler chosen");
      E::track_at(doc, 0).set("volume", json::Value::of(.6));
      if (mixer) {
        const auto mix = json::parse(Str(R"({"version":1,"tracks":{"track-0":{"pan":0.2,"sends":[0,0],"inserts":[{"id":"drive","kind":"distortion","bypass":false,"params":{"drive":0.25,"wet":0.5}}]}},"returns":[[],[]],"tempos":[]})"));
        doc.set("mix", mix.value);
      } else doc.remove("mix");
      live::ProjectSound sound; Str error;
      check(sound.prepare(doc, error), "loop level: audio prepared");
      uint64_t frame = 0; bool capturing = false;
      live::sample::LoopTake loop;
      live::Workbench w(doc, sound, true, {
        [&] { return frame; }, [](const auto&) { return true; },
        [&] { capturing = true; return true; }, [&] { return capturing; }, [&] { capturing = false; },
        [] { return std::vector<live::library::Entry>{}; }, [](const auto&, auto&) { return false; },
        [](const char*) {}, [](const auto&) { return std::string{}; },
      });
      w.loop = &loop;
      w.face.open(ui::View::sample);
      w.actions.push_back({ui::Action::play_scene, -1, 0}); w.run_actions("loop level");
      w.face.button(ui::Button::rec, true, w.board, w.now_state(), w.actions); w.run_actions("loop level");
      float input[256], left[256], right[256]; uint8_t valid[256];
      std::fill_n(input, 256, .01f); std::fill_n(valid, 256, 1);
      double first[2]{}, later[2]{}; int first_count = 0, later_count = 0;
      uint64_t published = UINT64_MAX;
      for (int block = 0; block < 1800; ++block) {
        w.tick(); check(w.player.fill(frame + 4800, error), "loop level: player fills");
        std::fill_n(left, 256, 0.f); std::fill_n(right, 256, 0.f);
        sound.process(left, right, 256, frame, &loop, input, valid);
        if (loop.state() == live::sample::LoopTake::State::published && published == UINT64_MAX) published = frame;
        const auto first_at = loop.first_frame() + loop.length() + 4096;
        for (int i = 0; i < 256; ++i) {
          const auto at = frame + i;
          if (at >= first_at && at < first_at + 4096) {
            first[0] += left[i]*left[i]; first[1] += right[i]*right[i]; ++first_count;
          }
          if (published != UINT64_MAX && at >= published + 4096 && at < published + 8192) {
            later[0] += left[i]*left[i]; later[1] += right[i]*right[i]; ++later_count;
          }
        }
        frame += 256;
      }
      check(first_count == 4096 && later_count == 4096, "loop level: measured both sides of the handoff");
      for (int channel = 0; channel < 2; ++channel) {
        const double a = std::sqrt(first[channel]/std::max(1,first_count));
        const double b = std::sqrt(later[channel]/std::max(1,later_count));
        if (std::abs(a-b)>1e-7) std::printf("loop level mixer=%d channel=%d first=%g later=%g\n", mixer,channel,a,b);
        check(a > .0001 && std::abs(a-b) < 1e-7, "loop level: first and later passes have identical RMS with master, track, pan and effects");
      }
      check(w.player.playing(), "loop level: transport continues across the handoff");
    }
  }
  if (run("tap-empty")) {
    for (const bool overview : {false, true}) {
      Session s;
      E::History machine_history; std::string machine_error;
      check(E::choose_instrument(s.doc, 1, 0, machine_history, machine_error), "tap fixture: target machine selected");
      s.w->board = ui::board_of(s.doc);
      s.start(); s.w->face.open(ui::View::clips); s.w->face.overview = overview;
      const auto before = json::stringify(s.doc);
      const auto cell = overview ? live::Rect{160, ui::layout::kClipTop, 128, ui::layout::kClip}
                                 : ui::layout::pad_cell(13);
      s.w->touch(ui::TouchPhase::down, cell.x + 20, cell.y + 30);
      s.w->touch(ui::TouchPhase::up, cell.x + 20, cell.y + 30);
      check(s.w->face.track == 1 && s.w->face.cursor == 0, "tap empty: selects the tapped slot");
      const auto place = E::focused_clip(s.doc, {1, 0});
      check(place.ok(), "tap empty: creates a clip in both layouts");
      if (place.ok()) check(project::detail::num(E::clip_at(s.doc, place), "length") == 16,
                            "tap empty: retains the one-bar default");
      check(s.w->player.playing() && s.w->now_state().clip[0] == s.w->board.clip[0][0],
            "tap empty: other tracks keep playing");
      check(E::track_at(s.doc, 1).get("clips")->items().size() == 1,
            "tap empty: release creates no duplicate");
      s.action({ui::Action::undo});
      check(json::stringify(s.doc) == before, "tap empty: one undo restores the project");
      s.w->face.rec = ui::Ui::Rec::recording; s.w->face.rec_track = 1; s.w->face.rec_scene = 0;
      s.w->touch(ui::TouchPhase::down, cell.x + 20, cell.y + 30);
      check(!E::focused_clip(s.doc, {1, 0}).ok(), "tap empty: leaves an active take's slot reserved");
    }
  }
  if (run("first-machine")) {
    Session s; auto& f = s.w->face;
    s.key(ui::Button::bank_b);
    check(f.track == 1 && f.view == ui::View::sound && f.machine_picker,
          "first machine: selecting a new track opens its machine chooser");
    check(s.w->board.unchosen[1], "first machine: selection does not silently assign a machine");
    f.pad(ui::option_pad(2), 100, s.w->board, s.w->now_state(), s.w->actions);
    s.w->run_actions("machine selection");
    check(!s.w->board.unchosen[1] && s.w->board.kind[1] == ui::Kind::synth && !f.machine_picker,
          "first machine: pad 15 chooses the synth");
    s.key(ui::Button::bank_a); s.key(ui::Button::bank_b);
    check(!f.machine_picker, "first machine: revisiting a configured track does not prompt again");
    f.open(ui::View::clips);
    const auto cell = ui::layout::pad_cell(14);
    s.w->touch(ui::TouchPhase::down, cell.x + 20, cell.y + 30);
    check(f.track == 2 && f.machine_picker && !E::focused_clip(s.doc, {2, 0}).ok(),
          "first machine: tapping a new track's empty clip asks for its machine first");
    f.pad(ui::option_pad(0), 100, s.w->board, s.w->now_state(), s.w->actions);
    s.w->run_actions("machine then clip");
    check(!s.w->board.unchosen[2] && E::focused_clip(s.doc, {2, 0}).ok() && f.view == ui::View::clips,
          "first machine: choosing a kit completes the requested clip creation");
  }
  if (run("clip-length-editor")) {
    Session s; auto& f = s.w->face;
    const auto before = json::stringify(s.doc);
    f.open_prepared(E::read_field(s.doc, {0, 0}, E::Field::clip_length));
    auto tap = [&](live::Rect r) {
      s.w->touch(ui::TouchPhase::down, r.x + r.w / 2, r.y + r.h / 2);
      s.w->touch(ui::TouchPhase::up, r.x + r.w / 2, r.y + r.h / 2);
    };
    tap(ui::layout::dialog_key(0, true));
    tap(ui::layout::dialog_key(1, true));
    tap(ui::layout::dialog_key(7, true));
    check(f.editor_text == "128", "clip editor: enlarged numeric keys match their touch targets");
    tap(ui::layout::dialog_apply(true));
    check(!f.editor_open && s.w->board.clip_steps[0][0] == 128, "clip editor: enlarged Apply commits once");
    s.action({ui::Action::undo});
    check(json::stringify(s.doc) == before, "clip editor: one undo restores the clip");
    f.open_prepared(E::read_field(s.doc, {0, 0}, E::Field::clip_length));
    tap(ui::layout::value_plus(true));
    check(f.editor.value == 17, "clip editor: enlarged plus increments");
    tap(ui::layout::value_minus(true));
    check(f.editor.value == 16, "clip editor: enlarged minus decrements");
    tap(ui::layout::dialog_cancel(true));
    check(json::stringify(s.doc) == before, "clip editor: Cancel leaves the project intact");
  }
  if (run("delete-playing")) {
    Session deleted, other;
    auto prepare = [&](Session& s, bool mute) {
      E::History h; std::string why;
      std::vector<float> pcm(48000, .03f);
      for (int t = 0; t < 2; ++t) {
        check(E::keep_sample(s.doc, t, 0, pcm, 1, "Held", h, why), "delete fixture: sustained sound");
        if (t == 1) check(E::create_empty_clip(s.doc, {t, 0}, h, why), "delete fixture: second clip");
        for (int at = t == 0 ? 2 : 0; at < 16; at += 2)
          check(E::toggle(s.doc, {t, 0}, at, 0, 36, h, why), "delete fixture: repeated notes");
      }
      if (mute) E::track_at(s.doc, 0).set("volume", json::Value::of(0.0));
      s.w->board = ui::board_of(s.doc);
      check(s.sound.reload(s.doc, s.error), "delete fixture: sounds reload");
      s.start();
    };
    prepare(deleted, false); prepare(other, true);
    const auto before = json::stringify(deleted.doc);
    deleted.action({ui::Action::unlink_clip, 0, 0});
    check(deleted.w->player.playing() && deleted.w->now_state().clip[0].empty() &&
              !deleted.w->now_state().clip[1].empty(), "delete: only the playing clip stops immediately");
    const auto actual = deleted.advance(24000), expected = other.advance(24000);
    bool same = true;
    for (size_t i = 512; i < actual.size(); ++i) same = same && actual[i] == expected[i];
    check(same, "delete: sustained voices fade immediately and queued notes never retrigger; other track PCM stays exact");
    deleted.action({ui::Action::undo});
    check(json::stringify(deleted.doc) == before, "delete: undo restores the clip and scene slot");
  }
  if (run("machine")) {
    Session low, high; low.start(); high.start(); low.synth(); high.synth(); low.note(60); high.note(72);
    check(difference(low.advance(4096), high.advance(4096)) > 1, "a synth chosen during playback immediately plays different pitches");
    check(low.w->player.playing() && high.w->player.playing(), "machine changes keep transport running");
  }
  if (run("continuity")) {
    Session control, edited; control.start(); edited.start(); edited.synth();
    check(difference(control.advance(4096), edited.advance(4096)) == 0, "changing another machine preserves the sounding drum sample exactly");
  }
  if (run("effect")) {
    Session dry, wet; dry.start(); wet.start();
    ui::Action fx{ui::Action::effect_edit, 0}; fx.source_track = -1; fx.step = 0; fx.pad = 4; fx.knob = 0; wet.action(fx);
    check(difference(dry.advance(4096), wet.advance(4096)) > 1, "an inserted distortion affects the already sounding voice without Stop");
    check(wet.w->player.playing(), "effect insertion keeps transport running");
  }
  if (run("bars")) {
    Session session(64); session.start(); session.w->face.enter_steps(session.w->board);
    session.advance(210000); session.w->tick();
    check(session.w->face.page == static_cast<int>(session.w->now_state().step) / 16, "Steps follows the audible bar");
    session.w->face.wheel(-1, session.w->board); const int manual = session.w->face.page;
    session.advance(512); check(session.w->face.page == manual, "manual browsing is not overwritten by follow");
    session.w->face.shift = true; session.w->face.knob(3, -1, session.w->board, session.w->actions);
    check(session.w->face.page == std::max(0, manual - 1), "Shift Q4 navigates bars");
  }
  if (run("length")) {
    Session session; std::string why; E::History history;
    auto field = E::read_field(session.doc, {0, 0}, E::Field::clip_length);
    check(E::apply_field(session.doc, field, 37, history, why), "custom 37-step clip length is accepted");
    session.w->board = ui::board_of(session.doc); session.w->face.enter_steps(session.w->board);
    session.w->face.wheel(2, session.w->board);
    session.w->face.pad(8, 100, session.w->board, {}, session.w->actions); // step 37 in the partial bar
    session.w->run_actions("pad");
    check(E::row(session.doc, {0, 0}, 0, 36).velocity[36] > 0, "pads edit the last partial bar");
    field = E::read_field(session.doc, {0, 0}, E::Field::clip_length);
    check(!E::apply_field(session.doc, field, 0, history, why) && !E::apply_field(session.doc, field, 1025, history, why) &&
          !E::apply_field(session.doc, field, 17.5, history, why), "clip lengths reject invalid bounds and fractions");
    Session long_clip(128);
    check(E::toggle(long_clip.doc, {0, 0}, 127, 0, 36, history, why), "step 128 is editable");
    const E::Focus last{0, 0, 0, 36, 127};
    check(E::apply_field(long_clip.doc, E::read_field(long_clip.doc, last, E::Field::condition), 5, history, why),
          "conditional notes in bar eight retain valid sequence positions");
    check(project::open(json::stringify(long_clip.doc)).ok, "the long clip reopens with its conditional note");
  }
  if (run("tempo")) {
    Session session; session.start(); const double bpm = project::detail::num(session.doc, "bpm");
    session.w->face.open_prepared(E::read_field(session.doc, {}, E::Field::tempo));
    session.w->face.editor.value = bpm * 2; session.w->tick();
    const double start = session.w->now_state().step;
    session.advance(4800); const double ran = session.w->now_state().step - start;
    check(std::fabs(ran - 4800 * bpm * 2 / 720000) < .03, "tempo previews audibly before Apply without jumping position");
    check(project::detail::num(session.doc, "bpm") == bpm, "preview leaves the saved tempo unchanged");
    session.w->face.editor_open = false; session.w->tick(); const double restored = session.w->now_state().step;
    session.advance(4800);
    check(std::fabs(session.w->now_state().step - restored - 4800 * bpm / 720000) < .03, "Cancel restores audible tempo without Stop");
    ui::Action tempo{ui::Action::set_value}; tempo.field = E::read_field(session.doc, {}, E::Field::tempo); tempo.value = 123.4;
    session.action(tempo);
    check(session.w->board.bpm == 123.4 && project::detail::num(session.doc, "bpm") == 123.4,
          "the closed tempo display retains fractional tap and entered tempos");
  }
  if (run("tap")) {
    Session session; session.doc.set("bpm", json::Value::of(90.0)); session.w->board = ui::board_of(session.doc); const auto start = live::Workbench::Clock::time_point{} + std::chrono::seconds(10);
    for (int i = 0; i < 5; ++i) {
      ui::Now now; now.input_time = start + std::chrono::milliseconds(i * 500);
      session.w->face.button(ui::Button::tap_tempo, true, session.w->board, now, session.w->actions);
      session.w->run_actions("tap");
    }
    check(project::detail::num(session.doc, "bpm") == 120, "five quarter-note taps set 120 BPM");
  }
  if (run("fader")) {
    Session session; E::track_at(session.doc, 0).set("volume", json::Value::of(1.0));
    session.w->face.knob(0, -50, session.w->board, session.w->actions); session.w->run_actions("fader");
    check(std::fabs(project::detail::num(E::track_at(session.doc, 0), "volume") - .125) < 1e-9,
          "half the control throw gives -18 dB rather than linear half amplitude");
  }
  if (run("lights")) {
    Session session(64);auto& face=session.w->face;auto& b=session.w->board;
    ui::Now now;now.input_time=live::Workbench::Clock::time_point{}+std::chrono::seconds(10);
    const auto button=[](const live::PanelLights& lights,int code){for(size_t i=0;i<live::kFeedbackButtons.size();++i)if(live::kFeedbackButtons[i]==code)return lights.buttons[i];return std::uint8_t{0};};
    auto lights=face.panel_lights(b,now);
    check(button(lights,0x23)==3&&button(lights,0x52)==0,"track one lights A and stopped transport clears Play");
    face.track=5;lights=face.panel_lights(b,now);check(button(lights,0x24)==3,"track six lights B");
    now.input_time+=std::chrono::milliseconds(300);lights=face.panel_lights(b,now);
    check(button(lights,0x24)==0,"upper track bank flashes");
    face.track=0;now.playing=true;face.rec=ui::Ui::Rec::recording;
    lights=face.panel_lights(b,now);check(button(lights,0x52)==3&&button(lights,0x49)==3&&button(lights,0x50)==0,"Play and Record match active recording");
    face.rec=ui::Ui::Rec::overdub;lights=face.panel_lights(b,now);
    check(button(lights,0x49)==0&&button(lights,0x50)==3,"overdub has its own light");
    face.rec=ui::Ui::Rec::off;face.open(ui::View::play);
    face.sampling=true;face.fill_held=true;lights=face.panel_lights(b,now);
    check(button(lights,0x49)==3&&button(lights,0x0B)==3,"sampling and held Note Repeat use their own lights");
    face.sampling=false;face.fill_held=false;
    face.pad(0,25,b,now,session.w->actions);auto soft=face.panel_lights(b,now).pads[0];
    face.pad(0,0,b,now,session.w->actions);face.pad(0,120,b,now,session.w->actions);
    auto hard=face.panel_lights(b,now).pads[0];check(soft!=hard&&soft.b>soft.r&&hard.r>hard.b,"strike velocity controls pad hue");
    face.pad(0,0,b,now,session.w->actions);now.input_time+=std::chrono::seconds(1);
    check(face.panel_lights(b,now).pads[0]==live::PadColour{},"released pad light expires");
    face.enter_steps(b);now.clip[0]=b.clip[0][0];now.anchor[0]=0;now.step=20.2;face.page=1;
    lights=face.panel_lights(b,now);check(lights.pads[8].g==127&&lights.pads[12]==live::PadColour{},"audible step 21 lights physical pad 9 in bar two");
    b.kind[0]=ui::Kind::synth;check(face.panel_lights(b,now).pads[8].g==127,"piano roll has the same physical step playhead");
    face.page=0;for(auto c:face.panel_lights(b,now).pads)check(c==live::PadColour{},"manual browsing never shows a false playhead on another bar");
    now.playing=false;lights=face.panel_lights(b,now);check(button(lights,0x52)==0,"Stop extinguishes Play");
  }
  if (run("summaries")) {
    Session s; s.start();
    auto& b = s.w->board;
    ui::Action add{ui::Action::toggle_step, 0, 0, 0, 36, 4}; s.action(add);
    check(b.clip_notes[0][0] == 2, "pad step edit immediately refreshes clip note count during playback");
    s.action({ui::Action::undo}); check(b.clip_notes[0][0] == 1, "undo refreshes note count");
    s.action({ui::Action::redo}); check(b.clip_notes[0][0] == 2, "redo refreshes note count");
    s.action({ui::Action::erase_row, 0, 0, 0, 36}); check(b.clip_notes[0][0] == 0, "erase refreshes note count");
    check(s.w->player.playing(), "summary edits keep transport running");
    b.scenes = 2; b.clip[0][1] = b.clip[0][0];
    auto& clip = E::clip_at(s.doc, {0, 0}); E::History h; std::string why;
    E::toggle(s.doc, {0, 0}, 8, 0, 36, h, why); ui::refresh_clip(b, 0, clip);
    check(b.clip_notes[0][0] == 1 && b.clip_notes[0][1] == 1, "shared clip aliases refresh together");
  }
  if (run("song-play")) {
    Session s; auto& f = s.w->face; auto b = s.w->board;
    b.song = true; b.chain.resize(2); f.block = 1; f.open(ui::View::song); f.block = 1;
    ui::Now now; now.playing = true; std::vector<ui::Action> actions;
    f.button(ui::Button::play, true, b, now, actions);
    check(actions.size() == 1 && actions[0].kind == ui::Action::play_song && actions[0].step == 1,
          "Play on Song enters the selected block even while a scene plays");
  }
  if (run("playing-range")) {
    Session s; auto& f = s.w->face; auto& b = s.w->board;
    f.octave = -1; f.scale = music::Scale::minor; f.root = 2;
    f.select_track(1, b); check(f.octave == 0 && f.scale == music::Scale::minor && f.root == 2, "new instrument inherits key with its own octave");
    f.octave = 1; f.root = 5; f.select_track(0, b);
    check(f.octave == -1 && f.root == 2 && f.scale == music::Scale::minor, "bass remembers octave root and scale after hook");
    f.open(ui::View::clips); f.slot(1, 0, b, {}, s.w->actions);
    check(f.octave == 1 && f.root == 5, "clip pad track selection also restores playing range");
  }
  if (run("effect-controls")) {
    Session s; s.start(); ui::Action fx{ui::Action::effect_edit, 0}; fx.source_track = -1; fx.step = 0; fx.pad = 2; s.action(fx);
    auto& f = s.w->face; f.effects_open = true; ui::fill_strip(f, s.doc, s.w->board);
    check(f.strip_page == "EFFECT" && f.effect_fields[0].unit == " ms" && f.effect_fields[0].value == 500,
          "delay editor maps Q-Links and shows milliseconds");
    f.knob(0, 2, s.w->board, s.w->actions); f.knob(0, 1, s.w->board, s.w->actions); s.w->run_actions("effects");
    ui::fill_strip(f, s.doc, s.w->board); check(f.effect_fields[0].value == 515, "rapid Q-Link turns accumulate in milliseconds");
    f.knob(3, 4, s.w->board, s.w->actions); s.w->run_actions("sync"); ui::fill_strip(f, s.doc, s.w->board);
    check(f.effect_fields[3].value == 4 && !f.effect_fields[0].available && f.strip[3].value == "1/8", "Q4 selects clock-synced eighth notes and disables unused free time");
    check(s.w->player.playing(), "effect controls keep playing");
  }
  if (run("keyboard-naming")) {
    Session s; auto& f = s.w->face; auto type = [&](const std::string& text, int key = 0) {
      ui::text_event(f, s.doc, s.w->board, s.w->now_state(), text, key, s.w->actions); s.w->run_actions("typing");
    };
    f.rename_kind = 2; f.rename_text = "Track 1"; type("", 1); type("Bass é"); type("", 2); type("line"); type("", 3);
    check(s.w->board.track_name[0] == "Bass line" && f.rename_kind == 0, "select-all Unicode backspace and Enter share native rename action");
    f.rename_kind = 2; f.rename_text = "Discard"; type("", 4);
    check(s.w->board.track_name[0] == "Bass line" && f.rename_kind == 0, "Escape cancels naming");
    f.rename_kind = 2; f.rename_text.clear(); type(std::string(1000, 'x')); check(f.rename_text.size() == 40, "typed and pasted names remain bounded");
  }
  if (run("take-editor")) {
    Session s; s.synth(); auto& f = s.w->face;
    f.select_track(1, s.w->board); f.take_length = 32;
    f.take = {{16, 0, 48, .8, 1}, {22, 0, 52, .8, 1}, {27, 0, 55, .8, 1}};
    s.action({ui::Action::record_end, 1, 0});
    f.step_note = 59; f.pitch_chosen = true; f.fit_roll(); // last overdubbed note
    f.enter_steps(s.w->board);
    check(f.page == 1 && f.step_note == 48 && f.roll_low <= 48 && f.roll_low + 7 >= 48,
          "opening a fresh take reveals its first recorded bar and pitch after overdubbing");
    f.move_bar(-1, s.w->board); f.enter_steps(s.w->board);
    check(f.page == 0, "reopening the take preserves subsequent manual bar navigation");
  }
  if (run("sampler-monitor-project")) {
    Session s;
    s.doc.set("name",json::Value::of("Existing song"));
    s.w->hooks.capturing=[] {return true;}; // the monitor stream remains open
    s.action({ui::Action::project_new,0});
    check(project::detail::str(s.doc,"name")=="Untitled", "input monitoring alone does not block starting a project");
  }
  if (run("sampler-chop-preview")) {
    Session s;
    const auto id=project::detail::str(project::detail::track_pads(s.doc,&E::track_at(s.doc,0))[0],"sampleId");
    for(auto& sample:s.doc.get("samples")->items()) if(project::detail::str(sample,"id")==id) {
      auto pcm=json::Value::new_array();for(int i=0;i<8;++i)pcm.items().push(json::Value::of(i/8.0));
      sample.set("pcm",xmp::move(pcm));sample.set("sampleRate",json::Value::of(48000.0));
    }
    s.action({ui::Action::open_sample,0,-1,0});
    s.w->face.sample.slices=4;
    s.action({ui::Action::sample_chop_mode,0});
    std::vector<float> preview;
    s.w->hooks.audition=[&](const auto& pcm){preview=pcm;return true;};
    s.action({ui::Action::sample_audition,0,-1,2});
    check(preview==std::vector<float>({.5f,.625f}),"Sample pads audition the exact displayed chop boundaries");
    s.action({ui::Action::sample_audition,0,-1,9});
    check(preview==std::vector<float>({.5f,.625f}),"unused chop pads remain silent");
    s.action({ui::Action::sample_chop,0});
    const auto& pads=project::detail::track_pads(s.doc,&E::track_at(s.doc,0));
    check(project::detail::num(project::detail::at(pads[2],"slice"),"start")==4 && project::detail::num(project::detail::at(pads[2],"slice"),"end")==6,
      "Chop to drum kit commits the previewed slices");
  }
  if (failures) return 1;
  std::puts("live changes: machines, effects, sustained audio, bars, custom length, tempo preview/cancel and tap tempo pass");
}
