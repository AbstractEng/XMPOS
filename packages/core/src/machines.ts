import { z } from "zod";
import { SynthPatchSchema, synthPresets } from "./instrument-schema.ts";

function boundedState(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 512 || depth > 5) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 256;
    if (Array.isArray(item))
      return item.length <= 64 && item.every((child) => visit(child, depth + 1));
    if (typeof item !== "object" || !item || Object.getPrototypeOf(item) !== Object.prototype)
      return false;
    return (
      Object.keys(item).length <= 32 &&
      Object.entries(item).every(
        ([key, child]) =>
          key.length <= 64 &&
          !["__proto__", "constructor", "prototype"].includes(key) &&
          visit(child, depth + 1),
      )
    );
  };
  return visit(value, 0);
}
export const TrackMachineSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/),
    base: z.enum(["audio", "midi"]),
    version: z.number().int().min(1).max(1000),
    state: z
      .record(z.string(), z.unknown())
      .refine(boundedState, "Machine state exceeds JSON limits"),
  })
  .strict();
export type TrackMachine = z.infer<typeof TrackMachineSchema>;
export interface MachineNote {
  id: number;
  note: number;
  velocity: number;
  durationFrames: number;
}
export interface MidiEvent {
  kind: "on" | "off";
  id: number;
  note: number;
  velocity: number;
  channel: number;
}
export interface MachineProcessor {
  noteOn(event: MachineNote): boolean;
  noteOff(id: number): void;
  panic(): void;
  setParameter?(id: string, value: number): void;
  expression?(id: number, dimension: "pressure" | "pitch" | "timbre", value: number): void;
  process(output: Float32Array, frames: number): void;
}
export interface MachineDefinition {
  automation?: boolean;
  id: string;
  name: string;
  base: "audio" | "midi";
  version: number;
  capabilities: readonly (
    | "notes"
    | "velocity"
    | "pressure"
    | "pitch"
    | "timbre"
    | "audio-input"
    | "audio-output"
    | "midi-output"
  )[];
  parameters: readonly {
    id: string;
    name: string;
    unit: string;
    min: number;
    max: number;
    defaultValue: number;
    step?: number;
  }[];
  defaults: Record<string, unknown>;
  validate(state: Record<string, unknown>): void;
  create?: (context: {
    sampleRate: number;
    assets?: readonly { id: string; pcm: Float32Array; sampleRate: number }[];
    state: Record<string, unknown>;
    emitMidi: (event: MidiEvent) => void;
  }) => MachineProcessor;
}
export class MachineRegistry {
  private definitions = new Map<string, MachineDefinition>();
  register(definition: MachineDefinition) {
    TrackMachineSchema.parse({
      id: definition.id,
      base: definition.base,
      version: definition.version,
      state: definition.defaults,
    });
    if (this.definitions.has(definition.id)) throw new Error("Machine ID already registered");
    if (
      definition.parameters.length > 16 ||
      new Set(definition.parameters.map((p) => p.id)).size !== definition.parameters.length
    )
      throw new Error("Invalid machine parameters");
    for (const p of definition.parameters)
      if (
        !/^[a-z][a-z0-9-]{0,31}$/.test(p.id) ||
        ![p.min, p.max, p.defaultValue].every(Number.isFinite) ||
        p.min >= p.max ||
        (p.step !== undefined &&
          (!Number.isFinite(p.step) || p.step <= 0 || p.step > p.max - p.min)) ||
        p.defaultValue < p.min ||
        p.defaultValue > p.max
      )
        throw new Error("Invalid machine parameter bounds");
    definition.validate(JSON.parse(JSON.stringify(definition.defaults)));
    this.definitions.set(definition.id, definition);
  }
  list() {
    return [...this.definitions.values()];
  }
  get(machine: TrackMachine | undefined) {
    const instance =
      machine ?? ({ id: "xmp.sampler", base: "audio", version: 1, state: {} } as const);
    const definition = this.definitions.get(instance.id);
    if (!definition || definition.version !== instance.version || definition.base !== instance.base)
      return undefined;
    definition.validate(instance.state);
    return definition;
  }
  instantiate(id: string): TrackMachine {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error("Machine is not installed");
    return TrackMachineSchema.parse({
      id,
      base: definition.base,
      version: definition.version,
      state: JSON.parse(JSON.stringify(definition.defaults)),
    });
  }
}
export const machines = new MachineRegistry();
// Additive, opt-in v1 state: old channel-only MIDI projects stay event-only.
export const MidiStateSchema = z
  .object({
    channel: z.number().int().min(1).max(16),
    destination: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict();
machines.register({
  id: "xmp.sampler",
  name: "Pad sampler",
  base: "audio",
  version: 1,
  capabilities: ["notes", "velocity", "audio-output"],
  parameters: [],
  defaults: {},
  // A Kit has no state; a Sampler says how its one sample plays: across the pads
  // as notes ("keys") or chopped into slices on the pads ("slices").
  validate(state) {
    z.object({ mode: z.enum(["keys", "slices"]).optional() })
      .strict()
      .parse(state);
  },
});
machines.register({
  id: "xmp.subtractive",
  automation: true,
  name: "Subtractive synth",
  base: "audio",
  version: 1,
  capabilities: ["notes", "velocity", "audio-output"],
  parameters: [
    { id: "attack", name: "Attack", unit: "seconds", min: 0.001, max: 2, defaultValue: 0.005 },
    { id: "decay", name: "Decay", unit: "seconds", min: 0.001, max: 2, defaultValue: 0.12 },
    { id: "sustain", name: "Sustain", unit: "normalized", min: 0, max: 1, defaultValue: 0.45 },
    { id: "release", name: "Release", unit: "seconds", min: 0.005, max: 2, defaultValue: 0.12 },
    { id: "cutoff", name: "Tone", unit: "Hz", min: 30, max: 16000, defaultValue: 750 },
    { id: "resonance", name: "Resonance", unit: "normalized", min: 0, max: 1, defaultValue: 0 },
    {
      id: "env-amount",
      name: "Filter envelope",
      unit: "octaves",
      min: 0,
      max: 6,
      defaultValue: 0,
    },
    {
      id: "env-decay",
      name: "Filter decay",
      unit: "seconds",
      min: 0.01,
      max: 2,
      defaultValue: 0.3,
    },
    { id: "detune", name: "Detune", unit: "cents", min: 0, max: 50, defaultValue: 0 },
    { id: "glide", name: "Glide", unit: "seconds", min: 0, max: 1, defaultValue: 0 },
  ],
  defaults: { ...synthPresets[0] },
  validate(state) {
    SynthPatchSchema.parse(state);
  },
});
machines.register({
  id: "xmp.midi",
  automation: true,
  name: "MIDI track",
  base: "midi",
  version: 1,
  capabilities: ["notes", "velocity", "midi-output"],
  parameters: [
    {
      id: "channel",
      name: "Channel",
      unit: "MIDI channel",
      min: 1,
      max: 16,
      defaultValue: 1,
      step: 1,
    },
  ],
  defaults: { channel: 1 },
  validate(state) {
    MidiStateSchema.parse(state);
  },
});
