import { createDemoProject, ProjectSchema, parseProject } from "@xmp/core";
import { expect, it } from "vitest";
import { loadCore, renderSequence } from "../packages/core/src/edits.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { machines } from "../packages/core/src/machines.ts";
import { parameterRegistry, setParameter } from "../packages/core/src/parameters.ts";
import {
  AutomationTake,
  appendNotes,
  clipFor,
  editSequence,
  emptySequence,
  NoteTake,
  notesInWindow,
  parameterFrame,
  resizeClip,
} from "../packages/core/src/sequencer.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

function fixture() {
  const p = createDemoProject();
  p.bpm = 120;
  p.samples = [{ id: "one", name: "Constant", sampleRate: 48000, pcm: [0.5, 0.5, 0.5, 0.5] }];
  for (const pad of p.pads) {
    pad.sampleId = "one";
    pad.playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
  }
  const track = p.tracks[0];
  if (!track) throw new Error("Missing fixture");
  const c = track.clips[0];
  if (!c) throw new Error("Missing clip");
  c.steps = [];
  c.sequence = emptySequence();
  return { p, track: track.id, clip: c.id, scene: p.scenes[0]?.id ?? "scene-0" };
}
it("migrates valid V3 musical data and rejects unsupported V4 sequence structure", () => {
  const { p } = fixture();
  const older = structuredClone(p);
  for (const t of older.tracks) for (const c of t.clips) delete c.sequence;
  expect(parseProject(JSON.stringify({ ...older, version: 3 }))).toEqual(older);
  expect(() => parseProject(JSON.stringify({ ...p, version: 9 }))).toThrow("Unsupported");
  const bad = structuredClone(p);
  const c = bad.tracks[0]?.clips[0];
  if (!c?.sequence) throw new Error("Missing sequence");
  c.sequence.version = 2 as 1;
  expect(() => ProjectSchema.parse(bad)).toThrow();
});
it("rejects invalid notes, unordered lanes and oversized modulation before session replacement", () => {
  const f = fixture();
  for (const modify of [
    (s: ReturnType<typeof emptySequence>) =>
      s.notes.push({
        id: "bad",
        pad: 0,
        note: 60,
        position: 15,
        duration: 2,
        velocity: 0.5,
        probability: 1,
        microtiming: 0,
        condition: "always",
      }),
    (s: ReturnType<typeof emptySequence>) =>
      s.lanes.push({
        parameter: "master.gain",
        points: [
          { position: 2, value: 1 },
          { position: 1, value: 0 },
        ],
      }),
    (s: ReturnType<typeof emptySequence>) =>
      s.modulations.push({
        id: "bad",
        parameter: "master.gain",
        kind: "lfo",
        amount: Infinity,
        cycles: 1,
        phase: 0,
      }),
  ])
    expect(() => editSequence(f.p, f.track, f.clip, modify)).toThrow();
  expect(clipFor(f.p, f.track, f.clip).sequence?.notes).toHaveLength(0);
});
it("closes all held take notes at the pass boundary with independent note identities", () => {
  const take = new NoteTake(16, 120);
  take.on("a", 0, 60, 0.2, 0.013);
  take.on("b", 0, 64, 0.9, 0.013);
  const notes = take.finish(3);
  expect(take.held).toBe(0);
  expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  expect(notes.map((n) => n.original?.velocity)).toEqual([0.2, 0.9]);
  expect(notes.every((n) => n.position + n.duration <= 16)).toBe(true);
});
it("touch restores gaps while latch and write retain values until stop", () => {
  const lane = {
    parameter: "master.gain",
    points: [
      { position: 0, value: 0.2 },
      { position: 8, value: 0.4 },
    ],
  };
  for (const mode of ["touch", "latch", "write"] as const) {
    const take = new AutomationTake(lane, mode);
    take.touch(2, 0.8);
    take.release(4);
    const output = take.stop(12);
    const value = (at: number) => output.points.filter((p) => p.position <= at).at(-1)?.value;
    expect(value(6)).toBe(mode === "touch" ? 0.2 : 0.8);
    expect(value(12)).toBe(0.4);
    expect(take.active).toBe(false);
    expect(() => take.touch(13, 0.5)).toThrow();
  }
});
it("maps normalized machine targets to their units without controlling a replacement machine", () => {
  const f = fixture(),
    t = f.p.tracks[0];
  if (!t) throw new Error("Missing track");
  t.machine = machines.instantiate("xmp.subtractive");
  const id = parameterRegistry(f.p).find((p) => p.id.endsWith(".cutoff"))?.id;
  if (!id) throw new Error("Missing machine parameter");
  const edited = setParameter(f.p, id, 0.5);
  expect(edited.tracks[0]?.machine?.state.cutoff).toBe(8015);
  const automated = editSequence(edited, f.track, f.clip, (s) =>
    s.lanes.push({ parameter: id, points: [{ position: 0, value: 0.9 }] }),
  );
  expect(parameterFrame(automated, f.scene, 0)[id]).toBe(0.9);
  const replacement = structuredClone(automated);
  const rt = replacement.tracks[0];
  if (rt) rt.machine = machines.instantiate("xmp.midi");
  expect(parameterFrame(replacement, f.scene, 0)[id]).toBeUndefined();
  expect(clipFor(replacement, f.track, f.clip).sequence?.lanes[0]?.parameter).toBe(id);
});
it("applies smoothed parameter changes independently of output block size and resets their source", () => {
  const f = fixture(),
    palette = () => prepareInstruments(f.p);
  const a = new VoiceRack(palette()),
    b = new VoiceRack(palette());
  for (const r of [a, b]) {
    r.noteOn(1, 0, 0, 60, 0.8);
    r.applyParameters({ "master.gain": 0.1, [`track.${f.track}.gain`]: 0.3 });
  }
  const one = new Float32Array(128),
    other = new Float32Array(128),
    scratch = new Float32Array(1);
  for (let i = 0; i < 128; i++) {
    a.process(scratch, new Float32Array(1));
    one[i] = scratch[0] ?? 0;
  }
  b.process(other, new Float32Array(128));
  expect(other).toEqual(one);
  expect(one[0]).toBeGreaterThan(one[127] ?? 0);
  b.resetParameters();
  b.process(new Float32Array(4096), new Float32Array(4096));
  expect(b.masterGain).toBeGreaterThan(0.54);
});
it("renders gated MIDI notes with paired virtual note-offs and no audio", () => {
  const f = fixture(),
    t = f.p.tracks[0];
  if (t) t.machine = machines.instantiate("xmp.midi");
  const p = appendNotes(f.p, f.track, f.clip, [
    {
      id: "midi",
      pad: 0,
      note: 64,
      position: 15,
      duration: 1,
      velocity: 0.8,
      probability: 1,
      microtiming: 0,
      condition: "always",
    },
  ]);
  const r = renderSequence(p, f.scene, 16, false, false);
  expect(r.pcm.every((v) => v === 0)).toBe(true);
  expect(r.midi.map((m) => [m.kind, m.note])).toEqual([
    ["on", 64],
    ["off", 64],
  ]);
});
it("keeps raw timestamps when resizing and clamps microtiming once per cycle", () => {
  const f = fixture(),
    t = new NoteTake(64, 120);
  t.on("a", 0, 60, 0.8, 1.9);
  t.off("a", 3);
  const p = appendNotes(resizeClip(f.p, f.track, f.clip, 64), f.track, f.clip, t.finish(3));
  const shortened = resizeClip(p, f.track, f.clip, 16);
  const n = clipFor(shortened, f.track, f.clip).sequence?.notes[0];
  expect(n?.original?.timestamp).toBe(1.9);
  expect((n?.position ?? 0) + (n?.duration ?? 0)).toBe(16);
  const trace = notesInWindow(shortened, f.scene, 0, 32);
  expect(trace.map((n) => n.position)).toEqual([15.2, 31.2]);
});
it("keeps new note identities distinct from legacy pad-step identities", () => {
  const f = fixture(),
    clip = clipFor(f.p, f.track, f.clip);
  clip.steps.push({ step: 0, pad: 0, velocity: 0.5, probability: 1 });
  const p = appendNotes(f.p, f.track, f.clip, [
    {
      id: "step-0-0",
      pad: 0,
      note: 64,
      position: 0,
      duration: 1,
      velocity: 0.8,
      probability: 1,
      microtiming: 0,
      condition: "always",
    },
  ]);
  const notes = notesInWindow(p, f.scene, 0, 1);
  expect(notes).toHaveLength(2);
  expect(new Set(notes.map((n) => n.id)).size).toBe(2);
});
