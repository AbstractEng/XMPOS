import { z } from "zod";
export const ModuleManifest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    apiVersion: z.literal(1),
    kind: z.enum(["instrument", "effect"]),
    license: z.enum(["Apache-2.0", "MIT", "BSD-3-Clause"]),
    permissions: z.array(z.enum(["audio-output", "simulated-controls"])).max(2),
    parameters: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
            name: z.string().min(1).max(40),
            min: z.number().finite(),
            max: z.number().finite(),
            default: z.number().finite(),
          })
          .strict()
          .refine(
            (p) => p.min < p.max && p.default >= p.min && p.default <= p.max,
            "Invalid parameter range",
          ),
      )
      .max(128),
  })
  .strict()
  .refine(
    (m) => new Set(m.parameters.map((p) => p.id)).size === m.parameters.length,
    "Duplicate parameter id",
  );
export type Manifest = z.infer<typeof ModuleManifest>;
// No physical output or device writer is exposed in this preview SDK.
export type ControlEvent =
  | { type: "pad"; pad: number; velocity: number }
  | { type: "parameter"; id: string; value: number };
export interface InstrumentHost {
  triggerPad(pad: number, velocity: number): void;
}
export interface Instrument {
  manifest: Manifest;
  onControl(event: ControlEvent, host: InstrumentHost): void;
}
export function defineInstrument(instrument: Instrument): Instrument {
  ModuleManifest.parse(instrument.manifest);
  return instrument;
}

export {
  type MachineDefinition,
  type MachineNote,
  type MachineProcessor,
  MachineRegistry,
  type MidiEvent,
  type TrackMachine,
} from "../../core/src/machines.ts";
export {
  midiDestination,
  midiDestinations,
  setMidiDestination,
} from "../../core/src/midi-routing.ts";
export {
  deleteTrack,
  editChain,
  editPerformance,
  PerformanceTake,
  PerformanceTransport,
  performanceControls,
  performanceValues,
  performanceWindow,
} from "../../core/src/performance.ts";
export type {
  ChainEntry,
  Performance,
  PerformanceEvent,
} from "../../core/src/performance-schema.ts";
export type { AutomationLane, Sequence, SequenceNote } from "../../core/src/sequence-schema.ts";
export {
  AutomationTake,
  appendNotes,
  duplicateClip,
  NoteRepeat,
  NoteTake,
  parameterFrame,
  quantizeNotes,
  resizeClip,
  timeline,
} from "../../core/src/sequencer.ts";

export * from "./community/contract.ts";
export * from "./community/package.ts";
export * from "./community/program.ts";
export * from "./community/project.ts";
export * from "./parity.ts";
