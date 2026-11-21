import { type Project, ProjectSchema } from "./index.ts";
import { machines } from "./machines.ts";
import {
  type AutomationLane,
  emptySequence,
  LaneSchema,
  type Sequence,
  type SequenceNote,
  SequenceNoteSchema,
} from "./sequence-schema.ts";
import { frameParameters, grooveFrom, windowNotes } from "./sequencer-engine.ts";

export { emptySequence } from "./sequence-schema.ts";
export type Clip = Project["tracks"][number]["clips"][number];
export function clipFor(project: Project, trackId: string, clipId: string): Clip {
  const clip = project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error("Missing clip");
  return clip;
}
export function editSequence(
  project: Project,
  track: string,
  clipId: string,
  change: (seq: Sequence) => void,
): Project {
  const next = structuredClone(project),
    clip = clipFor(next, track, clipId);
  clip.sequence ??= emptySequence();
  change(clip.sequence);
  return ProjectSchema.parse(next);
}
export function appendNotes(
  project: Project,
  track: string,
  clipId: string,
  notes: SequenceNote[],
): Project {
  return editSequence(project, track, clipId, (seq) => seq.notes.push(...notes));
}
export function quantizeNotes(
  project: Project,
  track: string,
  clipId: string,
  ids: string[],
  grid: number,
  restore = false,
): Project {
  if (![0.25, 0.5, 1, 2, 4].includes(grid)) throw new Error("Unsupported quantization grid");
  const length = clipFor(project, track, clipId).length;
  return editSequence(project, track, clipId, (seq) => {
    for (const n of seq.notes)
      if (ids.includes(n.id)) {
        n.original ??= {
          position: n.position,
          duration: n.duration,
          velocity: n.velocity,
          timestamp: 0,
        };
        n.position = restore
          ? n.original.position
          : Math.min(length - 1 / 960, Math.round(n.original.position / grid) * grid);
        n.duration = Math.min(restore ? n.original.duration : n.duration, length - n.position);
      }
  });
}
// The notes a clip would lose at a shorter length (they start at or after it).
export function notesBeyond(clip: Project["tracks"][number]["clips"][number], length: number) {
  return (
    clip.steps.filter((n) => n.step >= length).length +
    (clip.sequence?.notes.filter((n) => n.position >= length).length ?? 0)
  );
}
export function resizeClip(
  project: Project,
  track: string,
  clipId: string,
  length: number,
): Project {
  const next = structuredClone(project),
    clip = clipFor(next, track, clipId);
  clip.length = length;
  clip.steps = clip.steps
    .filter((n) => n.step < length)
    .map((n) => ({
      ...n,
      ...(n.duration ? { duration: Math.min(n.duration, length - n.step) } : {}),
    }));
  if (clip.sequence) {
    clip.sequence.notes = clip.sequence.notes
      .filter((n) => n.position < length)
      .map((n) => ({ ...n, duration: Math.min(n.duration, length - n.position) }));
    clip.sequence.locks = clip.sequence.locks.filter((l) => l.position < length);
    for (const lane of clip.sequence.lanes)
      lane.points = lane.points.filter((p) => p.position <= length);
  }
  return ProjectSchema.parse(next);
}
export function duplicateClip(project: Project, trackId: string, clipId: string): Project {
  const next = structuredClone(project),
    track = next.tracks.find((t) => t.id === trackId);
  if (!track || track.clips.length >= 16) throw new Error("Clip budget reached");
  const original = clipFor(next, trackId, clipId);
  let i = 0;
  while (track.clips.some((c) => c.id === `copy-${i}`)) i++;
  track.clips.push({
    ...structuredClone(original),
    id: `copy-${i}`,
    name: `${original.name.slice(0, 30)} copy`,
  });
  return ProjectSchema.parse(next);
}
export function groovePosition(position: number, swing: number): number {
  if (
    !Number.isFinite(position) ||
    position < 0 ||
    !Number.isFinite(swing) ||
    swing < 0 ||
    swing > 0.5
  )
    throw new Error("Invalid groove");
  return grooveFrom(position, swing);
}
// Note conditions, probability and microtiming are applied by the C++ sequencer
// (native/include/xmp/sequencer.hpp); the original TypeScript was retired in phase 9 part 5.
export interface SequencedNote {
  id: string;
  trackId: string;
  pad: number;
  note: number;
  position: number;
  duration: number;
  velocity: number;
  cycle: number;
}
export function notesInWindow(
  project: Project,
  sceneId: string,
  from: number,
  to: number,
  fill = false,
): SequencedNote[] {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    to <= from ||
    to - from > 64 ||
    to > 1000000
  )
    throw new Error("Invalid sequence window");
  return windowNotes(project, sceneId, from, to, fill).map(
    ({ frame: _frame, durationFrames: _duration, ...note }) => note,
  );
}
export function laneValue(lane: AutomationLane, position: number, fallback: number) {
  let value = fallback;
  for (const point of lane.points) {
    if (point.position > position) break;
    value = point.value;
  }
  return value;
}
export function parameterFrame(
  project: Project,
  sceneId: string,
  position: number,
  macroOffsets: Record<string, number> = {},
): Record<string, number> {
  if (!Number.isFinite(position) || position < 0) throw new Error("Invalid parameter position");
  return frameParameters(project, sceneId, position, macroOffsets);
}
export function hasSequence(project: Project) {
  return project.tracks.some((t) => t.clips.some((c) => c.sequence));
}
export interface TimelineNote extends SequencedNote {
  frame: number;
  durationFrames: number;
}
export function timeline(
  project: Project,
  scene: string,
  from: number,
  to: number,
  fill = false,
  swing = project.swing,
  rate = 48000,
): TimelineNote[] {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    to <= from ||
    to - from > 64 ||
    to > 1000000
  )
    throw new Error("Invalid sequence window");
  const notes = windowNotes(project, scene, from, to, fill, { swing, bpm: project.bpm, rate });
  if (notes.length && (!Number.isFinite(swing) || swing < 0 || swing > 0.5))
    throw new Error("Invalid groove");
  return notes;
}
export class NoteTake {
  private active = new Map<
    string,
    { pad: number; note: number; position: number; velocity: number; timestamp: number }
  >();
  private notes: SequenceNote[] = [];
  private next = 0;
  readonly length: number;
  readonly bpm: number;
  readonly prefix: string;
  constructor(length: number, bpm: number, prefix = "take") {
    if (
      ![16, 32, 64].includes(length) ||
      !Number.isFinite(bpm) ||
      bpm < 30 ||
      bpm > 300 ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(prefix)
    )
      throw new Error("Invalid take");
    this.length = length;
    this.bpm = bpm;
    this.prefix = prefix;
  }
  on(key: string, pad: number, note: number, velocity: number, seconds: number) {
    if (typeof key !== "string" || key.length < 1 || key.length > 64)
      throw new Error("Invalid input note identity");
    if (
      this.active.has(key) ||
      this.active.size >= 32 ||
      this.notes.length + this.active.size >= 1024
    )
      throw new Error("Take voice/note budget exceeded");
    const position = ((seconds * this.bpm) / 60) * 4;
    if (position < 0 || position >= this.length) throw new Error("Note outside recording pass");
    SequenceNoteSchema.parse({
      id: "check",
      pad,
      note,
      velocity,
      position,
      duration: 1 / 960,
      probability: 1,
      microtiming: 0,
      condition: "always",
    });
    this.active.set(key, { pad, note, velocity, position, timestamp: seconds });
  }
  off(key: string, seconds: number) {
    const n = this.active.get(key);
    if (!n) return;
    if (!Number.isFinite(seconds) || seconds < n.timestamp)
      throw new Error("Invalid note-off timestamp");
    const duration = Math.max(
      1 / 960,
      Math.min(this.length - n.position, ((seconds * this.bpm) / 60) * 4 - n.position),
    );
    const { timestamp, ...played } = n;
    this.notes.push(
      SequenceNoteSchema.parse({
        ...played,
        id: `${this.prefix}-${this.next++}`,
        duration,
        probability: 1,
        microtiming: 0,
        condition: "always",
        original: { position: n.position, duration, velocity: n.velocity, timestamp: n.timestamp },
      }),
    );
    this.active.delete(key);
  }
  finish(seconds: number) {
    for (const key of this.active.keys()) this.off(key, seconds);
    const result = structuredClone(this.notes);
    this.notes = [];
    return result;
  }
  get held() {
    return this.active.size;
  }
}
export class NoteRepeat {
  private held: { note: number; pad: number; velocity: number } | undefined;
  private next = 0;
  private stopped = false;
  readonly pressure: boolean;
  readonly interval: number;
  constructor(pressure: boolean, interval = 1) {
    if (![0.25, 0.5, 1, 2, 4].includes(interval)) throw new Error("Invalid repeat interval");
    this.pressure = pressure;
    this.interval = interval;
  }
  hold(note: number, pad: number, velocity: number, position = 0) {
    if (!Number.isFinite(position) || position < 0 || position > 1000000)
      throw new Error("Invalid repeat position");
    SequenceNoteSchema.parse({
      id: "repeat",
      note,
      pad,
      velocity,
      position: position % 64,
      duration: this.interval / 2,
      probability: 1,
      microtiming: 0,
      condition: "always",
    });
    this.held = { note, pad, velocity };
    this.next = Math.ceil(position / this.interval) * this.interval;
    this.stopped = false;
  }
  skipTo(position: number) {
    if (!Number.isFinite(position) || position < 0 || position > 1000000)
      throw new Error("Invalid repeat position");
    this.next = Math.max(this.next, Math.ceil(position / this.interval) * this.interval);
  }
  ticks(
    until: number,
    pressureAt: (position: number) => number = () => {
      throw new Error("Pressure unavailable");
    },
  ) {
    if (!Number.isFinite(until) || until < 0 || until > 1000000 || until - this.next > 64)
      throw new Error("Invalid repeat boundary");
    const output: SequenceNote[] = [];
    while (this.held && !this.stopped && this.next < until) {
      const velocity = this.pressure ? pressureAt(this.next) : this.held.velocity;
      output.push({
        ...SequenceNoteSchema.parse({
          ...this.held,
          id: `repeat-${Math.round(this.next * 960)}`,
          position: this.next % 64,
          duration: this.interval / 2,
          velocity,
          probability: 1,
          microtiming: 0,
          condition: "always",
        }),
        position: this.next,
      });
      this.next += this.interval;
    }
    return output;
  }
  release() {
    this.held = undefined;
    this.stopped = true;
  }
  disconnect() {
    this.release();
  }
}
export type AutomationMode = "touch" | "latch" | "write";
export class AutomationTake {
  readonly original: AutomationLane;
  readonly mode: AutomationMode;
  private segments: {
    start: number;
    end: number;
    points: { position: number; value: number }[];
  }[] = [];
  private current:
    | { start: number; end: number; points: { position: number; value: number }[] }
    | undefined;
  private last = 0;
  active = true;
  constructor(lane: AutomationLane, mode: AutomationMode, start = 0) {
    if (
      !["touch", "latch", "write"].includes(mode) ||
      !Number.isFinite(start) ||
      start < 0 ||
      start > 64
    )
      throw new Error("Invalid automation mode or position");
    this.original = LaneSchema.parse(lane);
    this.mode = mode;
    this.last = start;
    if (mode === "write") this.touch(start, laneValue(lane, start, 0));
  }
  get heldValue() {
    return this.current?.points.at(-1)?.value;
  }
  touch(position: number, value: number) {
    if (
      !this.active ||
      !Number.isFinite(position) ||
      position < this.last ||
      position > 64 ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      throw new Error("Invalid automation gesture");
    this.last = position;
    if (!this.current) this.current = { start: position, end: position, points: [] };
    const old = this.current.points.at(-1);
    if (old?.position === position) old.value = value;
    else this.current.points.push({ position, value });
    if (this.current.points.length > 256) throw new Error("Automation point budget exceeded");
  }
  release(position: number) {
    if (!this.active || !Number.isFinite(position) || position < this.last || position > 64)
      throw new Error("Invalid automation release");
    this.last = position;
    if (this.mode === "touch") this.close(position);
  }
  private close(position: number) {
    if (this.current) {
      this.current.end = position;
      this.segments.push(this.current);
      this.current = undefined;
    }
  }
  stop(position: number): AutomationLane {
    if (!this.active || !Number.isFinite(position) || position < this.last || position > 64)
      throw new Error("Invalid automation stop");
    this.close(position);
    this.active = false;
    const points = new Map(this.original.points.map((p) => [p.position, p.value]));
    for (const s of this.segments) {
      for (const p of [...points.keys()]) if (p >= s.start && p < s.end) points.delete(p);
      for (const p of s.points) if (p.position < s.end) points.set(p.position, p.value);
      points.set(s.end, laneValue(this.original, s.end, 0));
    }
    return {
      parameter: this.original.parameter,
      points: [...points]
        .sort((a, b) => a[0] - b[0])
        .map(([position, value]) => ({ position, value })),
    };
  }
}
// Machine IDs/versions are part of parameter identities; unrelated replacements never receive old lanes.
export function machineForParameter(project: Project, id: string) {
  for (const track of project.tracks) {
    const def = machines.get(track.machine);
    const p = def?.parameters.find(
      (p) => id === `track.${track.id}.machine.${def.id}.v${def.version}.${p.id}`,
    );
    if (p) return { track, parameter: p };
  }
  return undefined;
}
