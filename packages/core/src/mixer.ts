// The mixer and its effects, one sample at a time, from JavaScript: the C++
// engine's own Effect and Mixer (native/include/xmp/rack.hpp, in the engine's
// WebAssembly), with the API the original TypeScript mixer had (retired in
// phase 9 of docs/cpp-port.md). The engine runs the same code for every
// project with a mix; this is for tests and tools that drive one effect or
// one mixer directly.
import { createEngine, type EngineExports } from "./engine.ts";
import { EFFECT_SLOTS } from "./instruments.ts";
import { type Effect, EffectSchema, type Mix, MixSchema } from "./mix-schema.ts";

type UnitExports = EngineExports & {
  xmp_fx_new(
    kind: number,
    bypass: number,
    cutoffRaw: number,
    sync: number,
    division: number,
    sequenceLength: number,
    rate: number,
  ): number;
  xmp_fx_process(
    unit: number,
    input: number,
    step: number,
    bpm: number,
    mask: number,
    v0: number,
    v1: number,
    v2: number,
    bypass: number,
  ): number;
  xmp_fx_clear(unit: number): void;
  xmp_unit_free(unit: number): void;
  xmp_mix_new(rate: number, bpm: number): number;
  xmp_mix_strip(
    unit: number,
    i: number,
    pan: number,
    send0: number,
    send1: number,
    panIndex: number,
    send0Index: number,
    send1Index: number,
  ): number;
  xmp_mix_tempo(unit: number, step: number, bpm: number): number;
  xmp_mix_effect(
    unit: number,
    chain: number,
    kind: number,
    bypass: number,
    bypassIndex: number,
    cutoffRaw: number,
    sync: number,
    division: number,
    sequenceLength: number,
  ): number;
  xmp_mix_inputs(unit: number): number;
  xmp_mix_values(unit: number): number;
  xmp_mix_given(unit: number): number;
  xmp_mix_clock(unit: number, step: number, bpm: number): void;
  xmp_mix_process(unit: number, master: number): void;
  xmp_mix_clear(unit: number): void;
  xmp_mix_state(unit: number): void;
  xmp_mix_reset_meter(unit: number): void;
};

// One engine instance holds every standalone effect and mixer.
let shared: UnitExports | undefined;
const engine = () => (shared ??= createEngine(48000) as UnitExports);
const released = new FinalizationRegistry<number>((unit) => engine().xmp_unit_free(unit));
const scratch = (e: UnitExports) => ({
  index: new Int32Array(e.memory.buffer, e.xmp_scratch_index(), 16),
  value: new Float64Array(e.memory.buffer, e.xmp_scratch_value(), 16),
  sequence: new Float64Array(e.memory.buffer, e.xmp_scratch_sequence(), 16),
});
// An effect's slot defaults and sync sequence into the scratch areas.
function stageSlots(e: UnitExports, effect: Effect, indices?: readonly number[]) {
  const [kind, names] = EFFECT_SLOTS[effect.kind];
  const s = scratch(e);
  names.forEach((name, i) => {
    s.value[i] = effect.params[name] ?? 0;
    s.index[i] = indices?.[i] ?? -1;
  });
  effect.sync?.sequence.forEach((v, i) => {
    s.sequence[i] = v;
  });
  return { kind, names, cutoffRaw: effect.params.cutoff ?? 0.7 };
}

export function panGains(pan: number) {
  if (!Number.isFinite(pan) || pan < 0 || pan > 1) throw new Error("Invalid pan");
  return [Math.cos((pan * Math.PI) / 2), Math.sin((pan * Math.PI) / 2)] as const;
}

export class EffectProcessor {
  readonly effect: Effect;
  readonly rate: number;
  private unit: number;
  private names: readonly string[];
  constructor(effect: Effect, rate = 48000) {
    this.rate = rate;
    this.effect = EffectSchema.parse(effect);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96000)
      throw new Error("Invalid effect rate");
    const e = engine(),
      { kind, names, cutoffRaw } = stageSlots(e, this.effect);
    this.names = names;
    this.unit = e.xmp_fx_new(
      kind,
      this.effect.bypass ? 1 : 0,
      cutoffRaw,
      this.effect.sync ? 1 : 0,
      this.effect.sync?.division ?? 1,
      this.effect.sync?.sequence.length ?? 0,
      rate,
    );
    if (!this.unit) throw new Error("Effect exceeds the engine budget");
    released.register(this, this.unit);
  }
  clear() {
    engine().xmp_fx_clear(this.unit);
  }
  process(input: number, step = 0, bpm = 120, values?: Record<string, number>, prefix = "") {
    let mask = 0;
    const v = [0, 0, 0, 0];
    if (values) {
      this.names.forEach((name, i) => {
        const x = values[`${prefix}.${name}`];
        if (x !== undefined && x !== null) (v[i] = x), (mask |= 1 << i);
      });
      const b = values[`${prefix}.bypass`];
      if (b !== undefined && b !== null) (v[3] = b), (mask |= 8);
    }
    return engine().xmp_fx_process(
      this.unit,
      input,
      step,
      bpm,
      mask,
      v[0] ?? 0,
      v[1] ?? 0,
      v[2] ?? 0,
      v[3] ?? 0,
    );
  }
}

export class StereoMixer {
  left = 0;
  right = 0;
  readonly spec: Mix;
  readonly rate: number;
  private unit: number;
  private ids: string[] = [];
  constructor(spec: Mix, tracks: string[], rate = 48000, bpm = 120) {
    this.rate = rate;
    if (
      !Number.isInteger(rate) ||
      rate < 8000 ||
      rate > 96000 ||
      !Number.isFinite(bpm) ||
      bpm < 30 ||
      bpm > 300 ||
      tracks.length > 8 ||
      new Set(tracks).size !== tracks.length
    )
      throw new Error("Invalid mixer preparation");
    this.spec = MixSchema.parse(spec);
    const e = engine();
    this.unit = e.xmp_mix_new(rate, bpm);
    if (!this.unit) throw new Error("Mixer exceeds the engine budget");
    released.register(this, this.unit);
    const index = (id: string) => {
      const at = this.ids.indexOf(id);
      if (at >= 0) return at;
      if (this.ids.length >= 256) throw new Error("Mixer exceeds the engine budget");
      return this.ids.push(id) - 1;
    };
    for (const tempo of this.spec.tempos) e.xmp_mix_tempo(this.unit, tempo.step, tempo.bpm);
    const effects = (chain: number, list: readonly Effect[], prefix: string) => {
      for (const effect of list) {
        const [, names] = EFFECT_SLOTS[effect.kind];
        const indices = names.map((name) => index(`${prefix}.insert.${effect.id}.${name}`));
        const { kind, cutoffRaw } = stageSlots(e, effect, indices);
        if (
          !e.xmp_mix_effect(
            this.unit,
            chain,
            kind,
            effect.bypass ? 1 : 0,
            index(`${prefix}.insert.${effect.id}.bypass`),
            cutoffRaw,
            effect.sync ? 1 : 0,
            effect.sync?.division ?? 1,
            effect.sync?.sequence.length ?? 0,
          )
        )
          throw new Error("Mixer exceeds the engine budget");
      }
    };
    tracks.forEach((id, i) => {
      const strip = this.spec.tracks[id];
      e.xmp_mix_strip(
        this.unit,
        i,
        strip?.pan ?? 0.5,
        strip?.sends[0] ?? 0,
        strip?.sends[1] ?? 0,
        index(`track.${id}.pan`),
        index(`track.${id}.send.0`),
        index(`track.${id}.send.1`),
      );
      effects(i, strip?.inserts ?? [], `track.${id}`);
    });
    this.spec.returns.forEach((list, j) => {
      effects(8 + j, list, `return.${j}`);
    });
  }
  private state() {
    const e = engine();
    e.xmp_mix_state(this.unit);
    return new Float64Array(e.memory.buffer, e.xmp_scratch_value(), 9);
  }
  get step() {
    return this.state()[7] ?? 0;
  }
  get bpm() {
    return this.state()[8] ?? 120;
  }
  clock(step: number, bpm: number) {
    if (
      !Number.isFinite(step) ||
      step < 0 ||
      step > 1000100 ||
      !Number.isFinite(bpm) ||
      bpm < 30 ||
      bpm > 300
    )
      throw new Error("Invalid effect clock");
    engine().xmp_mix_clock(this.unit, step, bpm);
  }
  process(inputs: Float64Array, master: number, values?: Record<string, number>) {
    const e = engine();
    const into = new Float64Array(e.memory.buffer, e.xmp_mix_inputs(this.unit), 8);
    for (let i = 0; i < 8; i++) into[i] = inputs[i] ?? 0;
    const cur = new Float64Array(e.memory.buffer, e.xmp_mix_values(this.unit), 256),
      given = new Uint8Array(e.memory.buffer, e.xmp_mix_given(this.unit), 256);
    this.ids.forEach((id, i) => {
      const v = values?.[id];
      if (v === undefined || v === null) given[i] = 0;
      else (cur[i] = v), (given[i] = 1);
    });
    e.xmp_mix_process(this.unit, master);
    const s = this.state();
    this.left = s[0] ?? 0;
    this.right = s[1] ?? 0;
  }
  meter(reset = false) {
    const s = this.state();
    const samples = s[5] ?? 0;
    const result = {
      left: s[2] ?? 0,
      right: s[3] ?? 0,
      rms: samples ? Math.sqrt((s[4] ?? 0) / samples) : 0,
      clipped: s[6] ?? 0,
    };
    if (reset) engine().xmp_mix_reset_meter(this.unit);
    return result;
  }
  clear() {
    engine().xmp_mix_clear(this.unit);
  }
}
