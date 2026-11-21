#pragma once
// XMP's own interface on the MPC Live Mk1 (phase 8 of docs/cpp-port.md; the
// design is docs/live-ux.md): the Clips view (home: eight tracks by sixteen
// scenes, a 4x4 window of it on the pads), the Play view (the pads play the
// selected track) and the Steps view (the pads are sixteen steps of the
// selected clip), on the full project the session plays.
//
// Everything here is pure and runs on the session's main thread only: the
// session passes in what the controller sent and what the player is doing,
// and gets back Actions to carry out (launch a clip, play a note, ...). The
// drawing goes to a Canvas, which on the Mac is a plain pixel buffer, so the
// whole interface is tested without the hardware (native/tests/live_ui_test.cpp).
#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "xmp/live_edit.hpp"
#include "xmp/live_logo.hpp"
#include "xmp/live_sample.hpp"
#include "xmp/live_screen.hpp"
#include "xmp/live_text.hpp"
#include "xmp/project.hpp"
#include "xmp/pad_scale.hpp"
#include "xmp/live_fields.hpp"
#include "xmp/live_feedback.hpp"

namespace xmp::live::ui {

// ---- the Live Mk1's buttons (os/live-mk1/hardware.json, controller.map.labels) ----

enum class Button : std::uint8_t {
  none,
  bank_a, bank_b, bank_c, bank_d,
  note_repeat, full_level, level16, erase,
  shift, menu, main, undo, copy, plus, minus,
  tap_tempo, rec, overdub, stop, play, play_start,
  qlink, wheel,
};

// The note numbers the controller sends on MIDI channel 1 for its buttons.
inline Button button_of(std::uint8_t code) {
  switch (code) {
    case 0x23: return Button::bank_a;
    case 0x24: return Button::bank_b;
    case 0x25: return Button::bank_c;
    case 0x26: return Button::bank_d;
    case 0x0B: return Button::note_repeat;
    case 0x27: return Button::full_level;
    case 0x28: return Button::level16;
    case 0x09: return Button::erase;
    case 0x31: return Button::shift;
    case 0x7B: return Button::menu;
    case 0x34: return Button::main;
    case 0x43: return Button::undo;
    case 0x7A: return Button::copy;
    case 0x36: return Button::plus;
    case 0x37: return Button::minus;
    case 0x35: return Button::tap_tempo;
    case 0x49: return Button::rec;
    case 0x50: return Button::overdub;
    case 0x51: return Button::stop;
    case 0x52: return Button::play;
    case 0x53: return Button::play_start;
    case 0x00: return Button::qlink;
    case 0x6F: return Button::wheel;
    default: return Button::none;
  }
}

inline const char* button_name(Button b) {
  switch (b) {
    case Button::bank_a: return "Pad Bank A";
    case Button::bank_b: return "Pad Bank B";
    case Button::bank_c: return "Pad Bank C";
    case Button::bank_d: return "Pad Bank D";
    case Button::note_repeat: return "Note Repeat";
    case Button::full_level: return "Full Level";
    case Button::level16: return "16 Level";
    case Button::erase: return "Erase";
    case Button::shift: return "Shift";
    case Button::menu: return "Menu";
    case Button::main: return "Main";
    case Button::undo: return "Undo";
    case Button::copy: return "Copy";
    case Button::plus: return "+";
    case Button::minus: return "-";
    case Button::tap_tempo: return "Tap Tempo";
    case Button::rec: return "Rec";
    case Button::overdub: return "Overdub";
    case Button::stop: return "Stop";
    case Button::play: return "Play";
    case Button::play_start: return "Play Start";
    case Button::qlink: return "Q-Link";
    case Button::wheel: return "data wheel";
    default: return "?";
  }
}

// The data wheel: control 0x64 on channel 1, 01 one step clockwise, 7F one back.
constexpr std::uint8_t kWheelControl = 0x64;
inline int wheel_steps(std::uint8_t value) { return value < 64 ? value : value - 128; }

// ---- what the project has, read once when it is opened ----

constexpr int kTracks = 8, kScenes = 16;

enum class Kind : std::uint8_t { kit, synth, midi, other, sampler };

inline std::string text(const Str& s) { return std::string(s.c_str(), s.size()); }

struct Board {
  std::string name;
  double bpm = 120;
  int tracks = 0, scenes = 0;
  bool song = false;  // the project has a scene chain
  struct Sound { std::string id, name, detail{}; int kind=0; };
  std::vector<Sound> samples;
  std::array<std::string, kTracks> track_id, track_name, sound;
  std::array<Kind, kTracks> kind{};
  std::array<bool,kTracks> routed{}, input_track{};
  std::array<bool,kTracks> input_monitor{{true,true,true,true,true,true,true,true}};
  std::array<int,kTracks> input_bars{{4,4,4,4,4,4,4,4}};
  // No machine chosen yet: no machine, no kit of its own and no notes (a new
  // song's empty tracks). Selecting it asks which machine it should be.
  std::array<bool, kTracks> unchosen{};
  // A Sampler track whose sample is chopped into slices on the pads (its pads
  // play slices, not notes).
  std::array<bool, kTracks> slices{};
  std::array<std::string, kScenes> scene_id, scene_name;
  // The clip each scene gives each track ("" for none), its name and length in steps.
  std::array<std::array<std::string, kScenes>, kTracks> clip, clip_name;
  std::array<std::array<int, kScenes>, kTracks> clip_steps{}, clip_notes{}, clip_first_note{};
  // The project's pads (Kit tracks play them): names and the note a hit plays.
  // Each track's 16 pads (its own kit, else the project's; project format 7).
  std::array<std::array<std::string, 16>, kTracks> pad_name;
  std::array<std::array<int, 16>, kTracks> pad_note{};
  // The song: its blocks (scene index -1: a scene this board doesn't show) and its end.
  struct Block {
    std::string id;
    int scene = -1, repeats = 1, first_bar=1, last_bar=1;
  };
  std::vector<Block> chain;
  bool loop = false;
  // The mixer: each track's level, pan and sends (0..1), and mute and solo.
  std::array<float, kTracks> volume{}, pan{}, send1{}, send2{};
  std::array<bool, kTracks> muted{}, soloed{};
};

// Note edits refresh every scene that references this clip, including aliases.
inline void refresh_clip(Board& b, int track, const json::Value& clip) {
  using namespace project::detail;
  if (track < 0 || track >= b.tracks) return;
  int notes = list(clip, "steps").size() + list(at(clip, "sequence"), "notes").size();
  int first = 48; bool found = false;
  for (const auto& n : list(clip, "steps")) if (n.get("note")) { first = num(n, "note"); found = true; break; }
  if (!found) for (const auto& n : list(at(clip, "sequence"), "notes")) { first = num(n, "note"); break; }
  for (int scene = 0; scene < b.scenes; ++scene) if (b.clip[track][scene] == text(str(clip, "id"))) {
    b.clip_name[track][scene] = text(str(clip, "name"));
    b.clip_steps[track][scene] = num(clip, "length");
    b.clip_notes[track][scene] = notes;
    b.clip_first_note[track][scene] = first;
  }
}

inline Board board_of(const json::Value& project) {
  using project::detail::at;
  using project::detail::list;
  using project::detail::num;
  using project::detail::str;
  Board b;
  b.name = text(str(project, "name"));
  b.bpm = num(project, "bpm");
  for (const auto& s : list(project, "samples")) b.samples.push_back({text(str(s, "id")), text(str(s, "name"))});
  const auto& tracks = list(project, "tracks");
  const auto& scenes = list(project, "scenes");
  b.tracks = std::min<int>(kTracks, tracks.size());
  b.scenes = std::min<int>(kScenes, scenes.size());
  if (const json::Value* p = project.get("performance")) {
    if (const json::Value* chain = p->get("chain")) {
      b.song = chain->is_array() && chain->items().size() > 0;
      for (const auto& c : chain->items()) {
        Board::Block block;
        block.id = text(str(c, "id")), block.repeats = static_cast<int>(num(c, "repeats"));
        int length=16;
        for(const auto &scene:scenes) if(str(scene,"id")==str(c,"sceneId"))for(const auto &track:tracks)for(const auto &clip:list(track,"clips"))if(str(clip,"id")==str(at(scene,"clips"),str(track,"id").c_str()))length=std::max(length,static_cast<int>(num(clip,"length")));
        block.first_bar=b.chain.empty()?1:b.chain.back().last_bar+1;block.last_bar=block.first_bar+length/16*block.repeats-1;
        for (int s = 0; s < b.scenes; ++s)
          if (str(scenes[s], "id") == str(c, "sceneId")) block.scene = s;
        b.chain.push_back(block);
      }
    }
    if (const json::Value* end = p->get("end")) b.loop = end->is_string() && end->as_string() == "loop";
  }
  for (int t = 0; t < b.tracks; ++t) {
    b.volume[t] = static_cast<float>(num(tracks[t], "volume"));
    b.pan[t] = 0.5f;
    const auto& settings = at(at(at(at(project,"extensions"),"xmp.sampler-input"),"data"),"tracks");
    if (const auto* input = settings.get(str(tracks[t],"id").c_str()); input && num(at(at(project,"extensions"),"xmp.sampler-input"),"version") == 1) {
      b.input_track[t] = true;
      if (const auto* monitor = input->get("monitor")) b.input_monitor[t] = monitor->as_bool();
      const int bars = static_cast<int>(num(*input,"bars"));
      if (bars == 1 || bars == 2 || bars == 4) b.input_bars[t] = bars;
    }

    if (const json::Value* mix = project.get("mix"))
      if (const json::Value* strip = at(*mix, "tracks").get(str(tracks[t], "id").c_str())) {
        b.pan[t] = static_cast<float>(num(*strip, "pan"));
        b.send1[t] = static_cast<float>(list(*strip, "sends")[0].as_number());
        b.send2[t] = static_cast<float>(list(*strip, "sends")[1].as_number());
      }
    b.muted[t] = edit::is_muted(project, t);
    b.soloed[t] = edit::is_soloed(project, t);
  }
  for (int t = 0; t < b.tracks; ++t) {
    const auto& track = tracks[t];
    b.track_id[t] = text(str(track, "id"));
    b.track_name[t] = text(str(track, "name"));
    const json::Value* machine = track.get("machine");
    const std::string id = machine ? text(str(*machine, "id")) : std::string("xmp.sampler");
    b.kind[t] = id == "xmp.sampler" ? Kind::kit : id == "xmp.subtractive" ? Kind::synth : id == "xmp.midi" ? Kind::midi : Kind::other;
    if (b.kind[t] == Kind::kit) {
      // A Sampler says so in its state (keys or slices); older ones play chromatically.
      const Str mode = machine ? str(at(*machine, "state"), "mode") : Str();
      const auto& pads = project::detail::track_pads(project, &track);
      // Sliced, it plays like a kit (a slice per pad), flagged as a Sampler's.
      if (mode == "keys" || (mode != "slices" && !pads.empty() && str(at(pads[0], "playback"), "mode") == "chromatic"))
        b.kind[t] = Kind::sampler;
      b.slices[t] = mode == "slices";
    }
    b.input_track[t] = (b.input_track[t] || b.kind[t] == Kind::sampler || b.slices[t]) && (b.kind[t] == Kind::kit || b.kind[t] == Kind::sampler);
    if(b.kind[t]==Kind::midi&&machine){const Str dest=str(at(*machine,"state"),"destination");for(int other=0;other<b.tracks;++other)if(other!=t&&str(tracks[other],"id")==dest){const Str target=str(at(tracks[other],"machine"),"id");b.routed[t]=target.empty()||target=="xmp.sampler"||target=="xmp.subtractive";}}
    if (!machine && !track.get("pads")) {
      bool notes = false;
      for (const auto& c : list(track, "clips")) {
        if (!list(c, "steps").empty()) notes = true;
        if (const json::Value* seq = c.get("sequence"))
          if (!list(*seq, "notes").empty()) notes = true;
      }
      b.unchosen[t] = !notes;
    }
    if (b.kind[t] == Kind::synth) {
      const json::Value* state = machine->get("state");
      const json::Value* name = state ? state->get("name") : nullptr;
      b.sound[t] = name && name->is_string() ? text(name->as_string()) : "Synth";
    } else {
      b.sound[t] = b.slices[t] ? "Sampler \xC2\xB7 slices" : b.kind[t] == Kind::kit ? "Kit" : b.kind[t] == Kind::sampler ? "Sampler" : b.kind[t] == Kind::midi ? "MIDI" : "Plug-in";
    }
    for (int s = 0; s < b.scenes; ++s) {
      const json::Value* id_value = at(scenes[s], "clips").get(b.track_id[t].c_str());
      if (!id_value || !id_value->is_string()) continue;
      for (const auto& c : list(track, "clips"))
        if (str(c, "id") == id_value->as_string()) {
          b.clip[t][s] = text(id_value->as_string());
          b.clip_name[t][s] = text(str(c, "name"));
          b.clip_steps[t][s] = static_cast<int>(num(c, "length"));
          int notes = list(c, "steps").size();
          if (const json::Value* seq = c.get("sequence")) notes += list(*seq, "notes").size();
          b.clip_notes[t][s] = notes;
          int first=48;bool found=false;
          for(const auto &n:list(c,"steps"))if(n.get("note")){first=static_cast<int>(num(n,"note"));found=true;break;}
          if(!found)for(const auto &n:list(at(c,"sequence"),"notes")){first=static_cast<int>(num(n,"note"));break;}
          b.clip_first_note[t][s]=first;
        }
    }
  }
  for (int s = 0; s < b.scenes; ++s) {
    b.scene_id[s] = text(str(scenes[s], "id"));
    b.scene_name[s] = text(str(scenes[s], "name"));
  }
  for (int t = 0; t < kTracks; ++t) {
    const auto& pads = project::detail::track_pads(project, t < b.tracks ? &tracks[t] : nullptr);
    for (int p = 0; p < 16; ++p) {
      b.pad_note[t][p] = 60;
      if (p >= pads.size()) continue;
      if (const json::Value* n = pads[p].get("name"); n && n->is_string()) b.pad_name[t][p] = text(n->as_string());
      if (const json::Value* pb = pads[p].get("playback"))
        if (const json::Value* root = pb->get("rootNote"); root && root->is_number())
          b.pad_note[t][p] = static_cast<int>(root->as_number());
    }
  }
  return b;
}

// ---- what the player is doing (filled by the session every frame) ----

struct Now {
  bool playing = false, song = false;
  double step = 0;  // the step being heard
  std::string scene;
  std::array<std::string, kTracks> clip;    // the clip each track plays, "" for none
  std::array<double, kTracks> anchor{};     // the step it started on
  std::array<bool, kTracks> queued{};       // a launch waits for the next bar
  std::array<std::string, kTracks> queued_clip;  // what it launches ("" stops the track)
  std::string queued_scene;
  std::string block;  // the song block playing ("" outside a song)
  std::chrono::steady_clock::time_point input_time{};
};

// ---- what the interface asks the session to do ----

struct Action {
  enum Kind : std::uint8_t {
    play_song,     // start the song from its top (`step` >= 0: from that block)
    play_scene,    // start `scene`
    play_clip,     // start with only `track`'s clip in `scene` playing
    stop,          // stop the transport
    panic,         // silence everything (Stop while stopped)
    launch_clip,   // `track` plays its clip in `scene` from the next bar
    stop_clip,     // `track` stops at the next bar
    launch_scene,  // `scene` from the next bar
    note_on,       // live: `track` plays `pad` / `note` at `velocity`
    note_off,      // live: `track` lets go of `note`
    toggle_step,   // the clip of `track` in `scene`: `step` on or off for `pad` / `note`
    erase_row,     // the clip of `track` in `scene`: every step of `pad` / `note`
    undo,
    redo,
    copy_clip,    // independent copy of source_clip/source_track into track/scene
    unlink_clip,  // remove only the selected scene slot; keep the clip data
    browse_assign,
    browse_audition,
    record_start,  // a take into the empty slot of `track` in `scene` (stopped: start the scene first)
    record_end,    // the take is done: Ui::take becomes a clip in that slot
    overdub_hit,   // `hit` onto the clip `track` plays (`fresh`: the first of this overdub)
    turn_knob,     // Q-Link `knob` turned `delta` clicks (0: touched): on `step` of the clip of
                   // `track` in `scene` for `pad` / `note` (step >= 0), else on `track`;
                   // `song`: on song block `step`
    song_add,      // a block of `scene` into the song at `step`
    song_remove,   // song block `step` out
    mute_track,    // `track` muted, or unmuted
    solo_track,    // `track` soloed, or not
    choose_preset, // synth track `track` takes preset `pad` (0..31, synth_presets.hpp)
    song_capture,  // Ui::captured becomes song blocks after the selected block
    sample_arm,      // Sample view: record from the inputs, starting at the first sound
    sample_stop,     // Sample view: end the recording
    sample_keep,     // Sample view: the edited take onto `pad` of `track` (Ui::sample: slices and edits)
    sample_discard,  // Sample view: forget the take
    sample_audition, // Sample view: hear the edited take
    sample_chop, sample_chop_mode, sample_monitor, sample_length,
    set_value, rename, choose_machine, create_clip, open_sample, step_lock, effect_edit, browse_filter, project_new, project_save, project_save_as,
    chop_compute,  // Sample view, Sampler: work out Ui::chop_points for Ui::chop (even, transients)
    chop_lazy,     // Sample view, Sampler: start (or stop) lazy chop, playing the take from its start
    chop_mark,     // Sample view, Sampler, lazy chop: a slice starts where the take is now playing
  } kind = stop;
  int track = -1, scene = -1, pad = -1, note = 0, step = -1;
  float velocity = 0;
  float chance = 1, length = 1;  // toggle_step: a new step's chance and (synth) length
  edit::Hit hit{};
  bool fresh = false, song = false, sound = false;  // sound: turn_knob on the track's SOUND knobs
  int knob = 0, delta = 0;
  int source_track = -1;
  std::string source_clip{};
  std::string sample_id{};
  edit::FieldValue field{};
  double value = 0;
  std::string name{};
};

enum class View : std::uint8_t { clips, play, steps, song, sample, mix, browse, sound, project };

inline const char* view_name(View v) {
  switch (v) {
    case View::clips: return "CLIPS";
    case View::play: return "PLAY";
    case View::steps: return "STEPS";
    case View::song: return "SONG";
    case View::sample: return "SAMPLE";
    case View::mix: return "MIX";
    case View::browse: return "BROWSE";
    case View::sound: return "SOUND";
    case View::project: return "PROJECT";
  }
  return "?";
}

// Menu choices follow the panel in reading order, starting above pad 13.
constexpr int option_pad(int i) { return (3 - i / 4) * 4 + i % 4; }
constexpr int pad_option(int p) { return (3 - p / 4) * 4 + p % 4; }
inline std::string option_label(int i) { return "P" + std::to_string(option_pad(i) + 1); }

// Holding Menu, the track pages come first, followed by the project pages.
inline bool menu_view(int pad, View& out) {
  switch (pad) {
    case 12: out = View::play; return true;
    case 13: out = View::steps; return true;
    case 14: out = View::sample; return true;
    case 15: out = View::sound; return true;
    case 8: out = View::clips; return true;
    case 9: out = View::song; return true;
    case 10: out = View::mix; return true;
    case 11: out = View::browse; return true;
    case 4: out = View::project; return true;
    default: return false;
  }
}
// Whether a page acts on the selected track (else on the whole project).
inline bool track_page(View v) { return v == View::play || v == View::steps || v == View::sample || v == View::sound; }
inline bool view_ready(View v) {
  return v == View::clips || v == View::play || v == View::steps || v == View::song || v == View::mix ||
         v == View::sample || v == View::browse || v == View::sound || v == View::project;
}

class Ui {
 public:
  View view = View::clips, previous = View::clips;
  int track = 0;   // the selected track
  int window = 0;  // the first of the four scenes on the pads (a multiple of 4)
  int cursor = 0;  // the selected scene
  int octave = 0;  // Play view, synth tracks: -3..3
  int preset_page = 0;  // Sound view, synth tracks: the bank of sixteen presets
  music::Scale scale = music::Scale::major;
  int root = 0;  // the playing scale's root: 0 = C ... 11 = B
  struct PlayingRange { int octave = 0, root = 0; music::Scale scale = music::Scale::major; bool visited = false; };
  std::array<PlayingRange, kTracks> playing_ranges{};
  bool pitch_chosen=false;
  int pending_clip_scene = -1;
  bool draw_mode = false, machine_picker = false, health_open = false, help_open = false, overview = false;
  bool fill_held = false, capture_replace = false, step_held = false;
  std::array<edit::FieldValue,2> midi_fields{};
  int launch_grid=16;
  bool effects_open = false;
  int effect_location = -1, effect_slot = 0;
  int browse_category = 0; // samples (pool and stick), kits, projects
  std::string browse_query;
  std::array<std::string,2> effect_names{};
  std::array<edit::FieldValue,4> effect_fields{};
  bool editor_open = false, editor_fine = false, sound_pending = false;
  // The value the open sheet started from: the wheel, knobs and Reset change
  // editor.value, so Apply compares against this to tell an edit from none.
  double editor_from = 0;
  edit::FieldValue editor{}, touch_fields[8]{};
  // A Sampler's Sample page: how its take becomes the pads. Keys plays the whole
  // sample as notes; the other four chop it into slices (xmp/chop.hpp).
  enum class Chop : std::uint8_t { keys, even, transients, hand, lazy };
  Chop chop = Chop::transients;
  int chop_count = 8;              // Even: slices
  double chop_sensitivity = 0.5;   // Transients: 0..1
  std::vector<int> chop_points;    // slice starts in the edited take, frames
  int chop_selected = 0;           // By hand: the slice whose start - / + moves
  bool lazy = false;               // Lazy chop: pads mark slices as the take plays
  static const char* chop_name(Chop c) {
    switch (c) {
      case Chop::keys: return "Keys";
      case Chop::even: return "Even";
      case Chop::transients: return "Transients";
      case Chop::hand: return "By hand";
      case Chop::lazy: return "Lazy chop";
    }
    return "";
  }
  // The synth's Sound page: its presets, or every control (Controls page).
  bool sound_controls = false;
  // The wheel's place on the Sound page: a synth control or preset, or a MIDI
  // setting (kits and samplers use step_pad, the selected pad).
  int sound_focus = 0;
  // Shortening a clip that would lose notes waits for the same length to be
  // chosen again (the session counts the notes).
  int length_confirm = 0;
  static constexpr int kSynthFields = 11;
  edit::FieldValue synth_fields[kSynthFields]{};
  std::string editor_text, save_status = "Saved";
  static constexpr int kSaveAs = 5, kNewProject = 6;
  bool rename_selected = false;
  int rename_kind = 0; // 1 project, 2 track, 3 clip, 4 search, 5 Save As, 6 New
  std::string rename_text;
  int drag_kind = 0, drag_from = -1, drag_to = -1;
  sample::Edit sample_before{};
  double record_quantize = 1;
  bool follow_playhead = true;
  int page = 0;    // Steps view: which 16 steps of the clip
  int step_pad = 0, step_note = 48;  // Steps view: the kit pad or synth note being edited
  int roll_low = 43;                 // the piano roll's lowest pitch on screen (twelve show)
  bool shift = false, menu = false, full_level = false, erase = false;
  std::string toast;  // a short message in the header
  int toast_frames = 0;
  std::array<float, 16> level{};  // pad lights in the Play view
  std::array<int,16> strike_velocity{};
  std::array<std::chrono::steady_clock::time_point,16> strike_time{};
  int revision = 0;               // changes whenever something on screen should change
  // Recording: a take into an empty slot (waiting for its first bar, then
  // recording), or an overdub onto the playing clip.
  enum class Rec : std::uint8_t { off, waiting, recording, overdub };
  Rec rec = Rec::off;
  int rec_track = -1, rec_scene = -1;
  double rec_start = 0;          // the step the take starts on
  std::vector<edit::Hit> take;   // the take's hits, in steps from rec_start
  std::string recorded_clip; // Reveal the new take once, when opening its editor.
  int take_length = 0;           // its clip length, once done
  // The Q-Link knobs: in the Steps view they edit the selected step (the last
  // step pad pressed), elsewhere the selected track; the Q-Link button gives
  // the Steps view the track's knobs too. A touched or turned knob shows its
  // name and value in the header.
  int selected_step = -1;
  int block = 0;  // Song view: the selected block
  std::string knob_name, knob_value;
  int knob_frames = 0;
  // The Q-Link strip at the bottom of the screen: what the four knobs set
  // now (the session fills it), and which they edit ("TRACK", "STEP", "SONG").
  std::array<edit::Shown, 4> strip{};
  std::string strip_page = "TRACK";
  int knob_active = -1;  // the knob touched or turned last, while its value shows
  // The Sample view: how the take is edited, the pad it goes to, and (set by
  // the session) the take's length and whether the inputs are being recorded.
  sample::Edit sample{};
  int sample_pad = 0, sample_frames = 0;
  std::string sample_name = "Sample";
  bool sample_markers = false;
  bool sampling = false;
  bool copying = false;
  int browse_cursor = 0, browse_pad = 0;
  int browse_index(const Board& b) const { return std::clamp(browse_cursor, 0, std::max(0, static_cast<int>(b.samples.size()) - 1)); }

  // Which track and scene a pad stands for in the Clips view: the columns are
  // the selected track's four (1-4 or 5-8), the rows the window's scenes,
  // the first at the top.
  int pad_track(int pad) const { return track / 4 * 4 + pad % 4; }
  // In the Steps view the pads read like text: steps 1-4 on the top row.
  int pad_step(int pad) const { return page * 16 + (3 - pad / 4) * 4 + pad % 4; }
  // The selected clip's length in steps (0: no clip in the selected slot).
  int clip_length(const Board& b) const {
    return track < b.tracks && cursor < b.scenes && !b.clip[track][cursor].empty() ? b.clip_steps[track][cursor] : 0;
  }
  bool can_create_clip(const Board& b) const {
    const bool taking = (rec == Rec::waiting || rec == Rec::recording) && rec_track == track && rec_scene == cursor;
    return !taking && track >= 0 && track < b.tracks && cursor >= 0 && cursor < b.scenes &&
           b.clip[track][cursor].empty();
  }
  void request_clip(const Board& b, std::vector<Action>& out) const {
    if (can_create_clip(b)) out.push_back({Action::create_clip, track, cursor});
  }
  int pad_scene(int pad) const { return window + 3 - pad / 4; }

  void say(const std::string& message) {
    toast = message;
    toast_frames = 120;  // about two seconds at 60 frames a second
    ++revision;
  }
  // Once a screen frame: fades the toast and the pad lights.
  void tick() {
    if (toast_frames > 0 && --toast_frames == 0) toast.clear(), ++revision;
    if (knob_frames > 0 && !knob_held_ && --knob_frames == 0) knob_name.clear(), knob_value.clear(), knob_active = -1, ++revision;
    for (auto& l : level)
      if (l > 0) l = l < 0.02f ? 0 : l * 0.86f;
  }

  // The Sample page records into a Kit's pad or a Sampler's sample; synths and
  // MIDI tracks have nothing to sample into.
  bool sampler_take(const Board& b) const { return track < b.tracks && (b.kind[track] == Kind::sampler || b.slices[track]); }
  void show_presets(const Board& b) {
    sound_controls = false;
    sound_focus = 0;
    if (track < b.tracks)
      for (int i = 0; i < synth::kPresets; ++i)
        if (b.sound[track] == edit::presets()[i].name) sound_focus = i;
    preset_page = sound_focus / synth::kPresetsPerPage;
    ++revision;
  }
  void switch_sound_page(const Board& b) {
    if (sound_controls) return show_presets(b);
    sound_controls = true;
    sound_focus = 0;
    ++revision;
  }
  void turn_preset_page(int delta) {
    preset_page = (preset_page + delta + synth::kPresetPages) % synth::kPresetPages;
    sound_focus = preset_page * synth::kPresetsPerPage;
    ++revision;
  }
  void choose_preset(int index, std::vector<Action>& out) {
    sound_focus = index;
    ++revision;
    out.push_back({Action::choose_preset, track, -1, index});
  }
  void next_chop(std::vector<Action>& out) {
    sample_markers = false;
    chop = static_cast<Chop>((static_cast<int>(chop) + 1) % 5);
    lazy = false, chop_selected = 0, ++revision;
    say(std::string("Chop: ") + chop_name(chop));
    out.push_back({Action::chop_compute, track});
  }
  bool can_sample(const Board& b) const {
    return track < b.tracks && !b.unchosen[track] && (b.kind[track] == Kind::kit || b.kind[track] == Kind::sampler);
  }
  void select_track(int t, const Board& b, bool offer_machine = true) {
    if (t < 0 || t >= b.tracks) return say("No track " + std::to_string(t + 1));
    if (track != t) {
      playing_ranges[track] = {octave, root, scale, true};
      const auto& range = playing_ranges[t];
      octave = range.octave;
      // New instruments inherit the musical key; returning instruments keep their own range and key.
      if (range.visited) root = range.root, scale = range.scale;
      pitch_chosen = false;
    }
    track = t;
    pending_clip_scene = -1;
    machine_picker = false;
    fit_page(b);
    if (offer_machine && b.unchosen[t]) {
      editor_open = effects_open = false;
      rename_kind = 0;
      open(View::sound);
      machine_picker = true;
    }
    if (view == View::sample && !can_sample(b)) open(View::sound);
    ++revision;
  }
  void select_scene(int s, const Board& b) {
    if (b.scenes == 0) return;
    cursor = std::clamp(s, 0, b.scenes - 1);
    window = cursor / 4 * 4;
    fit_page(b);
    ++revision;
  }
  void fit_page(const Board& b) { page = std::clamp(page, 0, std::max(0, (clip_length(b) + 15) / 16 - 1)); }

  void move_bar(int delta, const Board& b) {
    page += delta; fit_page(b); follow_playhead = false; ++revision;
  }
  void follow_steps(const Board& b, const Now& now) {
    const int length = clip_length(b);
    if (view != View::steps || !follow_playhead || !now.playing || length == 0 ||
        now.clip[track] != b.clip[track][cursor] || step_held || editor_open) return;
    const int next = static_cast<int>(std::fmod(std::max(0.0, now.step - now.anchor[track]), length)) / 16;
    if (page != next) { page = next; ++revision; }
  }
  PanelLights panel_lights(const Board& b, const Now& now) const {
    PanelLights lights;
    const double seconds=std::chrono::duration<double>(now.input_time.time_since_epoch()).count();
    const bool blink=std::fmod(std::max(0.0,seconds),.5)<.25;
    lights.button(0x23+track%4,track<4||blink);
    lights.button(0x52,now.playing);
    lights.button(0x49,sampling||rec==Rec::recording||(rec==Rec::waiting&&blink)||(capturing&&(now.playing||blink)));
    lights.button(0x50,rec==Rec::overdub);
    lights.button(0x27,full_level);
    lights.button(0x0B,fill_held);
    lights.button(0x28,view==View::steps&&!menu);
    lights.button(0x35,now.playing&&std::fmod(std::max(0.0,now.step),4.0)<.7);
    lights.button(0x5A+qlink_led_page(),true);
    if(menu||editor_open||task_pads_active()||rename_kind||machine_picker)return lights;
    if(view==View::play) {
      for(int p=0;p<16;++p)if(strike_velocity[p]&&held_track_[p]==track) {
        const double age=std::chrono::duration<double>(now.input_time-strike_time[p]).count();
        const double brightness=held_[p]>=0?1.0:std::clamp(1.0-age/.22,0.0,1.0);
        if(brightness>0)lights.pads[p]=velocity_colour(strike_velocity[p],brightness);
      }
    } else if(view==View::steps) {
      const int length=clip_length(b);
      if(now.playing&&length>0&&now.clip[track]==b.clip[track][cursor]) {
        const int step=static_cast<int>(std::fmod(std::max(0.0,now.step-now.anchor[track]),length));
        for(int p=0;p<16;++p)if(pad_step(p)==step)lights.pads[p]={96,127,112};
      }
    } else if(view==View::clips) {
      for(int p=0;p<16;++p) {
        const int t=pad_track(p),s=pad_scene(p);
        if(t>=b.tracks||s>=b.scenes||b.clip[t][s].empty())continue;
        lights.pads[p]=now.clip[t]==b.clip[t][s]&&now.playing?PadColour{8,100,42}:PadColour{25,20,5};
        if(now.queued[t]&&now.queued_clip[t]==b.clip[t][s])lights.pads[p]=blink?PadColour{127,84,8}:PadColour{};
      }
    }
    return lights;
  }
  void button(Button btn, bool down, const Board& b, const Now& now, std::vector<Action>& out) {
    if (btn == Button::shift) {shift=down;++revision;return;}
    if (btn == Button::erase) return void(erase = down);
    if (editor_open && down) {
      if (btn == Button::plus || btn == Button::minus) {
        wheel(btn == Button::plus ? 1 : -1, b);
        return;
      }
      if (btn == Button::undo || btn == Button::main || btn == Button::menu) {
        editor_open = false;
        ++revision;
        if (btn == Button::undo)
          return;
      }
      if (btn == Button::wheel) {
        if (editor.field == edit::Field::scale || editor.field == edit::Field::scale_root) {
          if (editor.field == edit::Field::scale)
            scale = static_cast<music::Scale>(static_cast<int>(editor.value));
          else
            root = static_cast<int>(editor.value);
          editor_open = false;
          ++revision;
          return;
        }
        if (editor.field == edit::Field::quantize) {
          record_quantize = editor.value / 100;
          editor_open = false;
          ++revision;
          return;
        }
        if (editor.field >= edit::Field::sample_start && editor.field <= edit::Field::sample_reverse) {
          say("Tap Apply to keep this sample value");
          return;
        }
        Action a{Action::set_value, editor.focus.track};
        a.field = editor;
        a.field.value = editor_from;
        a.value = editor.value;
        out.push_back(a);
        editor_open = false;
        ++revision;
        return;
      }
    }
    if (btn == Button::copy) {
      copy_held_ = down;
      if (!down) return;
      if (rec != Rec::off) return say("Finish recording before copying");
      if (shift) {
        copying = false;
        out.push_back({Action::unlink_clip, track, cursor});
        return;
      }
      if (copying) { copying = false; return say("Copy canceled"); }
      copying = true, copy_first_ = true;
      copy_track_ = track;
      copy_clip_ = track < b.tracks && cursor < b.scenes ? b.clip[track][cursor] : std::string();
      open(View::clips);
      return say(copy_clip_.empty() ? "COPY: choose a source, then a destination" : "COPY: choose destination (hold COPY to choose source)");
    }
    if(btn==Button::note_repeat){fill_held=down;++revision;return;}
    if (btn == Button::menu) {
      if (menu_held_ == down) return;
      if (down) {
        menu_held_ = true;
        menu_pressed_ = now.input_time;
        menu_shift_ = shift;
        menu_used = menu && !menu_shift_;
        menu = !menu_shift_ && !menu_used;
      } else {
        menu = menu_hold_ready(now.input_time);
        menu_held_ = false;
        if (!menu_used && menu_shift_) open(view == View::browse ? previous : View::browse);
      }
      ++revision;
      return;
    }
    if (!down) return;
    if (btn == Button::tap_tempo) {
      const auto at = now.input_time;
      if (tap_count_ && at > last_tap_) {
        const double interval = std::chrono::duration<double>(at - last_tap_).count();
        if (interval < .2) return;
        if (interval <= 2) {
          tap_intervals_[(tap_count_ - 1) % 4] = interval;
          const int n = std::min(tap_count_, 4); double sum = 0;
          for (int i = 0; i < n; ++i) sum += tap_intervals_[i];
          Action a{Action::set_value};
          a.field.available = true; a.field.field = edit::Field::tempo;
          a.field.value = b.bpm; a.field.min = 30; a.field.max = 300;
          a.value = std::clamp(std::round(600 / (sum / n)) / 10, 30.0, 300.0);
          out.push_back(a);
        } else tap_count_ = 0;
      } else tap_count_ = 0;
      last_tap_ = at; ++tap_count_;
      say(tap_count_ == 1 ? "Tap again on the beat" : "Tap tempo");
      return;
    }
    if (view == View::browse) {
      if (btn == Button::minus || btn == Button::plus) return wheel(btn == Button::plus ? 1 : -1, b);
      if (btn == Button::wheel || (btn == Button::play && shift)) {
        if (b.samples.empty()) return say("No matching library items");
        if (btn == Button::play && browse_category != 0) return;
        Action a{btn == Button::wheel ? Action::browse_assign : Action::browse_audition, track, -1, browse_pad};
        a.sample_id = b.samples[browse_index(b)].id;
        return out.push_back(xmp::move(a));
      }
      if (btn == Button::rec || btn == Button::overdub) return say("Close Browse before recording");
    }
    if (btn == Button::rec && (view == View::clips || view == View::sound) && track < b.tracks && b.input_track[track]) {
      sample_pad = step_pad;
      open(View::sample);
    }
    if (view == View::sample && sample_button(btn, b, out)) return;
    if (view == View::song && btn == Button::rec) return toggle_capture(now, out);
    switch (btn) {
      case Button::bank_a:
      case Button::bank_b:
      case Button::bank_c:
      case Button::bank_d:
        select_track((shift ? 4 : 0) + static_cast<int>(btn) - static_cast<int>(Button::bank_a), b);
        return;
      case Button::main:
        copying = false;
        open(shift ? View::play : View::clips);
        return;
      case Button::play:
        if (view == View::song && b.song) return play_from(song_block(b), out);
        if (now.playing) return;
        if (b.song) (scene_launched(), out.push_back({Action::play_song}));
        else if (b.scenes) (scene_launched(), out.push_back({Action::play_scene, -1, cursor}));
        return;
      case Button::play_start:
        if (view == View::song && b.song) return scene_launched(), out.push_back({Action::play_song});
        if (b.scenes) (scene_launched(), out.push_back({Action::play_scene, -1, cursor}));
        return;
      case Button::stop:
        if (rec == Rec::waiting || rec == Rec::recording) finish(now, out);
        if (rec == Rec::overdub) rec = Rec::off;
        out.push_back({now.playing ? Action::stop : Action::panic});
        return;
      case Button::rec:
        if (rec == Rec::waiting || rec == Rec::recording) return finish(now, out);
        if (rec == Rec::overdub) return overdub_off();
        if (track >= b.tracks || cursor >= b.scenes) return say("No slot here");
        if (b.kind[track] != Kind::kit && b.kind[track] != Kind::synth && b.kind[track] != Kind::sampler && !(b.kind[track]==Kind::midi&&b.routed[track])) return say("Rec needs an audible instrument");
        if (!b.clip[track][cursor].empty()) return say("A clip is here: Overdub adds to it");
        rec = Rec::waiting, rec_track = track, rec_scene = cursor, take.clear(), take_length = 0;
        open_.fill(-1);
        // Stopped, the session starts the scene: its first bar counts in.
        rec_start = now.playing ? (std::floor(now.step / 16) + 1) * 16 : 16;
        open(View::play);
        out.push_back({Action::record_start, track, cursor});
        return say(now.playing ? "Recording from the next bar" : "One bar to count in");
      case Button::overdub:
        if (rec == Rec::overdub) return overdub_off();
        if (rec != Rec::off) return say("Recording a take");
        if (!now.playing || track >= b.tracks || now.clip[track].empty()) return say("Overdub needs a playing clip");
        if (b.kind[track] != Kind::kit && b.kind[track] != Kind::synth && b.kind[track] != Kind::sampler && !(b.kind[track]==Kind::midi&&b.routed[track])) return say("Overdub needs an audible instrument");
        rec = Rec::overdub, rec_track = track, fresh_ = true;
        open(View::play);
        return say("Overdub");
      case Button::minus:
      case Button::plus: {
        const int d = btn == Button::plus ? 1 : -1;
        if (view == View::steps && melodic(b)) {
          // The piano roll: the note being edited, a semitone (Shift: an octave) at a time.
          step_note = std::clamp(step_note + d * (shift ? 12 : 1), 0, 127);
          fit_roll();
          return say("Editing " + note_name(step_note));
        }
        if (view == View::sound && track < b.tracks && b.kind[track] == Kind::synth) {
          if (!sound_controls) turn_preset_page(d);
          return;
        }
        if (view == View::play) {
          octave = std::clamp(octave + d, -3, 3);
          say("Octave " + std::string(octave > 0 ? "+" : "") + std::to_string(octave));
        } else if (b.scenes) {
          window = std::clamp(window + 4 * d, 0, (b.scenes - 1) / 4 * 4);
          cursor = std::clamp(cursor, window, std::min(window + 3, b.scenes - 1));
          ++revision;
        }
        return;
      }
      case Button::wheel:
        if (view == View::steps && !erase && !shift) return request_clip(b, out);
        if (view == View::sound && track < b.tracks && !b.unchosen[track]) {
          const Kind k = b.kind[track];
          if (k == Kind::synth && sound_controls) return open_prepared(synth_fields[std::clamp(sound_focus, 0, kSynthFields - 1)]);
          if (k == Kind::synth) return choose_preset(sound_focus, out);
          if (k == Kind::midi) return open_prepared(midi_fields[std::clamp(sound_focus, 0, 1)]);
          return out.push_back({Action::open_sample, track, cursor, step_pad, step_note, selected_step});
        }
        if (view == View::song) {
          if (b.chain.empty()) return say("Add a scene: press its pad");
          if (erase) return out.push_back({Action::song_remove, -1, -1, -1, 0, song_block(b)});
          if (!now.playing) play_from(song_block(b), out);
          return;
        }
        if (view == View::clips && b.scenes)
          (scene_launched(), out.push_back({now.playing ? Action::launch_scene : Action::play_scene, -1, cursor}));
        return;
      case Button::full_level:
        full_level = !full_level;
        say(full_level ? "Full Level on" : "Full Level off");
        return;
      case Button::level16:
        enter_steps(b);
        return;
      case Button::undo:
        out.push_back({shift ? Action::redo : Action::undo});
        return;
      case Button::qlink:
        return next_knobs(shift ? -1 : 1);
      default:
        say(std::string(button_name(btn)) + " comes later");
        return;
    }
  }

  // Whether the selected track's clips are edited by pitch (synth and MIDI tracks).
  bool melodic(const Board& b) const { return track < b.tracks && (b.kind[track] == Kind::synth || b.kind[track] == Kind::midi || b.kind[track] == Kind::sampler); }
  // Keeps the note being edited among the piano roll's twelve rows.
  // A note a step outside moves the view one row; a jump further centres it.
  void fit_roll() {
    if (step_note < roll_low - 1 || step_note > roll_low + 8) roll_low = step_note - 5;
    if (step_note < roll_low) roll_low = step_note;
    if (step_note > roll_low + 7) roll_low = step_note - 7;
    roll_low = std::clamp(roll_low, 0, 120);
    ++revision;
  }
  // A touch on the piano roll: that pitch becomes the one edited, and its step turns on or off.
  void roll_touch(int step, int note, const Board& b, std::vector<Action>& out) {
    if (!melodic(b)) return;
    const int length = clip_length(b);
    if (step < 0 || step >= length || note < 0 || note > 127) return;
    step_note = note, selected_step = step;
    fit_roll();
    out.push_back(step_action(Action::toggle_step, step));
  }

  // Whether the knobs edit the selected step (else the selected track).
  bool knobs_on_step() const { return view == View::steps && knob_page() == Knobs::step; }

  // ---- the Q-Link knob pages: the Q-Link button cycles them (Shift: back) ----
  // STEP (the selected step), NEW STEPS (what a new step gets), TRACK (level,
  // pan, sends) and SOUND (the machine's parameters); outside Steps, TRACK
  // and SOUND. Song, Sample and Browse keep their own knobs.
  enum class Knobs : std::uint8_t { step, fresh, track, sound };
  Knobs steps_knobs = Knobs::step, other_knobs = Knobs::track;
  float new_velocity = 0.8f, new_chance = 1, new_length = 1;
  // Mix has only the track's level, pan and sends: its knobs stay on TRACK even
  // when the Sound view left the other pages on SOUND.
  Knobs knob_page() const { return view == View::steps ? steps_knobs : view == View::mix ? Knobs::track : other_knobs; }
  int qlink_led_page() const {
    if (view == View::steps) return static_cast<int>(steps_knobs);
    if (view == View::song || view == View::sample || view == View::browse) return 0;
    return knob_page() == Knobs::sound ? 1 : 0;
  }
  static const char* knobs_name(Knobs k) {
    switch (k) {
      case Knobs::step: return "STEP";
      case Knobs::fresh: return "NEW STEPS";
      case Knobs::track: return "TRACK";
      case Knobs::sound: return "SOUND";
    }
    return "?";
  }
  void next_knobs(int d) {
    if (view == View::song || view == View::sample || view == View::browse || view == View::mix)
      return say("Knobs: " + std::string(view_name(view)));
    if (view == View::steps) {
      static const Knobs order[4] = {Knobs::step, Knobs::fresh, Knobs::track, Knobs::sound};
      int i = 0;
      while (order[i] != steps_knobs) ++i;
      steps_knobs = order[(i + d + 4) % 4];
    } else {
      other_knobs = other_knobs == Knobs::track ? Knobs::sound : Knobs::track;
    }
    ++revision;
    say(std::string("Knobs: ") + knobs_name(knob_page()));
  }
  static std::string fresh_name(int k) {
    static const char* names[4] = {"Velocity", "Chance", "Length", "Bar"};
    return names[std::clamp(k, 0, 3)];
  }
  std::string fresh_value(int k) const {
    char text[24];
    if (k == 0) std::snprintf(text, sizeof text, "%d%%", static_cast<int>(std::lround(new_velocity * 100)));
    else if (k == 1) std::snprintf(text, sizeof text, "%d%%", static_cast<int>(std::lround(new_chance * 100)));
    else if (k == 2) std::snprintf(text, sizeof text, "%g steps", static_cast<double>(new_length));
    else return "";
    return text;
  }
  // NEW STEPS knob `k`: velocity and chance 1% a click, length a quarter step.
  void fresh_knob(int k, int clicks) {
    if (k == 0) new_velocity = std::clamp(std::round(new_velocity * 100 + clicks) / 100, 0.01f, 1.0f);
    else if (k == 1) new_chance = std::clamp(std::round(new_chance * 100 + clicks) / 100, 0.0f, 1.0f);
    else if (k == 2) new_length = std::clamp(new_length + clicks * 0.25f, 0.25f, 16.0f);
    else return;
    show_knob(fresh_name(k), fresh_value(k));
  }
  // A new step's action, with the NEW STEPS values.
  Action step_action(Action::Kind kind, int step) const {
    Action a{kind, track, cursor, step_pad, step_note, step};
    a.velocity = new_velocity, a.chance = new_chance, a.length = new_length;
    return a;
  }

  // Q-Link knob `k` (0..3, top to bottom) turned `clicks` (clockwise positive).
  void knob(int k, int clicks, const Board& b, std::vector<Action>& out) {
    if (k < 0 || k > 3 || clicks == 0) return;
    if (!effects_open && view == View::steps && k == 3 && (shift || knob_page() == Knobs::fresh) && !editor_open) return move_bar(clicks, b);
    if(editor_open){editor.value=std::clamp(editor.value+clicks*editor.increment,editor.min,editor.max);editor_text.clear();++revision;return;}
    if (effects_open) {
      auto& field = effect_fields[k];
      if (!field.available) return;
      Action a{Action::set_value, track}; a.field = field;
      a.value = std::clamp(field.value + clicks * field.increment, field.min, field.max);
      field.value = a.value; out.push_back(a); ++revision; return;
    }
    if(step_held&&view==View::steps&&knob_page()==Knobs::sound){Action a{Action::step_lock,track,cursor,step_pad,step_note,selected_step};a.knob=k;a.delta=clicks;out.push_back(a);return;}
    knob_active = k;
    if (view == View::browse) {
      if (k == 0) wheel(clicks, b);
      else if (k == 1 && browse_category == 0) browse_pad = std::clamp(browse_pad + std::clamp(clicks, -128, 128), 0, 15), ++revision;
      return;
    }
    if (view == View::song) return song_knob(k, clicks, b, out);
    if (view == View::sample) return sample_knob(k, clicks);
    if (track >= b.tracks) return say("No track " + std::to_string(track + 1));
    if (knob_page() == Knobs::fresh) return fresh_knob(k, clicks);
    if (knob_page() == Knobs::sound) {
      if(b.kind[track]==Kind::midi){
        if(k>1)return;
        edit::FieldValue field;
        // Values are supplied by fill_strip on the main thread; touch and knobs share bounds.
        field=midi_fields[k];if(!field.available)return;
        Action a{Action::set_value,track};a.field=field;a.value=std::clamp(field.value+clicks*field.increment,field.min,field.max);out.push_back(a);return;
      }
      bool fresh = false;
      const int delta = turn("sound|" + std::to_string(k) + "|" + std::to_string(track), 1, clicks, fresh);
      if (delta == 0) return;
      Action a{Action::turn_knob, track};
      a.knob = k, a.delta = delta, a.fresh = fresh, a.sound = true;
      return out.push_back(a);
    }
    const bool on_step = knobs_on_step();
    if (on_step && selected_step < 0) return say("Press a step, then turn a knob");
    // A turn of the same knob on the same thing is one change for undo.
    const std::string key = std::to_string(on_step) + "|" + std::to_string(k) + "|" + std::to_string(track) + "|" +
                            std::to_string(on_step ? cursor : -1) + "|" + std::to_string(on_step ? selected_step : -1) +
                            "|" + std::to_string(step_pad) + "|" + std::to_string(step_note);
    bool fresh = false;
    const int delta = turn(key, on_step && k == 3 ? 4 : 1, clicks, fresh);  // Move: one step per four clicks
    if (delta == 0) return;
    Action a{Action::turn_knob, track, on_step ? cursor : -1, step_pad, step_note, on_step ? selected_step : -1};
    a.knob = k, a.delta = delta, a.fresh = fresh;
    out.push_back(a);
  }
  // A knob touched (down) or let go: touching shows its value.
  void knob_touch(int k, bool down, const Board& b, std::vector<Action>& out) {
    if (k < 0 || k > 3) return;
    knob_held_ = down;
    if (down) knob_active = k, ++revision;
    if (view == View::browse) return;
    if (view == View::sample) {
      if (down) show_knob(sample_knob_name(k), sample_knob_value(k));
      return;
    }
    if (view == View::song) {
      if (!down || (b.chain.empty() && k != 2)) return;
      Action a{Action::turn_knob, -1, -1, -1, 0, song_block(b)};
      a.knob = k, a.delta = 0, a.song = true;
      return out.push_back(a);
    }
    if (!down || track >= b.tracks || (knobs_on_step() && selected_step < 0)) return;
    if (knob_page() == Knobs::fresh) return show_knob(fresh_name(k), fresh_value(k));
    if (knob_page() == Knobs::sound) {
      Action a{Action::turn_knob, track};
      a.knob = k, a.delta = 0, a.sound = true;
      return out.push_back(a);
    }
    const bool on_step = knobs_on_step();
    Action a{Action::turn_knob, track, on_step ? cursor : -1, step_pad, step_note, on_step ? selected_step : -1};
    a.knob = k, a.delta = 0;
    out.push_back(a);
  }
  // The session shows what a knob changed (or why it didn't).
  void show_knob(const std::string& name, const std::string& value) {
    knob_name = name, knob_value = value, knob_frames = 90;
    ++revision;
  }

  // The selected song block, within the chain.
  int song_block(const Board& b) const { return std::clamp(block, 0, std::max(0, static_cast<int>(b.chain.size()) - 1)); }
  // Song view: the pads are the scenes, 1-4 on the top row.
  static int song_scene(int pad) { return (3 - pad / 4) * 4 + pad % 4; }

  // An editor for a value already read for the screen (Ui::synth_fields, midi_fields).
  void open_prepared(const edit::FieldValue& f) {
    if (!f.available) return say("Nothing to edit here");
    editor = f, editor_open = true, editor_from = f.value, editor_text.clear(), editor_fine = true;
    ++revision;
  }
  // The wheel moves through the page's items by default: tracks on Mix and Play,
  // scenes on Clips, the Sound page's controls, presets or pads, a Sampler's
  // slices; pressing it acts on the one highlighted.
  void wheel(int steps, const Board& b) {
    if (editor_open) {editor.value=std::clamp(editor.value+steps*editor.increment*(editor_fine?1:10),editor.min,editor.max);editor_text.clear();++revision;return;}
    if (view == View::mix || view == View::play) {
      if (b.tracks > 0) select_track(std::clamp(track + steps, 0, b.tracks - 1), b);
      return;
    }
    if (view == View::sound && track < b.tracks && !b.unchosen[track]) {
      const Kind k = b.kind[track];
      if (k == Kind::synth && sound_controls)
        sound_focus = std::clamp(sound_focus + steps, 0, kSynthFields - 1);
      else if (k == Kind::synth) {
        sound_focus = std::clamp(sound_focus + steps, 0, synth::kPresets - 1);
        preset_page = sound_focus / synth::kPresetsPerPage;
      } else if (k == Kind::midi)
        sound_focus = std::clamp(sound_focus + steps, 0, 1);
      else
        step_pad = std::clamp(step_pad + steps, 0, 15);
      ++revision;
      return;
    }
    if (view == View::sample) {
      if (sampler_take(b) && !chop_points.empty())
        chop_selected = std::clamp(chop_selected + steps, 0, static_cast<int>(chop_points.size()) - 1);
      else
        sample_pad = std::clamp(sample_pad + steps, 0, 15);
      ++revision;
      return;
    }
    if (view == View::browse) {
      browse_cursor = std::clamp(browse_index(b) + std::clamp(steps, -128, 128), 0, std::max(0, static_cast<int>(b.samples.size()) - 1));
      ++revision;
      return;
    }
    if (view == View::song) {
      block = std::clamp(song_block(b) + steps, 0, std::max(0, static_cast<int>(b.chain.size()) - 1));
      ++revision;
    }
    if (view == View::clips) select_scene(cursor + steps, b);
    if (view == View::steps) {
      move_bar(steps, b);
    }
  }

  bool menu_button_held() const { return menu_held_; }
  bool menu_hold_ready(std::chrono::steady_clock::time_point time) const {
    return menu && menu_held_ && time - menu_pressed_ >= std::chrono::seconds(3);
  }
  bool task_pads_active() const { return menu_held_ && menu_shift_ && !menu_used; }
  bool menu_pad_consumed() const { return menu_held_ && menu_used; }
  void use_menu_pad() { menu_used = true; ++revision; }

  // A pad hit (velocity 1..127) or release (0).
  void pad(int p, int velocity, const Board& b, const Now& now, std::vector<Action>& out) {
    if (p < 0 || p >= 16) return;
    if (velocity == 0 && held_[p] >= 0) return play_pad(p, velocity, b, now, out);
    if (menu_pad_consumed()) return;
    if (menu) {
      if (velocity == 0) return;
      menu_used = true;
      View v = View::clips;
      if (!menu_view(p, v)) return;
      if (v == View::sample && !can_sample(b))
        return say("Sample is for Kit and Sampler tracks; this track is " + std::string(track < b.tracks ? b.sound[track] : "empty"));
      use_menu_pad();
      editor_open = effects_open = machine_picker = false;
      health_open = help_open = false;
      rename_kind = 0;
      if (v == View::steps) enter_steps(b);
      else open(v);
      return;
    }
    if (machine_picker || (view == View::sound && track < b.tracks && b.unchosen[track])) {
      const int option = pad_option(p);
      if (velocity > 0 && option < 4) {
        out.push_back({Action::choose_machine, track, -1, option});
        machine_picker = false;
        if (pending_clip_scene >= 0) {
          out.push_back({Action::create_clip, track, pending_clip_scene});
          pending_clip_scene = -1;
          open(View::clips);
        }
        ++revision;
      }
      return;
    }
    if (view == View::browse) {
      if (velocity > 0 && browse_category == 0) browse_pad = p, ++revision;
      return;
    }
    if (view == View::play) return play_pad(p, velocity, b, now, out);
    if (view == View::sound) {
      // The preset grid follows the whole pad matrix. Shift plays the current sound.
      if (track < b.tracks && b.kind[track] == Kind::synth && !sound_controls && !shift) {
        if (velocity > 0) choose_preset(preset_page * synth::kPresetsPerPage + pad_option(p), out);
        return;
      }
      return play_pad(p, velocity, b, now, out);
    }
    if (view == View::steps) return steps_pad(p, velocity, b, out);
    if (view == View::sample && sampler_take(b) && !sample_markers && sample_frames > 0) {
      // A Sampler's pads: during lazy chop each tap starts a slice; otherwise a
      // pad picks its slice (By hand moves it).
      if (velocity == 0) return;
      if (lazy) return out.push_back({Action::chop_mark, track, -1, p});
      if (p < static_cast<int>(chop_points.size())) chop_selected = p, ++revision;
      if (!sampling) out.push_back({Action::sample_audition, track, -1, p});
      return say(p < static_cast<int>(chop_points.size()) ? "Slice " + std::to_string(p + 1) : "No slice " + std::to_string(p + 1));
    }
    if (view == View::sample) {
      // The pad the take goes to; pressing it plays the edited take.
      if (velocity == 0) return;
      if (sample.slices > 1 && p >= sample.slices) return say("No chop on this pad");
      if (sample.slices == 1 && sample.chop_mode == 0) sample_pad = p;
      ++revision;
      if (sample_frames > 0 && !sampling) out.push_back({Action::sample_audition, track, -1, p});
      else say("Pad " + std::to_string(p + 1) + " \xC2\xB7 REC records from the inputs");
      return;
    }
    if (view == View::mix) {
      if (velocity == 0) return;
      // Mix: the top two rows select tracks 1-4 and 5-8; the two rows below mute them (Shift: solo).
      const int t = (p / 4 == 3 || p / 4 == 1 ? 0 : 4) + p % 4;
      if (p / 4 >= 2) return select_track(t, b);
      if (t >= b.tracks) return say("No track " + std::to_string(t + 1));
      return out.push_back({shift ? Action::solo_track : Action::mute_track, t});
    }
    if (view == View::song) {
      if (velocity == 0) return;
      const int scene = song_scene(p);
      if (scene >= b.scenes) return say("No scene " + std::to_string(scene + 1));
      // After the selected block (at the start of an empty song).
      return out.push_back({Action::song_add, -1, scene, -1, 0, b.chain.empty() ? 0 : song_block(b) + 1});
    }
    if (view != View::clips || velocity == 0) return;
    slot(pad_track(p), pad_scene(p), b, now, out);
  }

  // Pads launch or stop clips; tapping an empty slot creates a clip.
  void slot(int t, int s, const Board& b, const Now& now, std::vector<Action>& out, bool tapped = false) {
    if (t < 0 || s < 0 || t >= b.tracks || s >= b.scenes) return say("Nothing here");
    select_track(t, b, !copying); cursor = s; ++revision;
    const std::string& clip = b.clip[t][s];
    if (!copying && b.unchosen[t]) {
      if (tapped && can_create_clip(b)) pending_clip_scene = s;
      return;
    }
    if (copying) {
      if (copy_clip_.empty() || (copy_held_ && copy_first_)) {
        if (clip.empty()) return say("Choose a nonempty source clip");
        copy_track_ = t, copy_clip_ = clip, copy_first_ = false;
        return say("COPY: choose destination");
      }
      Action a{Action::copy_clip, t, s};
      a.source_track = copy_track_, a.source_clip = copy_clip_;
      copying = false;
      out.push_back(xmp::move(a));
      return;
    }
    if (clip.empty()) {
      if (tapped) return request_clip(b, out);
      if (now.playing && !now.clip[t].empty()) out.push_back({Action::stop_clip, t, s});
      else say("Empty: Rec records into it");
      return;
    }
    if (!now.playing) {
      heard_[static_cast<std::size_t>(t)] = s;
      return out.push_back({Action::play_clip, t, s});
    }
    // Pressing the clip that plays stops its track; any other slot launches,
    // even one holding the same clip (scenes may share a clip).
    if (now.clip[t] == clip && heard_scene(t, b, now) == s && !now.queued[t]) {
      out.push_back({Action::stop_clip, t, s});
    } else {
      heard_[static_cast<std::size_t>(t)] = s;
      out.push_back({Action::launch_clip, t, s});
    }
  }

  // The slot whose copy of a track's playing clip is lit: scenes may share a
  // clip, but a track plays one clip, from the slot it was launched from (else
  // the playing scene's, else the first holding it). -1: none.
  int heard_scene(int t, const Board& b, const Now& now) const {
    if (t < 0 || t >= b.tracks || now.clip[t].empty()) return -1;
    const int own = heard_[static_cast<std::size_t>(t)];
    if (own >= 0 && own < b.scenes && b.clip[t][own] == now.clip[t]) return own;
    for (int s = 0; s < b.scenes; ++s)
      if (b.scene_id[s] == now.scene && b.clip[t][s] == now.clip[t]) return s;
    for (int s = 0; s < b.scenes; ++s)
      if (b.clip[t][s] == now.clip[t]) return s;
    return -1;
  }
  // The slot a queued launch lands on: the slot pressed, else the queued scene's.
  int launch_scene(int t, const Board& b, const Now& now) const {
    if (t < 0 || t >= b.tracks || !now.queued[t]) return -1;
    const int own = heard_[static_cast<std::size_t>(t)];
    if (own >= 0 && own < b.scenes && b.clip[t][own] == now.queued_clip[t]) return own;
    for (int s = 0; s < b.scenes; ++s)
      if (b.scene_id[s] == now.queued_scene && b.clip[t][s] == now.queued_clip[t]) return s;
    for (int s = 0; s < b.scenes; ++s)
      if (b.clip[t][s] == now.queued_clip[t]) return s;
    return -1;
  }
  // A scene or the song starts: every track's clip comes from it.
  void scene_launched() { heard_.fill(-1); }

  void enter_steps(const Board &b) {
    open(View::steps);
    selected_step = -1;
    if (!recorded_clip.empty() && cursor < b.scenes && b.clip[track][cursor] == recorded_clip && !take.empty()) {
      page = std::max(0, static_cast<int>(take.front().at) / 16); fit_page(b);
      if (melodic(b)) step_note = take.front().note, fit_roll();
      else step_pad = take.front().pad;
      recorded_clip.clear();
    }
    if (!pitch_chosen && melodic(b) && cursor < b.scenes && !b.clip[track][cursor].empty()) {
      step_note = b.clip_first_note[track][cursor];
      fit_roll();
    }
  }
  void open(View v) {
    if (!view_ready(v)) return say(std::string(view_name(v)) + " view comes next");
    menu = false;
    machine_picker = false;
    pending_clip_scene = -1;
    if (v == View::sound) other_knobs = Knobs::sound;
    if (v != view) previous = view, view = v;
    if (v != View::clips) copying = false;
    ++revision;
  }

  // Every screen frame, with what the player is doing: a take starts on its
  // bar and ends by itself after four bars; stopping ends it.
  void follow(const Now& now, std::vector<Action>& out) {
    follow_capture(now, out);
    now_playing_ = now.playing;
    if (rec == Rec::off) return;
    if (!now.playing) {
      if (rec == Rec::overdub) overdub_off();
      else finish(now, out);
      return;
    }
    if (rec == Rec::waiting && now.step >= rec_start) rec = Rec::recording, ++revision;
    if (rec == Rec::recording && now.step >= rec_start + 64) finish(now, out);
    if (rec == Rec::overdub && now.clip[rec_track].empty()) overdub_off();
  }

  // "C3", "F#4".
  static std::string note_name(int note) {
    static const char* names[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
    return std::string(names[note % 12]) + std::to_string(note / 12 - 1);
  }

  // The note a Play-view pad plays on the selected track.
  int pad_note(int p, const Board& b) const {
    return melodic(b) ? music::pad_note(p, octave, scale, 48 + root) : b.pad_note[std::clamp(track, 0, kTracks - 1)][p];
  }

 private:
  int tap_count_ = 0;
  double tap_intervals_[4]{};
  std::chrono::steady_clock::time_point last_tap_{};
  bool menu_shift_ = false, menu_held_ = false;
  std::chrono::steady_clock::time_point menu_pressed_{};
  // Steps view: a pad turns its step on or off. Shift + pad chooses the kit pad
  // (or synth note, from the Play view's octave) to edit; Erase + pad clears it.
  void steps_pad(int p, int velocity, const Board& b, std::vector<Action>& out) {
    step_held=velocity>0;
    if (velocity == 0 || track >= b.tracks) return;
    const Kind k = b.kind[track];
    if (shift) {
      if (k == Kind::kit) {
        step_pad = p;
        say("Editing " + (b.pad_name[track][p].empty() ? "pad " + std::to_string(p + 1) : b.pad_name[track][p]));
      } else if (k == Kind::synth || k == Kind::sampler || k == Kind::midi) {
        step_note = pad_note(p, b);
        fit_roll();
        say("Editing " + note_name(step_note));
      }
      return;
    }
    const int length = clip_length(b);
    if (length == 0) {
      if (!erase && p == option_pad(0)) request_clip(b, out);
      return;
    }
    if (k != Kind::kit && k != Kind::synth && k != Kind::sampler && k != Kind::midi) return say("Steps edit kits, synths and MIDI");
    Action a = step_action(erase ? Action::erase_row : Action::toggle_step, pad_step(p));
    if (!erase && a.step >= length) return say("The clip ends at step " + std::to_string(length));
    if (!erase) selected_step = a.step;
    out.push_back(a);
  }

  // The take is done: its length in whole bars (pressing Rec up to half a step
  // late doesn't add a bar), held notes end here.
  void finish(const Now& now, std::vector<Action>& out) {
    const bool started = rec == Rec::recording || (rec == Rec::waiting && !take.empty());
    rec = Rec::off;
    ++revision;
    const double ran = now.step - rec_start;
    for (int p = 0; p < 16; ++p)
      if (open_[p] >= 0) take[open_[p]].length = std::max(0.25, ran - take[open_[p]].at);
    open_.fill(-1);
    take_length = edit::take_length(std::max(1.0, ran - 0.5));
    if (!started || take.empty()) return say("Nothing recorded");
    out.push_back({Action::record_end, rec_track, rec_scene});
  }
  void overdub_off() {
    rec = Rec::off;
    say("Overdub off");
  }

  void play_pad(int p, int velocity, const Board& b, const Now& now, std::vector<Action>& out) {
    const int target = velocity ? track : held_track_[p];
    if (target >= b.tracks || (!velocity && held_[p] < 0)) return;
    const Kind k = velocity ? b.kind[target] : held_kind_[p];
    if (velocity && ((k == Kind::midi && !b.routed[target]) || k == Kind::other)) {
      if (velocity) say(k == Kind::midi ? "Choose an internal MIDI destination in Sound" : "Plug-ins play in the browser");
      return;
    }
    const bool taking = (rec == Rec::waiting || rec == Rec::recording) && target == rec_track;
    const bool dubbing = rec == Rec::overdub && target == rec_track;
    if (velocity == 0) {
      if ((k == Kind::synth || k == Kind::sampler || k == Kind::midi) && held_[p] >= 0) out.push_back({Action::note_off, target, -1, p, held_[p]});
      if (taking && open_[p] >= 0) take[open_[p]].length = std::max(0.25, now.step - rec_start - take[open_[p]].at);
      open_[p] = -1;
      if (dubbing && (k == Kind::synth || k == Kind::sampler || k == Kind::midi) && dub_[p].note >= 0) {
        dub_[p].length = std::max(0.25, now.step - pressed_[p]);
        overdub(dub_[p], out);
      }
      dub_[p].note = -1;
      held_[p] = -1;
      return;
    }
    const int note = pad_note(p, b);
    held_[p] = note;
    held_track_[p] = target;
    held_kind_[p] = k;
    if (k == Kind::kit) step_pad = p;
    else step_note = note, pitch_chosen=true, fit_roll();
    level[p] = 0.35f + 0.65f * velocity / 127.0f;
    strike_velocity[p]=full_level?127:velocity;
    strike_time[p]=now.input_time;
    Action a{Action::note_on, track, -1, (k == Kind::kit || k == Kind::midi) ? p : 0, note};
    a.velocity = full_level ? 1.0f : velocity / 127.0f;
    out.push_back(a);
    edit::Hit hit{0, (k == Kind::kit || k == Kind::midi) ? p : 0, note, a.velocity, 1};
    hit.quantize=record_quantize;
    if (taking) {
      // Up to half a step before the take starts counts as its first step.
      const double at = now.step - rec_start;
      if (rec == Rec::recording || at >= -0.5) {
        take.push_back(hit), take.back().at = std::max(0.0, at);
        open_[p] = (k == Kind::synth || k == Kind::sampler || k == Kind::midi) ? static_cast<int>(take.size()) - 1 : -1;
      }
    }
    if (dubbing) {
      // Where in the playing clip: its length from the board.
      int length = 0;
      for (int s = 0; s < b.scenes; ++s)
        if (b.clip[track][s] == now.clip[track]) length = b.clip_steps[track][s];
      if (length <= 0) return;
      double at = std::fmod(now.step - now.anchor[track], length);
      if (at < 0) at += length;
      dub_[p] = hit, dub_[p].at = at, pressed_[p] = now.step;
      if (k == Kind::kit) overdub(dub_[p], out), dub_[p].note = -1;
    }
  }
  void overdub(const edit::Hit& hit, std::vector<Action>& out) {
    Action a{Action::overdub_hit, rec_track};
    a.hit = hit, a.fresh = fresh_;
    fresh_ = false;
    out.push_back(a);
  }

  bool menu_used = false, fresh_ = false;
  std::array<int, 16> held_ = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
  std::array<int, 16> held_track_{};
  std::array<Kind, 16> held_kind_{};
  std::array<int, 16> open_ = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};  // a take's held notes
  // Counts a knob's clicks into whole changes of `per` clicks. A turn of the
  // same knob on the same thing keeps its clicks; the first change after
  // another knob, another target or a pause (the value no longer on screen)
  // is `fresh`, a new step for undo.
  int turn(const std::string& key, int per, int clicks, bool& fresh) {
    if (key != knob_key_) knob_key_ = key, move_clicks_ = 0, fresh_turn_ = true;
    else if (knob_frames == 0) fresh_turn_ = true;
    move_clicks_ += clicks;
    const int delta = move_clicks_ / per;
    move_clicks_ -= delta * per;
    if (delta != 0) fresh = fresh_turn_, fresh_turn_ = false;
    return delta;
  }
  void play_from(int at, std::vector<Action>& out) {
    scene_launched();
    Action a{Action::play_song};
    a.step = at;
    out.push_back(a);
  }
  // Song view knobs: repeats (three clicks a repeat), Move, End and Scene (four clicks each).
  void song_knob(int k, int clicks, const Board& b, std::vector<Action>& out) {
    if (b.chain.empty() && k != 2) return say("Add a scene: press its pad");
    const int at = song_block(b);
    // Move and End keep one turn as one change while the block moves.
    const std::string key = "song|" + std::to_string(k) + "|" + (k == 1 || k == 2 ? std::string() : std::to_string(at));
    bool fresh = false;
    const int delta = turn(key, k == 0 ? 3 : 4, clicks, fresh);
    if (delta == 0) return;
    Action a{Action::turn_knob, -1, -1, -1, 0, at};
    a.knob = k, a.delta = delta, a.fresh = fresh, a.song = true;
    out.push_back(a);
  }
 public:
  // ---- capturing a jam as the song (Song view, REC) ----
  // Armed, capture starts with the music; while it plays, each change in the
  // clips heard (a scene or clip launched from any view) starts a new part.
  // Stopping the music or REC in the Song view ends it, and the session
  // writes the parts into the song.
  bool capturing = false;
  std::vector<edit::HeardPart> captured;
  void toggle_capture(const Now& now, std::vector<Action>& out) {
    if (capturing) return end_capture(out);
    if (rec != Rec::off) return say("Recording a take");
    if (now.playing && now.song) return say("Stop the song first: capture records what you launch");
    capturing = true, captured.clear(), last_heard_ = now.step;
    ++revision;
    say(now.playing ? "Capturing: launch scenes and clips" : "Capture armed: play a scene");
  }
  void follow_capture(const Now& now, std::vector<Action>& out) {
    if (!capturing) return;
    if (!now.playing || now.song) {
      if (!captured.empty()) end_capture(out);
      return;
    }
    std::array<std::string, 8> heard{};
    for (int t = 0; t < kTracks && t < 8; ++t) heard[static_cast<std::size_t>(t)] = now.clip[static_cast<std::size_t>(t)];
    if (captured.empty() || captured.back().clips != heard) {
      if (captured.empty()) last_heard_ = now.step;
      edit::HeardPart part;
      part.clips = heard;
      captured.push_back(part);
      ++revision;
    }
    captured.back().steps += std::max(0.0, now.step - last_heard_);
    last_heard_ = now.step;
  }
  void end_capture(std::vector<Action>& out) {
    capturing = false;
    ++revision;
    if (captured.empty()) return say("Nothing captured");
    out.push_back({Action::song_capture});
  }

  // ---- the Sample view ----
  // REC records (from the first sound) or ends the recording; STOP ends it;
  // the wheel keeps the take on the selected pad (ERASE + wheel forgets it);
  // - and + set how many pads it is sliced across.
  bool sample_button(Button btn, const Board& b, std::vector<Action>& out) {
    switch (btn) {
      case Button::rec:
        if (sampling) {
          sampling = false, ++revision;
          out.push_back({Action::sample_stop, track});
          return true;
        }
        sampling = true, ++revision;
        out.push_back({Action::sample_arm, track, cursor, sample_pad});
        say(now_playing_ ? "Queued for the next bar · " + std::to_string(b.input_bars[track]) + " bars" : "Waiting for sound");
        return true;
      case Button::stop:
        if (!sampling) return false;
        sampling = false, ++revision;
        out.push_back({Action::sample_stop, track});
        return true;
      case Button::wheel:
        if (sampling) return say("Recording: REC ends it"), true;
        if (sample_frames == 0) return say("Nothing recorded: REC records from the inputs"), true;
        if (erase) {
          out.push_back({Action::sample_discard, track});
          return true;
        }
        if (track >= b.tracks || (b.kind[track] != Kind::kit && b.kind[track] != Kind::sampler)) return say("Choose a kit or sampler track for the sample"), true;
        out.push_back({Action::sample_keep, track, -1, sample_pad});
        return true;
      case Button::minus:
      case Button::plus:
        if (sampler_take(b) && !sample_markers) {
          const int d = btn == Button::plus ? 1 : -1;
          if (chop == Chop::even) {
            chop_count = std::clamp(chop_count + d, 2, 16), ++revision;
            say("Even: " + std::to_string(chop_count) + " slices");
            out.push_back({Action::chop_compute, track});
          } else if (chop == Chop::transients) {
            chop_sensitivity = std::clamp(chop_sensitivity + d * 0.1, 0.0, 1.0), ++revision;
            say("Sensitivity " + std::to_string(static_cast<int>(std::lround(chop_sensitivity * 100))) + "%");
            out.push_back({Action::chop_compute, track});
          } else if (chop == Chop::hand && chop_selected > 0 && chop_selected < static_cast<int>(chop_points.size())) {
            // Moves the selected slice's start by 1% of the take, between its neighbours.
            const int step = std::max(1, sample_frames / 100), lo = chop_points[chop_selected - 1] + 1,
                      hi = chop_selected + 1 < static_cast<int>(chop_points.size()) ? chop_points[chop_selected + 1] - 1 : sample_frames - 1;
            chop_points[chop_selected] = std::clamp(chop_points[chop_selected] + d * step, lo, std::max(lo, hi));
            ++revision;
          } else if (chop == Chop::hand)
            say("Pad 2 or higher picks a slice to move");
          return true;
        }
        sample.slices = std::clamp(sample.slices + (btn == Button::plus ? 1 : -1), 1, 16);
        sample.chop_mode = 0, sample.markers.clear();
        ++revision;
        say(sample.slices == 1 ? "One pad" : "Sliced across " + std::to_string(sample.slices) + " pads");
        return true;
      default:
        return false;
    }
  }
  int sample_knob_index(int k) const { return k + (shift ? 4 : 0); }
  std::string sample_knob_name(int k) const {
    static const char* names[8] = {"Start", "End", "Tune", "Level", "Fade in", "Fade out", "Reverse", "Slices"};
    return names[sample_knob_index(k)];
  }
  std::string sample_knob_value(int k) const { return sample_value(sample_knob_index(k), sample); }
  static std::string sample_value(int i, const sample::Edit& e) {
    switch (i) {
      case 0: return sample::seconds_text(e.start);
      case 1: return sample::seconds_text(e.end);
      case 2: return (e.tune > 0 ? "+" : "") + std::to_string(e.tune) + " st";
      case 3: return std::to_string(static_cast<int>(std::lround(e.level * 100))) + "%";
      case 4: return std::to_string(e.fade_in) + " ms";
      case 5: return std::to_string(e.fade_out) + " ms";
      case 6: return e.reverse ? "On" : "Off";
      default: return e.slices == 1 ? "1 pad" : std::to_string(e.slices) + " pads";
    }
  }
  // Q1 start, Q2 end, Q3 tune, Q4 level; with Shift: fade in, fade out, reverse, slices.
  void sample_knob(int k, int clicks) {
    if (sample_frames == 0) return say("Record a take first: REC");
    const int i = sample_knob_index(k), fine = std::max(1, sample_frames / 400);
    auto& e = sample;
    switch (i) {
      case 0: e.start = std::clamp(e.start + clicks * fine, 0, e.end - 1); break;
      case 1: e.end = std::clamp(e.end + clicks * fine, e.start + 1, sample_frames); break;
      case 2: e.tune += clicks; break;
      case 3: e.level += clicks * 0.02f; break;
      case 4: e.fade_in += clicks * 5; break;
      case 5: e.fade_out += clicks * 5; break;
      case 6: e.reverse = clicks > 0; break;
      default: e.slices = std::clamp(e.slices + clicks, 1, 16); e.chop_mode = 0; e.markers.clear(); break;
    }
    e.fit(sample_frames);
    show_knob(sample_knob_name(k), sample_value(i, e));
  }
  bool now_playing_ = false;
  std::array<int, kTracks> heard_ = [] {  // the slot each track's clip was launched from (-1: from a scene)
    std::array<int, kTracks> a{};
    a.fill(-1);
    return a;
  }();
  double last_heard_ = 0;

 public:
  // The session's word on a recording: it ended (by itself, or the card went),
  // and the take that came of it (0 frames: none).
  void sample_done(int frames) {
    sampling = false, sample_frames = frames;
    sample = sample::Edit{};
    sample_markers = false;
    sample.slices = 1;
    sample.fit(frames);
    ++revision;
  }
  void set_playing(bool playing) { now_playing_ = playing; }

 private:
  bool copy_held_ = false, copy_first_ = false;
  int copy_track_ = -1;
  std::string copy_clip_;
  bool knob_held_ = false;
  std::string knob_key_;
  int move_clicks_ = 0;
  bool fresh_turn_ = true;
  std::array<edit::Hit, 16> dub_ = [] {  // an overdub's held synth notes (note -1: none)
    std::array<edit::Hit, 16> a{};
    for (auto& h : a) h.note = -1;
    return a;
  }();
  std::array<double, 16> pressed_{};
};

inline const char* sample_task_name(const Ui& ui, int i) {
  static const char* names[] = {"Audition", "Keep to pad", "Discard", "Fade / reverse", "Sound"};
  return i == 3 && ui.shift ? "Main edits" : names[std::clamp(i,0,4)];
}

inline bool workbench_task_available(const Ui& ui, const Board& b, int task) {
  if (ui.view == View::steps && ui.clip_length(b) == 0) return task == 4;
  if (ui.view == View::sample && task < 4) {
    if (ui.sample_frames == 0 || ui.sampling) return false;
    if (task == 1)
      return ui.track < b.tracks && (b.kind[ui.track] == Kind::kit || b.kind[ui.track] == Kind::sampler);
  }
  if (ui.view == View::sound && task >= 3)
    return task == 3 && ui.track < b.tracks && !b.unchosen[ui.track] &&
           b.kind[ui.track] == Kind::kit && !b.slices[ui.track];
  if (ui.view == View::browse && task != 0)
    return !b.samples.empty() && (task != 1 || ui.browse_category == 0);
  return true;
}

// What the four knobs set now, for the Q-Link strip: the selected step's,
// the selected track's or the selected song block's values. Reads only (the
// edits are asked for no change).
// The synth's Controls page, in reading order (four to a row).
inline edit::Field synth_control(int i) {
  using edit::Field;
  static constexpr Field order[Ui::kSynthFields] = {Field::oscillator, Field::cutoff,  Field::resonance, Field::env_amount,
                                                    Field::env_decay,  Field::attack,  Field::decay,     Field::sustain,
                                                    Field::release,    Field::detune,  Field::glide};
  return order[std::clamp(i, 0, Ui::kSynthFields - 1)];
}
// A field's value as the screen shows it.
inline std::string field_text(const edit::FieldValue& v) {
  if (!v.available) return "\xE2\x80\x93";
  if (v.field == edit::Field::oscillator) {
    static const char* waves[3] = {"Sine", "Saw", "Square"};
    return waves[std::clamp(static_cast<int>(v.value), 0, 2)];
  }
  char t[48];
  std::snprintf(t, sizeof t, "%g%s", v.value, v.unit.c_str());
  return t;
}
// The Sound page's five keys, by machine: a synth's presets or controls, a MIDI
// track's channel and destination, a kit's or sampler's pad sounds.
inline void sound_keys(const Ui& ui, const Board& b, const char* (&names)[5]) {
  const Kind k = ui.track < b.tracks ? b.kind[ui.track] : Kind::other;
  names[2] = "Choose machine";
  if (ui.track < b.tracks && b.unchosen[ui.track]) return;
  if (k == Kind::synth) {
    names[0] = ui.sound_controls ? "Presets" : "Controls";
    names[1] = ui.sound_controls ? "" : "Next presets";
  } else if (k == Kind::midi) {
    names[0] = "MIDI channel", names[1] = "MIDI destination";
  } else if (k == Kind::sampler || b.slices[ui.track]) {
    names[0] = "Chop or edit sample", names[1] = "Replace sample";
  } else if (k == Kind::kit) {
    names[0] = "Edit pad sample", names[1] = "Replace sample", names[3] = "Load kit";
  }
}
inline std::string task_name(const Ui& ui, const Board& b, int task) {
  if (!workbench_task_available(ui, b, task)) return {};
  const char* names[5] = {"", "", "", "", ""};

  switch (ui.view) {
    case View::steps:
      names[0] = ui.draw_mode ? "Draw: toggle" : "Select: inspect";
      names[1] = "Clip length";
      names[2] = "Rename clip";
      names[3] = ui.shift ? "Clear locks" : "Lock tone/level";
      names[4] = "Record quantize";
      break;
    case View::clips:
      names[0] = "Launch grid";
      names[1] = "Stop all tracks";
      names[2] = "Launch scene";
      names[3] = b.clip[ui.track][ui.cursor].empty() ? "Create clip" : "Edit clip";
      names[4] = "8-track overview";
      break;
    case View::play:
      names[0] = "Edit sound";
      names[1] = "Scale";
      names[2] = "Edit pattern";
      names[3] = "Controls";
      names[4] = "Root note";
      break;
    case View::sound:
      sound_keys(ui, b, names);
      break;
    case View::mix:
      names[0] = "Track effects";
      names[1] = "Return A effects";
      names[2] = "Return B effects";
      break;
    case View::song:
      names[0] = ui.capturing ? "Finish capture" : "Capture jam";
      names[1] = ui.capture_replace ? "Replace chain" : "Append after block";
      names[2] = "Append scene";
      names[3] = "Song end";
      names[4] = "Controls";
      break;
    case View::sample:
      names[0] = "Audition";
      names[1] = "Keep to pad";
      names[2] = "Discard";
      names[3] = ui.shift ? "Main edits" : "Fade / reverse";
      names[4] = "Sound";
      if (ui.sampler_take(b)) {
        names[1] = ui.chop == Ui::Chop::keys ? "Keep as keys" : "Keep slices";
        names[4] = ui.chop == Ui::Chop::lazy ? (ui.lazy ? "Stop lazy" : "Start lazy chop") : "Sound";
      }
      break;
    case View::browse:
      names[0] = "Return";
      names[1] = "Audition";
      names[2] = ui.browse_category == 2 ? "Load project" : ui.browse_category == 1 ? "Load kit" : "Load to pad";
      break;
    default:
      break;
  }
  if (ui.view == View::sample && task == 3 && ui.sampler_take(b))
    return std::string("Chop: ") + Ui::chop_name(ui.chop);
  return names[task];
}

inline const char* delay_sync_name(int value) {
  static const char* names[] = {"Free (ms)", "1/64", "1/32", "1/16", "1/8", "1/4", "1/2"};
  return names[std::clamp(value, 0, 6)];
}
inline void fill_strip(Ui &ui, json::Value &project, const Board &b) {
  edit::History scratch;
  // The SOUND page reads four parameters: the registry once for all of them.
  Vec<parameters::Definition> registry;
  if (ui.knob_page() == Ui::Knobs::sound && !ui.menu)
    registry = parameters::registry(project);
  const char *dash = "\xE2\x80\x93";
  for (int k = 0; k < 4; ++k) {
    edit::Shown shown;
    std::string why;
    if (ui.view == View::browse && !ui.menu) {
      ui.strip_page = "BROWSE";
      const bool pad_target = ui.browse_category == 0;
      shown.name = k == 0 ? (pad_target ? "Sample" : ui.browse_category == 1 ? "Kit" : "Project")
                          : k == 1 && pad_target ? "Target pad" : "Unassigned";
      shown.value = k == 0   ? (b.samples.empty()
                                    ? "None"
                                    : std::to_string(ui.browse_index(b) + 1) + " / " + std::to_string(b.samples.size()))
                    : k == 1 && pad_target ? std::to_string(ui.browse_pad + 1)
                             : dash;
    } else if (ui.view == View::sample && !ui.menu) {
      ui.strip_page = ui.shift ? "SAMPLE +" : "SAMPLE";
      shown.name = ui.sample_knob_name(k);
      shown.value = ui.sample_frames > 0 ? ui.sample_knob_value(k) : std::string();
    } else if (ui.view == View::song && !ui.menu) {
      ui.strip_page = "SONG";
      int at = ui.song_block(b);
      edit::song_knob(project, at, k, 0, false, scratch, shown, why);
    } else if (ui.view == View::steps && k == 3 && (ui.shift || ui.knob_page() == Ui::Knobs::fresh) && !ui.menu) {
      ui.strip_page = "STEPS"; shown.name = "Bar";
      shown.value = std::to_string(ui.page + 1) + " / " + std::to_string(std::max(1, (ui.clip_length(b) + 15) / 16));
    } else if (ui.knobs_on_step() && !ui.menu) {
      ui.strip_page = "STEP";
      shown.name = edit::step_knob_name(k);
      if (ui.selected_step >= 0 && ui.track < b.tracks && ui.clip_length(b) > 0) {
        const auto place =
            edit::find(project, Str(b.track_id[ui.track].c_str()), Str(b.clip[ui.track][ui.cursor].c_str()));
        int step = ui.selected_step;
        edit::step_knob(project, place, step, ui.step_pad, ui.step_note, k, 0, false, scratch, shown, why);
      } else {
        why = "no step";
      }
    } else if (ui.knob_page() == Ui::Knobs::fresh && !ui.menu) {
      ui.strip_page = "NEW STEPS";
      shown.name = Ui::fresh_name(k);
      shown.value = ui.fresh_value(k);
    } else if (ui.knob_page() == Ui::Knobs::sound && !ui.menu) {
      ui.strip_page = "SOUND";
      if (b.kind[ui.track] == Kind::midi) {
        const auto v =
            edit::read_field(project, {ui.track, ui.cursor, ui.step_pad, ui.step_note, ui.selected_step, ui.block},
                             k == 0   ? edit::Field::midi_channel
                             : k == 1 ? edit::Field::midi_destination
                                      : edit::Field::none);
        shown.name = v.available ? v.name : "Unassigned";
        shown.value = !v.available ? "—"
                      : k == 1     ? (v.value > 0 ? b.track_name[static_cast<int>(v.value) - 1] : "Not routed")
                                   : std::to_string(static_cast<int>(v.value));
      } else
        edit::sound_knob(project, ui.track, k, 0, false, scratch, shown, why, &registry);
      if (shown.name.empty())
        shown.name = dash;
    } else {
      ui.strip_page = "TRACK";
      edit::track_knob(project, ui.track, k, 0, false, scratch, shown, why);
    }
    if (!why.empty() || shown.value.empty())
      shown.value = dash;
    ui.strip[static_cast<std::size_t>(k)] = shown;
  }
  if (ui.effects_open) {
    const auto &mix = project::detail::at(project, "mix");
    const auto &tracks = project::detail::at(mix, "tracks");
    const auto *strip = tracks.get(b.track_id[ui.track].c_str());
    const json::Value empty;
    const auto &inserts =
        ui.effect_location < 0 ? project::detail::list(strip ? *strip : empty, "inserts")
        : project::detail::at(mix, "returns").is_array() && project::detail::at(mix, "returns").items().size() == 2
            ? project::detail::at(mix, "returns").items()[ui.effect_location].items()
            : project::detail::list(empty, "inserts");
    for (int i = 0; i < 2; ++i)
      ui.effect_names[i] = i < inserts.size() ? text(project::detail::str(inserts[i], "kind")) : "Empty slot";
    for (auto &f : ui.effect_fields)
      f = {};
    if (ui.effect_slot < inserts.size()) {
      const auto &effect = inserts[ui.effect_slot];
      const Str prefix = ui.effect_location < 0 ? Str("track.") + Str(b.track_id[ui.track].c_str())
                                                : Str("return.") + int_text(ui.effect_location);
      int i = 0;
      const auto known = parameters::registry(project);
      for (const auto &param : project::detail::at(effect, "params").members()) {
        if (i >= 4)
          break;
        auto &f = ui.effect_fields[i++];
        f.available = true;
        f.name = param.key.c_str();
        f.value = param.value.as_number() * 100;
        f.max = 100;
        f.increment = 1;
        f.unit = "%";
        f.focus = {ui.track};
        f.parameter = prefix + ".insert." + project::detail::str(effect, "id") + "." + param.key;
        // An edit is kept as the parameter's base value (parameters::set_parameter),
        // not in the effect's own params: show what plays.
        double shown = 0;
        Str why;
        if (parameters::value(project, f.parameter, shown, why, machine::machines(), &known)) f.value = shown * 100;
        if (project::detail::str(effect, "kind") == "delay" && param.key == "time") {
          f.value *= 40; f.max = 4000; f.increment = 5; f.unit = " ms"; f.parameter_scale = 4000;
          if (const auto* sync = effect.get("sync")) {
            f.available = false; f.name = "Time (synced)";
            f.value = project::detail::num(*sync, "division") * 15000 / b.bpm;
          }
        }
      }
    }
  }
  if (ui.effects_open) {
    // Q4 switches between free milliseconds and musical values using the existing effect clock.
    const auto& mix = project::detail::at(project, "mix");
    const auto* strip = project::detail::at(mix, "tracks").get(b.track_id[ui.track].c_str());
    const json::Value empty;
    const auto& inserts = ui.effect_location < 0 ? project::detail::list(strip ? *strip : empty, "inserts")
        : project::detail::at(mix, "returns").items()[ui.effect_location].items();
    if (ui.effect_slot < inserts.size() && project::detail::str(inserts[ui.effect_slot], "kind") == "delay") {
      auto& f = ui.effect_fields[3]; f = {}; f.available = true; f.field = edit::Field::effect_sync;
      f.name = "Sync"; f.max = 6; f.increment = 1; f.focus = {ui.track, ui.effect_location, ui.effect_slot};
      if (const auto* sync = inserts[ui.effect_slot].get("sync")) {
        static const double divisions[] = {0, .25, .5, 1, 2, 4, 8};
        for (int v = 1; v <= 6; ++v) if (project::detail::num(*sync, "division") == divisions[v]) f.value = v;
      }
    }
    ui.strip_page = "EFFECT";
    for (int k = 0; k < 4; ++k) {
      const auto& f = ui.effect_fields[k]; char value[48];
      std::snprintf(value, sizeof value, "%g%s", f.value, f.unit.c_str());
      ui.strip[k].name = !f.name.empty() ? f.name : "—";
      ui.strip[k].value = f.field == edit::Field::effect_sync ? delay_sync_name(f.value) : !f.name.empty() ? value : "—";
    }
  }
  ui.launch_grid = static_cast<int>(edit::read_field(project, {ui.track}, edit::Field::launch_grid).value);
  const edit::Field fields[8] = {edit::Field::velocity,  edit::Field::chance, edit::Field::duration,
                                 edit::Field::condition, edit::Field::cutoff, edit::Field::attack,
                                 edit::Field::decay,     edit::Field::release};
  for (int k = 0; k < 2; ++k)
    ui.midi_fields[k] = edit::read_field(project, {ui.track, ui.cursor},
                                         k == 0 ? edit::Field::midi_channel : edit::Field::midi_destination);
  for (int i = 0; i < 8; ++i)
    ui.touch_fields[i] = edit::read_field(
        project, {ui.track, ui.cursor, ui.step_pad, ui.step_note, ui.selected_step, ui.block}, fields[i]);
  for (int i = 0; i < Ui::kSynthFields; ++i)
    ui.synth_fields[i] = edit::read_field(project, {ui.track}, synth_control(i));
}

// ---- drawing: 1280 x 800, laid out as the web Device view's screen ----
// apps/studio/src/device/style.css: a 72 px header, the page, a 58 px status
// line and a 94 px Q-Link strip; the page has 18 px of padding top and
// bottom and 24 px at the sides. Sizes and colours are the CSS's own.

namespace layout {
inline Rect sample_chop_mode() { return {24,520,276,48}; }
inline Rect sample_monitor() { return {662,520,208,48}; }
inline Rect sample_length() { return {890,520,208,48}; }
inline Rect sample_make_kit() { return {320,520,320,48}; }
// The Q-Link knobs' panel runs down the right edge, beside the knobs
// themselves (owner, 2026-11-15); the page and its status line are to its left.
constexpr int kWidth = 1280, kHeader = 72, kPanel = 140, kPageWidth = kWidth - kPanel, kStatusTop = 742;
constexpr int kLeft = 24, kRight = kPageWidth - 24, kTop = 90;
constexpr int kGap = 10;
// The Device client uses the same header positions on its 1280 × 800 screen.
constexpr Rect kHeaderLogo{kLeft, (kHeader - gfx::logo::kHeight) / 2, gfx::logo::kWidth, gfx::logo::kHeight};
constexpr int kHeaderIdentity = 132, kHeaderSave = 508;
inline Rect header() { return {0, 0, kWidth, kHeader}; }
inline Rect page() { return {0, kHeader, kPageWidth, kStatusTop - kHeader}; }
inline Rect status() { return {0, kStatusTop, kPageWidth, 800 - kStatusTop}; }
// Q1 at the top, as the knobs lie.
inline Rect knob(int k) { return {kPageWidth, kHeader + k * 182, kPanel, k == 3 ? 800 - kHeader - 3 * 182 : 182}; }
// A toolbar's button at the right (min-height 64, padding 14 at the sides).
inline Rect toolbar_button(int text_width) { return {kRight - text_width - 30, kTop + 1, text_width + 30, 64}; }
// Four columns with 10 px gaps across the page.
inline int column_x(int i) { return kLeft + static_cast<int>(std::lround(i * (kRight - kLeft + kGap) / 4.0)); }
inline int column_w(int i) { return column_x(i + 1) - column_x(i) - kGap; }

// Clips: the toolbar, the column heads, then four rows of four cells 98 px high.
constexpr int kHeadTop = 170, kCellTop = 222, kCell = 98;
inline Rect cell(int column, int row) { return {column_x(column), kCellTop + row * (kCell + kGap), column_w(column), kCell}; }
// Clips has no toolbar: the track names sit at the top of the page and the
// sixteen clips share the rest, down to the keys (owner, 2026-11-18).
constexpr int kClipHeadTop = kTop, kClipTop = kTop + 42 + kGap, kClipBottom = 636;
constexpr int kClip = (kClipBottom - kClipTop - 3 * kGap) / 4;
inline Rect head(int column) { return {column_x(column), kClipHeadTop, column_w(column), 42}; }
inline Rect clip_cell(int column, int row) {
  return {column_x(column), kClipTop + row * (kClip + kGap), column_w(column), kClip};
}
// The Clips cell a pad stands for: pads 13-16 on the top row.
inline Rect pad_cell(int pad) { return clip_cell(pad % 4, 3 - pad / 4); }

// Play: the sound matrix, four rows of four 90 px buttons.
constexpr int kPadTop = 170, kPad = 90;
inline Rect play_pad(int pad) { return {column_x(pad % 4), kPadTop + (3 - pad / 4) * (kPad + kGap), column_w(pad % 4), kPad}; }
inline Rect preset_card(int index) { return play_pad(option_pad(index)); }
constexpr int kPresetPageLabel = kPadTop + 4 * (kPad + kGap) + 10;

// Steps: eight columns with 12 px gaps, two rows of 116 px.
constexpr int kStepTop = 195, kStep = 116, kStepGap = 12;
inline Rect step(int index) {
  const int column = index % 8, x = kLeft + static_cast<int>(std::lround(column * (kRight - kLeft + kStepGap) / 8.0));
  const int next = kLeft + static_cast<int>(std::lround((column + 1) * (kRight - kLeft + kStepGap) / 8.0));
  return {x, kStepTop + index / 8 * (kStep + kStepGap), next - x - kStepGap, kStep};
}
// The pad that plays step `index` (0..15) of a page: steps 1-4 on the top row.
inline int step_pad(int index) { return (3 - index / 4) * 4 + index % 4; }

// Steps for synth and MIDI tracks: a piano roll of twelve pitches by sixteen
// steps, the note names at the left.
constexpr int kRollTop = 170, kRollRows = 8, kRollRow = 44, kKeysLeft = 24, kKeysWidth = 72, kGridLeft = 104,
              kStepWidth = (kRight - kGridLeft) / 16;
inline Rect roll() { return {kKeysLeft, kRollTop, kRight - kKeysLeft, kRollRows * kRollRow}; }
inline Rect roll_cell(int step_on_page, int row_from_top) {
  return {kGridLeft + step_on_page * kStepWidth, kRollTop + row_from_top * kRollRow, kStepWidth, kRollRow};
}

// Song: a list of rows 82 px high, five on screen.
constexpr int kListTop = 170, kListRow = 82, kListRows = 5;
inline Rect song_row(int on_screen) { return {kLeft, kListTop + on_screen * kListRow, kRight - kLeft, kListRow}; }
inline int song_first(int selected, int count) {
  return std::clamp(selected - kListRows / 2, 0, std::max(0, count - kListRows));
}

// Mix: eight strips with 12 px gaps, and each strip's mute and solo buttons.
constexpr int kMixTop = 170, kMixHeight = 390;
inline Rect mix_strip(int t) {
  const int x = kLeft + static_cast<int>(std::lround(t * (kRight - kLeft + 12) / 8.0));
  const int next = kLeft + static_cast<int>(std::lround((t + 1) * (kRight - kLeft + 12) / 8.0));
  return {x, kMixTop, next - x - 12, kMixHeight};
}
inline Rect mute_button(int t) {
  const Rect r = mix_strip(t);
  return {r.x + 12, r.y + r.h - 56, (r.w - 36) / 2, 44};
}
inline Rect solo_button(int t) {
  const Rect m = mute_button(t);
  return {m.x + m.w + 12, m.y, m.w, m.h};
}
// A strip's level: a vertical bar.
inline Rect level_bar(int t) {
  const Rect r = mix_strip(t);
  return {r.x + 14, r.y + 92, 22, 214};
}

// Menu: four columns with 16 px gaps, 110 px cards, after the heading.
constexpr int kMenuTop = 159;
inline Rect menu_card(int index) {
  const int column = index % 4, x = kLeft + static_cast<int>(std::lround(column * (kRight - kLeft + 16) / 4.0));
  const int next = kLeft + static_cast<int>(std::lround((column + 1) * (kRight - kLeft + 16) / 4.0));
  return {x, kMenuTop + 30 + index / 4 * 170, next - x - 16, 110};
}
inline Rect task(int index) { return {kLeft + index * 218, 646, 204, 64}; }
inline Rect steps_create_clip() { return {kLeft, 170, kRight - kLeft, 160}; }
// The four machine choices (Kit, Sampler, Synth, MIDI), as pads 13–16.
inline Rect machine_card(int index) { return {24 + index * 270, 222, 254, 160}; }
inline Rect inspector(int index) { return {kLeft + index * 218, 530, 204, 68}; }
inline Rect dialog_key(int index, bool wide = false) {
  return wide ? Rect{48 + index % 3 * 256, 270 + index / 3 * 88, 244, 78}
              : Rect{300 + index % 3 * 128, 310 + index / 3 * 62, 116, 54};
}
inline Rect dialog_apply(bool wide = false) { return wide ? Rect{736, 630, 356, 70} : Rect{744, 616, 200, 62}; }
inline Rect dialog_cancel(bool wide = false) { return wide ? Rect{392, 630, 332, 70} : Rect{520, 616, 200, 62}; }
inline Rect dialog_reset(bool wide = false) { return wide ? Rect{48, 630, 332, 70} : Rect{296, 616, 200, 62}; }
// The pages, in the order the menu shows them, and the pad that opens each.
constexpr int kMenuPages = 9;
inline Rect browse_tab(int i) { return {24 + i * 218, 90, 204, 64}; }
inline Rect browse_search() { return {680, 90, 436, 64}; }
inline Rect effect_slot(int i) { return {24 + i * 550, 170, 530, 100}; }
inline Rect effect_field(int i) { return {24 + i * 270, 300, 254, 90}; }
inline Rect effect_choice(int i) { return {24 + i % 3 * 360, 424 + i / 3 * 78, 344, 64}; }
// The text dialogs share a full-width keyboard and use the same geometry for touch and drawing.
constexpr char kNameCharacters[] = "1234567890QWERTYUIOPASDFGHJKLZXCVBNM-_ ";
constexpr int kNameSpace = sizeof(kNameCharacters) - 2, kNameDelete = kNameSpace + 1;
inline Rect name_row(int row, int column, int columns = 10, int span = 1) {
  constexpr int width = kRight - kLeft + kGap, top = 210, height = 94;
  const int start = column * width / columns;
  const int end = (column + span) * width / columns - kGap;
  return {kLeft + start, top + row * (height + kGap), end - start, height};
}
inline Rect name_key(int i) {
  if (i < 20) return name_row(i / 10, i % 10);
  if (i < 29) return name_row(2, i - 20, 9);
  if (i < kNameSpace) return name_row(3, i - 29, 11);
  if (i == kNameSpace) return name_row(4, 2, 10, 6);
  return name_row(3, 9, 11, 2);
}
inline Rect name_cancel(bool confirming_new) {
  return confirming_new ? dialog_cancel() : name_row(4, 0, 10, 2);
}
inline Rect name_apply(bool confirming_new) {
  return confirming_new ? dialog_apply() : name_row(4, 8, 10, 2);
}
inline Rect value_minus(bool wide = false) { return wide ? Rect{840, 270, 244, 166} : Rect{744, 310, 92, 64}; }
inline Rect value_plus(bool wide = false) { return wide ? Rect{840, 446, 244, 166} : Rect{852, 310, 92, 64}; }
inline Rect project_card(int index) {
  return {kLeft + (index % 2) * 470, 223 + (index / 2) * 156, 450, 132};
}
}  // namespace layout

struct Choice {std::string name;double value;};
inline std::vector<Choice> choices(const Ui &ui, const Board &b) {
  using edit::Field;
  std::vector<Choice> out;
  switch (ui.editor.field) {
  case Field::effect_sync:
    for (int i = 0; i <= 6; ++i) out.push_back({delay_sync_name(i), static_cast<double>(i)});
    break;
  case Field::scale:
    for (int i = 0; i < music::kScales; ++i)
      out.push_back({music::scale_name(static_cast<music::Scale>(i)), static_cast<double>(i)});
    break;
  case Field::scale_root:
    for (int i = 0; i < 12; ++i)
      out.push_back({music::root_name(i), static_cast<double>(i)});
    break;
  case Field::condition:
    for (int i = 0; i < 7; ++i)
      out.push_back({edit::condition_name(i), static_cast<double>(i)});
    break;
  case Field::oscillator:
    return {{"Sine", 0}, {"Saw", 1}, {"Square", 2}};
  case Field::clip_length:
    return {};
  case Field::launch_grid:
    return {{"Immediate", 0}, {"Next beat", 4}, {"Next bar", 16}, {"2 bars", 32}, {"4 bars", 64}};
  case Field::song_end:
    return {{"Stop", 0}, {"Loop", 1}};
  case Field::midi_destination:
    out.push_back({"No destination", 0});
    for (int t = 0; t < b.tracks; ++t)
      if (t != ui.track && (b.kind[t] == Kind::kit || b.kind[t] == Kind::synth || b.kind[t] == Kind::sampler))
        out.push_back({b.track_name[t], static_cast<double>(t + 1)});
    break;
  case Field::block_scene:
    for (int i = 0; i < b.scenes; ++i)
      out.push_back({b.scene_name[i], static_cast<double>(i)});
    break;
  default:
    break;
  }
  return out;
}
inline Rect choice_rect(int i) { return {42 + i % 3 * 366, 190 + i / 3 * 66, 350, 56}; }

// What a touch at (x, y) on the landscape canvas means.
struct Hit {
  enum Kind : std::uint8_t { none, on_slot, on_track, on_scene, on_pad, on_block, on_mute, on_solo, on_note, on_sample } kind = none;
  int track = -1, scene = -1, pad = -1, block = -1, step = -1, note = -1;
};

inline bool within(const Rect& r, int x, int y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }

inline Hit hit(const Ui& ui, const Board& b, int x, int y) {
  const int song_blocks = static_cast<int>(b.chain.size());
  Hit h;
  if (ui.view == View::browse) {
    const int first = ui.browse_index(b) / layout::kListRows * layout::kListRows;
    for (int i = 0; i < layout::kListRows; ++i)
      if (first + i < static_cast<int>(b.samples.size()) && within(layout::song_row(i), x, y))
        return {Hit::on_sample, -1, -1, -1, first + i};
    return h;
  }
  if (ui.view == View::clips) {
    for (int p = 0; p < 16; ++p)
      if (within(layout::pad_cell(p), x, y)) return {Hit::on_slot, ui.pad_track(p), ui.pad_scene(p)};
    for (int c = 0; c < 4; ++c)
      if (within(layout::head(c), x, y)) return {Hit::on_track, ui.track / 4 * 4 + c};
  } else if (ui.view == View::play) {
    for (int p = 0; p < 16; ++p)
      if (within(layout::play_pad(p), x, y)) return {Hit::on_pad, -1, -1, p};
  } else if (ui.view == View::steps && ui.clip_length(b) == 0) {
    return h;
  } else if (ui.view == View::steps && ui.melodic(b)) {
    // The piano roll: a step and a pitch.
    if (x >= layout::kGridLeft && x < layout::kGridLeft + 16 * layout::kStepWidth && y >= layout::kRollTop &&
        y < layout::kRollTop + layout::kRollRows * layout::kRollRow) {
      Hit n{Hit::on_note};
      n.step = ui.page * 16 + (x - layout::kGridLeft) / layout::kStepWidth;
      n.note = ui.roll_low + layout::kRollRows - 1 - (y - layout::kRollTop) / layout::kRollRow;
      return n;
    }
  } else if (ui.view == View::steps) {
    for (int i = 0; i < 16; ++i)
      if (within(layout::step(i), x, y)) return {Hit::on_pad, -1, -1, layout::step_pad(i)};
  } else if (ui.view == View::mix) {
    for (int t = 0; t < kTracks; ++t) {
      if (within(layout::mute_button(t), x, y)) return {Hit::on_mute, t};
      if (within(layout::solo_button(t), x, y)) return {Hit::on_solo, t};
      if (within(layout::mix_strip(t), x, y)) return {Hit::on_track, t};
    }
  } else if (ui.view == View::song) {
    const int first = layout::song_first(ui.block, song_blocks);
    for (int i = 0; i < layout::kListRows; ++i)
      if (within(layout::song_row(i), x, y)) return {Hit::on_block, -1, -1, -1, first + i};
  }
  return h;
}

// Upper case, at most `n` characters.
inline std::string label(const std::string& s, std::size_t n) {
  std::string out;
  for (char c : s) {
    if (out.size() >= n) break;
    out += c >= 'a' && c <= 'z' ? static_cast<char>(c - 'a' + 'A') : c;
  }
  return out;
}

inline void erase_utf8(std::string& text){if(text.empty())return;std::size_t i=text.size()-1;while(i>0&&(static_cast<unsigned char>(text[i])&0xc0)==0x80)--i;text.erase(i);}
inline edit::Focus focus_of(const Ui &ui) {
  return {ui.track, ui.cursor, ui.step_pad, ui.step_note, ui.selected_step, ui.block};
}
inline void open_editor(Ui& ui, const json::Value& project, edit::Field field, edit::Focus focus) {
  ui.editor=edit::read_field(project,focus,field);
  if(!ui.editor.available){ui.say("Select an existing item first");return;}
  ui.editor_open=true;ui.editor_from=ui.editor.value;ui.editor_text.clear();ui.editor_fine=true;++ui.revision;
}
enum class TouchPhase { down, move, up, cancel };
// All gestures prepare state on the main thread and emit bounded semantic actions.
inline bool touch_event(Ui &ui, const json::Value &project, const Board &b, const Now &now, TouchPhase phase, int x,
                        int y, std::vector<Action> &out) {
  using edit::Field;
  if (x < 0 || x >= 1280 || y < 0 || y >= 800)
    return false;
  auto emit = [&](Action::Kind kind) {
    Action a{kind, ui.track, ui.cursor, ui.step_pad, ui.step_note, ui.selected_step};
    out.push_back(a);
  };
  auto edit = [&](Field f) { open_editor(ui, project, f, focus_of(ui)); };
  if (ui.drag_kind) {
    if (phase == TouchPhase::cancel) {
      if (ui.drag_kind == 1 || ui.drag_kind == 2)
        ui.sample = ui.sample_before;
      if (ui.drag_kind == 3)
        ui.block = ui.drag_from;
      ui.drag_kind = 0;
      ++ui.revision;
      return true;
    }
    if (phase == TouchPhase::move || phase == TouchPhase::up) {
      if (ui.drag_kind == 1 || ui.drag_kind == 2) {
        const int frame = std::clamp(
            static_cast<int>(std::lround((x - 36.0) / (layout::kRight - layout::kLeft - 24) * ui.sample_frames)), 0,
            ui.sample_frames);
        if (ui.drag_kind == 1)
          ui.sample.start = std::min(ui.sample.end - 1, frame);
        else
          ui.sample.end = std::max(ui.sample.start + 1, frame);
      }
      if (ui.drag_kind == 3) {
        ui.drag_to =
            std::clamp(layout::song_first(ui.block, b.chain.size()) + (y - layout::kListTop) / layout::kListRow, 0,
                       std::max(0, static_cast<int>(b.chain.size()) - 1));
        if (y > 570)
          ui.block = std::min(static_cast<int>(b.chain.size()) - 1, ui.block + 1);
        else if (y < 190)
          ui.block = std::max(0, ui.block - 1);
        else
          ui.block = ui.drag_to;
      }
      if (ui.drag_kind == 4) {
        ui.editor.value = std::clamp((layout::level_bar(ui.drag_from).y + layout::level_bar(ui.drag_from).h - y) *
                                         100.0 / layout::level_bar(ui.drag_from).h,
                                     0.0, 100.0);
      }
      if (phase == TouchPhase::up) {
        if (ui.drag_kind == 3 && ui.drag_to != ui.drag_from) {
          Action a{Action::turn_knob, -1, -1, -1, 0, ui.drag_from};
          a.song = true;
          a.knob = 1;
          a.delta = ui.drag_to - ui.drag_from;
          a.fresh = true;
          out.push_back(a);
          ui.block = ui.drag_to;
        }
        if (ui.drag_kind == 4) {
          Action a{Action::set_value, ui.drag_from};
          a.field = ui.editor;
          a.field.value = ui.editor_from;
          a.value = ui.editor.value;
          out.push_back(a);
        }
        ui.drag_kind = 0;
      }
      ++ui.revision;
      return true;
    }
    return true;
  }
  if (phase != TouchPhase::down)
    return false;
  if (ui.menu) {
    for (int i = 0; i < layout::kMenuPages; ++i)
      if (within(layout::menu_card(i), x, y)) {
        ui.pad(option_pad(i), 100, b, now, out);
        break;
      }
    return true;
  }
  if (ui.editor_open) {
    const bool wide = ui.editor.field == edit::Field::clip_length;
    if (within(layout::dialog_cancel(wide), x, y)) {
      ui.editor_open = false;
      ++ui.revision;
      return true;
    }
    const auto options = choices(ui, b);
    if (!options.empty()) {
      for (int i = 0; i < static_cast<int>(options.size()); ++i)
        if (within(choice_rect(i), x, y)) {
          if (ui.editor.field == Field::scale)
            ui.scale = static_cast<music::Scale>(static_cast<int>(options[i].value));
          else if (ui.editor.field == Field::scale_root)
            ui.root = static_cast<int>(options[i].value);
          else {
            Action a{Action::set_value, ui.editor.focus.track};
            a.field = ui.editor;
            a.field.value = ui.editor_from;
            a.value = options[i].value;
            out.push_back(a);
          }
          ui.editor_open = false;
          ++ui.revision;
          break;
        }
      return true;
    }
    if (within(layout::dialog_reset(wide), x, y)) {
      ui.editor.value = ui.editor.reset;
      ui.editor_text.clear();
      ++ui.revision;
      return true;
    }
    if (within(layout::dialog_apply(wide), x, y)) {
      double value = ui.editor.value;
      if (!ui.editor_text.empty()) {
        char *end = nullptr;
        value = std::strtod(ui.editor_text.c_str(), &end);
        if (!end || *end || !std::isfinite(value)) {
          ui.say("Enter a number");
          return true;
        }
      }
      if (value < ui.editor.min || value > ui.editor.max) {
        ui.say("Value outside bounds");
        return true;
      }
      if (ui.editor.field == Field::scale) {
        ui.scale = static_cast<music::Scale>(static_cast<int>(value));
      } else if (ui.editor.field == Field::scale_root) {
        ui.root = static_cast<int>(value);
      } else if (ui.editor.field == Field::quantize) {
        ui.record_quantize = value / 100;
      } else if (ui.editor.field >= Field::sample_start && ui.editor.field <= Field::sample_reverse) {
        auto &e = ui.sample;
        switch (ui.editor.field) {
        case Field::sample_start:
          e.start = static_cast<int>(value);
          break;
        case Field::sample_end:
          e.end = static_cast<int>(value);
          break;
        case Field::sample_tune:
          e.tune = static_cast<int>(value);
          break;
        case Field::sample_level:
          e.level = value / 100;
          break;
        case Field::sample_fade_in:
          e.fade_in = value;
          break;
        case Field::sample_fade_out:
          e.fade_out = value;
          break;
        case Field::sample_slices:
          e.slices = static_cast<int>(value);
          break;
        default:
          e.reverse = value > 0;
          break;
        }
        e.fit(ui.sample_frames);
      } else {
        Action a{Action::set_value, ui.editor.focus.track};
        a.field = ui.editor;
            a.field.value = ui.editor_from;
        a.value = value;
        out.push_back(a);
      }
      ui.editor_open = false;
      ++ui.revision;
      return true;
    }
    if (within(layout::value_minus(wide), x, y) || within(layout::value_plus(wide), x, y)) {
      ui.editor.value =
          std::clamp(ui.editor.value + (within(layout::value_minus(wide), x, y) ? -1 : 1) * ui.editor.increment, ui.editor.min, ui.editor.max);
      ui.editor_text.clear();
      ++ui.revision;
      return true;
    }
    for (int i = 0; i < 12; ++i)
      if (within(layout::dialog_key(i, wide), x, y)) {
        if (i < 9 && ui.editor_text.size() < 12)
          ui.editor_text += static_cast<char>('1' + i);
        else if (i == 9) {
          if (!ui.editor_text.empty())
            ui.editor_text.pop_back();
        } else if (i == 10 && ui.editor_text.size() < 12)
          ui.editor_text += '0';
        else if (i == 11 && ui.editor_text.find('.') == std::string::npos)
          ui.editor_text += '.';
        ++ui.revision;
        return true;
      }
    return true;
  }
  // The header (tempo, health, the project's name) still answers on the effects page.
  if (ui.effects_open && y >= layout::kHeader) {
    for (int i = 0; i < 2; ++i)
      if (within(layout::effect_slot(i), x, y)) {
        ui.effect_slot = i;
        ++ui.revision;
        return true;
      }
    for (int i = 0; i < 4; ++i)
      if (within(layout::effect_field(i), x, y) && ui.effect_fields[i].available) {
        ui.editor = ui.effect_fields[i];
        ui.editor_open = true;
        ui.editor_from = ui.editor.value;
        ui.editor_text.clear();
        ++ui.revision;
        return true;
      }
    for (int i = 0; i < 6; ++i)
      if (within(layout::effect_choice(i), x, y)) {
        Action a{Action::effect_edit, ui.track, -1, i};
        a.source_track = ui.effect_location;
        a.step = ui.effect_slot;
        a.knob = 0;
        out.push_back(a);
        return true;
      }
    for (int i = 0; i < 5; ++i)
      if (within(layout::task(i), x, y)) {
        if (i == 4)
          ui.effects_open = false;
        else if (i == 0 || i == 1) {
          Action a{Action::effect_edit, ui.track};
          a.source_track = ui.effect_location;
          a.step = ui.effect_slot;
          a.knob = i == 0 ? 1 : 2;
          out.push_back(a);
        } else
          ui.effect_location = i == 2 ? -1 : (ui.effect_location + 2) % 2;
        ++ui.revision;
        return true;
      }
    return true;
  }
  if (ui.rename_kind) {
    ui.rename_selected = false;
    const bool confirming_new = ui.rename_kind == Ui::kNewProject;
    if (within(layout::name_cancel(confirming_new), x, y)) {
      ui.rename_kind = 0;
      ++ui.revision;
      return true;
    }
    if (within(layout::name_apply(confirming_new), x, y)) {
      if (confirming_new) {
        ui.rename_kind = 0;
        emit(Action::project_new);
        ++ui.revision;
        return true;
      }
      if (ui.rename_kind == 4) {
        ui.browse_query = ui.rename_text;
        ui.rename_kind = 0;
        ui.browse_cursor = 0;
        emit(Action::browse_filter);
        ++ui.revision;
        return true;
      }
      if (ui.rename_text.empty())
        return true;
      Action a{ui.rename_kind == Ui::kSaveAs ? Action::project_save_as : Action::rename, ui.track, ui.cursor};
      a.knob = ui.rename_kind;
      a.name = ui.rename_text;
      out.push_back(a);
      ui.rename_kind = 0;
      ++ui.revision;
      return true;
    }
    if (confirming_new) return true;
    for (int i = 0; i <= layout::kNameDelete; ++i)
      if (within(layout::name_key(i), x, y)) {
        if (i == layout::kNameDelete) {
          if (!ui.rename_text.empty())
            erase_utf8(ui.rename_text);
        } else if (ui.rename_text.size() < (ui.rename_kind == 1 ? 80u : 40u))
          ui.rename_text += layout::kNameCharacters[i];
        ++ui.revision;
        return true;
      }
    return true;
  }
  if (ui.health_open || ui.help_open) {
    ui.health_open = ui.help_open = false;
    ++ui.revision;
    return true;
  }
  if (ui.machine_picker) {
    for (int i = 0; i < 4; ++i)
      if (within(layout::machine_card(i), x, y)) {
        ui.pad(option_pad(i), 100, b, now, out);
        return true;
      }
    return true;
  }
  if (y < layout::kHeader) {
    if (x >= 960 && x < 1110)
      edit(Field::tempo);
    else if (x >= 610 && x < 760)
      ui.health_open = true;
    else if (x >= layout::kHeaderIdentity && x < layout::kHeaderSave && y < 30) {
      ui.rename_kind = 1;
      ui.rename_text = b.name;
    } else if (x >= layout::kHeaderIdentity && x < layout::kHeaderSave) {
      ui.rename_kind = 2;
      ui.rename_text = ui.track < b.tracks ? b.track_name[ui.track] : "";
    }
    ++ui.revision;
    return true;
  }
  if (ui.view == View::project && x < layout::kPageWidth) {
    for (int i = 0; i < 4; ++i) {
      if (!within(layout::project_card(i), x, y)) continue;
      switch (i) {
        case 0: ui.rename_kind = Ui::kNewProject; break;
        case 1:
          ui.browse_category = 2;
          ui.browse_cursor = 0;
          ui.browse_query.clear();
          ui.open(View::browse);
          emit(Action::browse_filter);
          break;
        case 2: emit(Action::project_save); break;
        case 3:
          ui.rename_kind = Ui::kSaveAs;
          ui.rename_text.clear();
          break;
      }
      ++ui.revision;
      break;
    }
    return true;
  }
  if (x >= layout::kPageWidth) {
    const int k = std::clamp((y - layout::kHeader) / 182, 0, 3);
    Field field = Field::none;
    if (ui.view == View::sample) {
      field = ui.shift ? (k == 0   ? Field::sample_fade_in
                          : k == 1 ? Field::sample_fade_out
                          : k == 2 ? Field::sample_reverse
                                   : Field::sample_slices)
                       : static_cast<Field>(static_cast<int>(Field::sample_start) + k);
      auto &e = ui.sample;
      ui.editor = {};
      ui.editor.available = true;
      ui.editor.field = field;
      ui.editor.focus = focus_of(ui);
      ui.editor.name = ui.sample_knob_name(k);
      ui.editor.min = 0;
      ui.editor.max = k < 2 && !ui.shift ? ui.sample_frames : ui.shift ? 1000 : 100;
      ui.editor.increment = 1;
      if (!ui.shift) {
        ui.editor.value = k == 0 ? e.start : k == 1 ? e.end : k == 2 ? e.tune : e.level * 100;
        ui.editor.min = k == 1 ? e.start + 1 : k == 2 ? -24 : 0;
        ui.editor.max = k == 0 ? e.end - 1 : k == 1 ? ui.sample_frames : k == 2 ? 24 : 100;
      } else {
        ui.editor.value = k == 0 ? e.fade_in : k == 1 ? e.fade_out : k == 2 ? e.reverse : e.slices;
        ui.editor.max = k < 2 ? 1000 : k == 2 ? 1 : 16 - ui.sample_pad;
        ui.editor.min = k == 3 ? 1 : 0;
      }
      ui.editor.reset = ui.editor.value;
      ui.editor_open = ui.sample_frames > 0;
      ui.editor_text.clear();
      ++ui.revision;
      return true;
    }
    if (ui.view == View::song) {
      field = k == 0 ? Field::repeats : k == 2 ? Field::song_end : k == 3 ? Field::block_scene : Field::none;
    } else if (ui.knobs_on_step())
      field = k == 0 ? Field::velocity : k == 1 ? Field::chance : k == 2 ? Field::duration : Field::none;
    else if (ui.knob_page() == Ui::Knobs::sound)
      field = b.kind[ui.track] == Kind::midi ? (k == 0   ? Field::midi_channel
                                                : k == 1 ? Field::midi_destination
                                                         : Field::none)
              : k == 0                       ? Field::cutoff
              : k == 1                       ? Field::attack
              : k == 2                       ? Field::decay
                                             : Field::release;
    else
      field = k == 0 ? Field::level : k == 1 ? Field::pan : k == 2 ? Field::send_a : Field::send_b;
    if (field != Field::none)
      edit(field);
    return true;
  }
  if (ui.view == View::browse && y >= 90 && y < 155) {
    if (x < 660) {
      ui.browse_category = std::clamp((x - 24) / 218, 0, 2);
      ui.browse_cursor = 0;
      emit(Action::browse_filter);
    } else {
      ui.rename_kind = 4;
      ui.rename_text = ui.browse_query;
    }
    ++ui.revision;
    return true;
  }
  if (ui.view == View::sample && !ui.sampling && (within(layout::sample_monitor(),x,y) || within(layout::sample_length(),x,y))) {
    if (const auto* entry=project::detail::at(project,"extensions").get("xmp.sampler-input"); entry && project::detail::num(*entry,"version") != 1) return ui.say("These sampler settings need a newer XMP build"), true;
    out.push_back({within(layout::sample_monitor(),x,y) ? Action::sample_monitor : Action::sample_length,ui.track});
    ++ui.revision;
    return true;
  }
  if (ui.view == View::sample && y >= 520 && y < 570 && ui.sample_frames > 0 && !ui.sampling) {
    if (within(layout::sample_chop_mode(), x, y)) {
      ui.sample_markers = true;
      ui.sample.chop_mode = (ui.sample.chop_mode + 1) % 4;
      ui.sample.markers.clear();
      out.push_back({Action::sample_chop_mode, ui.track});
    } else if (within(layout::sample_make_kit(), x, y)) {
      out.push_back({Action::sample_chop, ui.track, -1, 0});
    } else if (within(layout::sample_monitor(),x,y)) out.push_back({Action::sample_monitor,ui.track});
    else if (within(layout::sample_length(),x,y)) out.push_back({Action::sample_length,ui.track});
    ++ui.revision;
    return true;
  }
  if (ui.view == View::sample && ui.sample_frames > 0 && within({24, 196, 1092, 280}, x, y)) {
    const int sx = 36 + static_cast<int>((layout::kRight - layout::kLeft - 24) * ui.sample.start /
                                         static_cast<double>(ui.sample_frames));
    const int ex = 36 + static_cast<int>((layout::kRight - layout::kLeft - 24) * ui.sample.end /
                                         static_cast<double>(ui.sample_frames));
    if (ui.sample.chop_mode == 3 && x > sx + 20 && x < ex - 20 && ui.sample.markers.size() < 15) {
      const double at = std::clamp((x - sx) / static_cast<double>(ex - sx), 0.001, 0.999);
      ui.sample.markers.push_back(at);
      std::sort(ui.sample.markers.begin(), ui.sample.markers.end());
      ui.sample.markers.erase(std::unique(ui.sample.markers.begin(), ui.sample.markers.end(),
        [](double a, double b) { return std::fabs(a - b) < 0.005; }), ui.sample.markers.end());
      ui.sample.slices = static_cast<int>(ui.sample.markers.size()) + 1;
      ++ui.revision;
      return true;
    }
    ui.sample_before = ui.sample;
    ui.drag_kind = std::abs(x - sx) < std::abs(x - ex) ? 1 : 2;
    return true;
  }
  if (ui.view == View::song) {
    for (int i = 0; i < layout::kListRows; ++i)
      if (within(layout::song_row(i), x, y)) {
        const int at = layout::song_first(ui.block, b.chain.size()) + i;
        if (at >= static_cast<int>(b.chain.size()))
          return true;
        ui.block = at;
        if (x < 100)
          ui.drag_kind = 3, ui.drag_from = ui.drag_to = at;
        else
          edit(x > 900 ? Field::repeats : Field::block_scene);
        ++ui.revision;
        return true;
      }
  }
  if (ui.view == View::mix) {
    for (int t = 0; t < b.tracks; ++t) {
      const auto r = layout::mix_strip(t);
      if (within({r.x + 4, r.y + 80, 44, 240}, x, y)) {
        ui.editor = edit::read_field(project, {t}, Field::level);
        ui.editor_from = ui.editor.value;
        ui.drag_kind = 4;
        ui.drag_from = t;
        return true;
      }
      if (within({r.x + 44, r.y + 90, r.w - 48, 220}, x, y)) {
        ui.select_track(t, b);
        if (b.unchosen[t]) return true;
        edit(static_cast<Field>(static_cast<int>(Field::level) + std::clamp((y - r.y - 90) / 54, 0, 3)));
        return true;
      }
    }
  }
  if (ui.view == View::sound) {
    if (ui.track < b.tracks && b.unchosen[ui.track]) {
      for (int i = 0; i < 4; ++i)
        if (within(layout::machine_card(i), x, y)) {
          ui.pad(option_pad(i), 100, b, now, out);
          break;
        }
      return true;
    }
    const bool synth_track = ui.track < b.tracks && b.kind[ui.track] == Kind::synth;
    // A synth's toolbar button switches between its presets and its controls.
    if (synth_track && x >= layout::kRight - 260 && y >= layout::kTop && y < layout::kTop + 66) {
      ui.switch_sound_page(b);
      return true;
    }
    if (y < 155) {
      ui.machine_picker = true;
      ++ui.revision;
      return true;
    }
    if (synth_track && ui.sound_controls && y < layout::task(0).y) {
      for (int i = 0; i < Ui::kSynthFields; ++i)
        if (within(layout::cell(i % 4, i / 4), x, y)) {
          edit(synth_control(i));
          return true;
        }
      return true;
    }
    if (synth_track) {
      for (int i = 0; i < synth::kPresetsPerPage; ++i)
        if (within(layout::preset_card(i), x, y)) {
          ui.choose_preset(ui.preset_page * synth::kPresetsPerPage + i, out);
          return true;
        }
    } else
      for (int p = 0; p < 16; ++p)
        if (within(layout::play_pad(p), x, y)) {
          ui.step_pad = p;
          ui.sample_pad = p;
          ui.pad(p, 100, b, now, out);
          ui.pad(p, 0, b, now, out);
          ++ui.revision;
          return true;
        }
  }
  if (ui.view == View::clips && !ui.overview) {
    for (int col = 0; col < 4; ++col) {
      const auto r = layout::head(col);
      const int t = ui.track / 4 * 4 + col;
      if (t < b.tracks && within({r.x + r.w - 48, r.y, 48, r.h}, x, y)) {
        out.push_back({Action::stop_clip, t});
        return true;
      }
    }
    for (int p = 0; p < 16; ++p)
      if (within(layout::pad_cell(p), x, y)) {
        ui.slot(ui.pad_track(p), ui.pad_scene(p), b, now, out, true);
        return true;
      }
  }
  if (ui.view == View::clips && ui.overview) {
    for (int t = 0; t < b.tracks; ++t) {
      const int left = 24 + t * 136;
      if (within({left, layout::kClipHeadTop, 128, 42}, x, y)) {
        ui.select_track(t, b);
        return true;
      }
      for (int row = 0; row < 4; ++row)
        if (within({left, layout::kClipTop + row * (layout::kClip + layout::kGap), 128, layout::kClip}, x, y)) {
          ui.slot(t, ui.window + row, b, now, out, true);
          return true;
        }
    }
  }
  if (ui.view == View::steps && ui.clip_length(b) == 0) {
    if (ui.can_create_clip(b) && within(layout::steps_create_clip(), x, y)) {
      ui.request_clip(b, out);
      return true;
    }
  } else if (ui.view == View::steps) {
    if (y >= 146 && y < 188 && !ui.melodic(b)) {
      if (x < 170) ui.move_bar(-1, b);
      else if (x < 340) ui.move_bar(1, b);
      else if (x < 600) { ui.follow_playhead = !ui.follow_playhead; ++ui.revision; }
      return true;
    }
    if (ui.melodic(b) && y >= 80 && y < 128 && x >= 650) {
      if (x < 810) ui.move_bar(-1, b); else if (x < 950) ui.move_bar(1, b);
      else { ui.follow_playhead = !ui.follow_playhead; ++ui.revision; }
      return true;
    }
    const auto h = hit(ui, b, x, y);
    if (h.kind == Hit::on_note) {
      ui.step_note = h.note;
      ui.selected_step = h.step;
      ui.fit_roll();
      if (ui.draw_mode || !edit::focused_note(project, edit::focused_clip(project, focus_of(ui)), focus_of(ui)))
        out.push_back(ui.step_action(Action::toggle_step, h.step));
      return true;
    }
    if (h.kind == Hit::on_pad) {
      ui.selected_step = ui.pad_step(h.pad);
      if (ui.draw_mode || !edit::focused_note(project, edit::focused_clip(project, focus_of(ui)), focus_of(ui)))
        out.push_back(ui.step_action(Action::toggle_step, ui.selected_step));
      ++ui.revision;
      return true;
    }
    for (int i = 0; i < 4; ++i)
      if (within(layout::inspector(i), x, y)) {
        edit(i == 0 ? Field::velocity : i == 1 ? Field::chance : i == 2 ? Field::duration : Field::condition);
        return true;
      }
  }
  for (int i = 0; i < 5; ++i)
    if (within(layout::task(i), x, y)) {
      if (task_name(ui, b, i).empty()) return false;
      if (ui.view == View::steps) {
        if (i == 0)
          ui.draw_mode = !ui.draw_mode;
        else if (i == 1)
          edit(Field::clip_length);
        else if (i == 2) {
          ui.rename_kind = 3;
          ui.rename_text = b.clip_name[ui.track][ui.cursor];
        } else if (i == 3) {
          Action a{Action::step_lock, ui.track, ui.cursor, ui.step_pad, ui.step_note, ui.selected_step};
          a.fresh = ui.shift;
          out.push_back(a);
        } else {
          ui.editor = {};
          ui.editor.available = true;
          ui.editor.field = Field::quantize;
          ui.editor.name = "Record quantize";
          ui.editor.value = ui.record_quantize * 100;
          ui.editor.min = 0;
          ui.editor.max = 100;
          ui.editor.increment = 1;
          ui.editor.reset = 100;
          ui.editor_open = true;
        ui.editor_from = ui.editor.value;
        }
      } else if (ui.view == View::mix) {
        ui.effects_open = true;
        ui.effect_location = i == 1 ? 0 : i == 2 ? 1 : -1;
      } else if (ui.view == View::sound) {
        // Each machine has its own keys (see sound_keys); 2 always changes the machine.
        const Kind k = ui.track < b.tracks ? b.kind[ui.track] : Kind::other;
        if (ui.track < b.tracks && b.unchosen[ui.track] && i != 2) {
          // Nothing to edit until a machine is chosen.
        } else if (i == 2)
          ui.machine_picker = true;
        else if (k == Kind::synth) {
          if (i == 0)
            ui.switch_sound_page(b);
          else if (i == 1 && !ui.sound_controls)
            ui.turn_preset_page(1);
        } else if (k == Kind::midi) {
          if (i == 0)
            edit(Field::midi_channel);
          else if (i == 1)
            edit(Field::midi_destination);
        } else if (k == Kind::kit || k == Kind::sampler) {
          if (i == 0)
            emit(Action::open_sample);
          else if (i == 1 || i == 3) {
            ui.open(View::browse);
            ui.browse_category = i == 3 ? 1 : 0;
            ui.browse_cursor = 0;
            ui.browse_query.clear();
            ui.browse_pad = ui.step_pad;
          }
        }
      } else if (ui.view == View::song) {
        if (i == 0)
          ui.toggle_capture(now, out);
        else if (i == 1)
          ui.capture_replace = !ui.capture_replace;
        else if (i == 2)
          out.push_back({Action::song_add, -1, ui.cursor, -1, 0, ui.block + 1});
        else if (i == 3)
          edit(Field::song_end);
        else
          ui.help_open = true;
      } else if (ui.view == View::sample && ui.sampler_take(b)) {
        // A Sampler: keep as keys or slices, choose how to chop, lazy chop.
        if (i == 0)
          emit(Action::sample_audition);
        else if (i == 1)
          out.push_back({Action::sample_keep, ui.track, -1, 0});
        else if (i == 2)
          emit(Action::sample_discard);
        else if (i == 3)
          ui.next_chop(out);
        else if (ui.chop == Ui::Chop::lazy)
          emit(Action::chop_lazy);
        else
          ui.open(View::sound);
      } else if (ui.view == View::sample) {
        if (i == 0)
          emit(Action::sample_audition);
        else if (i == 1) {
          Action a{Action::sample_keep, ui.track, -1, ui.sample_pad};
          out.push_back(a);
        } else if (i == 2)
          emit(Action::sample_discard);
        else if (i == 3)
          ui.shift = !ui.shift;
        else
          ui.open(View::sound);
      } else if (ui.view == View::clips) {
        if (i == 0)
          edit(Field::launch_grid);
        else if (i == 1) {
          for (int t = 0; t < b.tracks; ++t)
            out.push_back({Action::stop_clip, t});
        } else if (i == 2)
          out.push_back({now.playing ? Action::launch_scene : Action::play_scene, -1, ui.cursor});
        else if (i == 3) {
          ui.request_clip(b, out);
          ui.enter_steps(b);
        } else
          ui.overview = !ui.overview;
      } else if (ui.view == View::play) {
        if (i == 0)
          ui.open(View::sound);
        else if (i == 1) {
          ui.editor = {};
          ui.editor.available = true;
          ui.editor.field = Field::scale;
          ui.editor.name = "Playing scale";
          ui.editor.value = static_cast<int>(ui.scale);
          ui.editor.max = music::kScales - 1;
          ui.editor.increment = 1;
          ui.editor_open = true;
        ui.editor_from = ui.editor.value;
        } else if (i == 2)
          ui.enter_steps(b);
        else if (i == 4) {
          ui.editor = {};
          ui.editor.available = true;
          ui.editor.field = Field::scale_root;
          ui.editor.name = "Root note";
          ui.editor.value = ui.root;
          ui.editor.max = 11;
          ui.editor.increment = 1;
          ui.editor_open = true;
          ui.editor_from = ui.editor.value;
        } else
          ui.help_open = true;
      } else if (ui.view == View::browse) {
        if (i == 0)
          ui.open(ui.previous);
        else if (i == 1 || i == 2) {
          if (!b.samples.empty()) {
            Action a{i == 1 ? Action::browse_audition : Action::browse_assign, ui.track, -1, ui.browse_pad};
            a.sample_id = b.samples[ui.browse_index(b)].id;
            out.push_back(a);
          }
        }
      }
      ++ui.revision;
      return true;
    }
  return false;
}

// Platform text input feeds the same naming sheet and Apply/Cancel actions as pads/touch.
// Key codes: 1 select all, 2 backspace/delete, 3 apply, 4 cancel.
inline bool text_event(Ui& ui, const json::Value& project, const Board& b, const Now& now,
                       const std::string& text, int key, std::vector<Action>& out) {
  if (!ui.rename_kind) return false;
  if (key == 3 || key == 4) {
    const Rect r = key == 3 ? layout::name_apply(ui.rename_kind == Ui::kNewProject)
                            : layout::name_cancel(ui.rename_kind == Ui::kNewProject);
    ui.rename_selected = false;
    return touch_event(ui, project, b, now, TouchPhase::down, r.x + r.w / 2, r.y + r.h / 2, out);
  }
  if (ui.rename_kind == Ui::kNewProject) return true;
  if (key == 1) ui.rename_selected = true;
  else if (key == 2) {
    if (ui.rename_selected) ui.rename_text.clear(); else erase_utf8(ui.rename_text);
    ui.rename_selected = false;
  } else if (!text.empty()) {
    const std::size_t limit = ui.rename_kind == 1 || ui.rename_kind == Ui::kSaveAs ? 80 : 40;
    std::string next = ui.rename_selected ? "" : ui.rename_text;
    // Keep whole UTF-8 code points; control characters never become a file name.
    for (std::size_t i = 0; i < text.size();) {
      const unsigned char c = text[i];
      const std::size_t n = c < 128 ? 1 : c < 224 ? 2 : c < 240 ? 3 : 4;
      if (i + n > text.size() || next.size() + n > limit) break;
      if (c >= 32 && c != 127) next.append(text, i, n);
      i += n;
    }
    ui.rename_text = next; ui.rename_selected = false;
  }
  ++ui.revision; return true;
}

inline void pad_event(Ui& ui, const json::Value& project, const Board& b, const Now& now,
                      int pad, int velocity, std::vector<Action>& out) {
  if (pad < 0 || pad >= 16) return;
  if (velocity == 0 || ui.menu_pad_consumed()) return ui.pad(pad, velocity, b, now, out);
  const int i = pad_option(pad);
  const auto press = [&](const Rect& r) {
    if (ui.task_pads_active()) ui.use_menu_pad();
    touch_event(ui, project, b, now, TouchPhase::down, r.x + r.w / 2, r.y + r.h / 2, out);
  };
  if (ui.drag_kind) return;
  if (ui.menu) return ui.pad(pad, velocity, b, now, out);
  if (ui.editor_open) {
    const bool wide = ui.editor.field == edit::Field::clip_length;
    const auto options = choices(ui, b);
    if (!options.empty()) {
      if (ui.shift && i == 0) press(layout::dialog_cancel(wide));
      else if (i < static_cast<int>(options.size())) press(choice_rect(i));
      else if (i == static_cast<int>(options.size())) press(layout::dialog_cancel(wide));
    } else if (ui.shift && i < 2) {
      press(i ? layout::value_plus(wide) : layout::value_minus(wide));
    } else if (i < 12) {
      press(layout::dialog_key(i, wide));
    } else if (i < 15) {
      const Rect commands[] = {layout::dialog_reset(wide), layout::dialog_cancel(wide), layout::dialog_apply(wide)};
      press(commands[i - 12]);
    }
    return;
  }
  if (ui.effects_open) {
    if (ui.shift && i < 4) {
      if (ui.effect_fields[i].available) press(layout::effect_field(i));
    } else if (i < 2) press(layout::effect_slot(i));
    else if (i < 8) press(layout::effect_choice(i - 2));
    else if (i < 13) press(layout::task(i - 8));
    return;
  }
  if (ui.rename_kind) {
    const bool confirming_new = ui.rename_kind == Ui::kNewProject;
    if (i == 0) press(layout::name_cancel(confirming_new));
    else if (i == 1) press(layout::name_apply(confirming_new));
    else if (i == 2 && !confirming_new) press(layout::name_key(layout::kNameDelete));
    return;
  }
  if (ui.health_open || ui.help_open) {
    if (i == 0) press(layout::page());
    return;
  }
  if (ui.machine_picker) return ui.pad(pad, velocity, b, now, out);
  if (ui.view == View::project) {
    if (i < 4) press(layout::project_card(i));
    return;
  }
  if (ui.view == View::browse && (ui.browse_category != 0 || ui.shift)) {
    if (i < layout::kListRows) {
      const int first = ui.browse_index(b) / layout::kListRows * layout::kListRows;
      if (first + i < static_cast<int>(b.samples.size())) {
        if (ui.task_pads_active()) ui.use_menu_pad();
        ui.browse_cursor = first + i;
        ++ui.revision;
      }
    } else if (i < 8) press(layout::browse_tab(i - 5));
    else if (i == 8) press(layout::browse_search());
    else if (i < 12 && !task_name(ui, b, i - 9).empty()) press(layout::task(i - 9));
    return;
  }
  if (ui.task_pads_active()) {
    if (i < 5 && !task_name(ui, b, i).empty()) press(layout::task(i));
    return;
  }
  ui.pad(pad, velocity, b, now, out);
}

// What the Sample view shows of the recording (the session fills it).
struct SampleScreen {
  enum State : std::uint8_t { none, armed, recording, ready } state = none;
  float level = 0;          // the input's recent peak, 0..1
  int frames = 0;           // recorded so far, or the take's length
  int revision = 0;         // changes whenever `peaks` does
  std::vector<float> peaks;  // the waveform, one peak per column
};

class Painter {
 public:
  // Status lights for the header: audio, controller, start-up, input, bridge
  // (0 off, 1 good, 2 fault, 3 waiting). The bridge light is the indicator
  // AGENTS.md authorization 3 requires while the bridge runs.
  std::array<int, 5> lights{};

  void reset() {
    keys_.clear();
    cleared_ = false;
  }

  // Draws what differs from the last frame. `tick` makes queued launches blink.
  // `row`: the Steps view's clip row (live_edit.hpp's row()), when it shows;
  // `roll`: a synth or MIDI clip's notes for the piano roll.
  bool draw(Canvas& c, const Ui& ui, const Board& b, const Now& now, int tick, const edit::Row* row = nullptr,
            const edit::Roll* roll = nullptr, const SampleScreen* taken = nullptr) {
    const int base_mode = ui.menu                   ? 2
                     : ui.view == View::play  ? 1
                     : ui.view == View::steps ? (ui.clip_length(b) == 0 ? 10 : 3)
                     : ui.view == View::song  ? 4
                     : ui.view == View::mix   ? 5
                     : ui.view == View::sample ? 6
                     : ui.view == View::browse ? 7
                     : ui.view == View::sound ? 8
                     : ui.view == View::project ? 9
                                              : 0;
    const int mode=base_mode+(ui.overview&&ui.view==View::clips?600:0)+(ui.editor_open?100:ui.rename_kind?200:ui.machine_picker?300:ui.health_open||ui.help_open?400:ui.effects_open?500:0);
    dirty_.clear();
    if (!cleared_ || mode != mode_) {
      s_.fill({0, 0, layout::kWidth, 800}, gfx::css::kScreen);
      keys_.clear();
      cleared_ = true;
      mode_ = mode;
      dirty_.push_back({0, 0, layout::kWidth, 800});
    }
    header(ui, b, now);
    if (ui.menu) menu(ui, b);
    else if (ui.view == View::play) play(ui, b, now);
    else if (ui.view == View::steps && ui.clip_length(b) == 0) empty_steps(ui, b);
    else if (ui.view == View::steps && ui.melodic(b)) piano_roll(ui, b, now, roll);
    else if (ui.view == View::steps) steps(ui, b, now, row);
    else if (ui.view == View::song) song(ui, b, now);
    else if (ui.view == View::mix) mix(ui, b);
    else if (ui.view == View::sample) sample_view(ui, b, taken ? *taken : SampleScreen{});
    else if (ui.view == View::browse) browse(ui, b);
    else if (ui.view == View::sound) sound_view(ui, b);
    else if (ui.view == View::project) project_view(b);
    else clips(ui, b, now, tick);
    status(ui, b, now);
    strip(ui);
    if(!ui.menu){
      for(const auto &r:dirty_)if(r.x<layout::kPageWidth && r.y<layout::kStatusTop && r.y+r.h>layout::kHeader){++overlay_epoch_;break;}
      workbench(ui,b,row);
    }
    for (const Rect& r : dirty_) c.blit(s_.pixels(), gfx::Surface::kWidth, r);
    return !dirty_.empty();
  }

 private:
  using F = gfx::Font;
  using S = gfx::Surface;

  // Repaints a region only when its key changed; the region is then copied to the screen.
  bool changed(const std::string& region, const std::string& key, Rect area) {
    for (auto& k : keys_)
      if (k.first == region) {
        if (k.second == key) return false;
        k.second = key;
        dirty_.push_back(area);
        return true;
      }
    keys_.push_back({region, key});
    dirty_.push_back(area);
    return true;
  }
  // A line of text in a CSS line box of `top` (line-height 1.3).
  int line(F f, int x, int top, const std::string& text, gfx::Rgb colour, int max = 0) {
    return s_.text(f, x, S::baseline(f, top, S::line(f)), text, colour, max);
  }
  // A web button: surface-2 with a 1 px line border, radius 7.
  void button(Rect r, bool focused = false) {
    s_.box(r, 7, 1, gfx::css::kLine, gfx::css::kSurface2);
    if (focused) s_.ring(r, 7, 3, gfx::css::kGold);
  }
  // The page toolbar: a heading (or muted text) at the left, an optional button at the right.
  void toolbar(const std::string& title, bool heading, const std::string& action) {
    const int mid = layout::kTop + 33;
    if (heading)
      s_.text(F::heading, layout::kLeft, mid + 10, title, gfx::css::kIvory, 800);
    else
      s_.text(F::body, layout::kLeft, mid + 7, title, gfx::css::kMuted, 800);
    if (action.empty()) return;
    const Rect r = layout::toolbar_button(S::width(F::base, action));
    button(r);
    s_.text_centre(F::base, r.x + r.w / 2, r.y + 40, action, gfx::css::kIvory);
  }
  void bar_button(Rect r, const std::string& name) {
    button(r); s_.text_centre(F::body, r.x + r.w / 2, S::baseline(F::body, r.y, r.h), name, gfx::css::kIvory);
  }
  void note(int top, const std::string& text) { line(F::label, layout::kLeft, top, text, gfx::css::kMuted, layout::kRight - layout::kLeft); }

  // ---- the header ----
  static std::string state_text(const Ui& ui, const Now& now) {
    if (ui.rec == Ui::Rec::overdub) return "OVERDUB";
    if (ui.rec == Ui::Rec::waiting)
      return "REC IN " + std::to_string(std::max(1, static_cast<int>(std::ceil((ui.rec_start - now.step) / 4))));
    if (ui.rec == Ui::Rec::recording) return "REC BAR " + std::to_string(static_cast<int>((now.step - ui.rec_start) / 16) + 1);
    if (ui.capturing) return now.playing && !now.song ? "CAPTURE" : "CAPTURE ARMED";
    return now.playing ? (now.song ? "SONG" : "PLAYING") : "STOPPED";
  }
  void header(const Ui& ui, const Board& b, const Now& now) {
    using namespace gfx::css;
    const int bar = static_cast<int>(std::max(0.0, now.step)) / 16 + 1,
              beat = static_cast<int>(std::max(0.0, now.step)) % 16 / 4 + 1;
    char time[32];
    std::snprintf(time, sizeof time, "%02d : %02d", now.playing ? bar : 1, now.playing ? beat : 1);
    const std::string page = ui.menu ? "MENU" : view_name(ui.view);
    const std::string track = ui.track < b.tracks ? b.track_name[ui.track] : "";
    const std::string state = state_text(ui, now);
    double preview_bpm = b.bpm;
    if (ui.editor_open && ui.editor.field == edit::Field::tempo) {
      const double value = ui.editor_text.empty() ? ui.editor.value : std::strtod(ui.editor_text.c_str(), nullptr);
      if (std::isfinite(value) && value >= 30 && value <= 300) preview_bpm = value;
    }
    char bpm_text[32]; std::snprintf(bpm_text, sizeof bpm_text, "%g BPM", preview_bpm);
    std::string key = page + "|" + track + "|" + b.name + "|" + time + "|" + std::string(bpm_text) + "|" + state;
    for (int l : lights) key += std::to_string(l);
    key += ui.save_status;
    if (!changed("header", key, layout::header())) return;
    s_.round({0, 0, layout::kWidth, layout::kHeader - 1}, 0, kSurface, kBg);
    s_.fill({0, layout::kHeader - 1, layout::kWidth, 1}, kGoldDeep);
    s_.two_colour_mask(layout::kHeaderLogo, gfx::logo::kPixels, kIvory, kGoldBright);
    // The project's name over the page's name and the selected track's (gold, bold).
    const int x = layout::kHeaderIdentity, width = layout::kHeaderSave - x - 16;
    const float top = 8 + (56 - (S::line(F::muted) + S::line(F::title))) / 2;
    s_.text(F::muted, x, S::baseline(F::muted, static_cast<int>(top), S::line(F::muted)), b.name + "  · edit", kMuted, width);
    const int title_base = S::baseline(F::title, static_cast<int>(top + S::line(F::muted)), S::line(F::title));
    const int track_x = x + s_.text(F::title, x, title_base, page, kIvory) + 14;
    if (!track.empty()) s_.text(F::body_bold, track_x, title_base, track + "  · edit", kGold, width - (track_x - x));
    s_.text(F::muted,layout::kHeaderSave,26,ui.save_status,kMuted,230);
    s_.text(F::mono,770,45,time,kGold,168);
    s_.text(F::base,960,44,std::string(bpm_text),kIvory,145);
    s_.text(F::muted,1116,44,state,ui.rec!=Ui::Rec::off?kRubySoft:now.playing?kEmeraldBright:kMuted,148);
    for(int i=0;i<5;++i){const gfx::Rgb colour=lights[i]==1?kEmeraldBright:lights[i]==2?kRuby:lights[i]==3?kGold:kLine;s_.round({650+i*18,40,10,10},5,colour);}

  }

  // ---- the status line and the Q-Link strip ----
  static std::string hint(const Ui& ui, const Board& b) {
    if (ui.menu)
      return ui.menu_button_held() ? "Touch a page or press its pad · Hold MENU 3 s to keep Menu open"
                                   : "Touch a page or press its pad · Press MENU to close";
    if (ui.task_pads_active()) return "Press a labelled pad for a screen button";
    if(ui.sound_pending)return "Applying sound change · playback continues";
    if(ui.shift){if(ui.view==View::steps)return "SHIFT + pads choose a note/sound · Q-Link: previous page · UNDO: redo";if(ui.view==View::clips)return "SHIFT + A–D: tracks 5–8 · MAIN: Play · MENU: Browse · COPY: unlink";return "SHIFT: alternate controls · A–D: tracks 5–8 · UNDO: redo · MENU: Browse";}
    switch (ui.view) {
      case View::clips: return "MAIN: Clips \xC2\xB7 SHIFT + MAIN: Play \xC2\xB7 16 LEVEL: Steps \xC2\xB7 MENU: pages";
      case View::play: return "Pads play the track \xC2\xB7 REC records a take \xC2\xB7 OVERDUB adds to the playing clip";
      case View::steps:
        if (ui.clip_length(b) == 0)
          return ui.can_create_clip(b) ? "Press the data dial to create a clip · REC records a take" : "";
        if (ui.melodic(b)) return "Pads turn the edited note on and off \xC2\xB7 SHIFT + pad: note \xC2\xB7 wheel: page \xC2\xB7 knobs: velocity, chance, length, move";
        return "Pads turn steps on and off \xC2\xB7 SHIFT + pad: sound \xC2\xB7 ERASE + pad: clear \xC2\xB7 wheel: page";
      case View::song:
        if (ui.capturing) return "Capturing: launch scenes and clips anywhere \xC2\xB7 STOP or REC here ends it";
        return "Pads add a scene \xC2\xB7 wheel selects \xC2\xB7 PLAY plays from it \xC2\xB7 REC captures a jam \xC2\xB7 ERASE + wheel press removes";
      case View::mix: return "Top pads select a track \xC2\xB7 bottom pads mute \xC2\xB7 SHIFT + bottom pad solos";
      case View::sound:
        if (ui.track < b.tracks && b.unchosen[ui.track]) return "Pads 13–16 or touch choose this track’s machine";
        if (ui.track < b.tracks && b.kind[ui.track] == Kind::synth)
          return ui.sound_controls ? "Touch a control to set it \xC2\xB7 pads play \xC2\xB7 knobs: tone, attack, decay, release"
                                   : "Pads choose a preset \xC2\xB7 -/+ changes bank \xC2\xB7 Shift + pad plays the sound";
        return "Pads play the track \xC2\xB7 Q-LINK: track or sound knobs \xC2\xB7 SHIFT + MENU: Browse for sounds";
      case View::sample:
        if (ui.sampler_take(b)) {
          if (ui.lazy) return "Lazy chop: tap a pad where each slice starts \xC2\xB7 Stop lazy ends it";
          return ui.chop == Ui::Chop::even         ? "\xE2\x80\x93 / +: number of slices \xC2\xB7 wheel: keep the slices"
                 : ui.chop == Ui::Chop::transients ? "\xE2\x80\x93 / +: sensitivity \xC2\xB7 wheel: keep the slices"
                 : ui.chop == Ui::Chop::hand       ? "Pads pick a slice \xC2\xB7 \xE2\x80\x93 / +: move its start \xC2\xB7 wheel: keep"
                 : ui.chop == Ui::Chop::lazy       ? "Start lazy chop, then tap pads as the take plays \xC2\xB7 wheel: keep"
                                                   : "Keys: the whole sample across the pads as notes \xC2\xB7 wheel: keep";
        }
        return "REC records from the inputs \xC2\xB7 pads: the pad, and listen \xC2\xB7 wheel: keep \xC2\xB7 ERASE + wheel: discard";
      default: return "";
    }
  }
  void status(const Ui& ui, const Board& b, const Now&) {
    using namespace gfx::css;
    const std::string text = ui.toast.empty() ? hint(ui, b) : ui.toast;
    if (!changed("status", text + (ui.toast.empty() ? "" : "!"), layout::status())) return;
    const Rect r = layout::status();
    s_.fill(r, kSurface);
    s_.fill({r.x, r.y, r.w, 1}, kLine);
    s_.fill({r.x, r.y + r.h - 1, r.w, 1}, kGoldDeep);
    s_.text(F::status, layout::kLeft, S::baseline(F::status, r.y + 1, r.h - 2), text, ui.toast.empty() ? kMuted : kIvory, layout::kRight - layout::kLeft);
  }
  void strip(const Ui& ui) {
    using namespace gfx::css;
    // One size for the page's four values: large when every one fits.
    bool large = true;
    for (const auto& q : ui.strip) large = large && q.value.size() <= 4;
    for (int k = 0; k < 4; ++k) {
      const auto& q = ui.strip[static_cast<std::size_t>(k)];
      const bool active = ui.knob_active == k;
      const std::string page = "Q" + std::to_string(k + 1) + " \xC2\xB7 " + ui.strip_page;
      if (!changed("q" + std::to_string(k), page + "|" + q.name + "|" + q.value + (active ? "a" : "") + (large ? "L" : ""),
                   layout::knob(k)))
        continue;
      const Rect r = layout::knob(k);
      s_.fill(r, active ? kSurface2 : kBg);
      s_.fill({r.x, r.y, 1, r.h}, kLine);
      if (k < 3) s_.fill({r.x, r.y + r.h - 1, r.w, 1}, kLine);
      if (active) s_.fill({r.x + 1, r.y, 4, r.h - 1}, kGold);
      // The page, then the name and the value large, centred in the cell.
      const F value = large ? F::mono_large : F::mono;
      const float total = S::line(F::small) + 8 + S::line(F::label) + 6 + S::line(value);
      float top = r.y + (r.h - total) / 2;
      const int x = r.x + 16, w = r.w - 24;
      s_.text(F::small, x, S::baseline(F::small, static_cast<int>(top), S::line(F::small)), page, active ? kGold : kSubtle, w);
      top += S::line(F::small) + 8;
      s_.text(F::label, x, S::baseline(F::label, static_cast<int>(top), S::line(F::label)), q.name.empty() ? "\xE2\x80\x93" : q.name,
              kIvory, w);
      top += S::line(F::label) + 6;
      s_.text(value, x, S::baseline(value, static_cast<int>(top), S::line(value)), q.value, kGold, w);
    }
  }


  // ---- Clips: the four tracks and four scenes the pads stand for ----
  void clips(const Ui& ui, const Board& b, const Now& now, int tick) {
    using namespace gfx::css;
    if (ui.overview) {
      std::string key = std::to_string(ui.window) + "|" + std::to_string(ui.track) + "|" + std::to_string(ui.cursor) +
                        "|" + std::to_string(tick / 15);
      for (int t = 0; t < b.tracks; ++t)
        for (int r = 0; r < 4; ++r)
          key += b.clip_name[t][std::min(15, ui.window + r)];
      if (!changed("overview", key, layout::page()))
        return;
      s_.fill(layout::page(), kScreen);
      // No toolbar: track names on top, the clips filling the page as in Clips.
      for (int t = 0; t < b.tracks; ++t) {
        s_.text(F::body, 24 + t * 136, layout::kClipHeadTop + 30, b.track_name[t], t == ui.track ? kGold : kIvory, 128);
        for (int row = 0; row < 4; ++row) {
          const int scene = ui.window + row;
          if (scene >= b.scenes)
            continue;
          const Rect r{24 + t * 136, layout::kClipTop + row * (layout::kClip + layout::kGap), 128, layout::kClip};
          const bool filled = !b.clip[t][scene].empty(), playing = ui.heard_scene(t, b, now) == scene;
          button(r, t == ui.track && scene == ui.cursor);
          s_.text(F::caption, r.x + 8, r.y + 23, b.scene_name[scene], kMuted, r.w - 16);
          s_.text(F::body_bold, r.x + 8, r.y + 52, filled ? b.clip_name[t][scene] : "Create clip",
                  playing ? kEmeraldBright : kIvory, r.w - 16);
          s_.text(F::caption, r.x + 8, r.y + 79,
                  playing  ? "PLAYING"
                  : filled ? "Ready"
                           : "",
                  playing ? kEmeraldBright : kMuted, r.w - 16);
        }
      }
      return;
    }
    const int first_track = ui.track / 4 * 4;
    const bool blink = tick / 15 % 2 == 0;
    for (int col = 0; col < 4; ++col) {
      const int t = first_track + col;
      const std::string name = t < b.tracks ? b.track_name[t] : "Track " + std::to_string(t + 1);
      const bool selected = t == ui.track;
      if (!changed("head" + std::to_string(col), name + (selected ? "|s" : "|") + (t < b.tracks ? "" : "x"), layout::head(col)))
        continue;
      const Rect r = layout::head(col);
      s_.fill(r, kScreen);
      s_.text(F::body, r.x + 12, S::baseline(F::body, r.y + 8, S::line(F::body)), name,
              selected ? kGold : t < b.tracks ? kIvory : kSubtle, r.w - 74);
      if(t<b.tracks){button({r.x+r.w-48,r.y,48,r.h});s_.text_centre(F::base,r.x+r.w-24,S::baseline(F::base,r.y,r.h),"■",kIvory);}
    }
    for (int p = 0; p < 16; ++p) {
      const int t = ui.pad_track(p), sc = ui.pad_scene(p);
      const bool exists = t < b.tracks && sc < b.scenes;
      const std::string& clip = exists ? b.clip[t][sc] : std::string();
      const bool playing = !clip.empty() && now.playing && now.clip[t] == clip && ui.heard_scene(t, b, now) == sc;
      const bool launching =
          exists && now.queued[t] && !clip.empty() && now.queued_clip[t] == clip && ui.launch_scene(t, b, now) == sc;
      const bool stopping = playing && now.queued[t] && now.queued_clip[t] != clip;
      const bool focus = exists && sc == ui.cursor && t == ui.track;
      int progress = 0;
      if (playing && b.clip_steps[t][sc] > 0)
        progress = static_cast<int>(std::fmod(std::max(0.0, now.step - now.anchor[t]), b.clip_steps[t][sc]) /
                                    b.clip_steps[t][sc] * 64);
      const std::string caption = "PAD " + std::to_string(p + 1) + " \xC2\xB7 " + (sc < b.scenes ? b.scene_name[sc] : "No scene");
      const std::string key = caption + "|" + clip + "|" + (exists ? b.clip_name[t][sc] : "") + "|" +
                              (exists ? std::to_string(b.clip_notes[t][sc]) : "") + (playing ? "p" : "") +
                              (launching && blink ? "l" : "") + (stopping && blink ? "x" : "") + (focus ? "f" : "") +
                              std::to_string(progress) + (exists ? "e" : "");
      const Rect r = layout::pad_cell(p);
      if (!changed("cell" + std::to_string(p), key, r)) continue;
      s_.fill(r, kScreen);
      const bool filled = !clip.empty();
      if (filled) {
        s_.box(r, 7, 1, playing ? kEmeraldBright : kEmerald, kCellTop, kCellBottom);
        s_.fill({r.x + 7, r.y + 1, r.w - 14, 1}, gfx::blend_colour(kCellTop, kEmeraldBright, 0.15f));
      } else {
        s_.round(r, 7, kSurface);
        s_.gap_colour(kSurface);
        s_.dashed(r, 7, kLine);
      }
      if (focus) s_.ring(r, 7, 3, kGold);
      if (launching && blink) s_.ring(r, 7, 3, kGoldBright);
      if (stopping && blink) s_.ring(r, 7, 3, kRuby);
      const gfx::Rgb text = filled ? kIvory : kMuted;
      line(F::caption, r.x + 12, r.y + 12, caption, kMuted, r.w - 24);
      line(F::title, r.x + 12, r.y + 32, filled ? b.clip_name[t][sc] : "Create clip", text, r.w - 24);
      std::string detail = t >= b.tracks ? "No track yet" : sc >= b.scenes ? "No scene yet" : "";
      if (filled) {
        const int beats = b.clip_steps[t][sc] / 4, notes = b.clip_notes[t][sc];
        detail = std::to_string(beats) + (beats == 1 ? " beat" : " beats") + " \xC2\xB7 " + std::to_string(notes) +
                 (notes == 1 ? " note" : " notes");
      }
      line(F::muted, r.x + 12, r.y + 64, detail, kMuted, r.w - 24);
      if (playing) {
        const Rect bar{r.x + 12, r.y + r.h - 6, r.w - 24, 3};
        s_.fill(bar, kEmeraldDeep);
        s_.fill({bar.x, bar.y, bar.w * (progress + 1) / 64, bar.h}, kEmeraldBright);
      }
    }
  }

  // ---- Play: the selected track's sixteen pads ----
  void play(const Ui& ui, const Board& b, const Now& now) {
    using namespace gfx::css;
    const int t = ui.track;
    const bool real = t < b.tracks;
    const Kind kind = real ? b.kind[t] : Kind::other;
    std::string title = real ? b.track_name[t] + " \xC2\xB7 " + b.sound[t] : "No track";
    if (kind == Kind::synth || kind == Kind::sampler || kind == Kind::midi) title += " \xC2\xB7 octave " + std::string(ui.octave > 0 ? "+" : "") + std::to_string(ui.octave) + (ui.scale == music::Scale::chromatic ? std::string(" \xC2\xB7 Chromatic") : std::string(" \xC2\xB7 ") + music::root_name(ui.root) + " " + music::scale_name(ui.scale));
    const std::string rec = ui.rec != Ui::Rec::off ? state_text(ui, now) : "";
    if (changed("toolbar", title + "|" + rec + (ui.full_level ? "F" : ""), {0, layout::kTop, layout::kPageWidth, 66})) {
      s_.fill({0, layout::kTop, layout::kPageWidth, 66}, kScreen);
      toolbar(title, true, "");
      if (!rec.empty() || ui.full_level) {
        const std::string tag = !rec.empty() ? rec : "FULL LEVEL";
        const Rect r = layout::toolbar_button(S::width(F::base, tag));
        s_.box(r, 7, 1, !rec.empty() ? kRuby : kGoldDeep, kSurface2);
        if (!rec.empty()) s_.fill({r.x + 7, r.y + r.h - 3, r.w - 14, 3}, kRuby);
        s_.text_centre(F::base, r.x + r.w / 2, r.y + 40, tag, !rec.empty() ? kRubySoft : kGold);
      }
    }
    for (int p = 0; p < 16; ++p) {
      std::string name;
      if (kind == Kind::kit) {
        const auto& names = b.pad_name[std::clamp(ui.track, 0, kTracks - 1)];
        name = names[p].empty() ? "Pad " + std::to_string(p + 1) : names[p];
      }
      else if ((kind == Kind::synth || kind == Kind::sampler)) name = Ui::note_name(ui.pad_note(p, b));
      const int lit = static_cast<int>(ui.level[p] * 40);
      const Rect r = layout::play_pad(p);
      if (!changed("pad" + std::to_string(p), name + "|" + std::to_string(lit), r)) continue;
      s_.fill(r, kScreen);
      const float l = ui.level[p];
      s_.box(r, 7, 1, l > 0.05f ? kEmerald : kLine, gfx::blend_colour(kSurface2, kEmeraldDeep, l * 1.6f),
             gfx::blend_colour(kSurface2, kEmeraldDeep, l));
      line(F::muted, r.x + 14, r.y + 10, "PAD " + std::to_string(p + 1), kMuted);
      line(F::title, r.x + 14, r.y + r.h - 10 - static_cast<int>(S::line(F::title)), name, l > 0.3f ? kEmeraldBright : kIvory,
           r.w - 28);
    }
    if (changed("note", "play", {0, 570, layout::kPageWidth, 70})) {
      s_.fill({0, 570, layout::kPageWidth, 70}, kScreen);
      note(584, "MAIN: Clips \xC2\xB7 16 LEVEL: Steps \xC2\xB7 + / \xE2\x80\x93: octave \xC2\xB7 FULL LEVEL: every hit at full velocity");
    }
  }

  void empty_steps(const Ui& ui, const Board& b) {
    using namespace gfx::css;
    const bool has_slot = ui.track < b.tracks && ui.cursor < b.scenes;
    const std::string title = has_slot ? "Empty slot · " + b.scene_name[ui.cursor] : "Select a track and scene";
    const bool can_create = ui.can_create_clip(b);
    const Rect area{0, layout::kTop, layout::kPageWidth, layout::task(0).y - layout::kTop};
    if (!changed("empty-steps", title + (can_create ? "|create" : ""), area)) return;
    s_.fill(area, kScreen);
    toolbar(title, true, "");
    if (can_create) {
      const auto card = layout::steps_create_clip();
      button(card, true);
      pad_badge(card, option_label(0));
      s_.text(F::card, card.x + 20, card.y + 68, "Create clip", kIvory);
      s_.text(F::base, card.x + 20, card.y + 108,
              std::to_string(edit::kNewClipSteps) + " steps", kMuted);
    }
  }

  // ---- Steps: sixteen steps of the selected clip, for one pad or note ----
  void steps(const Ui& ui, const Board& b, const Now& now, const edit::Row* row) {
    using namespace gfx::css;
    const int t = ui.track, length = ui.clip_length(b);
    const bool real = t < b.tracks && length > 0;
    const Kind kind = t < b.tracks ? b.kind[t] : Kind::other;
    const std::string what = kind == Kind::kit
                                 ? "pad " + std::to_string(ui.step_pad + 1) + ": " +
                                       (b.pad_name[t][ui.step_pad].empty() ? "Pad " + std::to_string(ui.step_pad + 1)
                                                                          : b.pad_name[t][ui.step_pad])
                             : kind == Kind::synth ? "note " + Ui::note_name(ui.step_note)
                                                   : "";
    const std::string title = real ? b.clip_name[t][ui.cursor] + " \xC2\xB7 " + what : "No clip here";
    const std::string pages = real ? "Bar " + std::to_string(ui.page + 1) + " of " + std::to_string((length + 15) / 16) + " \xC2\xB7 " +
                                         std::to_string(length) + " steps"
                                   : "";
    if (changed("toolbar", title + "|" + pages + (ui.erase ? "E" : "") + (ui.follow_playhead ? "F" : "H"), {0, layout::kTop, layout::kPageWidth, 96})) {
      s_.fill({0, layout::kTop, layout::kPageWidth, 96}, kScreen);
      s_.text(F::heading, layout::kLeft, layout::kTop + 28, title, kIvory, 620);
      bar_button({24, 146, 140, 42}, "Prev bar"); bar_button({184, 146, 140, 42}, "Next bar");
      bar_button({344, 146, 240, 42}, ui.follow_playhead ? "Follow: on" : "Follow: off");
      if (!pages.empty()) s_.text_right(F::body, layout::kRight, layout::kTop + 28, ui.erase ? "ERASE + pad clears" : pages,
                                        ui.erase ? kRubySoft : kMuted);
    }
    int head = -1;
    if (real && now.playing && now.clip[t] == b.clip[t][ui.cursor])
      head = static_cast<int>(std::fmod(std::max(0.0, now.step - now.anchor[t]), length));
    for (int i = 0; i < 16; ++i) {
      const int st = ui.page * 16 + i;
      const bool inside = real && st < length;
      const float v = inside && row ? row->velocity[st] : 0;
      const bool on = v > 0, playhead = st == head, chosen = st == ui.selected_step && ui.knobs_on_step();
      const Rect r = layout::step(i);
      const std::string key = std::to_string(st) + "|" + std::to_string(static_cast<int>(v * 100)) + (inside ? "i" : "") +
                              (playhead ? "h" : "") + (chosen ? "c" : "") + (row && row->locked[st]?"lock":"") + (ui.shift?"shift":"");
      if (!changed("step" + std::to_string(i), key, r)) continue;
      s_.fill(r, kScreen);
      if (!inside) {
        s_.box(r, 7, 1, kLine, kSurface);
        line(F::base, r.x + r.w / 2 - S::width(F::base, std::to_string(st + 1)) / 2, r.y + 10, std::to_string(st + 1), kLine);
        continue;
      }
      if (on) s_.box(r, 7, 1, kGoldBright, kStepTop, kStepBottom);
      else s_.box(r, 7, 1, kLine, kSurface3);
      if (playhead) s_.ring(r, 7, 3, kEmeraldBright);
      else if (chosen) s_.ring(r, 7, 3, on ? kIvory : kGold);
      const std::string number = ui.shift?(ui.melodic(b)?Ui::note_name(ui.pad_note(layout::step_pad(i),b)):b.pad_name[t][layout::step_pad(i)]):std::to_string(st+1);
      if(row&&row->locked[st])line(F::caption,r.x+10,r.y+48,"LOCK",on?kStepText:kGold,r.w-20);
      line(F::base, ui.shift?r.x+8:r.x + r.w / 2 - S::width(F::base, number) / 2, r.y + 10, number, on ? kStepText : kIvory,r.w-16);
      const std::string mark = on ? std::to_string(static_cast<int>(std::lround(v * 100))) + "%" : "\xC2\xB7";
      const int top = r.y + r.h - 10 - static_cast<int>(S::line(F::base));
      if (on) s_.text_centre(F::base, r.x + r.w / 2, S::baseline(F::base, top, S::line(F::base)), mark, kStepMark);
      else s_.text_centre(F::base, r.x + r.w / 2, S::baseline(F::base, top, S::line(F::base)), mark, kGold);
    }

  }

  // ---- Steps for synth and MIDI tracks: the piano roll ----
  // Twelve pitches (the note being edited among them) by the page's sixteen
  // steps; each note a gold bar as long as it lasts, brighter the harder it
  // plays; the selected note ringed in ivory, the playhead an emerald line.
  void piano_roll(const Ui& ui, const Board& b, const Now& now, const edit::Roll* roll) {
    using namespace gfx::css;
    using namespace layout;
    const int t = ui.track, length = ui.clip_length(b);
    const bool real = length > 0;
    const std::string title = real ? b.clip_name[t][ui.cursor] + " \xC2\xB7 note " + Ui::note_name(ui.step_note) : "No clip here";
    const std::string pages = real ? "Bar " + std::to_string(ui.page + 1) + " of " + std::to_string((length + 15) / 16) + " \xC2\xB7 " +
                                         std::to_string(length) + " steps"
                                   : "";
    if (changed("toolbar", title + "|" + pages + (ui.erase ? "E" : "") + (ui.follow_playhead ? "F" : "H"), {0, kTop, kPageWidth, 66})) {
      s_.fill({0, kTop, kPageWidth, 66}, kScreen);
      s_.text(F::base, layout::kLeft, layout::kTop + 24, title, kIvory, 600);
      if (!pages.empty()) {
        s_.text(F::body, 24, kTop + 48, pages, kMuted, 560);
        bar_button({650, 80, 150, 48}, "Prev bar"); bar_button({810, 80, 130, 48}, "Next bar");
        bar_button({950, 80, 160, 48}, ui.follow_playhead ? "Follow: on" : "Follow: off");
      }
    }
    const int first = ui.page * 16, low = ui.roll_low, high = low + kRollRows - 1;
    int head = -1;
    if (real && now.playing && now.clip[t] == b.clip[t][ui.cursor])
      head = static_cast<int>(std::fmod(std::max(0.0, now.step - now.anchor[t]), length));
    // What the roll shows, as a key: the notes on this page and the pitches, the selection, the playhead.
    std::string key = std::to_string(first) + "|" + std::to_string(low) + "|" + std::to_string(ui.step_note) + "|" +
                      std::to_string(ui.knobs_on_step() ? ui.selected_step : -1) + "|" + std::to_string(length) + "|" +
                      std::to_string(head >= first && head < first + 16 ? head : -1);
    int above = 0, below = 0;
    if (roll)
      for (const auto& n : roll->notes) {
        if (n.at + n.length <= first || n.at >= first + 16) continue;
        if (n.note > high) ++above;
        else if (n.note < low) ++below;
        else
          key += "|" + std::to_string(static_cast<int>(n.at * 4)) + "," + std::to_string(n.note) + "," +
                 std::to_string(static_cast<int>(n.length * 4)) + "," + std::to_string(static_cast<int>(n.velocity * 100));
      }
    const Rect area = layout::roll();
    if (!changed("roll", key + "|" + std::to_string(above) + "|" + std::to_string(below), {0, area.y - 4, kPageWidth, area.h + 34}))
      return;
    s_.fill({0, area.y - 4, kPageWidth, area.h + 34}, kScreen);
    static constexpr bool kBlack[12] = {false, true, false, true, false, false, true, false, true, false, true, false};
    for (int row = 0; row < kRollRows; ++row) {
      const int note = high - row;
      const bool chosen = note == ui.step_note, black = kBlack[note % 12];
      const Rect lane{kGridLeft, kRollTop + row * kRollRow, 16 * kStepWidth, kRollRow};
      s_.fill(lane, chosen ? kSurface3 : black ? kBg : kSurface);
      s_.fill({lane.x, lane.y + lane.h - 1, lane.w, 1}, kLine);
      // The note names: C rows (and the edited row) labelled, black keys darker.
      const Rect keyr{kKeysLeft, lane.y, kKeysWidth - 6, kRollRow - 1};
      s_.fill(keyr, chosen ? kSurface3 : black ? kBg : kSurface2);
      if (chosen || note % 12 == 0 || row == 0 || row == kRollRows - 1)
        s_.text(F::caption, keyr.x + 10, S::baseline(F::caption, keyr.y, keyr.h), Ui::note_name(note), chosen ? kGold : kMuted);
    }
    for (int i = 0; i <= 16; ++i) {
      const int st = first + i;
      const bool bar = st % 16 == 0, beat = st % 4 == 0;
      if (!beat && i != 16) continue;
      s_.fill({kGridLeft + i * kStepWidth, kRollTop, 1, kRollRows * kRollRow}, bar ? kLineStrong : kLine);
    }
    // Past the clip's end: dimmed.
    if (real && first + 16 > length) {
      const int from = std::max(0, length - first);
      s_.fill({kGridLeft + from * kStepWidth + 1, kRollTop, (16 - from) * kStepWidth - 1, kRollRows * kRollRow}, kBg);
    }
    // Step numbers under the roll.
    for (int i = 0; i < 16; i += 4)
      s_.text(F::caption, kGridLeft + i * kStepWidth + 6, kRollTop - 10, std::to_string(first + i + 1), kSubtle);
    if (roll)
      for (const auto& n : roll->notes) {
        if (n.note < low || n.note > high || n.at + n.length <= first || n.at >= first + 16) continue;
        const int row = high - n.note;
        const double from = std::max<double>(n.at, first), to = std::min<double>(n.at + n.length, first + 16);
        const int x0 = kGridLeft + static_cast<int>(std::lround((from - first) * kStepWidth)) + 2;
        const int x1 = kGridLeft + static_cast<int>(std::lround((to - first) * kStepWidth)) - 2;
        const Rect r{x0, kRollTop + row * kRollRow + 3, std::max(6, x1 - x0), kRollRow - 6};
        const float v = 0.35f + 0.65f * std::clamp(n.velocity, 0.0f, 1.0f);
        s_.box(r, 5, 1, n.sequence ? kGold : kGoldBright, gfx::blend_colour(kSurface3, gfx::css::kStepTop, v),
               gfx::blend_colour(kSurface3, gfx::css::kStepBottom, v));
        const bool selected = ui.knobs_on_step() && n.note == ui.step_note && static_cast<int>(n.at) == ui.selected_step &&
                              !n.sequence;
        if (selected) s_.ring(r, 5, 2, kIvory);
      }
    if (head >= first && head < first + 16)
      s_.fill({kGridLeft + (head - first) * kStepWidth, kRollTop, 2, kRollRows * kRollRow}, kEmeraldBright);
    if (above) s_.text_right(F::caption, kRight, kRollTop - 6, "\xE2\x96\xB2 " + std::to_string(above) + " higher", kGold);
    if (below)
      s_.text_right(F::caption, kRight, kRollTop - 10, "\xE2\x96\xBC " + std::to_string(below) + " lower", kGold);
  }

  // ---- Song: the scene chain as a list ----
  void song(const Ui& ui, const Board& b, const Now& now) {
    using namespace gfx::css;
    const int n = static_cast<int>(b.chain.size()), selected = ui.song_block(b), first = layout::song_first(selected, n);
    const std::string summary = n == 0 ? "Empty song" : std::to_string(n) + (n == 1 ? " block" : " blocks") + " \xC2\xB7 ends: " +
                                                            (b.loop ? "loop" : "stop");
    if (changed("toolbar", summary, {0, layout::kTop, layout::kPageWidth, 66})) {
      s_.fill({0, layout::kTop, layout::kPageWidth, 66}, kScreen);
      toolbar("Song chain", true, "");
      s_.text_right(F::body, layout::kRight, layout::kTop + 40, summary, kMuted);
    }
    for (int i = 0; i < layout::kListRows; ++i) {
      const int at = first + i;
      const Rect r = layout::song_row(i);
      std::string key = "";
      if (at < n) {
        const auto& block = b.chain[static_cast<std::size_t>(at)];
        key = std::to_string(at) + "|" + block.id + "|" + std::to_string(block.scene) + "|" + std::to_string(block.repeats) + "|"+std::to_string(block.first_bar)+"|"+std::to_string(block.last_bar)+
              (now.playing && now.block == block.id ? "p" : "") + (at == selected ? "c" : "");
      } else if (n == 0 && i == 0) {
        key = "empty";
      }
      if (!changed("row" + std::to_string(i), key, r)) continue;
      s_.fill(r, kScreen);
      if (key.empty()) continue;
      if (n == 0) {
        line(F::base, r.x + 12, r.y + 24, "Press a scene\xE2\x80\x99s pad to turn your loops into a song.", kMuted);
        continue;
      }
      const auto& block = b.chain[static_cast<std::size_t>(at)];
      const bool playing = now.playing && now.block == block.id, chosen = at == selected;
      if (chosen) s_.box({r.x, r.y + 4, r.w, r.h - 9}, 7, 1, kLine, kSurface2);
      if (chosen) s_.ring({r.x, r.y + 4, r.w, r.h - 9}, 7, 3, kGold);
      s_.fill({r.x, r.y + r.h - 1, r.w, 1}, kLine);
      const int base = S::baseline(F::base, r.y + 4, r.h - 9);
      s_.text(F::base, r.x + 20, base, std::to_string(at + 1), playing ? kEmeraldBright : kMuted);
      const std::string name = block.scene >= 0 ? b.scene_name[block.scene] : "Missing scene";
      s_.text(F::title, r.x + 85, base, (playing ? "\xE2\x96\xB6 " : "") + name, playing ? kEmeraldBright : kIvory, 590);
      s_.text(F::label,r.x+700,base,"Bars "+std::to_string(block.first_bar)+"–"+std::to_string(block.last_bar),kMuted,220);
      s_.text_right(F::mono, r.x + r.w - 20, base, std::to_string(block.repeats) + "\xC3\x97", kGold);
    }
    if (changed("note", "song", {0, 590, layout::kPageWidth, 50})) {
      s_.fill({0, 590, layout::kPageWidth, 50}, kScreen);
      note(594, "PLAY START plays from the top \xC2\xB7 knobs: repeats, move, end, scene \xC2\xB7 UNDO restores");
    }
  }

  // ---- Mix: eight channel strips ----
  // ---- Sample: the take, its edits and where it goes ----
  void sample_view(const Ui& ui, const Board& b, const SampleScreen& t) {
    using namespace gfx::css;
    const bool kit = ui.track < b.tracks && (b.kind[ui.track] == Kind::kit || b.kind[ui.track] == Kind::sampler);
    const bool sampler = ui.sampler_take(b) && !ui.sample_markers;
    const int slices = static_cast<int>(ui.chop_points.size());
    const std::string where = sampler ? b.track_name[ui.track] + " \xC2\xB7 Sampler \xC2\xB7 " +
                                            (ui.chop == Ui::Chop::keys ? std::string("keys") : std::to_string(slices) + " slices")
                              : kit   ? b.track_name[ui.track] + " \xC2\xB7 pad " + std::to_string(ui.sample_pad + 1) +
                                          (ui.sample.slices > 1 ? "\xE2\x80\x93" + std::to_string(ui.sample_pad + ui.sample.slices) : "")
                                      : "Choose a kit track (bank buttons)";
    const std::string state = t.state == SampleScreen::armed       ? "Waiting for sound"
                              : t.state == SampleScreen::recording ? "Recording " + sample::seconds_text(t.frames)
                              : t.state == SampleScreen::ready     ? sample::seconds_text(t.frames) + " take"
                                                                   : "No take";
    if (changed("toolbar", where + "|" + state, {0, layout::kTop, layout::kPageWidth, 66})) {
      s_.fill({0, layout::kTop, layout::kPageWidth, 66}, kScreen);
      toolbar("Sample \xE2\x86\x92 " + where, true, "");
      s_.text_right(F::body, layout::kRight, layout::kTop + 40, state,
                    t.state == SampleScreen::recording ? kRubySoft : t.state == SampleScreen::armed ? kGold : kMuted);
    }
    // The input meter.
    const Rect meter{layout::kLeft, 168, layout::kRight - layout::kLeft, 14};
    const int lit = static_cast<int>(std::lround(meter.w * std::clamp(t.level, 0.0f, 1.0f)));
    if (changed("meter", std::to_string(lit / 4), meter)) {
      s_.fill(meter, kScreen);
      s_.round(meter, 5, kSurface3);
      if (lit > 0) s_.round({meter.x, meter.y, lit, meter.h}, 5, t.level > 0.9f ? kRuby : kEmeraldBright);
    }
    // The waveform: what is kept bright, the rest dim; start and end in gold, slices between.
    const Rect wave{layout::kLeft, 196, layout::kRight - layout::kLeft, 280};
    const auto& e = ui.sample;
    const std::string key = std::to_string(t.revision) + "|" + std::to_string(e.start) + "|" + std::to_string(e.end) + "|" +
                            std::to_string(e.slices) + "|" + std::to_string(t.frames) + std::to_string(t.state) + "|" + std::to_string(ui.revision);
    if (changed("wave", key, wave)) {
      s_.fill(wave, kScreen);
      s_.box(wave, 7, 1, kLine, kSurface2);
      const int columns = static_cast<int>(t.peaks.size()), mid = wave.y + wave.h / 2, half = wave.h / 2 - 12;
      const int inner = wave.w - 24;
      const bool editing = t.state == SampleScreen::ready && t.frames > 0;
      for (int i = 0; i < columns; ++i) {
        const int x0 = wave.x + 12 + i * inner / columns, x1 = wave.x + 12 + (i + 1) * inner / columns;
        const int h = std::max(1, static_cast<int>(std::lround(half * std::clamp(t.peaks[static_cast<std::size_t>(i)], 0.0f, 1.0f))));
        const double at = static_cast<double>(i) / columns * t.frames;
        const bool kept = !editing || (at >= e.start && at < e.end);
        s_.fill({x0, mid - h, std::max(1, x1 - x0 - 1), 2 * h}, kept ? kEmeraldBright : kLineStrong);
      }
      if (editing) {
        const auto x_of = [&](double frame) { return wave.x + 12 + static_cast<int>(std::lround(inner * frame / t.frames)); };
        if (e.chop_mode && !e.markers.empty()) {
          for (const double at : e.markers) s_.fill({x_of(e.start + (e.end - e.start) * at), wave.y + 8, 1, wave.h - 16}, kIvory);
        } else for (int k = 1; k < e.slices; ++k) s_.fill({x_of(e.start + (e.end - e.start) * k / static_cast<double>(e.slices)), wave.y + 8, 1, wave.h - 16}, kIvory);
        s_.fill({x_of(e.start) - 1, wave.y + 4, 3, wave.h - 8}, kGold);
        s_.fill({x_of(e.end) - 1, wave.y + 4, 3, wave.h - 8}, kGold);
      } else if (columns == 0) {
        s_.text_centre(F::body, wave.x + wave.w / 2, mid + 8, t.state == SampleScreen::armed ? "Play something: recording starts at the first sound"
                                                                                           : "REC records from the Live\xE2\x80\x99s inputs", kMuted);
      }
    }
    // The edits, in words.
    std::string facts;
    if (sampler)
      facts = std::string("Chop: ") + Ui::chop_name(ui.chop) +
              (ui.chop == Ui::Chop::even         ? " \xC2\xB7 " + std::to_string(ui.chop_count) + " slices"
               : ui.chop == Ui::Chop::transients ? " \xC2\xB7 sensitivity " + std::to_string(static_cast<int>(std::lround(ui.chop_sensitivity * 100))) + "%"
               : ui.chop == Ui::Chop::keys       ? std::string(" \xC2\xB7 the whole sample on every pad")
                                                 : " \xC2\xB7 " + std::to_string(slices) + " slices") +
              (ui.chop != Ui::Chop::keys ? " \xC2\xB7 slice " + std::to_string(ui.chop_selected + 1) + " selected" : std::string()) +
              "  \xC2\xB7  Start " + Ui::sample_value(0, e) + "  \xC2\xB7  End " + Ui::sample_value(1, e);
    for (int i = 0; i < 8 && !sampler; ++i) {
      static const char* names[8] = {"Start", "End", "Tune", "Level", "Fade in", "Fade out", "Reverse", "Slices"};
      facts += std::string(i ? "  \xC2\xB7  " : "") + names[i] + " " + Ui::sample_value(i, e);
    }
    if (changed("facts", facts + std::to_string(t.frames > 0), {0, 490, layout::kPageWidth, 70})) {
      s_.fill({0, 490, layout::kPageWidth, 70}, kScreen);
      if (t.frames > 0 && t.state == SampleScreen::ready) line(F::label, layout::kLeft, 500, facts, kIvory, layout::kRight - layout::kLeft);
    }
    if (changed("note", sampler ? "sampler" : "sample", {0, 576, layout::kPageWidth, 60})) {
      s_.fill({0, 576, layout::kPageWidth, 60}, kScreen);
      note(584, sampler ? "Chop key: Keys, Even, Transients, By hand, Lazy chop \xC2\xB7 knobs: start, end, tune, level \xC2\xB7 UNDO restores"
                        : "Knobs: start, end, tune, level \xC2\xB7 SHIFT: fade in, fade out, reverse, slices \xC2\xB7 \xE2\x80\x93 / +: slices \xC2\xB7 UNDO restores");
    }
    if (changed("chop-actions", std::to_string(ui.revision) + "|" + std::to_string(t.state) + std::to_string(b.input_monitor[ui.track]) + std::to_string(b.input_bars[ui.track]), {24,520,1074,50})) {
      const bool enabled = t.state == SampleScreen::ready;
      const Rect mode = layout::sample_chop_mode(), make = layout::sample_make_kit();
      button(mode); button(make);
      const Rect monitor = layout::sample_monitor(), length = layout::sample_length();
      button(monitor); button(length);
      s_.text_centre(F::body, monitor.x+monitor.w/2,S::baseline(F::body,monitor.y,monitor.h),b.input_monitor[ui.track] ? "Monitor: On" : "Monitor: Off",kIvory);
      s_.text_centre(F::body,length.x+length.w/2,S::baseline(F::body,length.y,length.h),std::to_string(b.input_bars[ui.track])+" bars",kIvory);
      s_.text_centre(F::body, mode.x + mode.w/2, S::baseline(F::body,mode.y,mode.h), sample::chop_mode_name(e.chop_mode), enabled ? kIvory : kSubtle);
      s_.text_centre(F::body, make.x + make.w/2, S::baseline(F::body,make.y,make.h), "Chop to drum kit", enabled ? kGold : kSubtle);
    }
  }

  void mix(const Ui& ui, const Board& b) {
    using namespace gfx::css;
    int muted = 0, soloed = 0;
    for (int t = 0; t < b.tracks; ++t) muted += b.muted[t], soloed += b.soloed[t];
    const std::string summary = std::to_string(muted) + " muted \xC2\xB7 " + std::to_string(soloed) + (soloed == 1 ? " solo" : " solos");
    if (changed("toolbar", summary, {0, layout::kTop, layout::kPageWidth, 66})) {
      s_.fill({0, layout::kTop, layout::kPageWidth, 66}, kScreen);
      toolbar("Track mixer", true, "");
      s_.text_right(F::body, layout::kRight, layout::kTop + 40, summary, kMuted);
    }
    auto percent = [](float v) { return std::to_string(static_cast<int>(std::lround(v * 100))) + "%"; };
    for (int t = 0; t < kTracks; ++t) {
      const Rect r = layout::mix_strip(t);
      const bool real = t < b.tracks, selected = t == ui.track;
      // A track a solo silences reads as muted.
      const bool silent = real && (b.muted[t] || (soloed > 0 && !b.soloed[t]));
      const std::string key = real ? b.track_name[t] + "|" + percent(b.volume[t]) + "|" + edit::pan_text(b.pan[t]) + "|" +
                                         percent(b.send1[t]) + "|" + percent(b.send2[t]) + (b.muted[t] ? "m" : "") +
                                         (b.soloed[t] ? "s" : "") + (silent ? "q" : "") + (selected ? "c" : "")
                                   : std::string("none") + (selected ? "c" : "");
      if (!changed("strip" + std::to_string(t), key, r)) continue;
      s_.fill(r, kScreen);
      s_.box(r, 7, 1, kLine, kSurface2);
      if (selected) s_.ring(r, 7, 3, kGold);
      const int pad = t < 4 ? 13 + t : 9 + t - 4;
      line(F::muted, r.x + 14, r.y + 12, "PAD " + std::to_string(pad), kMuted);
      line(F::title, r.x + 14, r.y + 38, real ? b.track_name[t] : "Track " + std::to_string(t + 1), real ? (silent ? kMuted : kIvory) : kSubtle,
           r.w - 28);
      if (!real) {
        line(F::muted, r.x + 14, r.y + 80, "No track", kSubtle);
        continue;
      }
      // The level: a bar filled from the bottom, emerald (dim while silent).
      const Rect bar = layout::level_bar(t);
      s_.round(bar, 5, kSurface3);
      const int fill = static_cast<int>(std::lround(bar.h * rack::fader_position(b.volume[t])));
      if (fill > 0)
        s_.round({bar.x, bar.y + bar.h - fill, bar.w, fill}, 5, silent ? kLineStrong : kEmeraldBright, silent ? kLine : kEmerald);
      const int handle_y=std::clamp(bar.y+bar.h-fill-5,bar.y,bar.y+bar.h-10);
      s_.box({bar.x-5,handle_y,bar.w+10,10},3,1,kGold,kIvory);
      const int x = bar.x + bar.w + 14, w = r.x + r.w - 12 - x;
      int y = bar.y;
      const std::pair<const char*, std::string> rows[] = {{"Level", percent(b.volume[t])},
                                                          {"Pan", edit::pan_text(b.pan[t])},
                                                          {"Send 1", percent(b.send1[t])},
                                                          {"Send 2", percent(b.send2[t])}};
      for (const auto& [name, value] : rows) {
        line(F::caption, x, y, name, kSubtle, w);
        line(F::label, x, y + 20, value, kGold, w);
        y += 54;
      }
      const Rect m = layout::mute_button(t), so = layout::solo_button(t);
      if (b.muted[t]) s_.box(m, 7, 1, kRuby, gfx::blend_colour(kSurface2, kRuby, 0.55f));
      else button(m);
      s_.text_centre(F::base, m.x + m.w / 2, S::baseline(F::base, m.y, m.h), "M", b.muted[t] ? kIvory : kMuted);
      if (b.soloed[t]) s_.box(so, 7, 1, kGoldBright, kStepTop, kStepBottom);
      else button(so);
      s_.text_centre(F::base, so.x + so.w / 2, S::baseline(F::base, so.y, so.h), "S", b.soloed[t] ? kStepText : kMuted);
    }
    if (changed("note", "mix", {0, 576, layout::kPageWidth, 60})) {
      s_.fill({0, 576, layout::kPageWidth, 60}, kScreen);
      note(584, "Knobs: the selected track\xE2\x80\x99s level, pan and sends \xC2\xB7 touch M or S to mute or solo \xC2\xB7 UNDO restores");
    }
  }

  void pad_badge(Rect r, const std::string& badge) {
    s_.text(F::caption, r.x + r.w - (badge.size() > 4 ? 88 : 42), r.y + 24, badge, gfx::css::kGold);
  }

  // Browse reuses project samples without touching any storage or other kit.
  void browse(const Ui& ui, const Board& b) {
    using namespace gfx::css;
    const int index = ui.browse_index(b), first = index / layout::kListRows * layout::kListRows;
    std::string key = std::to_string(index) + "|" + std::to_string(ui.browse_pad) + "|" + std::to_string(ui.track) +
                      "|" + std::to_string(ui.browse_category) + "|" + ui.browse_query + "|" + b.name +
                      "|" + b.track_name[ui.track] + (ui.shift ? "|shift" : "");
    for (const auto& sample : b.samples) key += "|" + sample.id + "|" + sample.name + "|" + sample.detail;
    if (!changed("browse", key, layout::page())) return;
    s_.fill(layout::page(), kScreen);
    const bool pad_choices = ui.browse_category != 0 || ui.shift;
    for (int i = 0; i < 3; ++i) {
      const Rect r = layout::browse_tab(i);
      button(r, ui.browse_category == i);
      s_.text(F::base, r.x + 14, r.y + 42, i == 0 ? "Samples" : i == 1 ? "Kits" : "Projects", kIvory);
      if (pad_choices) pad_badge(r, option_label(5 + i));
    }
    const Rect search = layout::browse_search();
    button(search);
    s_.text(F::body, 694, 132, ui.browse_query.empty() ? "Search library" : ui.browse_query, kGold, 372);
    if (pad_choices) pad_badge(search, option_label(8));
    for (int row = 0; row < layout::kListRows; ++row) {
      const int at = first + row;
      if (at >= static_cast<int>(b.samples.size())) break;
      const Rect r = layout::song_row(row);
      button(r, at == index);
      line(F::base, r.x + 18, r.y + 8, std::to_string(at + 1) + "  " + b.samples[at].name, kIvory, r.w - 74);
      if (pad_choices) pad_badge(r, option_label(row));
      line(F::caption,r.x+18,r.y+45,b.samples[at].detail.empty()?"Project sample":b.samples[at].detail,kMuted,r.w-36);
    }
    const int category = ui.browse_category;
    if (b.samples.empty())
      note(180, category == 0 ? "No samples match. Try another search or record in Sample."
                : category == 1 ? "No kits match. Try another search or add kits to the USB library."
                                : "No projects match. Try another search or add projects to the USB library.");
    if (category == 0) {
      note(580, "Hold SHIFT for list pads · SHIFT + PLAY auditions the selected sample");
      note(610, "Load to " + b.track_name[ui.track] + " · pad " + std::to_string(ui.browse_pad + 1));
    } else if (category == 1) {
      note(610, "Load kit onto " + b.track_name[ui.track]);
    } else {
      note(610, "Current song: " + b.name);
    }
  }

  void project_view(const Board& b) {
    using namespace gfx::css;
    if (!changed("project", b.name, layout::page())) return;
    s_.fill(layout::page(), kScreen);
    s_.text(F::heading, layout::kLeft, 118, "Project", kIvory);
    s_.text(F::base, layout::kLeft, 169, b.name, kGold, layout::kPageWidth - 2 * layout::kLeft);
    constexpr const char* names[] = {"New", "Open", "Save", "Save As"};
    constexpr const char* help[] = {"Start a blank project", "Browse saved projects",
                                    "Save the current project", "Save a named copy"};
    for (int i = 0; i < 4; ++i) {
      const Rect card = layout::project_card(i);
      button(card, false);
      pad_badge(card, option_label(i));
      s_.text(F::card, card.x + 20, card.y + 50, names[i], kIvory);
      s_.text(F::base, card.x + 20, card.y + 89, help[i], kMuted, card.w - 40);
    }
  }

  // ---- Menu: the pages, while MENU is held or latched ----
  void menu(const Ui& ui, const Board& b) {
    using namespace gfx::css;
    const std::string track = ui.track < b.tracks ? b.track_name[ui.track] : "No track";
    const bool sampling = ui.can_sample(b);
    if (!changed("menu", std::string(view_name(ui.view)) + "|" + track + (sampling ? "|s" : ""), layout::page())) return;
    s_.fill(layout::page(), kScreen);
    s_.text(F::heading, layout::kLeft, layout::kTop + 26, "Go to a page", kIvory);
    // Two rows: the selected track's pages, then the whole project's.
    line(F::label, layout::kLeft, layout::kMenuTop - 4, "TRACK \xC2\xB7 " + track, kGold, layout::kRight - layout::kLeft);
    line(F::label, layout::kLeft, layout::kMenuTop + 166, "PROJECT \xC2\xB7 every track", kMuted, layout::kRight - layout::kLeft);
    for (int i = 0; i < layout::kMenuPages; ++i) {
      const int pad = option_pad(i);
      View v = View::clips;
      menu_view(pad, v);
      const Rect r = layout::menu_card(i);
      button(r, v == ui.view);
      if (track_page(v)) s_.fill({r.x + 1, r.y + 1, 4, r.h - 2}, kGoldDeep);
      // Sample is only for tracks that hold samples (Kit, Sampler).
      const bool off = v == View::sample && !sampling;
      line(F::muted, r.x + 14, r.y + 14, "PAD " + std::to_string(pad + 1) + (off ? " \xC2\xB7 Kit, Sampler" : ""), kMuted,
           r.w - 28);
      std::string name = view_name(v);
      for (std::size_t c = 1; c < name.size(); ++c) name[c] = static_cast<char>(std::tolower(name[c]));
      line(F::card, r.x + 14, r.y + r.h - 14 - static_cast<int>(S::line(F::card)), name, off ? kMuted : kIvory);
    }
  }

  // ---- Sound: the selected track's sound ----
  void sound_view(const Ui& ui, const Board& b) {
    using namespace gfx::css;
    const int t = ui.track;
    const bool real = t < b.tracks;
    const Kind kind = real ? b.kind[t] : Kind::other;
    const bool unchosen = real && b.unchosen[t];
    const std::string what = !real ? "No track" : unchosen ? "No machine yet" : kind == Kind::synth ? "Synth \xC2\xB7 " + b.sound[t]
                             : real && b.slices[t]                  ? std::string("Sampler \xC2\xB7 slices")
                             : kind == Kind::sampler                ? std::string("Sampler \xC2\xB7 keys")
                             : kind == Kind::kit                    ? "Kit \xC2\xB7 16 pads"
                             : kind == Kind::midi                   ? "MIDI"
                                                                    : "Machine";
    const bool synth_page = real && !unchosen && kind == Kind::synth;
    if (changed("toolbar", (real ? b.track_name[t] : "") + "|" + what + (synth_page && ui.sound_controls ? "|c" : ""),
                {0, layout::kTop, layout::kPageWidth, 66})) {
      s_.fill({0, layout::kTop, layout::kPageWidth, 66}, kScreen);
      if (synth_page)  // the button switches between presets and controls
        toolbar("Sound \xC2\xB7 " + b.track_name[t] + " \xC2\xB7 " + b.sound[t], true,
                ui.sound_controls ? "Presets" : "Controls");
      else {
        toolbar("Sound \xC2\xB7 " + (real ? b.track_name[t] : std::string("no track")), true, "");
        s_.text_right(F::body, layout::kRight, layout::kTop + 40, what, kMuted);
      }
    }
    std::string key = what + "|" + std::to_string(ui.preset_page) + (ui.sound_controls ? "|controls" : "") + "|f" +
                      std::to_string(ui.sound_focus) + "|p" + std::to_string(ui.step_pad);
    if (synth_page && ui.sound_controls)
      for (const auto& v : ui.synth_fields) key += "|" + field_text(v);
    if (real && kind == Kind::kit)
      for (const auto& n : b.pad_name[t]) key += "|" + n;
    const Rect content{0, layout::kPadTop, layout::kPageWidth, layout::task(0).y - layout::kPadTop};
    if (!changed("sound", key, content)) return;
    s_.fill(content, kScreen);
    if (unchosen) {
      note(176, "This track has no machine yet. Choose one with pads 13–16 or touch.");
      const char* types[] = {"Kit", "Sampler", "Synth", "MIDI"};
      for (int i = 0; i < 4; ++i) {
        const Rect r = layout::machine_card(i);
        s_.box(r, 7, 1, kLine, kSurface2);
        line(F::muted, r.x + 14, r.y + 10, "PAD " + std::to_string(option_pad(i) + 1), kMuted);
        line(F::title, r.x + 14, r.y + r.h - 10 - static_cast<int>(S::line(F::title)), types[i], kIvory, r.w - 28);
      }
    } else if (synth_page && ui.sound_controls) {
      // Every control of the synth; touching one opens its value editor. The pads play.
      for (int i = 0; i < Ui::kSynthFields; ++i) {
        const Rect r = layout::cell(i % 4, i / 4);
        const auto& v = ui.synth_fields[i];
        s_.box(r, 7, 1, kLine, kSurface2);
        if (i == ui.sound_focus) s_.ring(r, 7, 3, kGold);  // the wheel's place; pressing it edits
        line(F::muted, r.x + 14, r.y + 10, v.name.empty() ? "\xE2\x80\x93" : v.name, kMuted, r.w - 28);
        line(F::title, r.x + 14, r.y + r.h - 10 - static_cast<int>(S::line(F::title)), field_text(v), kGold, r.w - 28);
      }
      note(548, "Touch a control to set it \xC2\xB7 the pads play \xC2\xB7 Presets returns to the sound list");
    } else if (real && kind == Kind::synth) {
      // The sixteen presets in the same order as the physical pads, with 13–16 on top.
      const int first = ui.preset_page * synth::kPresetsPerPage;
      for (int i = 0; i < synth::kPresetsPerPage; ++i) {
        const int pad = option_pad(i);
        const Rect r = layout::preset_card(i);
        const bool current = b.sound[t] == edit::presets()[first + i].name;
        s_.box(r, 7, 1, current ? kGold : kLine, current ? kSurface3 : kSurface2);
        if (current || first + i == ui.sound_focus) s_.ring(r, 7, current ? 3 : 2, current ? kGold : kIvory);
        line(F::muted, r.x + 14, r.y + 10, "PAD " + std::to_string(pad + 1), kMuted);
        line(F::title, r.x + 14, r.y + r.h - 10 - static_cast<int>(S::line(F::title)), edit::presets()[first + i].name,
             current ? kGold : kIvory, r.w - 28);
      }
      note(layout::kPresetPageLabel, "Bank " + std::to_string(ui.preset_page + 1) + "/" +
                                        std::to_string(synth::kPresetPages) + " · " + synth::preset_page_name(ui.preset_page));
    } else if (real && kind == Kind::kit) {
      for (int p = 0; p < 16; ++p) {
        const Rect r = layout::play_pad(p);
        s_.box(r, 7, 1, kLine, kSurface2);
        if (p == ui.step_pad) s_.ring(r, 7, 3, kGold);  // the wheel's pad; pressing it edits its sample
        line(F::muted, r.x + 14, r.y + 10, "PAD " + std::to_string(p + 1), kMuted);
        const std::string& n = b.pad_name[t][p];
        line(F::title, r.x + 14, r.y + r.h - 10 - static_cast<int>(S::line(F::title)), n.empty() ? "Pad " + std::to_string(p + 1) : n,
             kIvory, r.w - 28);
      }
    } else {
      note(200, real ? "The knobs set this track\xE2\x80\x99s machine \xC2\xB7 the pads play it" : "Choose a track (bank buttons)");
    }
  }

  void workbench(const Ui &ui, const Board &b, const edit::Row *row) {
    using namespace gfx::css;
    using edit::Field;
    auto control = [&](Rect r, const std::string &name, const std::string &value = "") {
      s_.box(r, 7, 1, kLine, kSurface2);
      s_.text(F::label, r.x + 12, r.y + 24, name, kMuted, r.w - 24);
      if (!value.empty())
        s_.text(F::title, r.x + 12, r.y + 54, value, kGold, r.w - 24);
    };
    auto labelled = [&](Rect r, const std::string& name, int option, const std::string& value = "") {
      control(r, name, value);
      if (option >= 0) pad_badge(r, option_label(option));
    };
    auto value_text = [](const edit::FieldValue &v) {
      char t[48];
      std::snprintf(t, sizeof t, "%g%s", v.value, v.value == 1 && v.unit == " steps" ? " step" : v.unit.c_str());
      if (v.field == Field::effect_sync) return std::string(delay_sync_name(v.value));
      if (v.field == Field::condition)
        return std::string(edit::condition_name(static_cast<int>(v.value)));
      return std::string(t);
    };
    std::string key = std::to_string(ui.revision) + "|" + std::to_string(ui.sound_pending) + "|" + ui.save_status +
                      "|" + std::to_string(overlay_epoch_);
    for (int i = 0; i < 5; ++i) key += workbench_task_available(ui, b, i) ? "1" : "0";
    for (const auto &v : ui.touch_fields)
      key += "|" + value_text(v);
    if (changed("workbench", key, {0, 646, layout::kPageWidth, 96})) {
      s_.fill({0, 646, layout::kPageWidth, 96}, kScreen);
      for (int i = 0; i < 5; ++i)
        if (const std::string name = task_name(ui, b, i); !name.empty())
          labelled(layout::task(i), name,
                   ui.view == View::browse ? (ui.shift || ui.browse_category != 0 ? 9 + i : -1)
                                          : ui.task_pads_active() ? i : -1,
                  ui.view == View::clips && i == 0   ? (ui.launch_grid == 0    ? "Immediate"
                                                        : ui.launch_grid == 4  ? "Beat"
                                                        : ui.launch_grid == 16 ? "Bar"
                                                        : ui.launch_grid == 32 ? "2 bars"
                                                                               : "4 bars")
                  : ui.view == View::steps && i == 4 ? std::to_string(static_cast<int>(ui.record_quantize * 100)) + "%"
                                                     : "");
      if (ui.view != View::project && ui.view != View::browse && !ui.task_pads_active())
        s_.text(F::caption, 24, 732, "Hold Shift + Menu for button pads", kMuted);
    }
    if (ui.view == View::steps && ui.clip_length(b) > 0 &&
        changed("expression", key, {0, ui.melodic(b) ? 524 : 450, layout::kPageWidth, ui.melodic(b) ? 122 : 196})) {
      s_.fill({0, ui.melodic(b) ? 524 : 450, layout::kPageWidth, ui.melodic(b) ? 122 : 196}, kScreen);
      if (!ui.melodic(b) && row)
        for (int i = 0; i < 16; ++i) {
          const int st = ui.page * 16 + i;
          const int height = static_cast<int>(row->velocity[st] * 48);
          s_.fill({24 + i * 68, 510 - height, 48, height}, kGold);
        }
      for (int i = 0; i < 4; ++i) {
        const auto &v = ui.touch_fields[i];
        control(layout::inspector(i), v.name.empty() ? "Select a hit" : v.name, v.available ? value_text(v) : "—");
      }
      s_.text(F::label, 24, 624, "Touch selects; Draw toggles · Shift + pad chooses a note or sound", kMuted, 1092);
    }
    if (ui.effects_open && changed("effects",
                                   key + ui.effect_names[0] + ui.effect_names[1] + std::to_string(ui.effect_slot) +
                                       std::to_string(ui.effect_location),
                                   layout::page())) {
      s_.fill(layout::page(), kScreen);
      s_.text(F::heading, 24, 132,
              ui.effect_location < 0    ? "Track inserts"
              : ui.effect_location == 0 ? "Return A inserts"
                                        : "Return B inserts",
              kIvory);
      for (int i = 0; i < 2; ++i)
        labelled(layout::effect_slot(i),
                 "Slot " + std::to_string(i + 1) + (ui.effect_slot == i ? " · selected" : ""),
                 ui.shift ? -1 : i, ui.effect_names[i]);
      for (int i = 0; i < 4; ++i)
        if (!ui.effect_fields[i].name.empty())
          labelled(layout::effect_field(i), ui.effect_fields[i].name, ui.shift ? i : -1, value_text(ui.effect_fields[i]));
      const char *kinds[] = {"EQ", "Filter", "Delay", "Reverb", "Distortion", "Compressor"};
      for (int i = 0; i < 6; ++i)
        labelled(layout::effect_choice(i), kinds[i], ui.shift && i < 2 ? -1 : 2 + i);
      const char *commands[] = {"Remove", "Bypass / enable", "Track", "Returns", "Close"};
      for (int i = 0; i < 5; ++i)
        labelled(layout::task(i), commands[i], 8 + i);
      s_.text(F::caption, 24, 732, "Hold Shift for parameter pads", kMuted);
    }
    if (ui.machine_picker && changed("picker", key, layout::page())) {
      s_.fill(layout::page(), kScreen);
      s_.text(F::heading, 24, 132, "Choose track instrument · pads 13–16", kIvory);
      const char *types[] = {"Kit", "Sampler", "Synth", "MIDI"};
      for (int i = 0; i < 4; ++i)
        labelled(layout::machine_card(i), types[i], i);
    }
    if (ui.health_open || ui.help_open) {
      if (changed("help", key, layout::page())) {
        s_.fill(layout::page(), kSurface);
        s_.text(F::heading, 40, 140, ui.health_open ? "System status" : "Current controls", kIvory);
        if (ui.health_open) {
          const char *labels[] = {"Audio", "Controller", "Startup", "Input", "Bridge"};
          for (int i = 0; i < 5; ++i)
            s_.text(F::base, 40, 210 + i * 66,
                    std::string(labels[i]) + ": " +
                        (lights[i] == 1   ? "Ready"
                         : lights[i] == 2 ? "Fault"
                         : lights[i] == 3 ? "Waiting"
                                          : "Off"),
                    lights[i] == 2 ? kRubySoft : kIvory);
        } else {
          const char *lines[] = {
              "Main: Clips · Shift + Main: Play · 16 Level: Steps", "A–D: tracks 1–4 · Shift + A–D: tracks 5–8",
              "Touch Select inspects; Draw toggles. Erase deletes.", "Q-Link cycles Step / New steps / Track / Sound.",
              "Copy then a slot duplicates. Undo restores an edit."};
          for (int i = 0; i < 5; ++i)
            s_.text(F::base, 40, 210 + i * 66, lines[i], kIvory, 1050);
        }
        s_.text(F::body, 40, 650, "Tap or press pad 13 to return", kGold);
      }
    }
    if (ui.editor_open && changed("editor", key + ui.editor_text + value_text(ui.editor), layout::page())) {
      const bool wide = ui.editor.field == Field::clip_length;
      s_.fill(layout::page(), kScreen);
      const auto options = choices(ui, b);
      if (!options.empty()) {
        s_.text(F::heading, 42, 142, ui.editor.field == Field::scale ? "Playing scale" : ui.editor.name, kIvory, 1050);
        for (int i = 0; i < static_cast<int>(options.size()); ++i) {
          const auto r = choice_rect(i);
          labelled(r, options[i].name, i);
          if (options[i].value == ui.editor.value)
            s_.ring(r, 7, 2, kGold);
        }
        labelled(layout::dialog_cancel(wide), "Cancel", options.size() < 16 ? options.size() : -1);
        if (options.size() == 16) pad_badge(layout::dialog_cancel(wide), "Shift P13");
        return;
      }
      s_.box(wide ? Rect{24, 90, 1092, 620} : Rect{180, 110, 800, 590}, 12, 2, kGold, kSurface);
      s_.text(F::heading, wide ? 48 : 210, wide ? 140 : 160, ui.editor.name, kIvory, wide ? 1044 : 740);
      s_.text(F::mono_large, wide ? 48 : 296, wide ? 226 : 246, ui.editor_text.empty() ? value_text(ui.editor) : ui.editor_text, kGold, wide ? 1044 : 640);
      const char *keys[] = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "Delete", "0", "."};
      const auto numeric_button = [&](Rect r, const std::string& text, int pad = -1) {
        if (!wide) return labelled(r, text, pad);
        button(r);
        if (pad >= 0) pad_badge(r, option_label(pad));
        s_.text_centre(F::title, r.x + r.w / 2, S::baseline(F::title, r.y, r.h), text, kIvory);
      };
      for (int i = 0; i < 12; ++i)
        numeric_button(layout::dialog_key(i, wide), keys[i], ui.shift && i < 2 ? -1 : i);
      numeric_button(layout::value_minus(wide), "–", ui.shift ? 0 : -1);
      numeric_button(layout::value_plus(wide), "+", ui.shift ? 1 : -1);
      numeric_button(layout::dialog_reset(wide), "Reset", 12);
      numeric_button(layout::dialog_cancel(wide), "Cancel", 13);
      numeric_button(layout::dialog_apply(wide), "Apply", 14);
      if (!wide) {
        s_.text(F::label, 744, 414, "Wheel: fine steps", kMuted, 210);
        s_.text(F::label, 744, 456, ui.editor.field == Field::tempo ? "Live preview" : "Apply is one Undo", kMuted, 210);
      }
    }
    if (ui.rename_kind && changed("rename", key + ui.rename_text + (ui.rename_selected ? "selected" : ""), layout::page())) {
      s_.fill(layout::page(), kSurface);
      if (ui.rename_kind == Ui::kNewProject) {
        s_.text(F::heading, 200, 160, "Start a new project?", kIvory);
        s_.text(F::base, 200, 258, "Save a named copy to keep this project in Browse.", kMuted, 850);
        labelled(layout::dialog_cancel(), "Cancel", 0);
        labelled(layout::dialog_apply(), "New project", 1);
        return;
      }
      const char* title = ui.rename_kind == 4 ? "Search library" : ui.rename_kind == Ui::kSaveAs ? "Save As" : "Rename";
      s_.text(F::heading, layout::kLeft, 115, title, kIvory);
      const Rect name_box{layout::kLeft, 132, layout::kRight - layout::kLeft, 62};
      s_.box(name_box, 7, 1, ui.rename_selected ? kGold : kLine, ui.rename_selected ? kGoldDeep : kScreen);
      const std::string text = ui.rename_text.empty() ? (ui.rename_kind == 4 ? "Search" : "File name") : ui.rename_text;
      s_.text(F::title, name_box.x + 16, S::baseline(F::title, name_box.y, name_box.h), text,
              ui.rename_text.empty() ? kMuted : kGold, name_box.w - 32);
      auto key_cap = [&](Rect r, const std::string& name, int pad = -1, bool primary = false) {
        button(r, primary);
        if (pad >= 0) pad_badge(r, option_label(pad));
        s_.text_centre(F::title, r.x + r.w / 2, S::baseline(F::title, r.y, r.h), name, primary ? kGold : kIvory);
      };
      for (int i = 0; i <= layout::kNameDelete; ++i) {
        const std::string name = i == layout::kNameDelete ? "Delete"
                                 : i == layout::kNameSpace ? "Space"
                                                          : std::string(1, layout::kNameCharacters[i]);
        key_cap(layout::name_key(i), name, i == layout::kNameDelete ? 2 : -1);
      }
      key_cap(layout::name_cancel(false), "Cancel", 0);
      key_cap(layout::name_apply(false), ui.rename_kind == Ui::kSaveAs ? "Save" : "Apply", 1, true);
    }
  }

  gfx::Surface s_;
  std::vector<Rect> dirty_;
  std::vector<std::pair<std::string, std::string>> keys_;
  bool cleared_ = false;
  int mode_ = -1;
  std::uint64_t overlay_epoch_=0;
};

}  // namespace xmp::live::ui
