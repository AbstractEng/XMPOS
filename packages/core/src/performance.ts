import { type LoadedControls, loadControls, timingChecked } from "./controls-engine.ts";
import { type Project, ProjectSchema } from "./index.ts";
import { parameterRegistry } from "./parameters.ts";
import {
  type ChainEntry,
  emptyPerformance,
  type Performance,
  type PerformanceEvent,
  PerformanceEventSchema,
} from "./performance-schema.ts";
import { type TimelineNote, timeline } from "./sequencer.ts";
import { parameterTable } from "./sequencer-engine.ts";
import { createTransport, type TransportExports } from "./transport-engine.ts";

export { emptyPerformance } from "./performance-schema.ts";
export function editPerformance(project: Project, edit: (p: Performance) => void): Project {
  const next = structuredClone(project);
  next.performance ??= emptyPerformance();
  edit(next.performance);
  return ProjectSchema.parse(next);
}
export function sceneLength(project: Project, sceneId: string) {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error("Missing scene");
  return Math.max(
    16,
    ...project.tracks.map((t) => t.clips.find((c) => c.id === scene.clips[t.id])?.length ?? 16),
  );
}
export function editChain(project: Project, chain: ChainEntry[]): Project {
  return editPerformance(project, (p) => {
    p.chain = structuredClone(chain);
    if (p.position && !chain.some((e) => e.id === p.position?.occurrenceId)) delete p.position;
  });
}
export function deleteTrack(project: Project, trackId: string): Project {
  if (project.tracks.length <= 1 || !project.tracks.some((t) => t.id === trackId))
    throw new Error("Keep at least one track");
  const next = structuredClone(project);
  next.tracks = next.tracks.filter((t) => t.id !== trackId);
  for (const source of next.tracks)
    if (
      source.machine?.id === "xmp.midi" &&
      source.machine.version === 1 &&
      source.machine.base === "midi" &&
      source.machine.state.destination === trackId
    )
      delete source.machine.state.destination;
  next.parameters = next.parameters.filter((p) => !p.id.startsWith(`track.${trackId}.`));
  if (next.mix) delete next.mix.tracks[trackId];
  for (const s of next.scenes) delete s.clips[trackId];
  if (next.performance) {
    const p = next.performance;
    delete p.mutes[trackId];
    delete p.delay.sends[trackId];
    p.solos = p.solos.filter((id) => id !== trackId);
    p.events = p.events.filter((e) => e.kind === "macro" || e.trackId !== trackId);
    for (const m of p.macros)
      m.assignments = m.assignments.filter((a) => !a.parameter.startsWith(`track.${trackId}.`));
    if (p.selection) delete p.selection.clips[trackId];
    delete p.position;
  }
  return ProjectSchema.parse(next);
}
export interface Slot {
  clipId?: string;
  anchor: number;
}
export interface PerformanceSnapshot {
  sceneId: string;
  clips: Record<string, string>;
  anchors: Record<string, number>;
  position?: { occurrenceId: string; offset: number };
  running: boolean;
  step: number;
}
// Which scene and clips play, bar-quantized launches and song mode. The state
// machine runs in the C++ transport (native/include/xmp/transport.hpp) as
// WebAssembly; this class keeps the original interface, validates commands,
// numbers the project's IDs for it and reads its state back. Live control
// overrides (mutes, solos, macros) stay here; performanceControls reads them.
// The original TypeScript was retired in phase 9 part 5 (docs/cpp-port.md).
export class PerformanceTransport {
  private engine: TransportExports;
  private ids = new Map<string, number>();
  private names: string[] = [];
  private projectValue: Project;
  readonly overrides = new Map<string, boolean | number>();
  constructor(project: Project) {
    this.engine = createTransport();
    this.projectValue = project;
    this.load(project, true);
    this.sceneUid = project.scenes[0]?.id ?? "";
  }
  private sceneUid = "";
  private uid(id: string) {
    let n = this.ids.get(id);
    if (n === undefined) {
      n = this.names.length;
      this.ids.set(id, n);
      this.names.push(id);
    }
    return n;
  }
  private name(n: number) {
    return this.names[n] ?? "";
  }
  private load(project: Project, first: boolean) {
    const e = this.engine,
      p = project.performance,
      scratch = () => new Int32Array(e.memory.buffer, e.tx_scratch(), 64);
    if (project.tracks.length > 16 || project.scenes.length > 256 || (p?.chain.length ?? 0) > 512)
      throw new Error("Project exceeds the transport budget");
    e.tx_project_begin(
      project.tracks.length,
      project.scenes.length,
      p?.end === "loop" ? 1 : 0,
      p?.position ? 1 : 0,
      p?.position ? this.uid(p.position.occurrenceId) : 0,
      p?.position?.offset ?? 0,
      p?.selection ? 1 : 0,
      p?.selection ? this.uid(p.selection.sceneId) : 0,
    );
    project.tracks.forEach((track, i) => {
      if (track.clips.length > 64) throw new Error("Project exceeds the transport budget");
      const s = scratch();
      track.clips.forEach((clip, k) => {
        s[k] = this.uid(clip.id);
      });
      const selected = p?.selection?.clips[track.id];
      e.tx_track(i, this.uid(track.id), track.clips.length, selected ? this.uid(selected) : -1);
    });
    for (const [i, scene] of project.scenes.entries()) {
      const s = scratch();
      project.tracks.forEach((track, t) => {
        const clip = scene.clips[track.id];
        s[t] = clip ? this.uid(clip) : -1;
      });
      e.tx_scene(i, this.uid(scene.id), sceneLength(project, scene.id));
    }
    for (const entry of p?.chain ?? [])
      e.tx_chain(this.uid(entry.id), this.uid(entry.sceneId), entry.repeats);
    e.tx_launch_grid(p?.launchQuantize ?? 16);
    e.tx_project_commit(first ? 1 : 0);
  }
  private fail(code: number) {
    if (code === 1) throw new Error("Add a song occurrence first");
    if (code === 2) throw new Error("Scene unavailable");
    if (code === 3) throw new Error("Missing scene");
  }
  get project() {
    return this.projectValue;
  }
  get sceneId() {
    const n = this.engine.tx_scene_uid();
    return n < 0 ? this.sceneUid : this.name(n);
  }
  get running() {
    return this.engine.tx_running() !== 0;
  }
  get mode(): "scene" | "song" {
    return this.engine.tx_song() ? "song" : "scene";
  }
  get step() {
    return this.engine.tx_step();
  }
  get songOffset() {
    return this.engine.tx_song_offset();
  }
  get clockOrigin() {
    return this.engine.tx_clock_origin();
  }
  get queuedScene() {
    const n = this.engine.tx_queued_scene();
    return n < 0 ? undefined : { id: this.name(n), at: this.engine.tx_queued_scene_at() };
  }
  get queuedClips() {
    const e = this.engine,
      out = new Map<string, { id: string | null; at: number }>();
    for (let i = 0; i < e.tx_queued_count(); i++) {
      const clip = e.tx_queued_clip(i);
      out.set(this.name(e.tx_queued_track(i)), {
        id: clip < 0 ? null : this.name(clip),
        at: e.tx_queued_at(i),
      });
    }
    return out;
  }
  get slots() {
    const e = this.engine,
      out = new Map<string, Slot>();
    for (let i = 0; i < e.tx_slot_count(); i++) {
      const clip = e.tx_slot_clip(i);
      out.set(this.name(e.tx_slot_track(i)), {
        ...(clip >= 0 ? { clipId: this.name(clip) } : {}),
        anchor: e.tx_slot_anchor(i),
      });
    }
    return out;
  }
  setProject(project: Project) {
    this.load(project, false);
    this.projectValue = project;
  }
  start(sceneId = this.sceneId, mode: "scene" | "song" = "scene", resume = false) {
    this.overrides.clear();
    this.fail(this.engine.tx_start(this.uid(sceneId), mode === "song" ? 1 : 0, resume ? 1 : 0));
  }
  queueScene(sceneId: string) {
    if (!this.project.scenes.some((s) => s.id === sceneId)) throw new Error("Unknown scene");
    this.engine.tx_queue_scene(this.uid(sceneId));
  }
  queueClip(trackId: string, clipId: string | null) {
    const t = this.project.tracks.find((t) => t.id === trackId);
    if (!t || (clipId !== null && !t.clips.some((c) => c.id === clipId)))
      throw new Error("Unknown clip or track");
    this.engine.tx_queue_clip(this.uid(trackId), clipId === null ? -1 : this.uid(clipId));
  }
  queueClipAt(trackId: string, clipId: string | null, at: number) {
    const t = this.project.tracks.find((t) => t.id === trackId);
    if (
      !t ||
      (clipId !== null && !t.clips.some((c) => c.id === clipId)) ||
      !Number.isFinite(at) ||
      at < this.step
    )
      throw new Error("Invalid recording launch");
    this.fail(
      this.engine.tx_queue_clip_at(this.uid(trackId), clipId === null ? -1 : this.uid(clipId), at),
    );
  }
  cancelLaunch() {
    return this.engine.tx_cancel() !== 0;
  }
  stop() {
    this.engine.tx_stop();
    this.overrides.clear();
  }
  control(event: PerformanceEvent) {
    const e = PerformanceEventSchema.parse(event);
    if (
      e.kind === "macro"
        ? !this.project.performance?.macros.some((m) => m.id === e.macroId)
        : !this.project.tracks.some((t) => t.id === e.trackId)
    )
      throw new Error("Control target unavailable");
    this.overrides.set(
      e.kind === "macro" ? `macro:${e.macroId}` : `${e.kind}:${e.trackId}`,
      e.value,
    );
  }
  advance(step: number) {
    if (
      !Number.isInteger(step) ||
      step < Math.max(0, this.step) ||
      step > 1000000 ||
      step - this.step > 4096
    )
      throw new Error("Invalid performance clock advance");
    this.fail(this.engine.tx_advance(step));
    const e = this.engine,
      releases: string[] = [];
    for (let i = 0; i < e.tx_release_count(); i++) releases.push(this.name(e.tx_release(i)));
    e.tx_clear_releases();
    return { snapshot: this.snapshot(), releases };
  }
  snapshot(): PerformanceSnapshot {
    const clips: Record<string, string> = {},
      anchors: Record<string, number> = {};
    for (const [id, s] of this.slots) {
      if (s.clipId) clips[id] = s.clipId;
      anchors[id] = s.anchor;
    }
    const e = this.engine,
      step = this.step;
    return {
      sceneId: this.sceneId,
      clips,
      anchors,
      running: this.running,
      step: Math.max(0, step),
      ...(e.tx_has_occurrence()
        ? {
            position: {
              occurrenceId: this.name(e.tx_occurrence_id()),
              offset: Math.min(
                e.tx_occurrence_span() - 1,
                Math.max(0, step - e.tx_occurrence_start()),
              ),
            },
          }
        : {}),
    };
  }
}
// Mutes, solos and macros at a song position, the macro offsets on their
// parameters and the silenced tracks. Evaluated by the C++ controls
// (native/include/xmp/controls.hpp) as WebAssembly.
export function performanceControls(
  project: Project,
  position: number,
  overrides: ReadonlyMap<string, boolean | number> = new Map(),
) {
  if (!Number.isFinite(position) || position < 0 || position > 1000000)
    throw new Error("Invalid control position");
  const loaded = loadControls(project, overrides, true);
  loaded.engine.ctl_evaluate(position, 1);
  return readControls(loaded, project);
}
function readControls({ engine: e, name }: LoadedControls, project: Project) {
  const mutes: Record<string, boolean> = {},
    solos: string[] = [],
    macros: Record<string, number> = {},
    offsets: Record<string, number> = {},
    blocked: string[] = [],
    unavailable: string[] = [];
  for (let i = 0; i < e.ctl_mute_count(); i++)
    mutes[name(e.ctl_mute_key(i))] = e.ctl_mute_value(i) !== 0;
  for (let i = 0; i < e.ctl_solo_count(); i++) solos.push(name(e.ctl_solo_key(i)));
  for (let i = 0; i < e.ctl_macro_count(); i++)
    macros[name(e.ctl_macro_key(i))] = e.ctl_macro_value(i);
  for (let i = 0; i < e.ctl_offset_count(); i++)
    offsets[name(e.ctl_offset_key(i))] = e.ctl_offset_value(i);
  for (let i = 0; i < e.ctl_blocked_count(); i++)
    blocked.push(project.tracks[e.ctl_blocked(i)]?.id ?? "");
  for (let i = 0; i < e.ctl_unavailable_count(); i++) unavailable.push(name(e.ctl_unavailable(i)));
  return { mutes, solos, macros, offsets, blocked, unavailable };
}
export function performanceValues(transport: PerformanceTransport, position: number) {
  return performanceEvaluator(transport)(position);
}
// Every parameter's value at song positions of the transport's playing clips:
// the registry and each parameter's sources are laid out once in the C++
// sequencer, the controls once in the C++ controls, and each position resolves
// the macro offsets and each playing clip's automation there. Both modules are
// shared, so evaluate the positions before querying either again.
function performanceEvaluator(transport: PerformanceTransport) {
  const project = transport.project,
    registry = parameterRegistry(project),
    ids = registry.map((d) => d.id),
    index = new Map(ids.map((id, i) => [id, i])),
    controls = loadControls(project, transport.overrides, new Set(ids));
  // Each playing clip, and which parameters its automation may set: its own
  // track's, plus master and return parameters its sequence names.
  const playing = project.tracks.flatMap((track) => {
    const slot = transport.slots.get(track.id),
      clip = track.clips.find((c) => c.id === slot?.clipId);
    if (!slot || !clip) return [];
    const seq = clip.sequence,
      named = new Set(
        [...(seq?.lanes ?? []), ...(seq?.locks ?? []), ...(seq?.modulations ?? [])].map(
          (p) => p.parameter,
        ),
      ),
      own = `track.${track.id}.`,
      sets = ids.flatMap((id, i) =>
        id.startsWith(own) || ((id === "master.gain" || id.startsWith("return.")) && named.has(id))
          ? [i]
          : [],
      );
    return [{ slot, clip, sets }];
  });
  const table = parameterTable(
      project,
      registry,
      playing.map((p) => p.clip),
    ),
    offsets = new Float64Array(registry.length);
  return (position: number) => {
    const at = Math.max(0, position + transport.songOffset);
    if (!Number.isFinite(at) || at > 1000000) throw new Error("Invalid control position");
    controls.engine.ctl_evaluate(at, 1);
    const control = readControls(controls, project);
    offsets.fill(Number.NaN);
    for (const [id, value] of Object.entries(control.offsets)) {
      const i = index.get(id);
      if (i !== undefined) offsets[i] = value;
    }
    const values: Record<string, number> = {},
      base = table.frame(0, offsets, -1);
    ids.forEach((id, i) => {
      values[id] = base[i] ?? 0;
    });
    // A clip without a sequence resolves its parameters to the same values.
    playing.forEach(({ slot, sets }, k) => {
      const only = table.tracks[k] ?? -1;
      if (only < 0) return;
      const frame = table.frame(Math.max(0, position - slot.anchor), offsets, only);
      for (const i of sets) values[ids[i] ?? ""] = frame[i] ?? 0;
    });
    for (const id of control.blocked) values[`track.${id}.gain`] = 0;
    return { values, blocked: control.blocked, unavailable: control.unavailable };
  };
}
export interface PerformanceWindow {
  startFrame?: number;
  clock?: { step: number; bpm: number };
  snapshot: PerformanceSnapshot;
  releases: string[];
  notes: TimelineNote[];
  controls: {
    position: number;
    frame: number;
    values: Record<string, number>;
    blocked: string[];
  }[];
}
export function performanceWindow(
  transport: PerformanceTransport,
  step: number,
  fill = false,
  swing = transport.project.swing,
  rate = 48000,
): PerformanceWindow {
  const { snapshot, releases } = transport.advance(step),
    project = transport.project,
    notes: TimelineNote[] = [],
    positions = new Set([step, step + 0.25, step + 0.5, step + 0.75]);
  // Note checks and timing run in the C++ controls, loaded once per window.
  const origin = transport.clockOrigin,
    { engine: e } = loadControls(project, transport.overrides, false),
    index = new Map(project.tracks.map((t, i) => [t.id, i]));
  const frame = (position: number) => timingChecked(e, e.ctl_frame(position, swing, rate, origin));
  const timing = project.mix
    ? {
        startFrame: Math.round(timingChecked(e, e.ctl_seconds(step, origin)) * rate),
        clock: { step: step + origin, bpm: e.ctl_tempo_at(step + origin) },
      }
    : {};
  if (!snapshot.running) return { ...timing, snapshot, releases, notes, controls: [] };
  for (const track of project.tracks) {
    const slot = transport.slots.get(track.id),
      clip = track.clips.find((c) => c.id === slot?.clipId);
    if (!slot || !clip) continue;
    const scene = { id: "performance", name: "Performance", clips: { [track.id]: clip.id } },
      context = { ...project, tracks: [track], scenes: [scene] },
      local = step - slot.anchor;
    for (const n of timeline(context, scene.id, local, local + 1, fill, swing, rate)) {
      const absolute = slot.anchor + n.position,
        at = Math.max(0, absolute + transport.songOffset);
      if (!Number.isFinite(at) || at > 1000000) throw new Error("Invalid control position");
      if (e.ctl_is_blocked(index.get(track.id) ?? -1, at)) continue;
      notes.push({
        ...n,
        id: `${slot.anchor}:${n.id}`,
        position: absolute,
        frame: frame(absolute),
        durationFrames: timingChecked(e, e.ctl_duration(absolute, n.duration, swing, rate, origin)),
      });
    }
    for (const lane of clip.sequence?.lanes ?? [])
      for (const p of lane.points) {
        const abs = slot.anchor + Math.floor(local / clip.length) * clip.length + p.position;
        if (abs >= step && abs < step + 1) positions.add(abs);
      }
  }
  for (const e of project.performance?.events ?? [])
    if (e.at - transport.songOffset >= step && e.at - transport.songOffset < step + 1)
      positions.add(e.at - transport.songOffset);
  const timed = [...positions]
    .sort((a, b) => a - b)
    .map((position) => ({ position, frame: frame(position) }));
  // The evaluator reloads the shared controls and sequencer, so it runs last.
  const values = performanceEvaluator(transport),
    controls = timed.map((c) => ({ ...c, ...values(c.position) }));
  return {
    ...timing,
    snapshot,
    releases,
    // Simultaneous notes in plain code-unit ID order (as the sequencer orders them;
    // locale collation cannot be reproduced outside a JavaScript runtime).
    notes: notes.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    controls,
  };
}
export class PerformanceTake {
  private events: PerformanceEvent[] = [];
  private next = 0;
  active = true;
  readonly prefix: string;
  constructor(prefix = "performance") {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(prefix)) throw new Error("Invalid take ID");
    this.prefix = prefix;
  }
  record(
    event:
      | Omit<Extract<PerformanceEvent, { kind: "macro" }>, "id">
      | Omit<Extract<PerformanceEvent, { kind: "mute" }>, "id">
      | Omit<Extract<PerformanceEvent, { kind: "solo" }>, "id">,
  ) {
    if (!this.active || this.events.length >= 2048)
      throw new Error("Performance take closed or full");
    this.events.push(
      PerformanceEventSchema.parse({ ...event, id: `${this.prefix}-${this.next++}` }),
    );
  }
  finish() {
    if (!this.active) throw new Error("Performance take already closed");
    this.active = false;
    return structuredClone(this.events.sort((a, b) => a.at - b.at));
  }
}
