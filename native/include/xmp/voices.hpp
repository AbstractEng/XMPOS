#pragma once
// XMP's engine set up from a project, in C++: the C++ port of packages/core
// instruments.ts prepareInstruments and editedPcm (the instrument palette a
// project needs) and of the VoiceRack binding (laying the palette out for the
// engine, rack.hpp, and validating every command). With this, offline renders
// (render.hpp) need no TypeScript.
//
// SDK machines are JavaScript and do not run here: a track playing one is
// silent (the browser runs them beside the engine).
#include "xmp/files.hpp"
#include "xmp/rack.hpp"

namespace xmp::voices {

using json::Value;

struct Take {
  Vec<float> pcm;
  double rate = 48000;
};
struct Layer {
  double up_to = 1;
  Vec<Take> takes;
};
struct Pad {
  Vec<float> pcm;
  double rate = 48000;
  Str mode;
  int32_t root = 60, choke = 0;
  Vec<Layer> layers;  // a multi-sampled pad's velocity layers, softest first (format 8)
};
struct Track {
  Str id;
  bool muted = false;
  Value machine;
  double gain = 0;
  int32_t pad_base = 0;  // where the track's 16 pads start in the palette (0: the project's)
};
// InstrumentPalette
struct Palette {
  bool has_master = false, has_base = false;
  double sequence_master = 1;
  Vec<json::Member> parameter_base;  // id -> value, registry order
  Value mix;                         // null: none
  double mix_bpm = 120;
  bool has_delay = false;
  double delay_seconds = 0, delay_feedback = 0, delay_wet = 0;
  Value delay_sends = Value::new_object();
  Vec<Pad> pads;  // the project's 16 pads, then 16 for each track with its own kit
  Vec<Track> tracks;
};

namespace detail {
using project::detail::at;
using project::detail::list;
using project::detail::num;
using project::detail::str;
}  // namespace detail

// editedPcm: a pad's sound (its slice, reversed and normalized as edited), in float32.
inline bool edited_pcm(const Value& project, int32_t pad_index, Vec<float>& out, Str& error,
                       const Value* track = nullptr) {
  using namespace detail;
  const auto& pads = project::detail::track_pads(project, track);
  const Value* pad = pad_index >= 0 && pad_index < pads.size() ? &pads[pad_index] : nullptr;
  const Value* sample = nullptr;
  if (pad)
    for (const auto& s : list(project, "samples"))
      if (str(s, "id") == str(*pad, "sampleId")) sample = &s;
  if (!pad || !sample) return error = "Unknown pad or sample", false;
  const auto& pcm = list(*sample, "pcm");
  const Value* slice = pad->get("slice");
  const double start = slice ? num(*slice, "start") : 0, end = slice ? num(*slice, "end") : pcm.size();
  if (start >= end || end > pcm.size()) return error = "Invalid sample boundaries", false;
  out.clear();
  for (int32_t i = static_cast<int32_t>(start); i < static_cast<int32_t>(end); ++i)
    out.push(static_cast<float>(pcm[i].as_number()));
  const Value* edit = pad->get("edit");
  if (edit && at(*edit, "reverse").as_bool())
    for (int32_t i = 0, k = out.size() - 1; i < k; ++i, --k) {
      const float t = out[i];
      out[i] = out[k], out[k] = t;
    }
  if (edit && at(*edit, "normalize").as_bool()) {
    double peak = 0;
    for (const float v : out) peak = fmax(peak, fabs(static_cast<double>(v)));
    if (peak > 0)
      for (auto& v : out) v = static_cast<float>(static_cast<double>(v) / peak);
  }
  return true;
}

// editedLayers: a multi-sampled pad's layers, each take its whole sample,
// reversed and normalized as the pad is edited.
inline bool edited_layers(const Value& project, const Value& pad, Vec<Layer>& out, Str& error) {
  using namespace detail;
  out.clear();
  const Value* layers = pad.get("layers");
  if (!layers) return true;
  const Value* edit = pad.get("edit");
  const bool reverse = edit && at(*edit, "reverse").as_bool(), normalize = edit && at(*edit, "normalize").as_bool();
  for (const auto& l : layers->items()) {
    Layer layer;
    layer.up_to = num(l, "upTo");
    for (const auto& id : list(l, "samples")) {
      const Value* sample = nullptr;
      for (const auto& s : list(project, "samples"))
        if (str(s, "id") == id.as_string()) sample = &s;
      if (!sample) return error = "Unknown pad or sample", false;
      Take take;
      take.rate = num(*sample, "sampleRate");
      for (const auto& v : list(*sample, "pcm")) take.pcm.push(static_cast<float>(v.as_number()));
      if (reverse)
        for (int32_t i = 0, k = take.pcm.size() - 1; i < k; ++i, --k) {
          const float t = take.pcm[i];
          take.pcm[i] = take.pcm[k], take.pcm[k] = t;
        }
      if (normalize) {
        double peak = 0;
        for (const float v : take.pcm) peak = fmax(peak, fabs(static_cast<double>(v)));
        if (peak > 0)
          for (auto& v : take.pcm) v = static_cast<float>(static_cast<double>(v) / peak);
      }
      layer.takes.push(xmp::move(take));
    }
    out.push(xmp::move(layer));
  }
  return true;
}

// prepareInstruments
inline bool prepare_instruments(const Value& project, Palette& out, Str& error) {
  using namespace detail;
  Value checked;
  if (!project::canonical(project, checked, error)) return false;
  out = Palette{};
  bool sequenced = false;
  for (const auto& t : list(project, "tracks"))
    for (const auto& c : list(t, "clips")) sequenced = sequenced || c.get("sequence");
  const Value* mix = project.get("mix");
  const Value* perf = project.get("performance");
  if (mix || perf || sequenced) {
    out.has_master = out.has_base = true;
    if (!parameters::value(project, Str("master.gain"), out.sequence_master, error)) return false;
    for (const auto& d : parameters::registry(project)) {
      double v = 0;
      if (!parameters::value(project, d.id, v, error)) return false;
      bool seen = false;
      for (auto& m : out.parameter_base)
        if (m.key == d.id) m.value = Value::of(v), seen = true;
      if (!seen) out.parameter_base.push(json::Member{d.id, Value::of(v)});
    }
  }
  if (mix) out.mix = *mix, out.mix_bpm = num(project, "bpm");
  if (perf && !mix) {
    const Value& d = at(*perf, "delay");
    out.has_delay = true;
    out.delay_seconds = (num(d, "steps") * 60) / num(project, "bpm") / 4;
    out.delay_feedback = num(d, "feedback"), out.delay_wet = num(d, "wet");
    out.delay_sends = at(d, "sends");
  }
  Vec<const Value*> owners;  // nullptr: the project's pads
  owners.push(nullptr);
  for (const auto& t : list(project, "tracks"))
    if (t.get("pads")) owners.push(&t);
  for (const Value* owner : owners) {
  const auto& pads = project::detail::track_pads(project, owner);
  for (int32_t i = 0; i < pads.size(); ++i) {
    Pad p;
    if (!edited_pcm(project, i, p.pcm, error, owner)) return false;
    p.rate = 48000;
    for (const auto& s : list(project, "samples"))
      if (str(s, "id") == str(pads[i], "sampleId")) p.rate = num(s, "sampleRate");
    if (const Value* pb = pads[i].get("playback"))
      p.mode = str(*pb, "mode"), p.root = static_cast<int32_t>(num(*pb, "rootNote")),
      p.choke = static_cast<int32_t>(num(*pb, "chokeGroup"));
    else
      p.mode = "one-shot";
    if (!edited_layers(project, pads[i], p.layers, error)) return false;
    out.pads.push(xmp::move(p));
  }
  }
  for (const auto& t : list(project, "tracks")) {
    Track track;
    track.id = str(t, "id");
    for (int32_t k = 1; k < owners.size(); ++k)
      if (owners[k] == &t) track.pad_base = 16 * k;
    track.muted = at(t, "muted").as_bool();
    if (const Value* m = t.get("machine"))
      track.machine = *m;
    else if (!machine::machines().instantiate(Str("xmp.sampler"), track.machine, error))
      return false;
    if (track.muted)
      track.gain = 0;
    else {
      double g = 0, e = 0;
      if (!parameters::value(project, Str("track.") + track.id + ".gain", g, error) ||
          !parameters::value(project, Str("track.") + track.id + ".effect.gain", e, error))
        return false;
      track.gain = g * e * 2;
    }
    out.tracks.push(xmp::move(track));
  }
  return true;
}

struct MidiEvent {  // machines.ts MidiEvent
  bool on = false;
  double id = 0, velocity = 0;
  int32_t note = 0, channel = 1;
};

// VoiceRack: the engine laid out from a palette, with the TypeScript's checks.
class Rack {
 public:
  Vec<MidiEvent> midi;  // everything the engine emitted, in order
  int32_t midi_budget = 16384;
  Str error;            // the first failure of a command that has no return value

  explicit Rack(int32_t rate = 48000, const Rack* previous = nullptr) : rate_(rate), engine_(new (checked_alloc(sizeof(rack::Rack))) rack::Rack(rate)) {
    // Stable numeric identities keep already queued commands valid across a swap.
    if (previous) uids_ = previous->uids_, keys_ = previous->keys_, parameter_ids_ = previous->parameter_ids_;
    for (int i = 0; i < parameter_ids_.size(); ++i) {
      const auto& id = parameter_ids_[i];
      if (id.size() >= 7 && !strcmp(id.c_str() + id.size() - 7, ".bypass")) engine_->set_bypass_flag(i, true);
    }
    engine_->master_index_ = index(Str("master.gain"));
  }
  ~Rack() {
    engine_->~BasicRack();
    free(engine_);
  }
  Rack(const Rack&) = delete;
  Rack& operator=(const Rack&) = delete;

  bool configure(const Palette& palette, Str& err) {
    using namespace detail;
    const auto& m = machine::machines();
    if (palette.tracks.size() > 8 || palette.pads.size() > 16 * 9) return err = "Invalid instrument palette", false;
    for (const auto& t : palette.tracks)
      if (t.pad_base < 0 || (t.pad_base && t.pad_base + 16 > palette.pads.size()))
        return err = "Invalid instrument palette", false;
    Vec<const machine::Definition*> definitions;
    for (const auto& t : palette.tracks) definitions.push(m.get(&t.machine));
    // midiDestination over the palette's tracks.
    Vec<int32_t> routes;
    for (int32_t s = 0; s < palette.tracks.size(); ++s) {
      int32_t route = -1;
      if (definitions[s] && definitions[s]->id == "xmp.midi") {
        const Value* dest = at(palette.tracks[s].machine, "state").get("destination");
        for (int32_t t = 0; dest && dest->is_string() && t < palette.tracks.size(); ++t) {
          if (palette.tracks[t].id == palette.tracks[s].id) continue;
          const machine::Definition* d = definitions[t];
          if (d && (d->id == "xmp.sampler" || d->id == "xmp.subtractive") && palette.tracks[t].id == dest->as_string()) {
            route = t;
            break;
          }
        }
      }
      routes.push(route);
    }
    Str identity;
    if (!palette.mix.is_null()) {
      Value pair = Value::new_array(), ids = Value::new_array();
      pair.push(palette.mix);
      for (const auto& t : palette.tracks) ids.push(Value::of(t.id));
      pair.push(xmp::move(ids));
      // JSON.stringify([palette.mix, ids]): the mix as {spec, bpm}.
      Value mix = Value::new_object();
      mix.set("spec", palette.mix), mix.set("bpm", Value::of(palette.mix_bpm));
      pair.items()[0] = xmp::move(mix);
      identity = json::stringify(pair);
    }
    const int32_t mix_mode = identity == mix_identity_ ? 1 : !palette.mix.is_null() ? 2 : 0;
    if (mix_mode == 2) {
      bool unique = true;
      for (int32_t i = 0; i < palette.tracks.size(); ++i)
        for (int32_t k = i + 1; k < palette.tracks.size(); ++k) unique = unique && palette.tracks[i].id != palette.tracks[k].id;
      if (!isfinite(palette.mix_bpm) || palette.mix_bpm < 30 || palette.mix_bpm > 300 || !unique)
        return err = "Invalid mixer preparation", false;
    }
    double delay_frames = 0;
    if (palette.has_delay) {
      delay_frames = fmax(1, edit::detail::js_round(palette.delay_seconds * rate_));
      if (delay_frames != delay_frames_ &&
          (!isfinite(palette.delay_seconds) || palette.delay_seconds <= 0 || palette.delay_seconds > 4 ||
           !isfinite(palette.delay_feedback) || palette.delay_feedback < 0 || palette.delay_feedback > 0.75 ||
           !isfinite(palette.delay_wet) || palette.delay_wet < 0 || palette.delay_wet > 1))
        return err = "Invalid preview delay", false;
    }
    rack::Rack& e = *engine_;
    sources_.clear();
    e.stage_begin(palette.tracks.size(), palette.pads.size());
    for (int32_t i = 0; i < palette.tracks.size(); ++i) {
      const Track& track = palette.tracks[i];
      const machine::Definition* d = definitions[i];
      const int32_t kind = !d ? rack::none
                           : d->id == "xmp.sampler"     ? rack::sampler
                           : d->id == "xmp.subtractive" ? rack::subtractive
                           : d->id == "xmp.midi"        ? rack::midi
                                                        : rack::none;
      rack::Track* t = e.stage_track(i);
      if (!t) return err = "Invalid instrument palette", false;
      const Value& state = at(track.machine, "state");
      t->uid = uids_.uid(track.id);
      t->kind = kind;
      t->key = key(track.machine);
      t->route = routes[i] < 0 ? -1 : uids_.uid(palette.tracks[routes[i]].id);
      t->pad_base = track.pad_base;
      t->base_midi = d && d->base == "midi";
      t->muted = track.muted;
      t->silent_route = d && d->id == "xmp.midi" && state.get("destination") && routes[i] < 0;
      t->midi_machine = str(track.machine, "id") == "xmp.midi";
      t->custom_audio = false;
      t->gain = track.gain;
      const Value* channel = state.get("channel");
      t->channel_state = channel && channel->is_number() ? channel->as_number() : 1;
      const Value* send = palette.delay_sends.get(track.id.c_str());
      t->delay_send = palette.has_delay && send ? send->as_number() : 0;
      t->gain_index = index(Str("track.") + track.id + ".gain");
      t->effect_gain_index = index(Str("track.") + track.id + ".effect.gain");
      t->channel_index = index(Str("track.") + track.id + ".machine.xmp.midi.v1.channel");
      if (d && d->id == "xmp.subtractive") {
        static const char* kFields[rack::kPatchFields] = {"attack",    "decay",     "sustain",  "release",
                                                          "cutoff",    "resonance", "env-amount", "env-decay",
                                                          "detune",    "glide"};
        const Str& osc = str(state, "oscillator");
        t->patch.oscillator = osc == "sine" ? rack::sine : osc == "square" ? rack::square : rack::saw;
        rack::Patch defaults{};
        for (int32_t p = 0; p < rack::kPatchFields; ++p) {
          const Value* field = state.get(kFields[p]);
          rack::patch_field(t->patch, p) =
              field && field->is_number() ? field->as_number() : rack::patch_field(defaults, p);
          t->patch_index[p] =
              index(Str("track.") + track.id + ".machine." + d->id + ".v" + int_text(d->version) + "." + kFields[p]);
        }
      }
    }
    for (int32_t i = 0; i < palette.pads.size(); ++i) {
      const Pad& pad = palette.pads[i];
      const int32_t mode = pad.mode == "gate" ? rack::gate : pad.mode == "loop" ? rack::loop
                           : pad.mode == "chromatic"                                 ? rack::chromatic
                                                                                     : rack::one_shot;
      float* at = e.stage_pad(i, static_cast<uint32_t>(pad.pcm.size()), pad.rate, mode, pad.root, pad.choke);
      if (!at) return err = "Pad sound exceeds the engine budget", false;
      for (int32_t k = 0; k < pad.pcm.size(); ++k) at[k] = pad.pcm[k];
      remember(at, pad.pcm.size());
      for (int32_t l = 0; l < pad.layers.size(); ++l)
        for (int32_t t = 0; t < pad.layers[l].takes.size(); ++t) {
          const Take& take = pad.layers[l].takes[t];
          float* buffer = e.stage_pad_take(i, l, t, static_cast<uint32_t>(take.pcm.size()), take.rate,
                                           pad.layers[l].up_to);
          if (!buffer) return err = "Pad sound exceeds the engine budget", false;
          for (int32_t k = 0; k < take.pcm.size(); ++k) buffer[k] = take.pcm[k];
          remember(buffer, take.pcm.size());
        }
    }
    e.stage_delay(palette.has_delay, palette.delay_seconds, palette.delay_feedback, palette.delay_wet);
    for (const auto& b : palette.parameter_base) e.stage_base(index(b.key), b.value.as_number());
    e.stage_master(palette.has_master ? palette.sequence_master : 1);
    if (!e.stage_mixer(mix_mode, palette.mix.is_null() ? 120 : palette.mix_bpm) && mix_mode == 2)
      return err = "Mixer exceeds the engine budget", false;
    if (mix_mode == 2 && !stage_mix(palette, err)) return false;
    e.commit();
    if (!drain(err)) return false;
    mix_identity_ = identity;
    delay_frames_ = delay_frames;
    return true;
  }

  // applyParameters
  bool apply_parameters(const Value& values, Str& err) {
    if (values.members().size() > 512) return err = "Invalid parameter command", false;
    for (const auto& m : values.members()) {
      const double v = m.value.is_number() ? m.value.as_number() : NAN;
      if (!isfinite(v) || v < 0 || v > 1) return err = "Invalid parameter command", false;
    }
    Vec<int32_t> indices;
    for (const auto& m : values.members()) indices.push(index(m.key));
    engine_->targets_begin();
    for (int32_t i = 0; i < indices.size(); ++i) engine_->targets_add(indices[i], values.members()[i].value.as_number());
    engine_->targets_commit();
    return true;
  }
  // setBlockedTracks
  bool set_blocked_tracks(const Vec<Str>& ids, Str& err) {
    if (ids.size() > 8) return err = "Invalid blocked track list", false;
    for (const auto& id : ids)
      if (!schema::is_id(id)) return err = "Invalid blocked track list", false;
    engine_->blocked_begin();
    Vec<Str> seen;
    for (const auto& id : ids) {
      bool dup = false;
      for (const auto& s : seen) dup = dup || s == id;
      if (dup) continue;
      seen.push(id);
      engine_->blocked_add(uids_.uid(id));
    }
    engine_->blocked_commit();
    return drain(err);
  }
  // noteOn: true when the engine played it.
  bool note_on(double id, double pad, double track, double note, double velocity, double duration, bool& played,
               Str& err) {
    const auto integer = [](double v) { return v == floor(v) && isfinite(v); };
    if (!(integer(id) && fabs(id) <= 9007199254740991.0) || id < 0 || !integer(pad) || pad < 0 || pad > 15 ||
        !integer(note) || note < 0 || note > 127 || !isfinite(velocity) || velocity < 0 || velocity > 1 ||
        !integer(duration) || duration < 0 || duration > rate_ * 32.0)
      return err = "Invalid note", false;
    played = false;
    if (!integer(track)) return true;
    const int32_t result = engine_->note_on(id, static_cast<int32_t>(pad), static_cast<int32_t>(track),
                                            static_cast<int32_t>(note), velocity, static_cast<int64_t>(duration));
    played = result == 1;
    return drain(err);
  }
  bool note_off(double id, Str& err) {
    engine_->note_off(id);
    return drain(err);
  }
  bool release_track(const Str& id, Str& err) {
    engine_->release_track(uids_.uid(id));
    return drain(err);
  }
  bool panic(Str& err) {
    engine_->panic();
    return drain(err);
  }
  bool clock(double step, double bpm, Str& err) {
    if (!engine_->has_mixer()) return true;
    if (!isfinite(step) || step < 0 || step > 1000100 || !isfinite(bpm) || bpm < 30 || bpm > 300)
      return err = "Invalid effect clock", false;
    engine_->clock(step, bpm);
    return true;
  }
  // process: `frames` (up to 4096) into the engine's left and right buffers.
  bool process(int32_t frames, Str& err) {
    if (frames < 0 || frames > rack::kBlock) return err = "Invalid processing block", false;
    engine_->process(frames);
    return drain(err);
  }
  // ---- for the Live's real-time player (live_player.hpp) ----
  // The engine itself: only its allocation-free calls belong on the audio thread.
  rack::Rack& engine() { return *engine_; }
  bool prepare_continuation(const Rack& old) {
    if (mix_identity_ != old.mix_identity_ || keys_.size() != old.keys_.size() ||
        parameter_ids_.size() != old.parameter_ids_.size() || uids_.names.size() != old.uids_.names.size()) return false;
    for (int i = 0; i < keys_.size(); ++i) if (keys_[i] != old.keys_[i]) return false;
    for (int i = 0; i < parameter_ids_.size(); ++i) if (parameter_ids_[i] != old.parameter_ids_[i]) return false;
    for (int i = 0; i < uids_.names.size(); ++i) if (uids_.names[i] != old.uids_.names[i]) return false;
    return engine_->prepare_continuation(*old.engine_);
  }
  void continue_from(Rack& old) noexcept { engine_->continue_from(*old.engine_); }

  // Control thread: exact PCM matching and history matching, never in process().
  void prepare_handover(const Rack& old) {
    for (const auto& source : old.sources_) for (const auto& next : sources_)
      if (source.hash == next.hash && source.frames == next.frames &&
          !memcmp(source.pcm, next.pcm, source.frames * sizeof(float))) {
        bindings_.push({source.pcm, next.pcm}); break;
      }
    qsort(bindings_.begin(), bindings_.size(), sizeof(rack::SampleBinding), [](const void* a, const void* b) {
      const auto x = reinterpret_cast<uintptr_t>(static_cast<const rack::SampleBinding*>(a)->from);
      const auto y = reinterpret_cast<uintptr_t>(static_cast<const rack::SampleBinding*>(b)->from);
      return (x > y) - (x < y);
    });
    for (int i = 0; i < rack::kTracks + 2; ++i) {
      chains_[i] = -1;
      for (int j = 0; j < rack::kTracks + 2; ++j)
        if (!chain_keys_[i].empty() && chain_keys_[i] == old.chain_keys_[j]) { chains_[i] = j; break; }
    }
  }
  void inherit(Rack& old) noexcept { engine_->inherit(*old.engine_, bindings_.begin(), bindings_.size(), chains_); }
  // Look-ups that never add an entry (-1: unknown), safe while the audio thread runs.
  int32_t uid_of(const Str& id) const {
    for (int32_t i = 0; i < uids_.names.size(); ++i)
      if (uids_.names[i] == id) return i;
    return -1;
  }
  int32_t index_of(const Str& id) const {
    for (int32_t i = 0; i < parameter_ids_.size(); ++i)
      if (parameter_ids_[i] == id) return i;
    return -1;
  }
  // Registers parameter IDs (and track IDs) before playback, so look-ups never add.
  void register_parameter(const Str& id) { index(id); }
  void register_track(const Str& id) { uids_.uid(id); }
  const float* left() const { return engine_->left; }
  const float* right() const { return engine_->right; }
  double refused() const { return engine_->refused; }
  // The master meter since the last read (null without a mixer).
  Value meter() {
    if (!engine_->meter(true)) return Value();
    Value m = Value::new_object();
    m.set("left", Value::of(engine_->meter_out[0])), m.set("right", Value::of(engine_->meter_out[1]));
    m.set("rms", Value::of(engine_->meter_out[2])), m.set("clipped", Value::of(engine_->meter_out[3]));
    return m;
  }

 private:
  struct Source { float* pcm; int32_t frames; uint64_t hash; };
  void remember(float* pcm, int32_t frames) {
    uint64_t hash = 1469598103934665603ULL;
    const auto* bytes = reinterpret_cast<const unsigned char*>(pcm);
    for (int32_t i = 0; i < frames * static_cast<int32_t>(sizeof(float)); ++i) hash = (hash ^ bytes[i]) * 1099511628211ULL;
    sources_.push({pcm, frames, hash});
  }
  int32_t index(const Str& id) {
    for (int32_t i = 0; i < parameter_ids_.size(); ++i)
      if (parameter_ids_[i] == id) return i;
    const int32_t n = parameter_ids_.size();
    parameter_ids_.push(id);
    const size_t len = id.size();
    if (len >= 7 && strcmp(id.c_str() + len - 7, ".bypass") == 0) engine_->set_bypass_flag(n, true);
    return n;
  }
  int32_t key(const Value& machine) {
    const Str text = detail::str(machine, "id") + "|" + detail::str(machine, "base") + "|" +
                     json::number_text(detail::num(machine, "version"));
    for (int32_t i = 0; i < keys_.size(); ++i)
      if (keys_[i] == text) return i + 1;
    keys_.push(text);
    return keys_.size();
  }
  bool drain(Str& err) {
    rack::Rack& e = *engine_;
    if (e.midi_overflow) {
      e.midi_count = 0, e.midi_overflow = 0;
      return err = "MIDI event buffer overflow", false;
    }
    for (int32_t i = 0; i < e.midi_count; ++i) {
      if (midi.size() >= midi_budget) {
        e.midi_count = 0;
        return err = "MIDI trace budget exceeded", false;
      }
      const auto& x = e.midi[i];
      midi.push(MidiEvent{x.kind != 0, x.id, x.velocity, x.note, x.channel});
    }
    e.midi_count = 0;
    return true;
  }
  bool stage_mix(const Palette& palette, Str& err) {
    using namespace detail;
    rack::Rack& e = *engine_;
    const Value& mix = palette.mix;
    for (const auto& t : list(mix, "tempos"))
      if (!e.stage_tempo(num(t, "step"), num(t, "bpm"))) return err = "Mixer exceeds the engine budget", false;
    auto effects = [&](int32_t chain, const Vec<Value>& list_, const Str& prefix) {
      Value identity = Value::new_array();
      for (const auto& effect : list_) identity.push(effect);
      chain_keys_[chain] = prefix + "|" + json::stringify(identity);
      for (const auto& effect : list_) {
        const Str& kind = str(effect, "kind");
        static const char* kKinds[] = {"eq", "filter", "delay", "reverb", "distortion", "compressor"};
        static const char* kSlots[6][3] = {{"tone", "gain", nullptr},   {"cutoff", nullptr, nullptr},
                                           {"time", "feedback", "wet"}, {"decay", "wet", nullptr},
                                           {"drive", "wet", nullptr},   {"threshold", "ratio", "makeup"}};
        int32_t k = 0;
        while (k < 6 && kind != kKinds[k]) ++k;
        int32_t indices[16] = {};
        double values[16] = {}, sequence[16] = {};
        const Value& params = at(effect, "params");
        for (int32_t s = 0; s < 3 && kSlots[k][s]; ++s) {
          indices[s] = index(prefix + ".insert." + str(effect, "id") + "." + kSlots[k][s]);
          const Value* v = params.get(kSlots[k][s]);
          values[s] = v ? v->as_number() : 0;
        }
        const Value* sync = effect.get("sync");
        int32_t length = 0;
        if (sync)
          for (const auto& v : list(*sync, "sequence")) sequence[length++] = v.as_number();
        const Value* cutoff = params.get("cutoff");
        if (!e.stage_effect(chain, k, at(effect, "bypass").as_bool(),
                            index(prefix + ".insert." + str(effect, "id") + ".bypass"), indices, values,
                            cutoff ? cutoff->as_number() : 0.7, sync != nullptr, sync ? num(*sync, "division") : 1,
                            sequence, length))
          return false;
      }
      return true;
    };
    for (int32_t i = 0; i < palette.tracks.size(); ++i) {
      const Str& id = palette.tracks[i].id;
      const Value* strip = at(mix, "tracks").get(id.c_str());
      e.stage_strip(i, strip ? num(*strip, "pan") : 0.5, strip ? list(*strip, "sends")[0].as_number() : 0,
                    strip ? list(*strip, "sends")[1].as_number() : 0, index(Str("track.") + id + ".pan"),
                    index(Str("track.") + id + ".send.0"), index(Str("track.") + id + ".send.1"));
      static const Vec<Value> none;
      if (!effects(i, strip ? list(*strip, "inserts") : none, Str("track.") + id))
        return err = "Mixer exceeds the engine budget", false;
    }
    const auto& returns = list(mix, "returns");
    for (int32_t j = 0; j < returns.size(); ++j)
      if (!effects(8 + j, returns[j].items(), Str("return.") + int_text(j)))
        return err = "Mixer exceeds the engine budget", false;
    return true;
  }

  int32_t rate_;
  rack::Rack* engine_;
  play::detail::Names uids_;
  Vec<Str> keys_, parameter_ids_;
  Str mix_identity_;
  double delay_frames_ = 0;
  Vec<Source> sources_;
  Vec<rack::SampleBinding> bindings_;
  Str chain_keys_[rack::kTracks + 2];
  int chains_[rack::kTracks + 2] = {};
};

}  // namespace xmp::voices
