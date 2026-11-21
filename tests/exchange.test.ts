import { expect, it } from "vitest";
import {
  decodeMidi,
  encodeMidi,
  exchangePlan,
  importMidiClip,
  loadCore,
  type MidiDocument,
  renderExchange,
} from "../packages/core/src/edits.ts";
import { saveExport } from "../packages/core/src/export-sink.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { VirtualMidiRoute, type VirtualPort, virtualClock } from "../packages/core/src/midi.ts";
import { editMix } from "../packages/core/src/mix.ts";
import { editPerformance } from "../packages/core/src/performance.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const document = (): MidiDocument => ({
  ppq: 960,
  endTick: 7680,
  ignoredEvents: 0,
  tempos: [
    { tick: 0, micros: 500000 },
    { tick: 3840, micros: 1000000 },
  ],
  notes: [
    { track: 0, channel: 0, note: 60, velocity: 100, tick: 0, duration: 480 },
    { track: 0, channel: 0, note: 64, velocity: 96, tick: 240, duration: 960 },
    { track: 1, channel: 1, note: 48, velocity: 127, tick: 3840, duration: 240 },
  ],
});
it("round-trips SMF note ticks, lengths, velocities and tempo meta events with an independent header oracle", () => {
  const bytes = encodeMidi(document());
  expect(Array.from(bytes.slice(0, 14))).toEqual([
    77, 84, 104, 100, 0, 0, 0, 6, 0, 1, 0, 3, 3, 192,
  ]);
  const decoded = decodeMidi(bytes);
  expect(decoded.tempos).toEqual(document().tempos);
  expect(decoded.notes.map((n) => ({ ...n, track: n.track - 1 }))).toEqual(document().notes);
  expect(decoded.endTick).toBe(7680);
});
it("imports notes as one reversible clip replacement and rejects non-bar tempo maps", () => {
  const p = createDemoProject(),
    d = document();
  d.endTick = 3840;
  d.tempos = d.tempos.slice(0, 1);
  d.notes = d.notes.slice(0, 2);
  const result = importMidiClip(p, encodeMidi(d), 1, "drums", "clip-0");
  expect(
    result.tracks[0]?.clips[0]?.sequence?.notes.map((n) => [n.position, n.duration, n.velocity]),
  ).toEqual([
    [0, 2, 100 / 127],
    [1, 4, 96 / 127],
  ]);
  expect(result.bpm).toBe(120);
  expect(p.tracks[0]?.clips[0]?.sequence).toBeUndefined();
  d.tempos.push({ tick: 240, micros: 600000 });
  expect(() => importMidiClip(p, encodeMidi(d), 1, "drums", "clip-0")).toThrow("bar boundaries");
});
it("rejects truncated, oversized, SMPTE, unpaired and ambiguous notes without changing the project", () => {
  const bytes = encodeMidi(document());
  for (let i = 0; i < bytes.length; i++) expect(() => decodeMidi(bytes.slice(0, i))).toThrow();
  const bad = bytes.slice();
  bad[12] = 0x80;
  expect(() => decodeMidi(bad)).toThrow("PPQ");
  expect(() => decodeMidi(new Uint8Array(1048577))).toThrow("1 MiB");
  const d = document();
  const first = d.notes[0];
  if (!first) throw new Error("Missing fixture note");
  d.notes.push({ ...first, tick: 100 });
  expect(() => encodeMidi(d)).toThrow("Overlapping");
});
it("captures 24 clocks per quarter, a bar tempo change, Start/Stop and final note cleanup only on a selected virtual route", () => {
  const input: VirtualPort = { kind: "virtual", id: "fixture-in", generation: 1, connected: true },
    output: VirtualPort = { kind: "virtual", id: "fixture-out", generation: 1, connected: true },
    route = new VirtualMidiRoute();
  route.select(input, output);
  const p = editMix(createDemoProject(), (m) => {
    m.tempos = [{ step: 16, bpm: 60 }];
  });
  p.bpm = 120;
  route.send({ frame: 0, bytes: [0x90, 60, 100] });
  virtualClock(p, 32, route);
  const clocks = route.capture.filter((e) => e.bytes[0] === 0xf8);
  expect(clocks.length).toBe(192);
  expect(clocks[1]?.frame).toBe(1000);
  expect(clocks[96]?.frame).toBe(96000);
  expect(clocks[97]?.frame).toBe(98000);
  expect(route.capture.at(-2)).toEqual({ frame: 288000, bytes: [0x80, 60, 0] });
  expect(route.capture.at(-1)?.bytes).toEqual([0xfc]);
  expect(route.activeNotes).toBe(0);
  output.connected = false;
  expect(route.revalidate([input, { ...output, connected: true, id: "fixture-replacement" }])).toBe(
    false,
  );
  output.connected = true;
  expect(route.send({ frame: 300000, bytes: [0x90, 60, 100] })).toBe(false);
  expect(() => route.select({ ...input, kind: "physical" } as never, output)).toThrow("virtual");
});
it("exports bounded deterministic stereo WAV and MIDI through the same seeded song plan", () => {
  let p = createDemoProject();
  p.bpm = 300;
  p.samples = [{ id: "s", name: "Impulse", sampleRate: 48000, pcm: [0.5, 0] }];
  for (const pad of p.pads) pad.sampleId = "s";
  for (const c of p.tracks[0]?.clips ?? [])
    c.steps = [{ step: 0, pad: 0, velocity: 1, probability: 1 }];
  p = editMix(p, (m) => {
    m.tracks.drums = { pan: 0, sends: [0, 0], inserts: [] };
  });
  p = editPerformance(p, (x) => {
    x.chain = [{ id: "one", sceneId: "scene-0", repeats: 1 }];
  });
  const plan = exchangePlan(p, "song");
  expect(plan.steps).toBe(16);
  expect(plan.document.endTick).toBe(3840);
  const rendered = renderExchange(p, "song", "scene-0", 0.1);
  expect(rendered.bodySteps).toBe(16);
  expect(rendered.pcm.length).toBe(43200);
  expect(rendered.pcm[0]).toBeCloseTo(0.22);
  expect(rendered.rightPcm.every((n) => Math.abs(n) < 1e-10)).toBe(true);
  expect(new DataView(rendered.wav).getUint16(22, true)).toBe(2);
  expect(decodeMidi(rendered.midiFile).notes[0]?.tick).toBe(0);
});
it("never commits partial renders or storage failures and requires explicit overwrite", async () => {
  let file: Uint8Array = Uint8Array.of(1, 2, 3),
    stage: Uint8Array | undefined;
  let commits = 0;
  const sink = {
    exists: async () => true,
    stage: async (bytes: Uint8Array) => {
      stage = bytes;
      throw new Error("ENOSPC");
    },
    commit: async () => {
      commits++;
      file = stage ?? file;
    },
    abort: async () => {
      stage = undefined;
    },
  };
  await expect(saveExport(sink, false, async () => Uint8Array.of(4))).rejects.toThrow("Overwrite");
  await expect(saveExport(sink, true, async () => Uint8Array.of(4))).rejects.toThrow("ENOSPC");
  expect(file).toEqual(Uint8Array.of(1, 2, 3));
  expect(stage).toBeUndefined();
  expect(commits).toBe(0);
});
it("cleans a MIDI note at recorded mute time and maps unpitched legacy pads distinctly", () => {
  let p = createDemoProject();
  p.bpm = 120;
  const c = p.tracks[0]?.clips[0];
  if (!c) throw Error("Missing clip");
  c.steps = [
    { step: 0, pad: 0, velocity: 1, probability: 1, duration: 8 },
    { step: 0, pad: 1, velocity: 1, probability: 1, duration: 8 },
  ];
  p = editPerformance(p, (x) => {
    x.chain = [{ id: "one", sceneId: "scene-0", repeats: 1 }];
    x.events = [{ id: "mute", at: 2, kind: "mute", trackId: "drums", value: true }];
  });
  const plan = exchangePlan(p, "song");
  expect(plan.document.notes.map((n) => [n.note, n.tick, n.duration])).toEqual([
    [36, 0, 480],
    [37, 0, 480],
  ]);
  expect(decodeMidi(encodeMidi(plan.document)).notes.length).toBe(2);
});
