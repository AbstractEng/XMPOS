import { z } from "zod";
import type { MachineDefinition, MachineProcessor } from "../../../core/src/machines.ts";
import {
  type CommunityManifest,
  Dimension,
  type MusicalEvent,
  negotiateModule,
  validateTake,
} from "./contract.ts";

const binding = z.union([
  z.number().finite().min(-20000).max(20000),
  z.object({ parameter: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict(),
]);
export const ProgramSchema = z
  .object({
    format: z.literal("xmp-dsp-graph"),
    version: z.literal(1),
    source: z.enum(["sine", "triangle", "virtual-input"]),
    gain: binding,
    cutoff: binding,
    requires: z
      .array(
        z
          .object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), version: z.string().max(24) })
          .strict(),
      )
      .max(8),
    migrations: z
      .array(
        z
          .object({
            from: z.number().int().min(1).max(999),
            to: z.number().int().min(2).max(1000),
            renames: z.record(
              z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
              z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
            ),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type Program = z.infer<typeof ProgramSchema>;
export function validateProgram(manifest: CommunityManifest, input: unknown) {
  const program = ProgramSchema.parse(input);
  if ((manifest.kind === "effect") !== (program.source === "virtual-input"))
    throw new Error("Program source does not match module kind");
  for (const [key, low, high] of [
    ["gain", 0, 1],
    ["cutoff", 20, 20000],
  ] as const) {
    const value = program[key],
      p =
        typeof value === "number"
          ? undefined
          : manifest.parameters.find((p) => p.id === value.parameter);
    if (
      typeof value === "number"
        ? value < low || value > high
        : !p || p.min < low || p.max > high || p.unit !== (key === "gain" ? "linear" : "Hz")
    )
      throw new Error(`Program ${key} has missing or incompatible parameter`);
  }
  for (const m of program.migrations)
    if (
      m.to !== m.from + 1 ||
      m.to > manifest.stateVersion ||
      Object.keys(m.renames).length > 16 ||
      new Set(Object.values(m.renames)).size !== Object.keys(m.renames).length
    )
      throw new Error("Invalid state migration");
  if (new Set(program.migrations.map((m) => m.from)).size !== program.migrations.length)
    throw new Error("Ambiguous state migration");
  return program;
}
export function validateState(m: CommunityManifest, input: Record<string, unknown>) {
  if (Object.keys(input).length !== m.parameters.length)
    throw new Error("State parameter set differs from manifest");
  for (const p of m.parameters) {
    const v = input[p.id];
    if (typeof v !== "number" || !Number.isFinite(v) || v < p.min || v > p.max)
      throw new Error(`Invalid state parameter ${p.id}`);
  }
  return input as Record<string, number>;
}
export function migrateState(
  m: CommunityManifest,
  program: Program,
  version: number,
  state: Record<string, unknown>,
) {
  const result = { ...state };
  if (!Number.isInteger(version) || version < 1 || version > m.stateVersion)
    throw new Error("Unsupported state version");
  while (version < m.stateVersion) {
    const migration = program.migrations.find((v) => v.from === version);
    if (!migration) throw new Error(`Missing migration ${version} -> ${version + 1}`);
    const before = { ...result };
    for (const key of Object.keys(migration.renames)) delete result[key];
    for (const [from, to] of Object.entries(migration.renames)) {
      if (before[from] === undefined || (before[to] !== undefined && to !== from))
        throw new Error("Migration would lose or overwrite state");
      result[to] = before[from];
    }
    version++;
  }
  for (const p of m.parameters) result[p.id] ??= p.default;
  return { ...validateState(m, result) };
}
interface Voice {
  active: boolean;
  id: number;
  note: number;
  velocity: number;
  phase: number;
  low: number;
  pressure: number;
  pitch: number;
  timbre: number;
  release: number;
  remaining: number;
}
export class CommunityProcessor implements MachineProcessor {
  private voices: Voice[] = Array.from({ length: 32 }, () => ({
    active: false,
    id: 0,
    note: 60,
    velocity: 0,
    phase: 0,
    low: 0,
    pressure: 1,
    pitch: 0,
    timbre: 1,
    release: -1,
    remaining: 0,
  }));
  private state: Record<string, number>;
  private manifest: CommunityManifest;
  private program: Program;
  private rate: number;
  private effectLow = 0;
  constructor(
    manifest: CommunityManifest,
    program: Program,
    state: Record<string, unknown>,
    rate = 48000,
  ) {
    this.manifest = negotiateModule(manifest).manifest;
    this.program = validateProgram(manifest, program);
    this.state = { ...validateState(manifest, state) };
    this.rate = rate;
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96000)
      throw new Error("Invalid module sample rate");
  }
  noteOn(e: { id: number; note: number; velocity: number; durationFrames: number }) {
    if (
      !Number.isInteger(e.id) ||
      e.id < 1 ||
      e.id > 0x7fffffff ||
      !Number.isInteger(e.note) ||
      e.note < 0 ||
      e.note > 127 ||
      !Number.isFinite(e.velocity) ||
      e.velocity < 0 ||
      e.velocity > 1 ||
      !Number.isInteger(e.durationFrames) ||
      e.durationFrames < 0 ||
      e.durationFrames > this.rate * 60
    )
      throw new Error("Invalid module note");
    if (this.manifest.kind !== "instrument" || this.voices.some((v) => v.active && v.id === e.id))
      return false;
    const v = this.voices.find((v) => !v.active);
    if (!v) return false;
    Object.assign(v, {
      active: true,
      id: e.id,
      note: e.note,
      velocity: e.velocity,
      phase: 0,
      low: 0,
      pressure: 1,
      pitch: 0,
      timbre: 1,
      release: -1,
      remaining: e.durationFrames,
    });
    return true;
  }
  expression(id: number, dimension: Dimension, value: number) {
    Dimension.parse(dimension);
    if (
      !this.manifest.capabilities.includes(dimension) ||
      !Number.isFinite(value) ||
      (dimension === "pitch" ? value < -48 || value > 48 : value < 0 || value > 1)
    )
      throw new Error("Expression capability or value unavailable");
    const v = this.voices.find((v) => v.active && v.id === id);
    if (!v) throw new Error("Unknown note identity");
    v[dimension] = value;
  }
  noteOff(id: number) {
    const v = this.voices.find((v) => v.active && v.id === id);
    if (v && v.release < 0) v.release = Math.round(this.rate * 0.005);
  }
  panic() {
    for (const v of this.voices)
      if (v.active && v.release < 0) v.release = Math.round(this.rate * 0.005);
    this.effectLow = 0;
  }
  setParameter(id: string, value: number) {
    const p = this.manifest.parameters.find((p) => p.id === id);
    if (!p || !Number.isFinite(value) || value < p.min || value > p.max)
      throw new Error("Invalid module parameter");
    this.state[id] = value;
  }
  private value(binding: Program["gain"]) {
    return typeof binding === "number" ? binding : (this.state[binding.parameter] ?? 0);
  }
  process(output: Float32Array, frames: number) {
    this.processInput(undefined, output, frames);
  }
  processInput(input: Float32Array | undefined, output: Float32Array, frames: number) {
    if (
      !Number.isInteger(frames) ||
      frames < 0 ||
      frames > 4096 ||
      output.length < frames ||
      (input && input.length < frames)
    )
      throw new Error("Invalid module processing block");
    const gain = this.value(this.program.gain),
      cutoff = this.value(this.program.cutoff);
    for (let i = 0; i < frames; i++) {
      let mixed = 0;
      if (this.manifest.kind === "effect") {
        const incoming = input?.[i] ?? 0;
        const value = Number.isFinite(incoming) ? incoming : 0;
        this.effectLow +=
          (1 - Math.exp((-2 * Math.PI * Math.min(cutoff, this.rate * 0.45)) / this.rate)) *
          (value - this.effectLow);
        mixed = this.effectLow * gain;
      } else
        for (const v of this.voices) {
          if (!v.active) continue;
          const oscillator =
            this.program.source === "sine"
              ? Math.sin(v.phase * Math.PI * 2)
              : 1 - 4 * Math.abs(v.phase - 0.5);
          v.phase =
            (v.phase + Math.min(0.45, (440 * 2 ** ((v.note + v.pitch - 69) / 12)) / this.rate)) % 1;
          v.low +=
            (1 -
              Math.exp(
                (-2 * Math.PI * Math.min(cutoff * (0.1 + 0.9 * v.timbre), this.rate * 0.45)) /
                  this.rate,
              )) *
            (oscillator - v.low);
          mixed +=
            v.low *
            gain *
            v.velocity *
            v.pressure *
            (v.release >= 0 ? v.release / Math.round(this.rate * 0.005) : 1);
          if (v.remaining > 0 && --v.remaining === 0) this.noteOff(v.id);
          if (v.release >= 0 && --v.release <= 0) v.active = false;
        }
      output[i] = Math.max(-1, Math.min(1, Number.isFinite(mixed) ? mixed : 0));
    }
  }
  snapshot() {
    return this.voices
      .filter((v) => v.active)
      .map((v) => ({
        id: v.id,
        note: v.note,
        pressure: v.pressure,
        pitch: v.pitch,
        timbre: v.timbre,
      }));
  }
}
export function communityMachine(manifest: CommunityManifest, program: Program): MachineDefinition {
  const m = negotiateModule(manifest).manifest,
    p = validateProgram(m, program);
  if (m.kind !== "instrument")
    throw new Error("Effect packages use the explicit virtual-input processor");
  return {
    id: `community.${m.id}`,
    name: m.name,
    version: m.stateVersion,
    base: "audio",
    automation: true,
    capabilities: m.capabilities.filter(
      (c): c is "notes" | "velocity" | "pressure" | "pitch" | "timbre" | "audio-output" =>
        ["notes", "velocity", "pressure", "pitch", "timbre", "audio-output"].includes(c),
    ),
    parameters: m.parameters.map((p) => ({ ...p, defaultValue: p.default })),
    defaults: Object.fromEntries(m.parameters.map((p) => [p.id, p.default])),
    validate: (state) => {
      validateState(m, state);
    },
    create: ({ sampleRate, state }) => new CommunityProcessor(m, p, state, sampleRate),
  };
}
export function renderCommunity(
  manifest: CommunityManifest,
  program: Program,
  state: Record<string, unknown>,
  events: MusicalEvent[],
  seconds = 1,
) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 8)
    throw new Error("Preview duration budget is eight seconds");
  const take = validateTake(events, manifest.capabilities, manifest.capabilities);
  if (take.some((e) => e.timestamp >= seconds)) throw new Error("Take exceeds preview duration");
  const processor = new CommunityProcessor(manifest, program, state),
    pcm = new Float32Array(Math.round(seconds * 48000)),
    sample = new Float32Array(1);
  let next = 0;
  for (let frame = 0; frame < pcm.length; frame++) {
    while (take[next] && Math.round((take[next]?.timestamp ?? 0) * 48000) <= frame) {
      const e = take[next++];
      if (!e) break;
      if (e.kind === "on") processor.noteOn({ ...e, durationFrames: 0 });
      else if (e.kind === "off") processor.noteOff(e.id);
      else processor.expression(e.id, e.dimension, e.value);
    }
    if (manifest.kind === "effect") {
      sample[0] = frame === 0 ? 0.5 : 0;
      processor.processInput(sample, sample, 1);
    } else processor.process(sample, 1);
    pcm[frame] = sample[0] ?? 0;
  }
  processor.panic();
  return pcm;
}
