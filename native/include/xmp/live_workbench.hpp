#pragma once
// The Live's project workspace. Hardware and browser adapters supply audio I/O,
// storage and time. Navigation, rendering and every project action run here.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>

#include "xmp/live_kits.hpp"
#include "xmp/live_library.hpp"
#include "xmp/live_player.hpp"
#include "xmp/live_sample_folder.hpp"
#include "xmp/live_ui.hpp"
#include "xmp/live_loop.hpp"
#include "xmp/song_snapshot.hpp"
#include "xmp/portable.hpp"

namespace xmp::live {

struct WorkbenchHooks {
  std::function<std::uint64_t()> engine_frame;
  std::function<bool(const std::vector<float>&)> audition;
  std::function<bool()> start_capture, capturing;
  std::function<void()> stop_capture;
  std::function<std::vector<library::Entry>()> list;
  std::function<bool(const library::Entry&, std::vector<unsigned char>&)> read;
  std::function<void(const char*)> log;
  // Empty result means the adapter accepted the request.
  std::function<std::string(const std::string&)> save;
  // Optional platform observer: fixed action kinds only, on the control thread.
  std::function<void(ui::Action::Kind)> observe_action{};
};

inline project::Result blank_project() {
  Str text = R"({"format":"xmp-project","version":6,"id":"untitled","name":"Untitled","bpm":120,"swing":0,"master":0.6,"pads":[)";
  for (int i = 0; i < 16; ++i) {
    if (i) text += ",";
    text += Str(R"({"id":"pad-)") + int_text(i) + R"(","name":"Pad )" + int_text(i + 1) + R"(","sampleId":"silence"})";
  }
  text += R"(],"samples":[{"id":"silence","name":"Silence","sampleRate":24000,"pcm":[0]}],"tracks":[)";
  for (int i = 0; i < 8; ++i) {
    if (i) text += ",";
    text += Str(R"({"id":"track-)") + int_text(i) + R"(","name":"Track )" + int_text(i + 1) +
            R"(","muted":false,"volume":0.8,"clips":[]})";
  }
  text += R"(],"scenes":[)";
  for (int i = 0; i < 16; ++i) {
    if (i) text += ",";
    text += Str(R"({"id":"scene-)") + int_text(i) + R"(","name":"Scene )" + int_text(i + 1) + R"(","clips":{}})";
  }
  text += R"(],"seed":0,"parameterVersion":1,"parameters":[]})";
  auto opened = project::open(text);
  if (!opened.ok) return opened;
  auto kit = xmp::edit::apply_drum_kit(opened.project, drum_machine_kit(kDrumMachineKits[0], 24000));
  if (!kit.ok) opened.ok = false, opened.error = kit.error;
  else opened.project = xmp::move(kit.project);
  return opened;
}

inline bool project_copy_name(std::string& name) {
  const auto first = name.find_first_not_of(' ');
  if (first == std::string::npos) return false;
  name = name.substr(first, name.find_last_not_of(' ') - first + 1);
  if (name.size() > 40 || library::lower(name) == "project") return false;
  return std::all_of(name.begin(), name.end(), [](unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
           c == '_' || c == '-' || c == ' ';
  });
}

class Workbench {
 public:
  using Clock = std::chrono::steady_clock;
  static constexpr std::uint64_t kLead = 2400;

  Workbench(json::Value& project, ProjectSound& engine, bool audio_ready, WorkbenchHooks adapter)
      : project_doc(project), sound(engine), hooks(std::move(adapter)), have_audio(audio_ready),
        board(ui::board_of(project)), stick_library(hooks.list()) {}

  json::Value& project_doc;
  ProjectSound& sound;
  WorkbenchHooks hooks;
  bool have_audio;
  ProjectPlayer player;
  ui::Board board;
  ui::Ui face;
  ui::Painter painter;
  sample::Recorder recorder;
  sample::LoopTake* loop = nullptr;
  bool input_failed = false;
  bool monitor_input() const {
    return face.track < board.tracks && (board.input_track[face.track] || face.view == ui::View::sample || face.sampling) && board.input_monitor[face.track];
  }
  bool input_needed() const { return monitor_input() || face.sampling || (loop && loop->busy()); }

  std::vector<ui::Action> actions;
  bool project_dirty = false;
  Clock::time_point project_changed = Clock::now();

  void refresh_files() {
    stick_library = hooks.list();
    refresh_library();
    ++face.revision;
  }

  void touch(ui::TouchPhase phase, int x, int y) {
    if (ui::touch_event(face, project_doc, board, now_state(), phase, x, y, actions)) {
      run_actions("touch");
      return;
    }
    if (phase != ui::TouchPhase::down) return;
    const auto h = ui::hit(face, board, x, y);
    const auto now = now_state();
    if (h.kind == ui::Hit::on_slot) face.slot(h.track, h.scene, board, now, actions, true);
    else if (h.kind == ui::Hit::on_track) face.select_track(h.track, board);
    else if (h.kind == ui::Hit::on_scene) face.select_scene(h.scene, board);
    else if (h.kind == ui::Hit::on_block && h.block < static_cast<int>(board.chain.size())) face.block = h.block, ++face.revision;
    else if (h.kind == ui::Hit::on_sample) face.browse_cursor = h.block, ++face.revision;
    else if (h.kind == ui::Hit::on_note) face.roll_touch(h.step, h.note, board, actions);
    else if (h.kind == ui::Hit::on_mute || h.kind == ui::Hit::on_solo) {
      if (h.track < board.tracks) actions.push_back({h.kind == ui::Hit::on_mute ? ui::Action::mute_track : ui::Action::solo_track, h.track});
    }
    else if (h.kind == ui::Hit::on_pad) {
      face.pad(h.pad, 100, board, now, actions);
      face.pad(h.pad, 0, board, now, actions);
    }
    run_actions("touch");
    return;
  }

  void tick_loop() {
    if (!loop) return;
        using LoopState = xmp::live::sample::LoopTake::State;
        const auto loop_state = loop->state();
        uint32_t ignored_frames=0;xmp::Str tempo_error;
        const bool tempo_ok=xmp::edit::sampler_plan(project_doc,loop_bars,ignored_frames,tempo_error);
        if (loop->busy() && (!player.playing() || board.bpm != loop_bpm || !tempo_ok ||
            xmp::project::detail::str(project_doc,"id") != loop_project || input_failed)) loop->cancel();
        if (loop_state == LoopState::queued || loop_state == LoopState::capturing) {
          sample_screen.frames=static_cast<int>(loop->frames());
          sample_screen.state=loop_state == LoopState::queued ? ui::SampleScreen::armed : ui::SampleScreen::recording;
        }
        if (loop_state == LoopState::looping && !loop_committed && player.playing() && board.bpm == loop_bpm && tempo_ok && !input_failed && xmp::project::detail::str(project_doc,"id")==loop_project) {
          // The fixed audio buffer is already looping while validation and DSP
          // preparation run here, away from the processing callback.
          const int frames=static_cast<int>(loop->length());
          sample_take.assign(loop->pcm(),loop->pcm()+frames);
          sample_from_input = true;
          face.sample_name = "Live loop";
          xmp::Vec<double> values; values.reserve(frames);
          for (float v:sample_take) values.push(v);
          const auto recorded=xmp::edit::record_loop(project_doc,loop_track,loop_scene,loop->pad(),"Live loop",values,loop_bars);
          xmp::Str error;
          if (!recorded.ok || !sound.reload(recorded.project,error,0,true)) {
            loop->cancel();face.sample_done(frames);
            face.say(recorded.ok ? error.c_str() : recorded.error.c_str());
          } else {
            history.before_project(project_doc);project_doc=recorded.project;
            board=ui::board_of(project_doc);
            player.set_project(project_doc,error);
            const uint64_t span=static_cast<uint64_t>(loop_bars*16);
            const auto future=std::max<double>(player.step()+16,player.audible_step(engine_frame())+16);
            const uint64_t handoff=loop_start_step+static_cast<uint64_t>(std::max(1.0,std::ceil((future-loop_start_step)/span)))*span;
            const auto* scene=xmp::edit::detail::find(xmp::edit::detail::items(project_doc,"scenes"),loop_scene);
            const xmp::Str clip=xmp::project::detail::str(xmp::project::detail::at(*scene,"clips"),loop_track.c_str());
            if (player.launch_recorded_loop(loop_track,clip,handoff,error)) loop->handoff_at(player.frame_at_step(handoff));
            else { loop->cancel();face.say(error.c_str()); }
            if(const auto* target=xmp::project::detail::find_by_id(xmp::project::detail::list(project_doc,"tracks"),loop_track))
              loop_sample=xmp::project::detail::str(xmp::project::detail::track_pads(project_doc,target)[loop->pad()],"sampleId");
            loop_committed=true;face.sample_done(frames);
            face.chop_points.clear();compute_chop();
            sample_screen.frames=frames;sample_screen.state=ui::SampleScreen::ready;
            sample_screen.peaks=xmp::live::sample::overview(sample_take,300);++sample_screen.revision;
            project_dirty=true;project_changed=Clock::now();sound_dirty=false;
            face.say("Live loop kept on selected pad · other tracks continue · Undo restores");
          }
        } else if (loop_state == LoopState::failed || loop_state == LoopState::cancelled) {
          if (!loop_restored && !loop_committed && player.playing() && xmp::project::detail::str(project_doc,"id")==loop_project) {
            xmp::Str error;player.launch_clip(loop_track,loop_previous.empty() ? nullptr : &loop_previous,error);loop_restored=true;
          }
          if(face.sampling) {face.sampling=false;face.say("Timed take cancelled; previous sample kept");}
        }
        if(loop_committed && loop->busy()) {
          const auto* target=xmp::project::detail::find_by_id(xmp::project::detail::list(project_doc,"tracks"),loop_track);
          if(!target || xmp::project::detail::str(xmp::project::detail::track_pads(project_doc,target)[loop->pad()],"sampleId")!=loop_sample) {
            loop->cancel();loop_committed=false;loop_restored=true;
            if(player.playing() && xmp::project::detail::str(project_doc,"id")==loop_project) {
              xmp::Str error;player.launch_clip(loop_track,loop_previous.empty()?nullptr:&loop_previous,error);
            }
          }
        }
  }

  void tick() {
    tick_loop();
    if (recorder.state != sample::Recorder::State::idle) {
      sample_screen.level = recorder.level;
      sample_screen.frames = static_cast<int>(recorder.pcm().size());
      sample_screen.state = recorder.state == sample::Recorder::State::recording
          ? ui::SampleScreen::recording : ui::SampleScreen::armed;
      if (++sample_peaks_frame % 15 == 0 && !recorder.pcm().empty()) {
        sample_screen.peaks = sample::overview(recorder.pcm(), 300);
        ++sample_screen.revision;
      }
      if (recorder.state == sample::Recorder::State::done) finish_sampling("ten seconds, the limit");
    }
    if (!audition_waiting.empty() && audition(audition_waiting)) audition_waiting.clear();
    player.fill_held = face.fill_held;
    face.follow(now_state(), actions);
    face.follow_steps(board, now_state());
    if (!actions.empty()) run_actions("transport");
    if (mix_dirty && !player.playing()) mix_dirty = false;
    if (have_audio) {
      sound.collect();
      if (sound_dirty)
        apply_pending_sounds();
    }
    if (mix_dirty && player.playing()) {
      mix_dirty = false;
      mix_applied = Clock::now();
      Str error;
      if (!player.set_project(project_doc, error, engine_frame())) say("ui: the mix waits for the next play: %s", error.c_str());
    }
    if (!face.toast.empty() && face.toast != logged_toast) say("screen: %s", face.toast.c_str());
    logged_toast = face.toast;
    face.tick();
    ++ui_tick;
    face.sound_pending = sound_dirty;
    preview_tempo();
  }

  bool draw(Canvas& canvas) {
    edit::Row row;
    edit::Roll roll;
    if (face.view == ui::View::steps && face.clip_length(board) > 0) {
      const auto place = edit::find(project_doc, Str(board.track_id[face.track].c_str()),
                                   Str(board.clip[face.track][face.cursor].c_str()));
      if (face.melodic(board)) roll = edit::roll(project_doc, place);
      else row = edit::row(project_doc, place, face.step_pad, face.step_note);
    }
    if (face.revision != strip_revision) {
      ui::fill_strip(face, project_doc, board);
      strip_revision = face.revision;
    }
    return painter.draw(canvas, face, board, now_state(), ui_tick, &row, &roll, &sample_screen);
  }

  bool apply_pending_sounds() {
    if (!sound_dirty) return true;
    xmp::Str error;
    sound_changed = Clock::now();
    if (sound.reload(project_doc, error)) {
      sound_dirty = sound_failed = false;
      say("ui: sound: the engine has the project's new sounds");
      return true;
    }
    if (!sound_failed) {
      sound_failed = true;
      say("ui: sound: not applied yet: %s", error.c_str());
    }
    return false;
  }
  // Carries out what the interface asked for.
  void start_project(const xmp::json::Value& doc, const xmp::Str& scene, bool song_mode, const std::string& what,
                           bool resume = false) {
    if (!have_audio) return say("ui: play ignored, no audio");
    if (loop) loop->cancel();
    if (player.playing()) player.stop(engine_frame());
    if (!apply_pending_sounds()) {
      face.say("Sound change still pending · try Play again");
      return;
    }
    xmp::Str error;
    if (player.start(doc, sound, scene, song_mode, engine_frame() + kLead, 0, error, resume))
      say("ui: play %s", what.c_str());
    else
      say("ui: play refused: %s", error.c_str());
  }
  // A Sampler's slice points for the chosen chop (Ui::Chop), in the edited take.
  void compute_chop() {
    if (!face.sampler_take(board) || sample_take.empty()) return;
    face.sample_markers=false;
    const auto pcm = xmp::live::sample::render(sample_take, face.sample);
    const int n = static_cast<int>(pcm.size());
    using C = ui::Ui::Chop;
    if (face.chop == C::keys) face.chop_points = {0};
    else if (face.chop == C::even) face.chop_points = xmp::chop::even(n, face.chop_count);
    else if (face.chop == C::transients) face.chop_points = xmp::chop::transients(pcm, 48000, face.chop_sensitivity);
    else if (face.chop == C::hand) {
      // Starts from the detected hits; - / + then move them.
      if (face.chop_points.size() < 2) face.chop_points = xmp::chop::transients(pcm, 48000, face.chop_sensitivity);
      face.chop_points = xmp::chop::clean(face.chop_points, n);
    } else if (!face.lazy && face.chop_points.empty())
      face.chop_points = {0};
    if (face.chop_points.empty()) face.chop_points = {0};
    face.chop_selected = std::clamp(face.chop_selected, 0, static_cast<int>(face.chop_points.size()) - 1);
    ++face.revision;
  }
  // The end of a recording: the inputs close, and the take is trimmed and normalized.
  void finish_sampling(const char* why) {
    say("sample: the inputs gave %llu frames, loudest %.4f (%.1f dBFS)", static_cast<unsigned long long>(recorder.fed),
        recorder.loudest, recorder.loudest > 0 ? 20 * std::log10(recorder.loudest) : -120.0);
    recorder.stop();
    sample_take = recorder.take();
    sample_from_input = true;
    face.sample_name = "Sample";
    recorder.clear();
    xmp::live::sample::trim_and_normalize(sample_take);
    face.sample_done(static_cast<int>(sample_take.size()));
    face.chop_points.clear(), face.lazy = false;
    compute_chop();
    sample_screen.state = sample_take.empty() ? ui::SampleScreen::none : ui::SampleScreen::ready;
    sample_screen.frames = static_cast<int>(sample_take.size()), sample_screen.level = 0;
    sample_screen.peaks = xmp::live::sample::overview(sample_take, 300);
    ++sample_screen.revision;
    if (sample_take.empty()) {
      face.say("Nothing recorded");
      say("sample: nothing recorded (%s)", why);
    } else {
      face.say("Recorded " + xmp::live::sample::seconds_text(static_cast<int>(sample_take.size())) + ": wheel keeps it");
      say("sample: a take of %zu frames, trimmed and normalized (%s)", sample_take.size(), why);
    }
  }
  void run_actions(const char* source) {
    const bool had_mix = project_doc.get("mix") != nullptr;
    for (const auto& a : actions) {
      if (hooks.observe_action) hooks.observe_action(a.kind);
      const auto track_id = a.track >= 0 && a.track < board.tracks ? xmp::Str(board.track_id[a.track].c_str()) : xmp::Str();
      const auto scene_id = a.scene >= 0 && a.scene < board.scenes ? xmp::Str(board.scene_id[a.scene].c_str()) : xmp::Str();
      xmp::Str error;
      switch (a.kind) {
        case ui::Action::project_new: {
          if (player.playing() || face.sampling || (loop && loop->busy()) || face.rec != ui::Ui::Rec::off) {
            face.say("Stop playback and recording to start a project");
            break;
          }
          auto fresh = blank_project();
          if (!fresh.ok || !sound.reload(fresh.project, error)) {
            face.say("Could not start a project");
            break;
          }
          history.before_project(project_doc);
          project_doc = xmp::move(fresh.project);
          const int revision = face.revision;
          face = ui::Ui{};
          face.revision = revision + 1;
          board = ui::board_of(project_doc);
          sample_take.clear();
          sample_screen = ui::SampleScreen{};
          recorder.clear();
          audition_waiting.clear();
          sound_dirty = false;
          project_dirty = true;
          project_changed = Clock::now();
          face.say("New project");
          break;
        }
        case ui::Action::project_save:
        case ui::Action::project_save_as: {
          std::string name = a.name;
          if (a.kind == ui::Action::project_save_as && !project_copy_name(name)) {
            face.say("Choose a different file name");
            break;
          }
          const auto why = hooks.save ? hooks.save(name) : "Storage is unavailable";
          face.say(why.empty() ? "Saving…" : why);
          break;
        }
      case ui::Action::set_value:
      case ui::Action::rename:
      case ui::Action::choose_machine:
      case ui::Action::create_clip:
      case ui::Action::step_lock: {
        namespace E = xmp::live::edit;
        std::string why;
        bool changed = false;
        const E::Focus focus{a.track, a.scene, a.pad, a.note, a.step, face.block};
        if (a.kind == ui::Action::set_value && a.field.field == E::Field::clip_length) {
          // Asks first when notes would go; UNDO brings them back either way.
          const int lost = E::notes_beyond(project_doc, a.field.focus, a.value);
          if (lost > 0 && face.length_confirm != static_cast<int>(a.value)) {
            face.length_confirm = static_cast<int>(a.value);
            face.say("Shortening to " + std::to_string(static_cast<int>(a.value)) + " steps removes " + std::to_string(lost) +
                     (lost == 1 ? " note" : " notes") + " \xC2\xB7 choose it again to confirm");
            break;
          }
          face.length_confirm = 0;
          changed = E::apply_field(project_doc, a.field, a.value, history, why);
          if (changed && lost > 0) {
            board = ui::board_of(project_doc);
            project_dirty = true, project_changed = Clock::now();
            face.say(std::to_string(lost) + (lost == 1 ? " note" : " notes") + " removed \xC2\xB7 UNDO restores");
            if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
              say("ui: edit waits for next start: %s", error.c_str());
            break;
          }
        } else if (a.kind == ui::Action::set_value)
          changed = E::apply_field(project_doc, a.field, a.value, history, why);
        else if (a.kind == ui::Action::rename)
          changed = E::rename_item(project_doc, focus, a.knob, a.name, history, why);
        else if (a.kind == ui::Action::create_clip)
          changed = E::create_empty_clip(project_doc, focus, history, why);
        else if (a.kind == ui::Action::choose_machine)
          changed = E::choose_instrument(project_doc, a.track, a.pad, history, why);
        else
          changed = E::lock_step(project_doc, focus, a.knob, a.delta, a.fresh, history, why);
        if (!changed) {
          if (!why.empty())
            face.say(why);
          break;
        }
        board = ui::board_of(project_doc);
        if (a.kind == ui::Action::create_clip || (a.kind == ui::Action::set_value && a.field.field == E::Field::clip_length)) {
          face.selected_step = -1;
          face.fit_page(board);
        }
        if (a.kind == ui::Action::choose_machine && board.kind[a.track] == ui::Kind::synth)
          face.show_presets(board);
        if (a.kind == ui::Action::choose_machine ||
            (a.kind == ui::Action::set_value &&
             (a.field.field == E::Field::effect_sync || a.field.field == E::Field::oscillator || (!player.playing() && a.field.field >= E::Field::cutoff && a.field.field <= E::Field::glide))))
          sound_dirty = true, sound_changed = Clock::now();
        mix_dirty = true;
        if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
          say("ui: edit waits for next start: %s", error.c_str());
        project_dirty = true;
        project_changed = Clock::now();
        face.say(a.kind == ui::Action::create_clip ? board.clip_name[a.track][a.scene] + " created"
                                                   : "Edit kept · Undo restores");
        break;
      }
      case ui::Action::effect_edit: {
        std::string why;
        if (!xmp::live::edit::effect_edit(project_doc, a.track, a.source_track, a.step, a.knob, std::max(0, a.pad),
                                          history, why)) {
          face.say(why);
          break;
        }
        board = ui::board_of(project_doc);
        sound_dirty = true;
        sound_changed = Clock::now();
        mix_dirty = true;
        project_dirty = true;
        project_changed = Clock::now();
        face.say("Effect changed · Undo restores");
        break;
      }
      case ui::Action::open_sample: {
        if (a.track < 0 || a.track >= board.tracks || a.pad < 0 || a.pad > 15)
          break;
        const auto &track = xmp::project::detail::list(project_doc, "tracks")[a.track];
        const auto &pad = xmp::project::detail::track_pads(project_doc, &track)[a.pad];
        const auto id = xmp::project::detail::str(pad, "sampleId");
        for (const auto &sample : xmp::project::detail::list(project_doc, "samples"))
          if (xmp::project::detail::str(sample, "id") == id) {
            const auto &pcm = xmp::project::detail::list(sample, "pcm");
            const double rate = xmp::project::detail::num(sample, "sampleRate");
            const auto *slice = pad.get("slice");
            const int start = slice ? static_cast<int>(xmp::project::detail::num(*slice, "start")) : 0,
                      end = slice ? static_cast<int>(xmp::project::detail::num(*slice, "end")) : pcm.size();
            const int frames = std::max(1,static_cast<int>(std::llround(pcm.size()*48000.0/rate)));
            if(frames>xmp::live::sample::kMaxFrames) {face.say("This sample exceeds the 32-second editing limit");break;}
            sample_take.resize(frames);
            const bool normalize=xmp::project::detail::at(xmp::project::detail::at(pad,"edit"),"normalize").as_bool();
            double peak=0;
            if(normalize) for(int at=start;at<end;++at) peak=std::max(peak,std::fabs(pcm[at].as_number()));
            const auto source_sample=[&](int at) {const double v=pcm[at].as_number();return normalize && peak>0 ? std::clamp(v/peak,-1.0,1.0) : v;};
            for (int i = 0; i < frames; ++i) {
              const double at = std::min(pcm.size()-1.0,i*rate/48000.0);
              const int low=static_cast<int>(at);
              const double fraction=at-low;
              sample_take[i]=static_cast<float>(source_sample(low)*(1-fraction)+source_sample(std::min(pcm.size()-1,low+1))*fraction);
            }
            face.sample_markers = false;
            face.sample_name = xmp::project::detail::str(sample,"name").c_str();
            sample_from_input = false;
            face.sample_done(frames);
            face.sample.start=static_cast<int>(std::llround(start*48000.0/rate));
            face.sample.end=static_cast<int>(std::llround(end*48000.0/rate));
            face.sample.fit(frames);
            face.sample.reverse = xmp::project::detail::at(xmp::project::detail::at(pad, "edit"), "reverse").as_bool();
            face.sample_pad = a.pad;
            face.open(ui::View::sample);
            if(face.sampler_take(board)) {
              face.chop=ui::Ui::Chop::keys;face.chop_points={0};
              if(board.slices[a.track]) {
                face.chop=ui::Ui::Chop::hand;face.chop_points.clear();
                for(const auto& p:xmp::project::detail::track_pads(project_doc,&track))
                  if(const auto* slice=p.get("slice");slice && xmp::project::detail::str(p,"sampleId")==id)
                    face.chop_points.push_back(static_cast<int>(std::llround(xmp::project::detail::num(*slice,"start")*48000/rate)));
                face.chop_points=xmp::chop::clean(face.chop_points,frames);
              }
            }
            sample_screen.state = ui::SampleScreen::ready;
            sample_screen.frames = frames;
            sample_screen.peaks = xmp::live::sample::overview(sample_take, 300);
            ++sample_screen.revision;
            face.say("Edit pad sample · Keep commits one undoable edit");
            break;
          }
        break;
      }
        case ui::Action::browse_audition:
          if (a.sample_id.rfind("stick:", 0) == 0) {
            const auto index = std::strtoul(a.sample_id.c_str() + 6, nullptr, 10);
            if (index >= stick_library.size() || stick_library[index].kind != 1)
              break;
            std::vector<unsigned char> bytes;
            if (!hooks.read(stick_library[index], bytes)) {
              face.say("File unavailable; project unchanged");
              break;
            }
            const auto wave = xmp::live::decode_wav(bytes, 48000);
            if (!wave.error.empty()) {
              face.say(wave.error);
              break;
            }
            audition_waiting = wave.samples;
            if (have_audio && audition(audition_waiting))
              audition_waiting.clear();
            break;
          }
          if (have_audio) {
            audition_waiting = xmp::live::edit::preview_pool_sample(project_doc, xmp::Str(a.sample_id.c_str()));
            if (audition(audition_waiting)) audition_waiting.clear();
          }
          break;
        case ui::Action::browse_assign: {
          auto load_kit = [&](const xmp::json::Value& kit) {
            std::string why;
            if (!xmp::live::edit::load_track_kit(project_doc, track_id, kit, history, why)) {
              face.say(why);
              return;
            }
            board = ui::board_of(project_doc);
            sound_dirty = true;
            sound_changed = Clock::now();
            project_dirty = true;
            project_changed = sound_changed;
            if (face.previous == ui::View::sound)
              face.open(ui::View::sound);
            face.say("Kit loaded · Undo restores");
          };
          const auto &builtins = xmp::live::kDrumMachineKits;
          const auto *kit = std::find_if(std::begin(builtins), std::end(builtins),
                                         [&](const auto &entry) { return a.sample_id == entry.id; });
          if (kit != std::end(builtins)) {
            // The generated PCM enters the same bounded project edit as a USB kit.
            load_kit(xmp::live::drum_machine_kit(*kit, 48000));
            break;
          }
          if (a.sample_id.rfind("stick:", 0) == 0) {
            const auto index = std::strtoul(a.sample_id.c_str() + 6, nullptr, 10);
            if (index >= stick_library.size())
              break;
            const auto &entry = stick_library[index];
            if (entry.kind == 3 && (player.playing() || face.sampling || (loop && loop->busy()) || face.rec != ui::Ui::Rec::off)) {
              face.say("Stop playback and recording to switch projects");
              break;
            }
            std::vector<unsigned char> bytes;
            if (!hooks.read(entry, bytes)) {
              face.say("File unavailable; project unchanged");
              break;
            }
            std::string why;
            bool changed = false;
            if (entry.kind == 1) {
              const auto wave = xmp::live::decode_wav(bytes, 48000);
              if (!wave.error.empty()) {
                face.say(wave.error);
                break;
              }
              if (wave.samples.size() > 480000) {
                face.say("Sample exceeds ten seconds");
                break;
              }
              changed =
                  xmp::live::edit::keep_sample(project_doc, a.track, a.pad, wave.samples, 1, entry.name, history, why);
            } else if (entry.kind == 2) {
              xmp::Str source(reinterpret_cast<const char *>(bytes.data()), bytes.size());
              if (!xmp::project::preflight(source.data(), source.size(), error)) {
                face.say(error.c_str());
                break;
              }
              auto kit = xmp::json::parse(source);
              if (!kit.ok) {
                face.say("Invalid kit JSON");
                break;
              }
              if (entry.factory && !unpack_factory_kit(kit.value, error)) {
                face.say("Factory kit is invalid");
                break;
              }
              load_kit(kit.value);
              break;
            } else {
              const auto opened = xmp::song_snapshot::open(reinterpret_cast<const char *>(bytes.data()), bytes.size());
              if (!opened.ok) {
                face.say(opened.error.c_str());
                break;
              }
              if (!sound.reload(opened.project, error)) {
                face.say("Project could not prepare; current song retained");
                break;
              }
              history.before_project(project_doc);
              project_doc = opened.project;
              face.track = face.cursor = face.window = 0;
              changed = true;
            }
            if (!changed) {
              face.say(why);
              break;
            }
            board = ui::board_of(project_doc);
            sound_dirty = entry.kind != 3;
            sound_changed = Clock::now();
            project_dirty = true;
            project_changed = Clock::now();
            face.say("Loaded · Undo restores");
            break;
          }
          std::string why;
          if (!xmp::live::edit::assign_pool_sample(project_doc, a.track, a.pad, xmp::Str(a.sample_id.c_str()), history, why)) {
            face.say(why);
            break;
          }
          board = ui::board_of(project_doc);
          sound_dirty=true;sound_changed=Clock::now();
          face.say("Sample loaded to pad " + std::to_string(a.pad + 1) + ": UNDO restores it");
          if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
            say("ui: the sample plays from the next start: %s", error.c_str());
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::browse_filter: break;
        case ui::Action::copy_clip:
        case ui::Action::unlink_clip: {
          namespace E = xmp::live::edit;
          std::string why;
          const bool copy = a.kind == ui::Action::copy_clip;
          const auto heard = now_state();
          const bool removed_playing = !copy && heard.playing && a.track >= 0 && a.track < board.tracks &&
              a.scene >= 0 && a.scene < board.scenes && !board.clip[a.track][a.scene].empty() &&
              heard.clip[a.track] == board.clip[a.track][a.scene] && face.heard_scene(a.track, board, heard) == a.scene;
          const bool removed_queued = !copy && a.track >= 0 && a.track < board.tracks && a.scene >= 0 && a.scene < board.scenes &&
              heard.queued[a.track] && heard.queued_clip[a.track] == board.clip[a.track][a.scene] &&
              face.launch_scene(a.track, board, heard) == a.scene;

          const bool removed_live_loop = !copy && loop && loop_committed && loop->busy() &&
              loop_track == track_id && loop_scene == scene_id;
          const bool changed = copy
              ? E::copy_slot(project_doc, a.source_track, xmp::Str(a.source_clip.c_str()), a.track, a.scene, history, why)
              : E::unlink_slot(project_doc, a.track, a.scene, history, why);
          if (!changed) { face.say(why); break; }
          if (removed_live_loop) {
            loop->cancel();
            loop_restored = true;  // Deleting a take must not relaunch its previous clip.
          }
          if ((removed_playing || removed_live_loop) && !player.stop_clip_now(track_id, engine_frame(), error))
            say("ui: clip stop refused: %s", error.c_str());
          else if (removed_queued) player.cancel_clip_launch(track_id);
          board = ui::board_of(project_doc);
          face.say(copy ? "Clip copied: UNDO restores the slot" : "Slot removed: UNDO restores it");
          if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
            say("ui: the clip change waits for the next play: %s", error.c_str());
          project_dirty = true;
          project_changed = Clock::now();
          say("ui: %s track %d scene %d (%s)", copy ? "copied into" : "unlinked", a.track + 1, a.scene + 1, source);
          break;
        }
        case ui::Action::play_song:
          if (a.step >= 0 && a.step < static_cast<int>(board.chain.size())) {
            // From a block: the song's position set to that block's start, in a lean copy.
            xmp::json::Value doc = xmp::live::lean(project_doc);
            xmp::json::Value position = xmp::json::Value::new_object();
            position.set("occurrenceId", xmp::json::Value::of(xmp::Str(board.chain[a.step].id.c_str())));
            position.set("offset", xmp::json::Value::of(0.0));
            doc.get("performance")->set("position", xmp::move(position));
            start_project(doc, xmp::Str(), true,
                          "the song from block " + std::to_string(a.step + 1) + " (" + source + ")", true);
          } else {
            start_project(project_doc, xmp::Str(), true, std::string("the song (") + source + ")");
          }
          break;
        case ui::Action::mute_track:
        case ui::Action::solo_track: {
          namespace E = xmp::live::edit;
          std::string why;
          const bool mute = a.kind == ui::Action::mute_track;
          if (!(mute ? E::toggle_mute(project_doc, a.track, history, why) : E::toggle_solo(project_doc, a.track, history, why))) {
            face.say(why);
            break;
          }
          board = ui::board_of(project_doc);
          const bool on = mute ? board.muted[a.track] : board.soloed[a.track];
          say("ui: mix: track %d %s (%s)", a.track + 1,
              mute ? (on ? "muted" : "unmuted") : (on ? "soloed" : "no longer soloed"), source);
          face.say(board.track_name[a.track] + (mute ? (on ? " muted" : " unmuted") : (on ? " soloed" : " unsoloed")));
          if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
            say("ui: the mix waits for the next play: %s", error.c_str());
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::song_capture: {
          namespace E = xmp::live::edit;
          std::string why;
          const int at = face.capture_replace ? 0 : board.chain.empty() ? 0 : face.song_block(board) + 1;
          int added = 0, blocks = 0;
          bool kept = false;
          if (face.capture_replace) {
            auto next = project_doc;
            if (!next.get("performance"))
              next.set("performance", xmp::edit::detail::empty_performance());
            next.get("performance")->set("chain", xmp::json::Value::new_array());
            next.get("performance")->remove("position");
            E::History scratch;
            if (E::song_capture(next, face.captured, 0, scratch, added, blocks, why)) {
              history.before_project(project_doc);
              project_doc = next;
              kept = true;
            }
          } else
            kept = E::song_capture(project_doc, face.captured, at, history, added, blocks, why);
          if (!kept) {
            face.say("Not captured: " + why);
            say("ui: song capture not kept: %s (%s)", why.c_str(), source);
            break;
          }
          board = ui::board_of(project_doc);
          face.block = at;
          say("ui: song: captured %zu parts as %d blocks from block %d, %d new scenes (%s)", face.captured.size(),
              blocks, at + 1, added, source);
          face.say(
              "Captured " + std::to_string(blocks) + (blocks == 1 ? " block" : " blocks") +
              (added ? ", " + std::to_string(added) + (added == 1 ? " new scene" : " new scenes") : std::string()));
          face.captured.clear();
          if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
            say("ui: the song change waits for the next play: %s", error.c_str());
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::song_add:
        case ui::Action::song_remove: {
          namespace E = xmp::live::edit;
          std::string why;
          int at = a.step;
          const bool changed = a.kind == ui::Action::song_add ? E::song_insert(project_doc, at, a.scene, history, why)
                                                              : E::song_remove(project_doc, at, history, why);
          if (!changed) {
            face.say(why);
            break;
          }
          board = ui::board_of(project_doc);
          face.block = std::min(at, std::max(0, static_cast<int>(board.chain.size()) - 1));
          if (a.kind == ui::Action::song_add) {
            say("ui: song: %s added as block %d (%s)", board.scene_name[a.scene].c_str(), at + 1, source);
            face.say(board.scene_name[a.scene] + " is block " + std::to_string(at + 1));
          } else {
            say("ui: song: block %d removed (%s)", at + 1, source);
            face.say("Block " + std::to_string(at + 1) + " removed");
          }
          if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
            say("ui: the song change waits for the next play: %s", error.c_str());
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::play_scene:
          start_project(project_doc, scene_id, false, "scene " + board.scene_name[a.scene] + " (" + source + ")");
          break;
        case ui::Action::sample_monitor:
        case ui::Action::sample_length: {
          const bool monitor = a.kind == ui::Action::sample_monitor ? !board.input_monitor[a.track] : board.input_monitor[a.track];
          const int bars = a.kind == ui::Action::sample_length ? (board.input_bars[a.track] == 4 ? 1 : board.input_bars[a.track]*2) : board.input_bars[a.track];
          const auto changed = xmp::edit::sampler_input(project_doc,track_id,monitor,bars);
          if (!changed.ok) { face.say(changed.error.c_str()); break; }
          history.before_project(project_doc), project_doc = changed.project;
          board = ui::board_of(project_doc), project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::sample_arm: {
          if (loop && loop->busy()) { face.sampling=false; face.say("The previous loop is entering its clip"); break; }
          uint32_t timed_frames=0;xmp::Str plan_error;
          if(player.playing() && !xmp::edit::sampler_plan(project_doc,board.input_bars[a.track],timed_frames,plan_error)) {
            face.sampling=false;face.say(plan_error.c_str());break;
          }
          if (!hooks.capturing() && !hooks.start_capture()) {
            face.sample_done(static_cast<int>(sample_take.size())); face.say("Input unavailable; the previous sample is intact"); break;
          }
          if (player.playing()) {
            if (!loop) {face.sampling=false;face.say("Synced input is unavailable");break;}
            if ((board.kind[a.track] != ui::Kind::sampler && board.kind[a.track] != ui::Kind::kit) || a.scene < 0 || a.scene >= board.scenes) {
              face.sampling=false; face.say("Choose a sampler track and scene"); break;
            }
            loop_start_step = xmp::live::sample::next_record_bar(std::max(player.audible_step(engine_frame()),player.step()));
            loop_bars = board.input_bars[a.track], loop_bpm = board.bpm;
            loop_track=track_id, loop_scene=xmp::Str(board.scene_id[a.scene].c_str());
            loop_project=xmp::project::detail::str(project_doc,"id"),loop_committed=false;
            const auto first = player.frame_at_step(loop_start_step);
            loop_previous = "";loop_restored=false;
            if (const auto* performance=player.performance()) for(const auto& slot:performance->slots())
              if(slot.track==track_id && slot.has_clip) loop_previous=slot.clip;
            if (!loop->queue(first,timed_frames,a.track,a.pad)) {
              face.sampling=false; face.say("Could not queue the take"); break;
            }
            player.stop_for_recording(track_id,loop_start_step,error);
            face.say("Queued for next bar · "+std::to_string(loop_bars)+" bars");
          } else {
            recorder.arm(); face.say("Waiting for sound");
          }
          sample_screen.state=ui::SampleScreen::armed, sample_screen.frames=0;
          sample_screen.peaks.clear(),++sample_screen.revision;
          break;
        }
        case ui::Action::sample_stop:
          if (loop && loop->busy()) { loop->cancel(); face.sampling=false; face.say("Timed take cancelled; previous sample kept"); }
          else if (face.sampling || recorder.state != xmp::live::sample::Recorder::State::idle) finish_sampling(source);
          break;
        case ui::Action::sample_discard:
          sample_take.clear();
          face.sample_done(0);
          sample_screen = ui::SampleScreen{}, sample_screen.revision = 1;
          face.say("Take discarded");
          say("sample: take discarded (%s)", source);
          break;
        case ui::Action::sample_audition:
          if (!have_audio) break;
          if (face.sampler_take(board) && !face.sample_markers && a.pad >= 0 && face.chop != ui::Ui::Chop::keys) {
            const auto pcm = sample::render(sample_take,face.sample);
            const auto points = xmp::chop::clean(face.chop_points,static_cast<int>(pcm.size()));
            if(a.pad >= static_cast<int>(points.size())) break;
            const int first=points[a.pad], last=a.pad+1 < static_cast<int>(points.size()) ? points[a.pad+1] : static_cast<int>(pcm.size());
            audition_waiting.assign(pcm.begin()+first,pcm.begin()+last);
          } else audition_waiting = xmp::live::sample::preview_chop(sample_take, face.sample, a.pad);
          if (audition_waiting.empty()) break;
          if (audition(audition_waiting)) audition_waiting.clear();
          break;
        case ui::Action::sample_chop_mode:
          face.sample_markers = true;
          xmp::live::sample::refresh_chops(sample_take, face.sample, board.bpm);
          ++face.revision;
          break;
        case ui::Action::sample_chop: {
          const auto pcm = xmp::live::sample::render(sample_take, face.sample);
          auto points = xmp::live::sample::chop_boundaries(static_cast<int>(pcm.size()), face.sample);
          if (face.sampler_take(board) && !face.sample_markers && face.chop != ui::Ui::Chop::keys) {
            points=xmp::chop::clean(face.chop_points,static_cast<int>(pcm.size()));points.push_back(static_cast<int>(pcm.size()));
          }
          xmp::Vec<double> audio, boundaries;
          for (const float v : pcm) audio.push(v);
          for (const int v : points) boundaries.push(v);
          auto result = xmp::edit::chop_sample_to_kit(project_doc, track_id, xmp::Str(face.sample_name.c_str()), 48000, audio, boundaries);
          if(result.ok && sample_from_input) result=xmp::edit::sampler_input(result.project,track_id,board.input_monitor[a.track],board.input_bars[a.track]);
          if (!result.ok) { face.say(result.error.c_str()); break; }
          history.before_project(project_doc);
          project_doc = result.project;
          board = ui::board_of(project_doc);
          sound_dirty = project_dirty = true;
          sound_changed = project_changed = Clock::now();
          face.open(ui::View::sound);
          face.say("Chopped to this track's drum kit · Undo restores");
          break;
        }
        case ui::Action::chop_compute:
          compute_chop();
          break;
        case ui::Action::chop_lazy: {
          if (face.lazy) {
            face.lazy = false, ++face.revision;
            face.say(std::to_string(face.chop_points.size()) + " slices marked");
            break;
          }
          if (sample_take.empty()) break;
          const auto pcm = xmp::live::sample::render(sample_take, face.sample);
          face.chop_points = {0}, face.chop_selected = 0, face.lazy = true, ++face.revision;
          lazy_frames = static_cast<int>(pcm.size());
          lazy_started = Clock::now();
          if (have_audio) {
            audition_waiting = pcm;
            if (audition(audition_waiting)) audition_waiting.clear();
          }
          face.say("Tap a pad where each slice starts");
          break;
        }
        case ui::Action::chop_mark: {
          if (!face.lazy) break;
          const double seconds = std::chrono::duration<double>(Clock::now() - lazy_started).count();
          const int at = static_cast<int>(std::lround(seconds * 48000));
          if (at >= lazy_frames) {
            face.lazy = false, ++face.revision;
            face.say("The take ended: " + std::to_string(face.chop_points.size()) + " slices");
            break;
          }
          face.chop_points.push_back(at);
          face.chop_points = xmp::chop::clean(face.chop_points, lazy_frames);
          face.chop_selected = static_cast<int>(face.chop_points.size()) - 1, ++face.revision;
          if (static_cast<int>(face.chop_points.size()) >= xmp::chop::kMaxSlices) face.lazy = false;
          face.say("Slice " + std::to_string(face.chop_points.size()));
          break;
        }
        case ui::Action::sample_keep: {
          std::string why;
          const auto pcm = xmp::live::sample::render(sample_take, face.sample);
          if (face.sampler_take(board) && !face.sample_markers) {
            // A Sampler: the whole take as keys, or chopped at the slice points
            // (even and transient points worked out again from what is kept).
            using C = ui::Ui::Chop;
            auto points = face.chop == C::even         ? xmp::chop::even(static_cast<int>(pcm.size()), face.chop_count)
                          : face.chop == C::transients ? xmp::chop::transients(pcm, 48000, face.chop_sensitivity)
                                                       : face.chop_points;
            const std::string name = face.sample_name;
            if (!xmp::live::edit::keep_sampler(project_doc, a.track, pcm, points, face.chop != C::keys, name, history, why)) {
              face.say(why);
              say("sample: not kept: %s", why.c_str());
              break;
            }
            if(sample_from_input) {
              const auto tagged=xmp::edit::sampler_input(project_doc,track_id,board.input_monitor[a.track],board.input_bars[a.track]);
              if(tagged.ok) project_doc=tagged.project;
            }
            board = ui::board_of(project_doc);
            sound_dirty = true, sound_changed = Clock::now();
            face.lazy = false;
            face.say(name + (face.chop == C::keys ? " as keys" : " in " + std::to_string(xmp::chop::clean(points, static_cast<int>(pcm.size())).size()) + " slices"));
            say("sample: %s, %zu frames, kept on Sampler track %d (%s)", name.c_str(), pcm.size(), a.track + 1, ui::Ui::chop_name(face.chop));
            if (player.playing() && !player.set_project(project_doc, error, engine_frame())) say("ui: the sample plays from the next start: %s", error.c_str());
            project_dirty = true;
            project_changed = Clock::now();
            break;
          }
          const std::string name = face.sample_name;
          const auto boundaries = xmp::live::sample::chop_boundaries(static_cast<int>(pcm.size()),face.sample);
          if (!xmp::live::edit::keep_sample(project_doc, a.track, a.pad, pcm, static_cast<int>(boundaries.size())-1, name, history, why, &boundaries)) {
            face.say(why);
            say("sample: not kept: %s", why.c_str());
            break;
          }
          if (sample_from_input) {
            const auto tagged=xmp::edit::sampler_input(project_doc,track_id,board.input_monitor[a.track],board.input_bars[a.track]);
            if(tagged.ok) project_doc=tagged.project;
          }
          board = ui::board_of(project_doc);
          sound_dirty=true;sound_changed=Clock::now();
          const int last = a.pad + std::min(face.sample.slices, 16 - a.pad);
          face.say(name + " on " + board.track_name[a.track] + (last - a.pad > 1 ? ", pads " + std::to_string(a.pad + 1) + "\xE2\x80\x93" + std::to_string(last)
                                                                                 : ", pad " + std::to_string(a.pad + 1)));
          say("sample: %s, %zu frames, kept on track %d pad %d across %d pads (%s)", name.c_str(), pcm.size(), a.track + 1,
              a.pad + 1, last - a.pad, source);
          if (player.playing() && !player.set_project(project_doc, error)) say("ui: the sample plays from the next start: %s", error.c_str());
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::play_clip: {
          // Only this clip: the performance's selection for its scene.
          xmp::json::Value doc = project_doc;
          if (!doc.get("performance")) doc.set("performance", xmp::edit::detail::empty_performance());
          auto selection = xmp::json::Value::new_object();
          selection.set("sceneId", xmp::json::Value::of(scene_id));
          auto clips = xmp::json::Value::new_object();
          clips.set(track_id, xmp::json::Value::of(xmp::Str(board.clip[a.track][a.scene].c_str())));
          selection.set("clips", xmp::move(clips));
          doc.get("performance")->set("selection", xmp::move(selection));
          start_project(doc, scene_id, false,
                        "clip " + board.clip_name[a.track][a.scene] + " on track " + std::to_string(a.track + 1) + " (" + source + ")");
          break;
        }
        case ui::Action::stop:
          player.stop(engine_frame());
          say("ui: stop (%s)", source);
          break;
        case ui::Action::panic: {
          xmp::live::PlayerCommand c;
          c.kind = xmp::live::PlayerCommand::panic;
          sound.push(c);
          say("ui: silence (%s)", source);
          break;
        }
        case ui::Action::launch_clip: {
          const xmp::Str clip(board.clip[a.track][a.scene].c_str());
          if (player.launch_clip(track_id, &clip, error))
            say("ui: launch clip %s on track %d at the next bar (%s)", board.clip_name[a.track][a.scene].c_str(), a.track + 1, source);
          else
            say("ui: launch refused: %s", error.c_str());
          break;
        }
        case ui::Action::stop_clip:
          if (player.launch_clip(track_id, nullptr, error)) say("ui: stop track %d at the next bar (%s)", a.track + 1, source);
          else say("ui: stop refused: %s", error.c_str());
          break;
        case ui::Action::launch_scene:
          if (player.launch_scene(scene_id, error))
            say("ui: launch scene %s at the next bar (%s)", board.scene_name[a.scene].c_str(), source);
          else
            say("ui: launch refused: %s", error.c_str());
          break;
        case ui::Action::note_on:
          if (have_audio && !apply_pending_sounds()) break;
          if (have_audio && !sound.play_live(a.track, a.pad, a.note, a.velocity))
            say("audio: command queue full, live note dropped");
          break;
        case ui::Action::note_off:
          if (have_audio) sound.release_live(track_id, a.note);
          break;
        case ui::Action::toggle_step:
        case ui::Action::erase_row:
        case ui::Action::undo:
        case ui::Action::redo: {
          namespace E = xmp::live::edit;
          E::Place place;
          std::string why;
          bool changed = false;
          if (a.kind == ui::Action::undo || a.kind == ui::Action::redo) {
            changed = a.kind == ui::Action::undo ? history.undo(project_doc, place) : history.redo(project_doc, place);
            if (changed) sound_dirty = true, sound_changed = Clock::now();
            face.say(changed ? (a.kind == ui::Action::undo ? "Undone" : "Redone")
                             : (a.kind == ui::Action::undo ? "Nothing to undo" : "Nothing to redo"));
            if (changed) say("ui: %s (%s)", a.kind == ui::Action::undo ? "undo" : "redo", source);
          } else {
            place = E::find(project_doc, track_id, xmp::Str(board.clip[a.track][a.scene].c_str()));
            changed = a.kind == ui::Action::toggle_step
                          ? E::toggle(project_doc, place, a.step, a.pad, a.note, history, why, a.velocity, a.chance, a.length)
                          : E::erase(project_doc, place, a.pad, a.note, history, why);
            if (!changed) face.say(why);
            else if (a.kind == ui::Action::toggle_step)
              say("ui: step %d of %s on track %d toggled (%s)", a.step + 1, board.clip_name[a.track][a.scene].c_str(), a.track + 1, source);
            else
              say("ui: erased a row of %s on track %d (%s)", board.clip_name[a.track][a.scene].c_str(), a.track + 1, source);
          }
          if (changed) {
            if (place.ok()) ui::refresh_clip(board, place.track, E::clip_at(project_doc, place));
            if (history.structural() && (a.kind == ui::Action::undo || a.kind == ui::Action::redo)) {
              board = ui::board_of(project_doc);
              if (player.playing() && !player.set_project(project_doc, error, engine_frame())) say("ui: the player kept the old project: %s", error.c_str());
            } else if (player.playing() && !player.replace_clip(place.track, place.clip, E::clip_at(project_doc, place))) {
              say("ui: the edit waits for the next play");
            }
            project_dirty = true;
            project_changed = Clock::now();
          }
          break;
        }
        case ui::Action::record_start:
          if (!player.playing())
            start_project(project_doc, scene_id, false, "scene " + board.scene_name[a.scene] + " to count in a take (" + source + ")");
          say("ui: recording track %d into scene %s from step %d (%s)", a.track + 1, board.scene_name[a.scene].c_str(),
              static_cast<int>(face.rec_start) + 1, source);
          break;
        case ui::Action::record_end: {
          namespace E = xmp::live::edit;
          std::string id, why;
          if (!E::record_clip(project_doc, a.track, a.scene, face.take_length, face.take, history, id, why)) {
            face.say(why);
            say("ui: take not kept: %s", why.c_str());
            break;
          }
          board = ui::board_of(project_doc);
          say("ui: recorded %s, %d steps, %zu hits, on track %d in scene %s (%s)", board.clip_name[a.track][a.scene].c_str(),
              face.take_length, face.take.size(), a.track + 1, board.scene_name[a.scene].c_str(), source);
          face.recorded_clip = id;
          face.say("Recorded " + board.clip_name[a.track][a.scene]);
          if (player.playing()) {
            const xmp::Str clip(id.c_str());
            if (!player.set_project(project_doc, error, engine_frame()) || !player.launch_clip(track_id, &clip, error))
              say("ui: the take plays from the next start: %s", error.c_str());
          }
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::choose_preset: {
          namespace E = xmp::live::edit;
          std::string why;
          if (!E::set_preset(project_doc, a.track, a.pad, history, why)) {
            face.say(why);
            break;
          }
          board = ui::board_of(project_doc);
          mix_dirty = true;
          sound_dirty = true, sound_changed = Clock::now();
          say("ui: track %d preset %s (%s)", a.track + 1, E::presets()[a.pad].name, source);
          face.say(board.track_name[a.track] + ": " + E::presets()[a.pad].name);
          project_dirty = true;
          project_changed = Clock::now();
          break;
        }
        case ui::Action::turn_knob: {
          namespace E = xmp::live::edit;
          E::Shown shown;
          std::string why;
          bool changed = false;
          if (a.sound) {
            changed = E::sound_knob(project_doc, a.track, a.knob, a.delta, a.fresh, history, shown, why);
            if (changed) {
              mix_dirty = true;
              if (!player.playing()) sound_dirty = true, sound_changed = Clock::now();
              say("ui: track %d sound %s %s (knob %d, %s)", a.track + 1, shown.name.c_str(), shown.value.c_str(), a.knob + 1,
                  source);
            }
          } else if (a.song) {
            int at = a.step;
            changed = E::song_knob(project_doc, at, a.knob, a.delta, a.fresh, history, shown, why);
            if (changed) {
              board = ui::board_of(project_doc);
              face.block = at;
              if (player.playing() && !player.set_project(project_doc, error, engine_frame()))
                say("ui: the song change waits for the next play: %s", error.c_str());
              say("ui: song block %d: %s %s (knob %d, %s)", at + 1, shown.name.c_str(), shown.value.c_str(), a.knob + 1,
                  source);
            }
          } else if (a.step >= 0) {
            const auto place = E::find(project_doc, track_id, xmp::Str(board.clip[a.track][a.scene].c_str()));
            int step = a.step;
            changed = E::step_knob(project_doc, place, step, a.pad, a.note, a.knob, a.delta, a.fresh, history, shown, why);
            if (changed) {
              ui::refresh_clip(board, place.track, E::clip_at(project_doc, place));
              face.selected_step = step;
              if (step / 16 != face.page) face.page = step / 16, face.fit_page(board);
              if (player.playing() && !player.replace_clip(place.track, place.clip, E::clip_at(project_doc, place)))
                say("ui: the edit waits for the next play");
              say("ui: step %d of %s on track %d: %s %s (knob %d, %s)", step + 1, board.clip_name[a.track][a.scene].c_str(),
                  a.track + 1, shown.name.c_str(), shown.value.c_str(), a.knob + 1, source);
            }
          } else {
            changed = E::track_knob(project_doc, a.track, a.knob, a.delta, a.fresh, history, shown, why);
            if (changed) {
              mix_dirty = true;
              board = ui::board_of(project_doc);  // the Mix view's strips
              say("ui: track %d %s %s (knob %d, %s)", a.track + 1, shown.name.c_str(), shown.value.c_str(), a.knob + 1, source);
            }
          }
          if (!why.empty()) face.show_knob(shown.name, why);
          else face.show_knob(shown.name, shown.value);
          if (changed) {
            project_dirty = true;
            project_changed = Clock::now();
          }
          break;
        }
        case ui::Action::overdub_hit: {
          namespace E = xmp::live::edit;
          // The clip the track plays now.
          xmp::Str playing_clip;
          if (const auto* perf = player.performance())
            for (const auto& slot : perf->slots())
              if (slot.track == track_id && slot.has_clip) playing_clip = slot.clip;
          const auto place = E::find(project_doc, track_id, playing_clip);
          if (!place.ok()) break;
          if (a.fresh) history.before(project_doc, place);
          if (E::add_hit(E::clip_at(project_doc, place), E::is_synth(project_doc, place), a.hit)) {
            ui::refresh_clip(board, place.track, E::clip_at(project_doc, place));
            player.replace_clip(place.track, place.clip, E::clip_at(project_doc, place));
            say("ui: overdub on track %d at step %.2f (%s)", a.track + 1, a.hit.at + 1, source);
            project_dirty = true;
            project_changed = Clock::now();
          }
          break;
        }
      }
    }
    if (face.view == ui::View::browse && last_view != ui::View::browse) refresh_files();
    else refresh_library();
    last_view = face.view;
    if (!actions.empty()) strip_revision = -1;  // the knobs' values may have changed
    actions.clear();
    if (!had_mix && project_doc.get("mix")) sound_dirty = true;
    if (have_audio && sound_dirty) apply_pending_sounds();
    preview_tempo();
  }
  // What the player is doing, for the interface.
  ui::Now now_state() const {
    ui::Now n;
    n.input_time = Clock::now();
    const auto* perf = player.performance();
    n.playing = player.playing();
    if (!perf || !n.playing) return n;
    n.song = perf->song();
    n.step = player.audible_step(engine_frame());
    n.scene = ui::text(perf->scene_id());
    for (const auto& slot : perf->slots())
      for (int t = 0; t < board.tracks; ++t)
        if (board.track_id[t] == ui::text(slot.track)) {
          if (slot.has_clip) n.clip[t] = ui::text(slot.clip);
          n.anchor[t] = slot.anchor;
        }
    for (const auto& q : perf->queued())
      for (int t = 0; t < board.tracks; ++t)
        if (board.track_id[t] == ui::text(q.track)) {
          n.queued[t] = true;
          n.queued_clip[t] = q.has_clip ? ui::text(q.clip) : std::string();
        }
    xmp::Str queued_scene;
    if (perf->queued_scene(queued_scene)) n.queued_scene = ui::text(queued_scene);
    xmp::Str block;
    if (n.song && perf->occurrence(block)) n.block = ui::text(block);
    return n;
  }

 private:
  ui::View last_view = ui::View::clips;
  std::vector<library::Entry> stick_library;
  std::vector<float> sample_take, audition_waiting;
  bool sample_from_input = false;
  xmp::Str loop_track, loop_scene, loop_project, loop_previous, loop_sample;
  int loop_bars = 4, loop_bpm = 120;
  uint64_t loop_start_step = 0;
  bool loop_committed = false, loop_restored = false;
  Clock::time_point lazy_started{}, mix_applied = Clock::now(), sound_changed = Clock::now();
  int lazy_frames = 0, sample_peaks_frame = 0, ui_tick = 0, strip_revision = -1;
  ui::SampleScreen sample_screen;
  edit::History history;
  std::string logged_toast;
  bool mix_dirty = false, sound_dirty = false, sound_failed = false;

  void preview_tempo() {
    if (!player.playing()) return;
    double bpm = project::detail::num(project_doc, "bpm");
    if (face.editor_open && face.editor.field == edit::Field::tempo) {
      bpm = face.editor.value;
      if (!face.editor_text.empty()) {
        char* end = nullptr; bpm = std::strtod(face.editor_text.c_str(), &end);
        if (!end || *end || !std::isfinite(bpm) || bpm < 30 || bpm > 300) return;
      }
    }
    Str error;
    if (!player.preview_tempo(bpm, engine_frame(), error)) say("tempo preview: %s", error.c_str());
  }
  std::uint64_t engine_frame() const { return hooks.engine_frame(); }
  bool audition(const std::vector<float>& samples) { return hooks.audition(samples); }
  void say(const char* line) { hooks.log(line); }
  template <typename... Args>
  void say(const char* format, Args... args) {
    char text[512];
    std::snprintf(text, sizeof text, format, args...);
    hooks.log(text);
  }
  static bool unpack_factory_kit(json::Value& kit, Str& error) {
    auto* samples = kit.get("samples");
    if (!samples || !samples->is_array() || samples->items().size() > 16) return false;
    for (auto& sample : samples->items()) {
      if (sample.get("pcm")) continue;  // Velvet already uses the public kit format.
      const auto frames = project::detail::num(sample, "frames");
      if (frames < 1 || frames > 480000 || std::floor(frames) != frames ||
          project::detail::str(sample, "encoding") != "pcm-f32le") return false;
      Vec<double> pcm;
      if (!portable::detail::decode_asset(sample, pcm, error)) return false;
      json::Value unpacked = json::Value::new_array();
      unpacked.items().reserve(pcm.size());
      for (double point : pcm) unpacked.push(json::Value::of(point));
      auto decoded = json::Value::new_object();
      decoded.set("name", project::detail::at(sample, "name"));
      decoded.set("sampleRate", project::detail::at(sample, "sampleRate"));
      decoded.set("pcm", xmp::move(unpacked));
      sample = xmp::move(decoded);
    }
    return true;
  }

  void refresh_library() {
    if (face.view != ui::View::browse)
      return;
    board.samples.clear();
    const auto query = xmp::live::library::lower(face.browse_query);
    if (face.browse_category == 0)
      for (const auto &sample : xmp::project::detail::list(project_doc, "samples")) {
        const std::string name = xmp::project::detail::str(sample, "name").c_str();
        if (query.empty() || xmp::live::library::lower(name).find(query) != std::string::npos)
          board.samples.push_back({xmp::project::detail::str(sample, "id").c_str(), name, "Project pool", 0});
      }
    if (face.browse_category == 1)
      for (const auto &kit : xmp::live::kDrumMachineKits)
        if (query.empty() || xmp::live::library::lower(kit.name).find(query) != std::string::npos)
          board.samples.push_back({kit.id, kit.name, "Built-in kit", 2});
    for (std::size_t i = 0; i < stick_library.size(); ++i) {
      const auto &item = stick_library[i];
      if (item.kind != face.browse_category + 1)
        continue;
      if (!xmp::live::library::matches(item, query))
        continue;
      board.samples.push_back({"stick:" + std::to_string(i), item.name, item.factory ? "Factory kit" : item.name, item.kind});
    }
    face.browse_cursor = std::clamp(face.browse_cursor, 0, std::max(0, static_cast<int>(board.samples.size()) - 1));
  }
};

} // namespace xmp::live
