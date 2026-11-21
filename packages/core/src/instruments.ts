import { createEngine, type EngineExports } from "./engine.ts";
import { type Pad, type Project, ProjectSchema, type Sample, stepTime } from "./index.ts";
import { MAX_LOOP_SAMPLE_FRAMES } from "./input.ts";
import { SynthPatchSchema } from "./instrument-schema.ts";
import { type MachineProcessor, type MidiEvent, machines, type TrackMachine } from "./machines.ts";
import { midiDestination } from "./midi-routing.ts";
import { type Effect, type Mix, MixSchema } from "./mix-schema.ts";
import { sampleInUse, trackPads } from "./pads.ts";
import { parameterRegistry, parameterValue } from "./parameters.ts";
import type { DelaySettings } from "./performance-dsp.ts";
import { withSampleProfile } from "./sample-profile.ts";

export const INSTRUMENT_RATE = 48000,
  INSTRUMENT_VOICES = 32,
  PANIC_SECONDS = 0.005;
export const inputCapabilities = Object.freeze({
  notes: true,
  velocity: true,
  pressure: false,
  pitchSlide: false,
  timbreSlide: false,
});
export function editedPcm(project: Project, padIndex: number, trackId?: string): Float32Array {
  const pad = trackPads(project, trackId)[padIndex],
    sample = project.samples.find((sample) => sample.id === pad?.sampleId);
  if (!pad || !sample) throw new Error("Unknown pad or sample");
  const start = pad.slice?.start ?? 0,
    end = pad.slice?.end ?? sample.pcm.length;
  if (start >= end || end > sample.pcm.length) throw new Error("Invalid sample boundaries");
  const pcm = Float32Array.from(sample.pcm.slice(start, end));
  if (pad.edit?.reverse) pcm.reverse();
  if (pad.edit?.normalize) {
    let peak = 0;
    for (const value of pcm) peak = Math.max(peak, Math.abs(value));
    if (peak > 0) for (let i = 0; i < pcm.length; i++) pcm[i] = (pcm[i] ?? 0) / peak;
  }
  return pcm;
}
// A multi-sampled pad's layers (project format 8): each take is its whole
// sample, reversed and normalized as the pad is edited.
export function editedLayers(
  project: Project,
  padIndex: number,
  trackId?: string,
): PreparedLayer[] | undefined {
  const pad = trackPads(project, trackId)[padIndex];
  if (!pad?.layers) return undefined;
  return pad.layers.map((layer) => ({
    upTo: layer.upTo,
    takes: layer.samples.map((id) => {
      const sample = project.samples.find((s) => s.id === id);
      if (!sample) throw new Error("Unknown pad or sample");
      const pcm = Float32Array.from(sample.pcm);
      if (pad.edit?.reverse) pcm.reverse();
      if (pad.edit?.normalize) {
        let peak = 0;
        for (const value of pcm) peak = Math.max(peak, Math.abs(value));
        if (peak > 0) for (let i = 0; i < pcm.length; i++) pcm[i] = (pcm[i] ?? 0) / peak;
      }
      return { pcm, rate: sample.sampleRate };
    }),
  }));
}
// The pads an edit changes: the track's own kit, else the project's.
function bankOf(project: Project, trackId: string | undefined): Pad[] {
  return project.tracks.find((t) => t.id === trackId)?.pads ?? project.pads;
}
export function manualSlices(
  project: Project,
  padIndex: number,
  boundaries: number[],
  trackId?: string,
): Project {
  const next = structuredClone(project),
    pads = bankOf(next, trackId),
    source = pads[padIndex],
    asset = next.samples.find((s) => s.id === source?.sampleId);
  if (
    !source ||
    !asset ||
    boundaries.length < 2 ||
    boundaries.length > 17 ||
    padIndex + boundaries.length - 1 > 16 ||
    boundaries.some(
      (value, i) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value > asset.pcm.length ||
        (i > 0 && value <= (boundaries[i - 1] ?? 0)),
    )
  )
    throw new Error("Use increasing slice frames within the asset and available pads");
  for (let i = 0; i < boundaries.length - 1; i++)
    pads[padIndex + i] = {
      ...source,
      id: pads[padIndex + i]?.id ?? `pad-${padIndex + i}`,
      name: `${asset.name.slice(0, 32)} ${i + 1}`,
      slice: { start: boundaries[i] ?? 0, end: boundaries[i + 1] ?? 1 },
    };
  // A slice plays one sound.
  for (let i = 0; i < boundaries.length - 1; i++) delete pads[padIndex + i]?.layers;
  return ProjectSchema.parse(next);
}
export function installSample(
  project: Project,
  padIndex: number,
  name: string,
  sampleRate: number,
  pcm: Float32Array,
  trackId?: string,
): Project {
  const next = structuredClone(project),
    pad = bankOf(next, trackId)[padIndex];
  if (
    !pad ||
    !pcm.length ||
    pcm.length > MAX_LOOP_SAMPLE_FRAMES ||
    pcm.some((v) => !Number.isFinite(v) || Math.abs(v) > 1)
  )
    throw new Error("Invalid or oversized take");
  let n = 0;
  while (next.samples.some((s) => s.id === `take-${n}`)) n++;
  const sample: Sample = {
    id: `take-${n}`,
    name: name.slice(0, 120) || "Take",
    sampleRate,
    pcm: Array.from(pcm),
  };
  pad.sampleId = sample.id;
  pad.name = sample.name.slice(0, 40);
  delete pad.slice;
  delete pad.edit;
  delete pad.layers;
  next.samples = next.samples.filter((s) => sampleInUse(next, s.id));
  next.samples.push(sample);
  return ProjectSchema.parse(withSampleProfile(next));
}
// Gives a track its own kit: a copy of the 16 pads it plays now, sharing their
// samples, so it sounds the same until its pads are changed.
export function ownKit(project: Project, trackId: string): Project {
  const next = structuredClone(project),
    track = next.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error("Unknown track");
  if (!track.pads) track.pads = structuredClone(next.pads);
  return ProjectSchema.parse(next);
}
// Returns a track to the project's pads, dropping samples nothing plays any more.
export function shareKit(project: Project, trackId: string): Project {
  const next = structuredClone(project),
    track = next.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error("Unknown track");
  delete track.pads;
  next.samples = next.samples.filter((s) => sampleInUse(next, s.id));
  return ProjectSchema.parse(next);
}
export interface PreparedLayer {
  upTo: number;
  takes: { pcm: Float32Array; rate: number }[];
}
export interface PreparedPad {
  pcm: Float32Array;
  rate: number;
  mode: "one-shot" | "gate" | "loop" | "chromatic";
  rootNote: number;
  chokeGroup: number;
  // A multi-sampled pad's velocity layers, softest first (format 8).
  layers?: PreparedLayer[];
}
export interface PreparedTrack {
  id: string;
  machine: TrackMachine;
  gain: number;
  muted?: boolean;
  // Where the track's 16 pads start in the palette's pads (0: the project's).
  padBase?: number;
}
export interface InstrumentPalette {
  mix?: { spec: Mix; bpm: number };
  delay?: DelaySettings;
  assets?: { id: string; pcm: Float32Array; sampleRate: number }[];
  parameterBase?: Record<string, number>;
  sequenceMaster?: number;
  // The project's 16 pads, then 16 for each track with its own kit.
  pads: PreparedPad[];
  tracks: PreparedTrack[];
  // The pads and assets are those of the palette before this one (left out
  // here): what an edit that changes no sound sends, instead of every sample.
  keepSounds?: boolean;
}
// What the pads' sounds depend on: each sample's audio (by identity) and the
// pads that slice and edit it. Two projects with equal keys prepare the same
// pads and assets.
export function soundsKey(project: Project) {
  return {
    pcm: project.samples.map((s) => s.pcm),
    rates: project.samples.map((s) => `${s.id}@${s.sampleRate}`).join(),
    pads: JSON.stringify([project.pads, project.tracks.map((t) => t.pads ?? null)]),
  };
}
export function sameSounds(a: ReturnType<typeof soundsKey>, b: ReturnType<typeof soundsKey>) {
  return (
    a.pads === b.pads &&
    a.rates === b.rates &&
    a.pcm.length === b.pcm.length &&
    a.pcm.every((pcm, i) => pcm === b.pcm[i])
  );
}
// `checked`: the project already passed the schema (it came from the core's
// edits or an opened file), so it is not parsed again; that parse was 157 of
// the 220 ms this took on every edit of a full song. `sounds: false` leaves the
// pads and assets out (keepSounds) for a project whose sounds did not change.
export function prepareInstruments(
  project: Project,
  options: { checked?: boolean; sounds?: boolean } = {},
): InstrumentPalette {
  if (!options.checked) ProjectSchema.parse(project);
  const sounds = options.sounds !== false;
  return {
    ...(project.mix ||
    project.performance ||
    project.tracks.some((t) => t.clips.some((c) => c.sequence))
      ? {
          sequenceMaster: parameterValue(project, "master.gain"),
          parameterBase: Object.fromEntries(
            parameterRegistry(project).map((p) => [p.id, parameterValue(project, p.id)]),
          ),
        }
      : {}),
    ...(project.mix ? { mix: { spec: structuredClone(project.mix), bpm: project.bpm } } : {}),
    ...(project.performance && !project.mix
      ? {
          delay: {
            seconds: (project.performance.delay.steps * 60) / project.bpm / 4,
            feedback: project.performance.delay.feedback,
            wet: project.performance.delay.wet,
            sends: { ...project.performance.delay.sends },
          },
        }
      : {}),
    ...(sounds
      ? {
          assets: project.samples.map((s) => ({
            id: s.id,
            pcm: Float32Array.from(s.pcm),
            sampleRate: s.sampleRate,
          })),
        }
      : { keepSounds: true }),
    pads: sounds
      ? [undefined, ...project.tracks.filter((t) => t.pads).map((t) => t.id)].flatMap((owner) =>
          trackPads(project, owner).map((pad, i) => {
            const layers = editedLayers(project, i, owner);
            return {
              pcm: editedPcm(project, i, owner),
              rate: project.samples.find((s) => s.id === pad.sampleId)?.sampleRate ?? 48000,
              ...(pad.playback ?? { mode: "one-shot", rootNote: 60, chokeGroup: 0 }),
              ...(layers ? { layers } : {}),
            };
          }),
        )
      : [],
    tracks: project.tracks.map((track) => ({
      id: track.id,
      ...(track.pads
        ? {
            padBase: 16 * (1 + project.tracks.filter((t) => t.pads).indexOf(track)),
          }
        : {}),
      muted: track.muted,
      machine: track.machine ?? machines.instantiate("xmp.sampler"),
      gain: track.muted
        ? 0
        : parameterValue(project, `track.${track.id}.gain`) *
          parameterValue(project, `track.${track.id}.effect.gain`) *
          2,
    })),
  };
}
// Track kinds, pad modes, oscillators and effect kinds as the C++ engine numbers them.
const KIND = { none: 0, sampler: 1, subtractive: 2, midi: 3, custom: 4 } as const;
const PAD_MODE = { "one-shot": 0, gate: 1, loop: 2, chromatic: 3 } as const;
const OSCILLATOR = { sine: 0, saw: 1, square: 2 } as const;
export const EFFECT_SLOTS = {
  eq: [0, ["tone", "gain"]],
  filter: [1, ["cutoff"]],
  delay: [2, ["time", "feedback", "wet"]],
  reverb: [3, ["decay", "wet"]],
  distortion: [4, ["drive", "wet"]],
  compressor: [5, ["threshold", "ratio", "makeup"]],
} as const;
// The synth's fields in the engine's order (rack.hpp patch_field), with the
// values the later, optional ones play at when a patch leaves them out.
const PATCH_FIELDS = [
  "attack",
  "decay",
  "sustain",
  "release",
  "cutoff",
  "resonance",
  "env-amount",
  "env-decay",
  "detune",
  "glide",
] as const;
const PATCH_DEFAULTS = {
  resonance: 0,
  "env-amount": 0,
  "env-decay": 0.3,
  detune: 0,
  glide: 0,
} as const;
const MAX_PARAMETERS = 4096;

// XMP's voice rack: every track's sampler, synth and MIDI voices, parameter
// smoothing, the mixer and the shared delay. The DSP runs in the C++ engine
// (native/include/xmp/rack.hpp) as WebAssembly; this class lays the palette
// out for it, validates every command first, maps string IDs to the engine's
// numbers, and runs locally bundled JavaScript machines (the SDK's custom
// machines) alongside it. The original TypeScript rack was retired in phase 9
// part 5 (docs/cpp-port.md); tests/golden.json keeps what the engine produced
// while it matched.
export class VoiceRack {
  private engine: EngineExports;
  private palette: InstrumentPalette;
  readonly sampleRate: number;
  private emitMidi: (event: MidiEvent) => void;
  private uids = new Map<string, number>();
  private keys = new Map<string, number>();
  private parameterIndex = new Map<string, number>();
  private definitions = new Map<string, ReturnType<typeof machines.get>>();
  private custom = new Map<
    string,
    {
      machine: TrackMachine;
      processor: MachineProcessor;
      base: "audio" | "midi";
      parameters: { id: string; index: number; min: number; max: number }[];
    }
  >();
  private mixIdentity = "";
  private delayFrames = 0;
  private scratch = new Float32Array(4096);
  private customSample = new Float32Array(1);
  constructor(
    palette: InstrumentPalette,
    sampleRate = 48000,
    emitMidi: (event: MidiEvent) => void = () => {},
  ) {
    if (palette.keepSounds) throw new Error("A new rack needs its sounds");
    this.palette = palette;
    this.sampleRate = sampleRate;
    this.emitMidi = emitMidi;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
      throw new Error("Invalid processing rate");
    this.engine = createEngine(sampleRate);
    this.engine.xmp_set_master_index(this.index("master.gain"));
    this.configure(palette);
  }
  get meter() {
    if (!this.engine.xmp_meter(1)) return undefined;
    const m = new Float64Array(this.engine.memory.buffer, this.engine.xmp_meter_out(), 4);
    return { left: m[0] ?? 0, right: m[1] ?? 0, rms: m[2] ?? 0, clipped: m[3] ?? 0 };
  }
  get refused() {
    return this.engine.xmp_refused();
  }
  get frame() {
    return this.engine.xmp_frame();
  }
  get masterGain() {
    return this.engine.xmp_master_gain();
  }
  set masterGain(gain: number) {
    this.engine.xmp_set_master_gain(gain);
  }
  get active() {
    return this.engine.xmp_active();
  }
  clock(step: number, bpm: number) {
    if (!this.engine.xmp_has_mixer()) return;
    if (
      !Number.isFinite(step) ||
      step < 0 ||
      step > 1000100 ||
      !Number.isFinite(bpm) ||
      bpm < 30 ||
      bpm > 300
    )
      throw new Error("Invalid effect clock");
    this.engine.xmp_clock(step, bpm);
  }
  private uid(id: string) {
    let n = this.uids.get(id);
    if (n === undefined) {
      n = this.uids.size;
      this.uids.set(id, n);
    }
    return n;
  }
  private key(machine: TrackMachine) {
    const text = `${machine.id}|${machine.base}|${machine.version}`;
    let n = this.keys.get(text);
    if (n === undefined) {
      n = this.keys.size + 1;
      this.keys.set(text, n);
    }
    return n;
  }
  private index(id: string) {
    let n = this.parameterIndex.get(id);
    if (n === undefined) {
      if (this.parameterIndex.size >= MAX_PARAMETERS) throw new Error("Too many parameters");
      n = this.parameterIndex.size;
      this.parameterIndex.set(id, n);
      if (id.endsWith(".bypass")) this.engine.xmp_set_bypass_flag(n, 1);
    }
    return n;
  }
  private drain() {
    const e = this.engine,
      count = e.xmp_midi_count();
    if (e.xmp_midi_overflow()) {
      e.xmp_midi_clear();
      throw new Error("MIDI event buffer overflow");
    }
    if (!count) return;
    const view = new DataView(e.memory.buffer, e.xmp_midi(), count * e.xmp_midi_event_size()),
      size = e.xmp_midi_event_size(),
      events: MidiEvent[] = [];
    for (let i = 0; i < count; i++) {
      const at = i * size;
      events.push({
        kind: view.getInt32(at + 16, true) ? "on" : "off",
        id: view.getFloat64(at, true),
        note: view.getInt32(at + 20, true),
        velocity: view.getFloat64(at + 8, true),
        channel: view.getInt32(at + 24, true),
      });
    }
    e.xmp_midi_clear();
    for (const event of events) this.emitMidi(event);
  }
  configure(next: InstrumentPalette) {
    // A palette without its sounds keeps the ones this rack already has.
    const palette: InstrumentPalette = next.keepSounds
      ? { ...next, pads: this.palette.pads, assets: this.palette.assets, keepSounds: false }
      : next;
    // Validate the replacement before touching any active voices or graph.
    const e = this.engine;
    const definitions = new Map(palette.tracks.map((t) => [t.id, machines.get(t.machine)]));
    const routes = new Map<string, string>();
    for (const source of palette.tracks) {
      const target = midiDestination(palette.tracks, source);
      if (target) routes.set(source.id, target.id);
    }
    if (
      palette.tracks.length > 8 ||
      palette.pads.length > 16 * 9 ||
      palette.tracks.some(
        (t) =>
          t.padBase !== undefined &&
          (!Number.isInteger(t.padBase) || t.padBase < 0 || t.padBase + 16 > palette.pads.length),
      )
    )
      throw new Error("Invalid instrument palette");
    const identity = palette.mix
      ? JSON.stringify([palette.mix, palette.tracks.map((t) => t.id)])
      : "";
    const mixMode = identity === this.mixIdentity ? 1 : palette.mix ? 2 : 0;
    let mix: Mix | undefined;
    if (mixMode === 2 && palette.mix) {
      const ids = palette.tracks.map((t) => t.id);
      if (
        !Number.isFinite(palette.mix.bpm) ||
        palette.mix.bpm < 30 ||
        palette.mix.bpm > 300 ||
        new Set(ids).size !== ids.length
      )
        throw new Error("Invalid mixer preparation");
      mix = MixSchema.parse(palette.mix.spec);
    }
    let delayFrames = 0;
    if (palette.delay) {
      delayFrames = Math.max(1, Math.round(palette.delay.seconds * this.sampleRate));
      const d = palette.delay;
      if (
        delayFrames !== this.delayFrames &&
        (!Number.isFinite(d.seconds) ||
          d.seconds <= 0 ||
          d.seconds > 4 ||
          !Number.isFinite(d.feedback) ||
          d.feedback < 0 ||
          d.feedback > 0.75 ||
          !Number.isFinite(d.wet) ||
          d.wet < 0 ||
          d.wet > 1)
      )
        throw new Error("Invalid preview delay");
    }
    const patches = palette.tracks.map((t) =>
      definitions.get(t.id)?.id === "xmp.subtractive"
        ? SynthPatchSchema.parse(t.machine.state)
        : undefined,
    );
    e.xmp_stage_begin(palette.tracks.length, palette.pads.length);
    palette.tracks.forEach((track, i) => {
      const definition = definitions.get(track.id),
        route = routes.get(track.id);
      const kind = !definition
        ? KIND.none
        : definition.create
          ? KIND.custom
          : definition.id === "xmp.sampler"
            ? KIND.sampler
            : definition.id === "xmp.subtractive"
              ? KIND.subtractive
              : definition.id === "xmp.midi"
                ? KIND.midi
                : KIND.none;
      const flags =
        (definition?.base === "midi" ? 1 : 0) |
        (track.muted ? 2 : 0) |
        (definition?.id === "xmp.midi" && track.machine.state.destination && !route ? 4 : 0) |
        (track.machine.id === "xmp.midi" ? 8 : 0) |
        (kind === KIND.custom && definition?.base === "audio" ? 16 : 0);
      e.xmp_stage_track(
        i,
        this.uid(track.id),
        kind,
        this.key(track.machine),
        route === undefined ? -1 : this.uid(route),
        flags,
        track.gain,
        Number(track.machine.state.channel ?? 1),
        palette.delay?.sends[track.id] ?? 0,
        this.index(`track.${track.id}.gain`),
        this.index(`track.${track.id}.effect.gain`),
        this.index(`track.${track.id}.machine.xmp.midi.v1.channel`),
      );
      if (track.padBase) e.xmp_stage_pad_base(i, track.padBase);
      const patch = patches[i];
      if (patch && definition) {
        const values = new Float64Array(e.memory.buffer, e.xmp_scratch_value(), 16),
          indices = new Int32Array(e.memory.buffer, e.xmp_scratch_index(), 16);
        PATCH_FIELDS.forEach((field, p) => {
          values[p] = patch[field] ?? PATCH_DEFAULTS[field as keyof typeof PATCH_DEFAULTS];
          indices[p] = this.index(
            `track.${track.id}.machine.${definition.id}.v${definition.version}.${field}`,
          );
        });
        e.xmp_stage_patch(i, OSCILLATOR[patch.oscillator]);
      }
    });
    palette.pads.forEach((pad, i) => {
      const at = e.xmp_stage_pad(
        i,
        pad.pcm.length,
        pad.rate,
        PAD_MODE[pad.mode],
        pad.rootNote,
        pad.chokeGroup,
      );
      if (!at) throw new Error("Pad sound exceeds the engine budget");
      new Float32Array(e.memory.buffer, at, pad.pcm.length).set(pad.pcm);
      for (const [l, layer] of (pad.layers ?? []).entries())
        for (const [t, take] of layer.takes.entries()) {
          const buffer = e.xmp_stage_pad_take(i, l, t, take.pcm.length, take.rate, layer.upTo);
          if (!buffer) throw new Error("Pad sound exceeds the engine budget");
          new Float32Array(e.memory.buffer, buffer, take.pcm.length).set(take.pcm);
        }
    });
    e.xmp_stage_delay(
      palette.delay ? 1 : 0,
      palette.delay?.seconds ?? 0,
      palette.delay?.feedback ?? 0,
      palette.delay?.wet ?? 0,
    );
    for (const [id, value] of Object.entries(palette.parameterBase ?? {}))
      e.xmp_stage_base(this.index(id), value);
    e.xmp_stage_master(palette.sequenceMaster ?? 1);
    if (!e.xmp_stage_mixer(mixMode, palette.mix?.bpm ?? 120))
      throw new Error("Mixer exceeds the engine budget");
    if (mix) this.stageMix(mix, palette.tracks);
    e.xmp_commit();
    this.drain();
    for (const [id, entry] of this.custom) {
      const owner = palette.tracks.find((t) => t.id === id);
      if (owner?.muted || owner?.gain === 0) entry.processor.panic();
      if (
        !palette.tracks.some(
          (t) => t.id === id && JSON.stringify(t.machine) === JSON.stringify(entry.machine),
        )
      ) {
        entry.processor.panic();
        this.custom.delete(id);
      }
    }
    this.palette = palette;
    this.definitions = definitions;
    this.mixIdentity = identity;
    this.delayFrames = delayFrames;
    for (const track of palette.tracks) {
      const definition = definitions.get(track.id);
      if (definition?.create && !this.custom.has(track.id)) {
        const processor = definition.create({
          sampleRate: this.sampleRate,
          assets: palette.assets,
          state: JSON.parse(JSON.stringify(track.machine.state)),
          emitMidi: this.emitMidi,
        });
        if (definition.automation && !processor.setParameter)
          throw new Error("Automatable machine requires setParameter");
        this.custom.set(track.id, {
          machine: track.machine,
          base: definition.base,
          processor,
          parameters: definition.parameters.map((p) => ({
            id: p.id,
            min: p.min,
            max: p.max,
            index: this.index(
              `track.${track.id}.machine.${definition.id}.v${definition.version}.${p.id}`,
            ),
          })),
        });
      }
    }
  }
  private stageMix(mix: Mix, tracks: readonly PreparedTrack[]) {
    const e = this.engine;
    for (const tempo of mix.tempos) e.xmp_stage_tempo(tempo.step, tempo.bpm);
    const effects = (chain: number, list: readonly Effect[], prefix: string) => {
      for (const effect of list) {
        const [kind, names] = EFFECT_SLOTS[effect.kind];
        const indices = new Int32Array(e.memory.buffer, e.xmp_scratch_index(), 16),
          values = new Float64Array(e.memory.buffer, e.xmp_scratch_value(), 16),
          sequence = new Float64Array(e.memory.buffer, e.xmp_scratch_sequence(), 16);
        names.forEach((name, s) => {
          indices[s] = this.index(`${prefix}.insert.${effect.id}.${name}`);
          values[s] = effect.params[name] ?? 0;
        });
        effect.sync?.sequence.forEach((v, s) => {
          sequence[s] = v;
        });
        if (
          !e.xmp_stage_effect(
            chain,
            kind,
            effect.bypass ? 1 : 0,
            this.index(`${prefix}.insert.${effect.id}.bypass`),
            effect.params.cutoff ?? 0.7,
            effect.sync ? 1 : 0,
            effect.sync?.division ?? 1,
            effect.sync?.sequence.length ?? 0,
          )
        )
          throw new Error("Mixer exceeds the engine budget");
      }
    };
    tracks.forEach((track, i) => {
      const strip = mix.tracks[track.id];
      e.xmp_stage_strip(
        i,
        strip?.pan ?? 0.5,
        strip?.sends[0] ?? 0,
        strip?.sends[1] ?? 0,
        this.index(`track.${track.id}.pan`),
        this.index(`track.${track.id}.send.0`),
        this.index(`track.${track.id}.send.1`),
      );
      effects(i, strip?.inserts ?? [], `track.${track.id}`);
    });
    mix.returns.forEach((list, j) => {
      effects(8 + j, list, `return.${j}`);
    });
  }
  applyParameters(values: Record<string, number>) {
    if (
      Object.keys(values).length > 512 ||
      Object.values(values).some((v) => !Number.isFinite(v) || v < 0 || v > 1)
    )
      throw new Error("Invalid parameter command");
    const indices = Object.keys(values).map((id) => this.index(id));
    this.engine.xmp_targets_begin();
    Object.values(values).forEach((value, i) => {
      this.engine.xmp_targets_add(indices[i] ?? 0, value);
    });
    this.engine.xmp_targets_commit();
  }
  resetParameters() {
    this.applyParameters(this.palette.parameterBase ?? {});
  }
  setBlockedTracks(ids: readonly string[]) {
    if (ids.length > 8 || ids.some((id) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id)))
      throw new Error("Invalid blocked track list");
    this.engine.xmp_blocked_begin();
    for (const id of new Set(ids)) this.engine.xmp_blocked_add(this.uid(id));
    this.engine.xmp_blocked_commit();
    this.drain();
    const blocked = new Set(ids);
    for (const [id, entry] of this.custom) if (blocked.has(id)) entry.processor.panic();
  }
  isTrackBlocked(trackIndex: number) {
    return this.engine.xmp_track_blocked(trackIndex) !== 0;
  }
  noteOn(
    id: number,
    padIndex: number,
    trackIndex: number,
    note = 60,
    velocity = 0.8,
    durationFrames = 0,
  ): boolean {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isInteger(padIndex) ||
      padIndex < 0 ||
      padIndex > 15 ||
      !Number.isInteger(note) ||
      note < 0 ||
      note > 127 ||
      !Number.isFinite(velocity) ||
      velocity < 0 ||
      velocity > 1 ||
      !Number.isInteger(durationFrames) ||
      durationFrames < 0 ||
      durationFrames > this.sampleRate * 32
    )
      throw new Error("Invalid note");
    if (!Number.isInteger(trackIndex)) return false;
    const played = this.engine.xmp_note_on(
      id,
      padIndex,
      trackIndex,
      note,
      velocity,
      durationFrames,
    );
    this.drain();
    if (played !== 2) return played === 1;
    const track = this.palette.tracks[trackIndex];
    const extension = track ? this.custom.get(track.id) : undefined;
    return extension ? extension.processor.noteOn({ id, note, velocity, durationFrames }) : false;
  }
  expression(
    trackId: string,
    id: number,
    dimension: "pressure" | "pitch" | "timbre",
    value: number,
  ) {
    const definition = this.definitions.get(trackId),
      processor = this.custom.get(trackId)?.processor;
    if (
      !["pressure", "pitch", "timbre"].includes(dimension) ||
      !Number.isInteger(id) ||
      id < 1 ||
      !Number.isFinite(value) ||
      (dimension === "pitch" ? value < -48 || value > 48 : value < 0 || value > 1) ||
      !definition?.capabilities.includes(dimension) ||
      !processor?.expression
    )
      throw new Error("Per-note expression unavailable before delivery");
    processor.expression(id, dimension, value);
  }
  noteOff(id: number) {
    this.engine.xmp_note_off(id);
    this.drain();
    for (const entry of this.custom.values()) entry.processor.noteOff(id);
  }
  releaseTrack(id: string) {
    this.engine.xmp_release_track(this.uid(id));
    this.drain();
    this.custom.get(id)?.processor.panic();
  }
  clearTail() {
    this.engine.xmp_clear_tail();
  }
  removeTrack(id: string) {
    this.engine.xmp_remove_track(this.uid(id));
    this.drain();
    this.custom.get(id)?.processor.panic();
    this.custom.delete(id);
  }
  panic() {
    this.engine.xmp_panic();
    this.drain();
    for (const entry of this.custom.values()) entry.processor.panic();
  }
  // Custom machines see each parameter as the engine smoothed it.
  private customParameters() {
    if (!this.engine.xmp_advanced()) return;
    for (const entry of this.custom.values())
      for (const p of entry.parameters)
        if (this.engine.xmp_has_value(p.index))
          entry.processor.setParameter?.(
            p.id,
            p.min + this.engine.xmp_value(p.index) * (p.max - p.min),
          );
  }
  process(left: Float32Array, right: Float32Array, frames = left.length) {
    if (
      !Number.isInteger(frames) ||
      frames < 0 ||
      frames > 4096 ||
      left.length < frames ||
      right.length < frames
    )
      throw new Error("Invalid processing block");
    const e = this.engine;
    if (!this.custom.size) {
      e.xmp_process(frames);
      this.drain();
    } else if (e.xmp_has_mixer()) {
      for (let i = 0; i < frames; i++) {
        e.xmp_frame_voices(i);
        this.drain();
        this.customParameters();
        for (const [id, entry] of this.custom) {
          this.customSample[0] = 0;
          entry.processor.process(this.customSample, 1);
          if (entry.base === "audio") {
            const index = this.palette.tracks.findIndex((t) => t.id === id);
            if (index >= 0) e.xmp_frame_custom(index, this.customSample[0] ?? 0);
          }
        }
        e.xmp_frame_mix(i);
      }
    } else {
      e.xmp_voices_block(frames);
      this.drain();
      this.customParameters();
      for (const [id, entry] of this.custom) {
        this.scratch.fill(0, 0, frames);
        entry.processor.process(this.scratch, frames);
        if (entry.base === "audio") {
          new Float32Array(e.memory.buffer, e.xmp_custom_audio(), frames).set(
            this.scratch.subarray(0, frames),
          );
          e.xmp_custom_add(
            this.palette.tracks.findIndex((t) => t.id === id),
            frames,
          );
        }
      }
      e.xmp_finish(frames);
    }
    const out = this.output();
    left.set(out.left.subarray(0, frames));
    right.set(out.right.subarray(0, frames));
  }
  // The engine's output buffers, re-viewed only when its memory grows.
  private views?: { buffer: ArrayBuffer; left: Float32Array; right: Float32Array };
  private output() {
    const buffer = this.engine.memory.buffer;
    if (this.views?.buffer !== buffer)
      this.views = {
        buffer,
        left: new Float32Array(buffer, this.engine.xmp_left(), 4096),
        right: new Float32Array(buffer, this.engine.xmp_right(), 4096),
      };
    return this.views;
  }
}
export function hasInstruments(project: Project) {
  return (
    project.mix !== undefined ||
    project.performance !== undefined ||
    project.tracks.some((t) => t.clips.some((c) => c.sequence)) ||
    project.tracks.some(
      (t) =>
        t.machine &&
        (t.machine.id !== "xmp.sampler" || t.machine.version !== 1 || t.machine.base !== "audio"),
    ) ||
    project.pads.some((p) => p.edit || p.playback) ||
    project.tracks.some((t) => t.pads?.some((p) => p.edit || p.playback))
  );
}
export function instrumentDuration(project: Project, steps: number) {
  return Math.round(stepTime(steps, project.bpm, project.swing) * 48000);
}
