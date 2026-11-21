#pragma once
// One-way import of the old pattern engine into the shared project model.
// Resolved original XMP kit/sample banks are supplied by the session. No I/O.
#include <map>
#include "xmp/live_sampler.hpp"
#include "xmp/live_song.hpp"
#include "xmp/project.hpp"

namespace xmp::live {
inline bool import_pattern_project(const Song& song, const std::array<const SampleBank*, kTracks>& banks,
                                   json::Value& out, Str& error) {
  using json::Value;
  auto number = [](double n) { return Value::of(n); };
  Value project = Value::new_object(), samples = Value::new_array(), tracks = Value::new_array();
  Value scenes = Value::new_array(), slots = Value::new_object(), roots = Value::new_object();
  std::map<const std::vector<float>*, Str> stored;
  size_t frames = 0;
  Value silence = Value::new_object(), pcm = Value::new_array();
  pcm.push(number(0));
  silence.set("id", Value::of("legacy-silence")), silence.set("name", Value::of("Empty pad"));
  silence.set("sampleRate", number(48000)), silence.set("pcm", pcm), samples.push(silence);
  auto pads = [&](int track, const SampleBank* bank, Value& result) {
    result = Value::new_array();
    for (int p = 0; p < 16; ++p) {
      Value pad = Value::new_object(), layers = Value::new_array();
      pad.set("id", Value::of(Str("pad-") + int_text(p)));
      const SamplePad* source = bank ? &bank->pads[static_cast<size_t>(p)] : nullptr;
      Str name = source && !source->name.empty() ? Str(source->name.c_str()).utf16_prefix(40) :
                                                 Str("Pad ") + int_text(p + 1);
      pad.set("name", Value::of(name)), pad.set("sampleId", Value::of("legacy-silence"));
      if (source) {
        if (source->layers.size() > kMaxLayers || !std::isfinite(source->trim) || source->trim < 0 || source->trim > 1) {
          error = "Invalid legacy sample bank; original files retained";
          return false;
        }
        for (const auto& layer : source->layers) {
          if (layer.takes.empty() || layer.takes.size() > kMaxTakes) {
            error = "Invalid legacy sample layer; original files retained";
            return false;
          }
          Value ids = Value::new_array();
          for (const auto& take : layer.takes) {
            if (take.empty()) { error = "Legacy sample is empty; original files retained"; return false; }
            auto known = stored.find(&take);
            Str id;
            if (known != stored.end()) id = known->second;
            else {
              if (samples.items().size() >= 128 || take.size() > 480000 || frames + take.size() + 1 > 1000000) {
                error = "Legacy samples exceed the portable song budget; original files retained";
                return false;
              }
              frames += take.size();
              id = Str("legacy-s") + int_text(samples.items().size());
              Value sample = Value::new_object(), audio = Value::new_array();
              audio.items().reserve(static_cast<int32_t>(take.size()));
              for (const float value : take) audio.push(number(value * source->trim));
              sample.set("id", Value::of(id));
              sample.set("name", Value::of(Str("Track ") + int_text(track + 1) + " " + name));
              sample.set("sampleRate", number(48000)), sample.set("pcm", audio);
              samples.push(sample), stored.emplace(&take, id);
            }
            ids.push(Value::of(id));
          }
          Value row = Value::new_object();
          row.set("upTo", number(layer.top / 127.0)), row.set("samples", ids), layers.push(row);
        }
        if (!layers.items().empty()) {
          pad.set("sampleId", layers.items()[0].get("samples")->items()[0]);
          if (layers.items().size() > 1 || layers.items()[0].get("samples")->items().size() > 1)
            pad.set("layers", layers);
        }
        if (source->choke) {
          Value playback = Value::new_object();
          playback.set("mode", Value::of("one-shot")), playback.set("rootNote", number(60));
          playback.set("chokeGroup", number(source->choke)), pad.set("playback", playback);
        }
      }
      result.push(pad);
    }
    return true;
  };
  Value shared;
  if (!pads(0, banks[0], shared)) return false;
  for (int t = 0; t < kTracks; ++t) {
    const auto& source = song.tracks[static_cast<size_t>(t)];
    if (source.kind == Track::synth && (source.preset < 0 || source.preset >= kSongSynthPresets)) {
      error = "Invalid legacy synth preset; original files retained";
      return false;
    }
    const Str id = t == 0 ? Str("drums") : Str("track-") + int_text(t);
    Value track = Value::new_object(), clip = Value::new_object(), clips = Value::new_array(), steps = Value::new_array();
    track.set("id", Value::of(id)), track.set("name", Value::of(Str("Track ") + int_text(t + 1)));
    track.set("muted", Value::of(source.mute)), track.set("volume", number(source.level));
    if (source.kind == Track::synth) {
      const auto& preset = synth::presets()[static_cast<size_t>(source.preset)];
      Value machine = Value::new_object(), state = Value::new_object();
      state.set("name", Value::of(preset.name)), state.set("oscillator", Value::of(preset.oscillator));
      state.set("attack", number(preset.attack)), state.set("decay", number(preset.decay));
      state.set("sustain", number(preset.sustain)), state.set("release", number(preset.release));
      state.set("cutoff", number(source.cutoff >= 30 ? source.cutoff : preset.cutoff));
      machine.set("id", Value::of("xmp.subtractive")), machine.set("base", Value::of("audio"));
      machine.set("version", number(1)), machine.set("state", state), track.set("machine", machine);
    } else {
      Value own;
      if (!pads(t, banks[static_cast<size_t>(t)], own)) return false;
      track.set("pads", own);
    }
    for (int s = 0; s < kSteps; ++s)
      for (int p = 0; p < (source.pads() ? 16 : 1); ++p) {
        const int velocity = source.pads() ? source.kit_velocity[static_cast<size_t>(p)][static_cast<size_t>(s)] :
                                            source.velocity[static_cast<size_t>(s)];
        if (source.pads() ? !velocity : !source.note[static_cast<size_t>(s)]) continue;
        Value step = Value::new_object();
        step.set("step", number(s)), step.set("pad", number(p));
        step.set("velocity", number(std::max(1, velocity) / 127.0)), step.set("probability", number(1));
        if (!source.pads()) step.set("note", number(source.note[static_cast<size_t>(s)])), step.set("duration", number(0.8));
        steps.push(step);
      }
    clip.set("id", Value::of("clip-0")), clip.set("name", Value::of("Imported pattern"));
    clip.set("length", number(16)), clip.set("steps", steps), clips.push(clip), track.set("clips", clips);
    tracks.push(track), slots.set(id, Value::of("clip-0")), roots.set(id, number(source.root));
  }
  Value scene = Value::new_object();
  scene.set("id", Value::of("scene-0")), scene.set("name", Value::of("Imported pattern"));
  scene.set("clips", slots), scenes.push(scene);
  project.set("format", Value::of("xmp-project")), project.set("version", number(project::kVersion));
  project.set("id", Value::of("live-pattern")), project.set("name", Value::of("Live pattern"));
  project.set("bpm", number(song.bpm)), project.set("swing", number(0)), project.set("master", number(0.55));
  project.set("pads", shared), project.set("samples", samples), project.set("tracks", tracks), project.set("scenes", scenes);
  project.set("seed", number(0)), project.set("parameterVersion", number(1)), project.set("parameters", Value::new_array());
  Value extensions = Value::new_object(), imported = Value::new_object(), data = Value::new_object();
  data.set("padRoots", roots), imported.set("version", number(1)), imported.set("data", data);
  extensions.set("xmp.legacy-pattern", imported), project.set("extensions", extensions);
  return project::canonical(project, out, error);
}
}  // namespace xmp::live
