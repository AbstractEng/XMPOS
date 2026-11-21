// The project edits and parameter functions of packages/core, done by XMP's
// C++ core in WebAssembly (phase 9 of docs/cpp-port.md; native/include/xmp/commands.hpp).
// Each function has the TypeScript original's name, arguments and result, so
// the browser switches by changing an import; tests/edits.test.ts compares them.
//
// Projects stay in WebAssembly: each Project the core produces keeps a handle
// to its document there, and the next edit starts from that handle instead of
// sending the project again. Sample audio never crosses for an edit: a new
// project's samples reuse the previous arrays when the core left them alone.
// The core must be loaded first (`await loadCore()`); then every call is synchronous.

import type { Project } from "./index.ts";
import { machines } from "./machines.ts";
import { emptyMix, type Mix } from "./mix-schema.ts";
import type { ParameterDefinition, ParameterSource } from "./parameters.ts";
import { type PerformanceSnapshot, type PerformanceWindow, sceneLength } from "./performance.ts";
import { type ChainEntry, emptyPerformance, type Performance } from "./performance-schema.ts";
import {
  core,
  encoder,
  errorText,
  loadedCore,
  type ProjectCore,
  resultText,
  withBytes,
  withDoubles,
} from "./project-io.ts";
import { emptySequence, type Sequence, type SequenceNote } from "./sequence-schema.ts";
import { hasSequence } from "./sequencer.ts";

/** Loads the C++ core; edits and parameter calls work once this has resolved. */
export async function loadCore(): Promise<void> {
  await core();
}
// The machines the C++ core knows: its built-ins, then each one the browser registers.
const known = new Set(["xmp.sampler", "xmp.subtractive", "xmp.midi"]);
function c(): ProjectCore {
  const loaded = loadedCore();
  if (!loaded) throw new Error("The project core is still loading; await loadCore() first");
  for (const definition of machines.list())
    if (!known.has(definition.id)) {
      known.add(definition.id);
      const bytes = encoder.encode(JSON.stringify(definition));
      if (!withBytes(loaded, bytes, (p) => loaded.xp_register_machine(p, bytes.length)))
        throw new Error(errorText(loaded));
    }
  return loaded;
}

const handles = new WeakMap<Project, number>();
const closer = new FinalizationRegistry<number>((handle) => loadedCore()?.xp_close(handle));
// The project last seen, whose handle's audio a project built from scratch can reuse.
let last: WeakRef<Project> | undefined;
function remember(project: Project, handle: number) {
  handles.set(project, handle);
  closer.register(project, handle);
  last = new WeakRef(project);
}

// The handle of `project`'s document, building it if the core has not seen this object.
function handleOf(project: Project): number {
  const known = handles.get(project);
  if (known) return known;
  const k = c();
  const text = JSON.stringify({
    ...project,
    samples: project.samples.map((s) => ({ ...s, pcm: [] })),
  });
  const bytes = encoder.encode(text);
  const handle = withBytes(k, bytes, (p) => k.xp_build(p, bytes.length));
  if (!handle) throw new Error(errorText(k));
  const base = last?.deref(),
    baseHandle = base ? handles.get(base) : undefined;
  for (const [i, sample] of project.samples.entries()) {
    const from = base && baseHandle ? base.samples.findIndex((b) => b.pcm === sample.pcm) : -1;
    if (from >= 0 && baseHandle && k.xp_reuse_pcm(handle, i, baseHandle, from)) continue;
    withDoubles(k, sample.pcm, (p) => k.xp_set_pcm(handle, i, p, sample.pcm.length));
  }
  if (!k.xp_check(handle)) {
    const message = errorText(k);
    k.xp_close(handle);
    throw new Error(message);
  }
  remember(project, handle);
  return handle;
}

function command(op: string, args: unknown[]): Uint8Array {
  return encoder.encode(JSON.stringify({ op, args }));
}

// An edit: the new Project, its unchanged samples' audio reused from `project`.
function edit(project: Project, op: string, args: unknown[]): Project {
  const k = c(),
    handle = handleOf(project),
    bytes = command(op, args);
  const next = withBytes(k, bytes, (p) => k.xp_edit(handle, p, bytes.length));
  if (!next) throw new Error(errorText(k));
  return adopt(k, project, handle, next);
}
// The Project of handle `next`, made from `project` (handle `handle`) by an edit.
function adopt(k: ProjectCore, project: Project, handle: number, next: number): Project {
  k.xp_lean(next);
  const out = JSON.parse(resultText(k)) as Project;
  k.xp_release();
  for (const [i, sample] of out.samples.entries()) {
    const same =
      i < project.samples.length && k.xp_shares_pcm(next, i, handle, i)
        ? i
        : project.samples.findIndex((_s, j) => k.xp_shares_pcm(next, i, handle, j) === 1);
    const old = same >= 0 ? project.samples[same] : undefined;
    if (old) {
      sample.pcm = old.pcm;
      continue;
    }
    const frames = k.xp_sample_frames(next, i);
    const pointer = k.xp_alloc(frames * 8);
    try {
      k.xp_sample_pcm(next, i, pointer);
      sample.pcm = Array.from(new Float64Array(k.memory.buffer, pointer, frames));
    } finally {
      k.xp_free(pointer);
    }
  }
  remember(out, next);
  return out;
}

function query<T>(project: Project, op: string, args: unknown[]): T {
  const k = c(),
    handle = handleOf(project),
    bytes = command(op, args);
  if (!withBytes(k, bytes, (p) => k.xp_query(handle, p, bytes.length)))
    throw new Error(errorText(k));
  const answer = JSON.parse(resultText(k)) as T;
  k.xp_release();
  return answer;
}

// ---- edits ----
export const toggleStep = (
  project: Project,
  trackId: string,
  clipId: string,
  pad: number,
  step: number,
) => edit(project, "toggleStep", [trackId, clipId, pad, step]);
export const samplerPlan = (project: Project, bars = 4) =>
  query<{ frames: number }>(project, "samplerPlan", [bars]);
export const samplerInput = (project: Project, track: string, monitor: boolean, bars: number) =>
  edit(project, "samplerInput", [track, monitor, bars]);
export const recordLoop = (
  project: Project,
  track: string,
  scene: string,
  pad: number,
  name: string,
  pcm: Float32Array | readonly number[],
  bars = 4,
) => edit(project, "recordLoop", [track, scene, pad, name, Array.from(pcm), bars]);
export const chopSampleToKit = (
  project: Project,
  trackId: string,
  name: string,
  rate: number,
  pcm: Float32Array | readonly number[],
  boundaries: readonly number[],
) => edit(project, "chopSampleToKit", [trackId, name, rate, Array.from(pcm), boundaries]);
export const expandSong = (project: Project) => edit(project, "expandSong", []);
export const appendNotes = (
  project: Project,
  track: string,
  clipId: string,
  notes: SequenceNote[],
) => edit(project, "appendNotes", [track, clipId, notes]);
export const overdubSteps = (
  project: Project,
  track: string,
  clipId: string,
  hits: Project["tracks"][number]["clips"][number]["steps"],
) => edit(project, "overdubSteps", [track, clipId, hits]);
export const quantizeNotes = (
  project: Project,
  track: string,
  clipId: string,
  ids: string[],
  grid: number,
  restore = false,
) => edit(project, "quantizeNotes", [track, clipId, ids, grid, restore]);
export const resizeClip = (project: Project, track: string, clipId: string, length: number) =>
  edit(project, "resizeClip", [track, clipId, length]);
export const duplicateClip = (project: Project, trackId: string, clipId: string) =>
  edit(project, "duplicateClip", [trackId, clipId]);
export const editChain = (project: Project, chain: ChainEntry[]) =>
  edit(project, "editChain", [chain]);
export const deleteTrack = (project: Project, trackId: string) =>
  edit(project, "deleteTrack", [trackId]);
export const setMidiDestination = (project: Project, sourceId: string, destination?: string) =>
  edit(project, "setMidiDestination", [sourceId, destination ?? null]);
export const manualSlices = (
  project: Project,
  padIndex: number,
  boundaries: number[],
  trackId?: string,
) => edit(project, "manualSlices", [padIndex, boundaries, ...(trackId ? [trackId] : [])]);
export const installSample = (
  project: Project,
  padIndex: number,
  name: string,
  sampleRate: number,
  pcm: Float32Array,
  trackId?: string,
) =>
  edit(project, "installSample", [
    padIndex,
    name,
    sampleRate,
    Array.from(pcm),
    ...(trackId ? [trackId] : []),
  ]);
export const applyDrumKit = (project: Project, input: unknown, trackId?: string) =>
  edit(project, "applyDrumKit", [input, ...(trackId ? [trackId] : [])]);
// Project format 7: a track's own kit, and back to the project's pads.
export const ownKit = (project: Project, trackId: string) => edit(project, "ownKit", [trackId]);
export const shareKit = (project: Project, trackId: string) => edit(project, "shareKit", [trackId]);

// The edits that take a change: it is applied to a copy of the mix, performance
// or sequence here, and the core puts the result in place and checks the project.
export function editMix(project: Project, change: (mix: Mix) => void): Project {
  const mix = structuredClone(project.mix ?? emptyMix());
  change(mix);
  return edit(project, "setMix", [mix]);
}
export function editPerformance(project: Project, change: (p: Performance) => void): Project {
  const performance = structuredClone(project.performance ?? emptyPerformance());
  change(performance);
  return edit(project, "setPerformance", [performance]);
}
export function editSequence(
  project: Project,
  track: string,
  clipId: string,
  change: (seq: Sequence) => void,
): Project {
  const clip = project.tracks.find((t) => t.id === track)?.clips.find((x) => x.id === clipId);
  if (!clip) return edit(project, "setSequence", [track, clipId, emptySequence()]); // the core names what is missing
  const sequence = structuredClone(clip.sequence ?? emptySequence());
  change(sequence);
  return edit(project, "setSequence", [track, clipId, sequence]);
}

// ---- parameters ----
export const setParameter = (
  project: Project,
  id: string,
  value: number,
  source: ParameterSource = "base",
) => edit(project, "setParameter", [id, value, source]);
export const clearParameterSource = (project: Project, id: string, source: ParameterSource) =>
  edit(project, "clearParameterSource", [id, source]);
export const parameterValue = (project: Project, id: string) =>
  query<number>(project, "parameterValue", [id]);
export const parameterRegistry = (project: Project) =>
  query<ParameterDefinition[]>(project, "parameterRegistry", []);
export const parameterSmoothingMs = (project: Project, id: string) =>
  query<number>(project, "parameterSmoothingMs", [id]);

// ---- files and rendering ----
export type MidiDocument = {
  ppq: number;
  notes: {
    track: number;
    channel: number;
    note: number;
    velocity: number;
    tick: number;
    duration: number;
  }[];
  tempos: { tick: number; micros: number }[];
  endTick: number;
  ignoredEvents: number;
};
const blob = (k: ProjectCore, i: number) =>
  new Uint8Array(k.memory.buffer, k.xp_blob(i), k.xp_blob_size(i)).slice();
const floats = (k: ProjectCore, i: number) => new Float32Array(blob(k, i).buffer);
function answer<T>(k: ProjectCore): T {
  const text = resultText(k);
  k.xp_release();
  return (text ? JSON.parse(text) : null) as T;
}
// A file operation without a project, with optional binary input.
function files(op: string, args: unknown[], data?: Uint8Array): ProjectCore {
  const k = c(),
    bytes = command(op, args),
    input = data ?? new Uint8Array(0);
  const ok = withBytes(k, bytes, (p) =>
    withBytes(k, input, (d) => k.xp_files(p, bytes.length, d, input.length)),
  );
  if (!ok) throw new Error(errorText(k));
  return k;
}
function projectFiles(project: Project, op: string, args: unknown[]): ProjectCore {
  const k = c(),
    handle = handleOf(project),
    bytes = command(op, args);
  if (!withBytes(k, bytes, (p) => k.xp_project_files(handle, p, bytes.length)))
    throw new Error(errorText(k));
  return k;
}

/** decodeSampleWav: mono or stereo PCM16/24/32 or float32 WAV, mixed to mono. */
export function decodeSampleWav(bytes: Uint8Array) {
  const k = files("decodeWav", [], bytes);
  const { sampleRate } = answer<{ sampleRate: number }>(k);
  const pcm = floats(k, 0);
  k.xp_blobs_release();
  return { pcm, sampleRate };
}
/** encodeWav: one or two channels of float audio to a WAV file. */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const frames = channels[0]?.length ?? 0,
    data = new Float32Array(frames * channels.length);
  channels.forEach((ch, i) => {
    data.set(ch.length === frames ? ch : new Float32Array(frames), i * frames);
  });
  if (channels.some((ch) => ch.length !== frames)) throw new Error("Invalid WAV channels");
  const k = files("encodeWav", [sampleRate, frames, channels.length], new Uint8Array(data.buffer));
  answer(k);
  const wav = blob(k, 0).buffer;
  k.xp_blobs_release();
  return wav;
}
export function encodeMidi(document: MidiDocument): Uint8Array {
  const k = files("encodeMidi", [document]);
  answer(k);
  const bytes = blob(k, 0);
  k.xp_blobs_release();
  return bytes;
}
export function decodeMidi(bytes: Uint8Array): MidiDocument {
  if (bytes.length > 1048576) throw new Error("MIDI exceeds 1 MiB");
  return answer<MidiDocument>(files("decodeMidi", [], bytes));
}
export function exchangePlan(
  project: Project,
  mode: "scene" | "song",
  scene = project.scenes[0]?.id ?? "",
) {
  return answer<{ document: MidiDocument; steps: number }>(
    projectFiles(project, "exchangePlan", [mode, scene]),
  );
}
export function importMidiClip(
  project: Project,
  bytes: Uint8Array,
  fileTrack: number,
  trackId: string,
  clipId: string,
): Project {
  const k = c(),
    handle = handleOf(project),
    text = command("importMidiClip", [fileTrack, trackId, clipId]);
  const next = withBytes(k, text, (p) =>
    withBytes(k, bytes, (d) => k.xp_import_midi(handle, p, text.length, d, bytes.length)),
  );
  if (!next) throw new Error(errorText(k));
  return adopt(k, project, handle, next);
}

// A window's work for the engine, frame by frame (render.hpp performance_commands).
export interface PerformanceCommand {
  frame: number;
  kind: "release" | "gates" | "parameters" | "on" | "clock";
  position?: number;
  bpm?: number;
  tracks?: string[];
  values?: Record<string, number>;
  note?: PerformanceWindow["notes"][number];
  id?: number;
}
type Rendered = {
  meter: unknown;
  trace: { frame: number; note: number; trackId: string }[];
  transitions: { step: number; sceneId: string; occurrenceId?: string }[];
  bodySteps: number;
  midi: { kind: "on" | "off"; id: string; note: number; velocity: number; channel: number }[];
  snapshot: unknown;
  // What the render scheduled, frame by frame.
  commands: PerformanceCommand[];
};
function rendered(k: ProjectCore) {
  const meta = answer<Rendered>(k);
  const out = { wav: blob(k, 2).buffer, pcm: floats(k, 0), rightPcm: floats(k, 1), ...meta };
  return out;
}
/** renderPerformance: a scene or the song, played through the performance, to stereo audio and its WAV. */
export function renderPerformance(
  project: Project,
  {
    scene = project.scenes[0]?.id ?? "",
    mode = "song",
    steps = 256,
    tailSeconds = 2,
    resume = false,
  }: {
    scene?: string;
    mode?: "scene" | "song";
    steps?: number;
    tailSeconds?: number;
    resume?: boolean;
  } = {},
) {
  const k = projectFiles(project, "renderPerformance", [scene, mode, steps, tailSeconds, resume]);
  const out = rendered(k);
  k.xp_blobs_release();
  return out;
}
/** renderProjectScene: a scene to a WAV file. */
export function renderProjectScene(project: Project, sceneId: string): ArrayBuffer {
  const k = projectFiles(project, "renderProjectScene", [sceneId]);
  answer(k);
  const wav = blob(k, 0).buffer;
  k.xp_blobs_release();
  return wav;
}
/** renderInstrumentScene: a scene as mono audio (for resampling) and its MIDI events. */
export function renderInstrumentScene(project: Project, sceneId: string, exactSteps?: number) {
  // The three renderers, chosen as the TypeScript chose them.
  if (project.mix) {
    const result = renderPerformance(project, {
      scene: sceneId,
      mode: "scene",
      steps: exactSteps ?? sceneLength(project, sceneId),
      tailSeconds: exactSteps ? 0 : 2,
    });
    // Sample assets are mono; resampling uses an equal-weight downmix.
    const pcm = Float32Array.from(result.pcm, (left, i) => (left + (result.rightPcm[i] ?? 0)) / 2);
    return { ...result, pcm };
  }
  if (hasSequence(project)) {
    const scene = project.scenes.find((s) => s.id === sceneId);
    const steps =
      exactSteps ??
      Math.max(
        16,
        ...project.tracks.map(
          (t) => t.clips.find((c) => c.id === scene?.clips[t.id])?.length ?? 16,
        ),
      );
    return { ...renderSequence(project, sceneId, steps, false, !exactSteps), midi: [] };
  }
  const k = projectFiles(project, "renderInstrumentScene", [sceneId, exactSteps ?? 0]);
  const meta = answer<{
    midi: Rendered["midi"];
    events: {
      frame: number;
      id: number;
      pad: number;
      track: number;
      note: number;
      velocity: number;
      duration: number;
    }[];
    refused: number;
  }>(k);
  const out = {
    wav: blob(k, 1).buffer,
    pcm: floats(k, 0),
    events: meta.events,
    midi: meta.midi,
    refused: meta.refused,
  };
  k.xp_blobs_release();
  return out;
}
/**
 * prepareScene: the pad-sampler plan of a scene (projects with no instruments):
 * each distinct pad sound at 48 kHz and the events that play them, in frame
 * order. The native song renderer reads it.
 */
export function prepareScene(project: Project, sceneId: string) {
  const k = projectFiles(project, "prepareScene", [sceneId]);
  const meta = answer<{
    sampleRate: 48000;
    frames: number;
    events: {
      frame: number;
      sample: number;
      velocity: number;
      trackId: string;
      pad: number;
      step: number;
    }[];
  }>(k);
  const samples = Array.from({ length: k.xp_blob_count() }, (_, i) => floats(k, i));
  k.xp_blobs_release();
  return { sampleRate: meta.sampleRate, frames: meta.frames, samples, events: meta.events };
}
/** renderPlan(prepareScene(...)): a scene through the pad-sampler renderer, as a stereo WAV. */
export function renderScenePlan(project: Project, sceneId: string): ArrayBuffer {
  const k = projectFiles(project, "renderScenePlan", [sceneId]);
  answer(k);
  const wav = blob(k, 0).buffer;
  k.xp_blobs_release();
  return wav;
}
/** renderSequence: a scene's clip sequences through the engine, mono, with its timeline and MIDI. */
export function renderSequence(
  project: Project,
  scene: string,
  steps: number,
  fill = false,
  tail = true,
) {
  const k = projectFiles(project, "renderSequence", [scene, steps, fill, tail]);
  const meta = answer<{
    midi: Rendered["midi"];
    events: TimelineNote[];
    refused: number;
  }>(k);
  const out = {
    midi: meta.midi,
    wav: blob(k, 1).buffer,
    pcm: floats(k, 0),
    events: meta.events,
    refused: meta.refused,
  };
  k.xp_blobs_release();
  return out;
}
/** renderExchange: the WAV and the MIDI file of a scene or the song. */
export function renderExchange(
  project: Project,
  mode: "scene" | "song",
  scene = project.scenes[0]?.id ?? "",
  tailSeconds = 2,
) {
  const k = projectFiles(project, "renderExchange", [mode, scene, tailSeconds]);
  const meta = answer<Rendered & { document: MidiDocument }>(k);
  const out = {
    wav: blob(k, 2).buffer,
    pcm: floats(k, 0),
    rightPcm: floats(k, 1),
    ...meta,
    midiFile: blob(k, 3),
  };
  k.xp_blobs_release();
  return out;
}

// ---- playback: the performance (transport) in the core ----
type Snapshot = PerformanceSnapshot;
type State = {
  sceneId: string;
  running: boolean;
  mode: "scene" | "song";
  step: number;
  songOffset: number;
  clockOrigin: number;
  slots: [string, string | null, number][];
  queuedClips: [string, string | null, number][];
  queuedScene?: { id: string; at: number };
  overrides: [string, boolean | number][];
};
const performances = new FinalizationRegistry<number>((id) => loadedCore()?.xp_perf_close(id));

/** PerformanceTransport, in the core: scenes, songs, launches and live controls. */
export class PerformanceTransport {
  private readonly id: number;
  private projectValue: Project;
  constructor(project: Project) {
    const k = c(),
      id = k.xp_perf_new(handleOf(project));
    if (!id) throw new Error(errorText(k));
    this.id = id;
    this.projectValue = project;
    performances.register(this, id);
  }
  /** A command to the core's performance; its answer. */
  run<T>(op: string, args: unknown[] = []): T {
    const k = c(),
      bytes = command(op, args);
    if (!withBytes(k, bytes, (p) => k.xp_perf(this.id, p, bytes.length)))
      throw new Error(errorText(k));
    return answer<T>(k);
  }
  private state() {
    return this.run<State>("state");
  }
  get project() {
    return this.projectValue;
  }
  get sceneId() {
    return this.state().sceneId;
  }
  get running() {
    return this.state().running;
  }
  get mode() {
    return this.state().mode;
  }
  get step() {
    return this.state().step;
  }
  get songOffset() {
    return this.state().songOffset;
  }
  get clockOrigin() {
    return this.state().clockOrigin;
  }
  get queuedScene() {
    return this.state().queuedScene;
  }
  get queuedClips() {
    return new Map(this.state().queuedClips.map(([track, id, at]) => [track, { id, at }]));
  }
  get slots() {
    return new Map(
      this.state().slots.map(([track, clip, anchor]) => [
        track,
        { ...(clip !== null ? { clipId: clip } : {}), anchor },
      ]),
    );
  }
  get overrides(): ReadonlyMap<string, boolean | number> {
    return new Map(this.state().overrides);
  }
  setProject(project: Project) {
    const k = c();
    if (!k.xp_perf_set_project(this.id, handleOf(project))) throw new Error(errorText(k));
    this.projectValue = project;
  }
  start(sceneId?: string, mode: "scene" | "song" = "scene", resume = false) {
    this.run("start", [sceneId ?? null, mode, resume]);
  }
  queueScene(sceneId: string) {
    this.run("queueScene", [sceneId]);
  }
  queueClip(trackId: string, clipId: string | null) {
    this.run("queueClip", [trackId, clipId]);
  }
  queueClipAt(trackId: string, clipId: string | null, at: number) {
    this.run("queueClipAt", [trackId, clipId, at]);
  }
  cancelLaunch() {
    return this.run<boolean>("cancel");
  }
  stop() {
    this.run("stop");
  }
  control(event: unknown) {
    this.run("control", [event]);
  }
  advance(step: number) {
    return this.run<{ snapshot: Snapshot; releases: string[] }>("advance", [step]);
  }
  snapshot(): Snapshot {
    return this.run<Snapshot>("snapshot");
  }
}

type Window = PerformanceWindow;
type Command = PerformanceCommand;
const windowCommands = new WeakMap<object, Command[]>();
/** performanceWindow: everything due in [step, step + 1), the clock advanced to `step`. */
export function performanceWindow(
  transport: PerformanceTransport,
  step: number,
  fill = false,
  swing = transport.project.swing,
  rate = 48000,
) {
  const { window, commands } = transport.run<{ window: Window; commands: Command[] }>("window", [
    step,
    fill,
    swing,
    rate,
  ]);
  windowCommands.set(window, commands);
  return window;
}
/** performanceCommands: a window from performanceWindow as the scheduler's commands, by frame. */
export function performanceCommands(window: object, _project?: Project, _rate?: number): Command[] {
  const commands = windowCommands.get(window);
  if (!commands) throw new Error("A window from performanceWindow is needed");
  return commands;
}
/** performanceValues: every parameter's value at a song position, with what is blocked. */
export function performanceValues(transport: PerformanceTransport, position: number) {
  return transport.run<{
    values: Record<string, number>;
    blocked: string[];
    unavailable: string[];
  }>("values", [position]);
}
/** performanceControls: the mutes, solos and macros at a song position (stateless). */
export function performanceControls(
  project: Project,
  position: number,
  overrides: ReadonlyMap<string, boolean | number> = new Map(),
) {
  const k = c(),
    handle = handleOf(project),
    bytes = command("controls", [position, [...overrides]]);
  if (!withBytes(k, bytes, (p) => k.xp_controls(handle, p, bytes.length)))
    throw new Error(errorText(k));
  return answer<{
    mutes: Record<string, boolean>;
    solos: string[];
    macros: Record<string, number>;
    blocked: string[];
    unavailable: string[];
    offsets: Record<string, number>;
  }>(k);
}

// ---- playing a project with neither a performance nor a mix ----
type TimelineNote = {
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
};
/** timeline: the scene's notes in [from, to), with their frames. */
export const timeline = (
  project: Project,
  scene: string,
  from: number,
  to: number,
  fill = false,
  swing = project.swing,
  rate = 48000,
) => query<TimelineNote[]>(project, "timeline", [scene, from, to, fill, swing, rate]);
/** eventsAtStep: the step entries the scene plays at a step, their velocity scaled by the track's gain. */
export const eventsAtStep = (project: Project, sceneId: string, absoluteStep: number) =>
  query<
    {
      step: number;
      pad: number;
      velocity: number;
      probability: number;
      note?: number;
      duration?: number;
      trackId: string;
    }[]
  >(project, "eventsAtStep", [sceneId, absoluteStep]);
/** parameterFrame: every parameter's value at a position of the scene. */
export const parameterFrame = (
  project: Project,
  sceneId: string,
  position: number,
  macroOffsets: Record<string, number> = {},
) => query<Record<string, number>>(project, "parameterFrame", [sceneId, position, macroOffsets]);
