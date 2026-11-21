// The binding for XMP's C++ sequencer (native/include/xmp/sequencer.hpp),
// compiled to WebAssembly by `npm run engine:wasm`. Each query lays the scene
// out in the module's memory (tracks, clips, step and sequence notes, and for
// parameter frames every parameter's sources, lanes, locks and modulations),
// asks the sequencer, and turns its answer back into the project's objects.
// The original TypeScript was retired in phase 9 part 5 (docs/cpp-port.md).
import { decodeBase64 } from "./engine.ts";
import { SEQUENCER_WASM_BASE64 } from "./generated/xmp-sequencer-wasm.ts";
import type { Project } from "./index.ts";
import { trackPads } from "./pads.ts";
import { type ParameterDefinition, parameterRegistry, parameterSources } from "./parameters.ts";
import type { SequenceNote } from "./sequence-schema.ts";

interface SequencerExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  seq_scratch_a(): number;
  seq_scratch_b(): number;
  seq_offsets(): number;
  seq_values(): number;
  seq_results(): number;
  seq_result_size(): number;
  seq_error(): number;
  seq_groove_position(position: number, swing: number): number;
  seq_step_time(step: number, bpm: number, swing: number): number;
  seq_reset(seed: number): void;
  seq_pool_tail(): number;
  seq_pool_room(): number;
  seq_text(length: number): number;
  seq_project(id: number): void;
  seq_track(id: number, clip: number, length: number): number;
  seq_note(
    track: number,
    legacy: number,
    id: number,
    pad: number,
    note: number,
    position: number,
    duration: number,
    velocity: number,
    probability: number,
    microtiming: number,
    condition: number,
  ): number;
  seq_clip_track(length: number): number;
  seq_parameter(present: number): number;
  seq_lane(track: number, parameter: number, count: number): number;
  seq_lock(track: number, parameter: number, position: number, value: number): number;
  seq_mod(
    track: number,
    parameter: number,
    kind: number,
    amount: number,
    cycles: number,
    phase: number,
  ): number;
  seq_window(from: number, to: number, fill: number): number;
  seq_timeline(swing: number, bpm: number, rate: number): void;
  seq_step_events(step: number): number;
  seq_parameter_frame(position: number): number;
  seq_parameter_frame_track(position: number, only: number): number;
}

const CONDITIONS: Record<SequenceNote["condition"], number> = {
  always: 0,
  first: 1,
  "not-first": 2,
  fill: 3,
  "not-fill": 4,
  "every-2": 5,
  "every-4": 6,
};
const SOURCES = ["base", "automation", "stepLock", "macro", "lfo"] as const;

let instance: SequencerExports | undefined;
function sequencer(): SequencerExports {
  if (!instance) {
    const module = new WebAssembly.Module(decodeBase64(SEQUENCER_WASM_BASE64));
    instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: { random_get: () => 0 },
    }).exports as unknown as SequencerExports;
    instance._initialize?.();
  }
  return instance;
}

export const grooveFrom = (position: number, swing: number) =>
  sequencer().seq_groove_position(position, swing);
export const stepSeconds = (step: number, bpm: number, swing: number) =>
  sequencer().seq_step_time(step, bpm, swing);

function text(s: SequencerExports, value: string) {
  if (value.length > s.seq_pool_room()) throw new Error("Sequence plan exceeds its text budget");
  const units = new Uint16Array(s.memory.buffer, s.seq_pool_tail(), value.length);
  for (let i = 0; i < value.length; i++) units[i] = value.charCodeAt(i);
  return s.seq_text(value.length);
}
function checked(s: SequencerExports, ok: number) {
  if (!ok || s.seq_error()) throw new Error("Sequence plan exceeds the sequencer budget");
}

type Track = Project["tracks"][number];
type Clip = Track["clips"][number];
type Step = Clip["steps"][number];
interface PlannedNote {
  legacy: boolean;
  id: string;
  step?: Step;
  note: SequenceNote | { pad: number; note: number; velocity: number };
}
export interface Plan {
  tracks: { track: Track; clip: Clip }[];
  notes: PlannedNote[];
}

// The audible tracks of a scene and their notes (step notes first, as notesInWindow).
export function planNotes(project: Project, sceneId: string): Plan | undefined {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return undefined;
  const s = sequencer(),
    plan: Plan = { tracks: [], notes: [] };
  s.seq_reset(project.seed ?? 0);
  s.seq_project(text(s, project.id));
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === scene.clips[track.id]);
    if (!clip || track.muted) continue;
    const t = s.seq_track(text(s, track.id), text(s, clip.id), clip.length);
    if (t < 0) checked(s, 0);
    plan.tracks.push({ track, clip });
    for (const step of clip.steps) {
      const id = `step-${step.pad}-${step.step}`,
        note =
          step.note ??
          (track.machine?.id === "xmp.subtractive"
            ? 48 + step.pad
            : (trackPads(project, track.id)[step.pad]?.playback?.rootNote ?? 60));
      checked(
        s,
        s.seq_note(
          t,
          1,
          text(s, id),
          step.pad,
          note,
          step.step,
          step.duration ?? 1,
          step.velocity,
          step.probability,
          0,
          0,
        ),
      );
      plan.notes.push({
        legacy: true,
        id,
        step,
        note: { pad: step.pad, note, velocity: step.velocity },
      });
    }
    for (const n of clip.sequence?.notes ?? []) {
      checked(
        s,
        s.seq_note(
          t,
          0,
          text(s, n.id),
          n.pad,
          n.note,
          n.position,
          n.duration,
          n.velocity,
          n.probability,
          n.microtiming,
          CONDITIONS[n.condition],
        ),
      );
      plan.notes.push({ legacy: false, id: n.id, note: n });
    }
  }
  checked(s, 1);
  return plan;
}

export interface WindowNote {
  id: string;
  trackId: string;
  pad: number;
  note: number;
  position: number;
  duration: number;
  velocity: number;
  cycle: number;
  frame: number;
  durationFrames: number;
}
function readResults(s: SequencerExports, plan: Plan, count: number, frames: boolean) {
  const view = new DataView(s.memory.buffer, s.seq_results(), count * s.seq_result_size()),
    size = s.seq_result_size(),
    out: WindowNote[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * size,
      t = plan.tracks[view.getInt32(at, true)],
      n = plan.notes[view.getInt32(at + 4, true)];
    if (!t || !n) throw new Error("Sequencer result out of range");
    const cycle = Number(view.getBigInt64(at + 8, true));
    out.push({
      id: `${t.track.id}:${t.clip.id}:${n.legacy ? "legacy:" : ""}${n.id}:${cycle}`,
      trackId: t.track.id,
      pad: n.note.pad,
      note: n.note.note,
      position: view.getFloat64(at + 16, true),
      duration: view.getFloat64(at + 24, true),
      velocity: n.note.velocity,
      cycle,
      frame: frames ? view.getFloat64(at + 32, true) : 0,
      durationFrames: frames ? view.getFloat64(at + 40, true) : 0,
    });
  }
  return out;
}

// notesInWindow and timeline: the notes starting in [from, to), with frames when `timing` is given.
export function windowNotes(
  project: Project,
  sceneId: string,
  from: number,
  to: number,
  fill: boolean,
  timing?: { swing: number; bpm: number; rate: number },
) {
  const plan = planNotes(project, sceneId);
  if (!plan) throw new Error("Missing scene");
  const s = sequencer(),
    count = s.seq_window(from, to, fill ? 1 : 0);
  if (count < 0) throw new Error("Sequence event budget exceeded");
  if (timing) s.seq_timeline(timing.swing, timing.bpm, timing.rate);
  return readResults(s, plan, count, Boolean(timing));
}

// eventsAtStep: the step notes due on an absolute step, with their source steps.
export function stepEvents(project: Project, sceneId: string, absoluteStep: number) {
  if (!Number.isSafeInteger(absoluteStep) || absoluteStep < 0) return [];
  const plan = planNotes(project, sceneId);
  if (!plan) return [];
  const s = sequencer(),
    count = s.seq_step_events(absoluteStep),
    view = new DataView(s.memory.buffer, s.seq_results(), count * s.seq_result_size()),
    out: { track: Track; step: Step }[] = [];
  for (let i = 0; i < count; i++) {
    const t = plan.tracks[view.getInt32(i * s.seq_result_size(), true)],
      n = plan.notes[view.getInt32(i * s.seq_result_size() + 4, true)];
    if (t && n?.step) out.push({ track: t.track, step: n.step });
  }
  return out;
}

// parameterFrame: every registered parameter's value at `position` in the scene.
// Lays out every parameter's sources, then the sequences of `clips` as clip
// tracks (in order; a clip without a sequence gets none, -1).
function loadParameters(
  project: Project,
  registry: readonly ParameterDefinition[],
  clips: readonly (Clip | undefined)[],
) {
  const s = sequencer(),
    index = new Map(registry.map((d, i) => [d.id, i]));
  s.seq_reset(project.seed ?? 0);
  const scratchA = () => new Float64Array(s.memory.buffer, s.seq_scratch_a(), 256),
    scratchB = () => new Float64Array(s.memory.buffer, s.seq_scratch_b(), 256);
  for (const definition of registry) {
    const sources = parameterSources(project, definition.id, definition),
      a = scratchA();
    let present = 0;
    SOURCES.forEach((source, k) => {
      const value = sources[source];
      if (value !== undefined || k === 0) {
        present |= 1 << k;
        a[k] = value ?? Number.NaN;
      }
    });
    checked(s, s.seq_parameter(present));
  }
  const tracks = clips.map((clip) => {
    const seq = clip?.sequence;
    if (!clip || !seq) return -1;
    const t = s.seq_clip_track(clip.length);
    if (t < 0) checked(s, 0);
    for (const lane of seq.lanes) {
      const p = index.get(lane.parameter);
      if (p === undefined) continue;
      const a = scratchA(),
        b = scratchB();
      lane.points.forEach((point, i) => {
        a[i] = point.position;
        b[i] = point.value;
      });
      checked(s, s.seq_lane(t, p, lane.points.length));
    }
    for (const lock of seq.locks) {
      const p = index.get(lock.parameter);
      if (p !== undefined) checked(s, s.seq_lock(t, p, lock.position, lock.value));
    }
    for (const mod of seq.modulations) {
      const p = index.get(mod.parameter);
      if (p !== undefined)
        checked(
          s,
          s.seq_mod(t, p, mod.kind === "macro" ? 0 : 1, mod.amount, mod.cycles, mod.phase),
        );
    }
    return t;
  });
  return { s, tracks };
}
function frameChecked(code: number) {
  if (code < 0) throw new Error(`Invalid ${SOURCES[(-code - 1) % 5] ?? "base"} parameter value`);
}

export function frameParameters(
  project: Project,
  sceneId: string,
  position: number,
  macroOffsets: Record<string, number>,
): Record<string, number> {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error("Missing scene");
  const registry = parameterRegistry(project),
    { s } = loadParameters(
      project,
      registry,
      project.tracks.map((track) => track.clips.find((c) => c.id === scene.clips[track.id])),
    );
  const offsets = new Float64Array(s.memory.buffer, s.seq_offsets(), registry.length);
  registry.forEach((d, i) => {
    offsets[i] = macroOffsets[d.id] ?? Number.NaN;
  });
  frameChecked(s.seq_parameter_frame(position));
  const values = new Float64Array(s.memory.buffer, s.seq_values(), registry.length),
    out: Record<string, number> = {};
  registry.forEach((d, i) => {
    out[d.id] = values[i] ?? 0;
  });
  return out;
}

/** A parameter table for repeated frames: every parameter's sources and the
 *  sequences of `clips`, laid out once. Uses the shared sequencer, so frames
 *  are taken before anything else queries it. */
export interface ParameterTable {
  /** Clip track of each entry of `clips`, or -1 when it has no sequence. */
  readonly tracks: readonly number[];
  /** Values (registry order) at `position` with `offsets` (NaN: none) and
   *  only clip track `only` (-1: none) applied. The view is reused. */
  frame(position: number, offsets: Float64Array, only: number): Float64Array;
}
export function parameterTable(
  project: Project,
  registry: readonly ParameterDefinition[],
  clips: readonly (Clip | undefined)[],
): ParameterTable {
  const { s, tracks } = loadParameters(project, registry, clips),
    n = registry.length;
  return {
    tracks,
    frame(position, offsets, only) {
      new Float64Array(s.memory.buffer, s.seq_offsets(), n).set(offsets.subarray(0, n));
      frameChecked(s.seq_parameter_frame_track(position, only));
      return new Float64Array(s.memory.buffer, s.seq_values(), n);
    },
  };
}
