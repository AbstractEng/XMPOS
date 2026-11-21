import { createDemoProject, expandSong } from "@xmp/core";
import { afterEach, expect, it, vi } from "vitest";
import { prepareInstruments } from "../packages/core/src/instruments.ts";
import { machines } from "../packages/core/src/machines.ts";
import { setMidiDestination } from "../packages/core/src/midi-routing.ts";

interface Processor {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}
async function processor() {
  vi.resetModules();
  let Constructor: (new () => Processor) | undefined;
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = { onmessage: () => {}, postMessage: vi.fn() };
    },
  );
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal("currentFrame", 0);
  vi.stubGlobal("registerProcessor", (_name: string, value: new () => Processor) => {
    Constructor = value;
  });
  await import("../apps/studio/src/instrument-worklet.ts");
  if (!Constructor) throw new Error("Worklet did not register");
  return new Constructor();
}
afterEach(() => vi.unstubAllGlobals());
it("routes MIDI to the real worklet synth at the scheduled frame and clears destination gates on reset", async () => {
  let p = expandSong(createDemoProject());
  const source = p.tracks[0],
    target = p.tracks[1];
  if (!source || !target) throw new Error("Missing routing fixture");
  source.machine = machines.instantiate("xmp.midi");
  target.machine = machines.instantiate("xmp.subtractive");
  p = setMidiDestination(p, source.id, target.id);
  const w = await processor(),
    send = (data: unknown) => w.port.onmessage({ data });
  send({ op: "project", palette: prepareInstruments(p) });
  send({ op: "observe", enabled: true });
  send({ op: "on", frame: 64, id: 1, pad: 0, track: 0, note: 60, velocity: 1, duration: 10000 });
  const left = new Float32Array(128),
    right = new Float32Array(128);
  w.process([], [[left, right]]);
  expect(left.subarray(0, 64).every((v) => v === 0)).toBe(true);
  expect(left.subarray(65).some((v) => v !== 0)).toBe(true);
  expect(w.port.postMessage.mock.calls.some(([v]) => v.noteTrace?.frame === 64)).toBe(true);
  send({ op: "on", frame: 200, id: 2, pad: 0, track: 0, note: 64, velocity: 1, duration: 10000 });
  send({ op: "performance-now", tracks: [target.id], values: {} });
  send({ op: "performance-now", tracks: [], values: {} });
  for (let frame = 128; frame < 768; frame += 128) {
    vi.stubGlobal("currentFrame", frame);
    w.process([], [[left, right]]);
  }
  expect(left.every((v) => v === 0)).toBe(true);
  expect(
    w.port.postMessage.mock.calls.filter(([v]) => v.midi).map(([v]) => [v.midi.kind, v.midi.id]),
  ).toEqual([
    ["on", 1],
    ["off", 1],
  ]);
  send({ op: "reset" });
  send({ op: "on", frame: 768, id: 3, pad: 0, track: 0, note: 67, velocity: 1, duration: 10000 });
  vi.stubGlobal("currentFrame", 768);
  w.process([], [[left, right]]);
  expect(left.some((v) => v !== 0)).toBe(true);
  send({ op: "panic" });
  for (let frame = 896; frame < 1536; frame += 128) {
    vi.stubGlobal("currentFrame", frame);
    w.process([], [[left, right]]);
  }
  expect(left.every((v) => v === 0)).toBe(true);
});
it("schedules the actual worklet at the requested frame and cancels future notes on panic", async () => {
  const p = createDemoProject();
  const track = p.tracks[0];
  if (!track) throw new Error("Missing track");
  track.volume = 1;
  p.samples = [{ id: "test", name: "Impulse", sampleRate: 48000, pcm: [1, 0, 0, 0] }];
  for (const pad of p.pads) pad.sampleId = "test";
  const worklet = await processor();
  worklet.port.onmessage({ data: { op: "project", palette: prepareInstruments(p) } });
  worklet.port.onmessage({
    data: { op: "on", frame: 64, id: 1, pad: 0, track: 0, note: 60, velocity: 0.5, duration: 0 },
  });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  expect(worklet.process([], [[a, b]])).toBe(true);
  expect(a.findIndex((v) => v !== 0)).toBe(64);
  expect(a[64]).toBe(0.5);
  expect(b).toEqual(a);
  worklet.port.onmessage({
    data: { op: "on", frame: 200, id: 2, pad: 0, track: 0, note: 60, velocity: 1, duration: 0 },
  });
  worklet.port.onmessage({ data: { op: "panic" } });
  vi.stubGlobal("currentFrame", 128);
  worklet.process([], [[a, b]]);
  expect(a.every((v) => v === 0)).toBe(true);
});
it("rejects a malformed command without killing processing or opening any device", async () => {
  const worklet = await processor();
  worklet.port.onmessage({
    data: {
      op: "on",
      frame: 0,
      id: 1,
      pad: 0,
      track: 0,
      note: 60,
      velocity: Infinity,
      duration: 0,
    },
  });
  expect(worklet.port.postMessage).toHaveBeenCalledWith({ error: "Instrument command rejected" });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  expect(worklet.process([], [[a, b]])).toBe(true);
  expect(a.every((v) => v === 0)).toBe(true);
});
it("keeps the MIDI machine silent and returns paired virtual events from the worklet", async () => {
  const p = createDemoProject();
  const track = p.tracks[0];
  if (!track) throw new Error("Missing track");
  track.machine = machines.instantiate("xmp.midi");
  track.machine.state.channel = 3;
  const worklet = await processor();
  worklet.port.onmessage({ data: { op: "project", palette: prepareInstruments(p) } });
  worklet.port.onmessage({
    data: { op: "on", frame: 0, id: 1, pad: 0, track: 0, note: 64, velocity: 0.7, duration: 64 },
  });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  worklet.process([], [[a, b]]);
  expect(a.every((v) => v === 0)).toBe(true);
  const events = worklet.port.postMessage.mock.calls.map(([v]) => v);
  expect(events.map((v) => [v.midi.kind, v.midi.note, v.midi.channel, v.physical])).toEqual([
    ["on", 64, 3, false],
    ["off", 64, 3, false],
  ]);
});
it("bundles runnable audio and MIDI extension examples through the same registry", async () => {
  const p = createDemoProject(),
    track = p.tracks[0];
  if (!track) throw new Error("Missing track");
  track.volume = 1;
  track.machine = { id: "example.pulse", base: "audio", version: 1, state: { level: 0.15 } };
  const worklet = await processor();
  worklet.port.onmessage({ data: { op: "project", palette: prepareInstruments(p) } });
  worklet.port.onmessage({
    data: { op: "on", frame: 0, id: 1, pad: 0, track: 0, note: 60, velocity: 1, duration: 64 },
  });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  worklet.process([], [[a, b]]);
  expect(a.some((v) => v !== 0)).toBe(true);
  track.machine = { id: "example.transpose", base: "midi", version: 1, state: { semitones: 12 } };
  worklet.port.onmessage({ data: { op: "project", palette: prepareInstruments(p) } });
  worklet.port.onmessage({
    data: { op: "on", frame: 0, id: 2, pad: 0, track: 0, note: 60, velocity: 0.5, duration: 64 },
  });
  worklet.process([], [[a, b]]);
  expect(a.every((v) => v === 0)).toBe(true);
  const events = worklet.port.postMessage.mock.calls.map(([v]) => v.midi).filter(Boolean);
  expect(events.map((e) => [e.kind, e.note])).toEqual([
    ["on", 72],
    ["off", 72],
  ]);
});
it("keeps a live gesture above queued automation and restores the lane on release", async () => {
  const p = createDemoProject(),
    track = p.tracks[0],
    clip = track?.clips[0];
  if (!track || !clip) throw new Error("Missing fixture");
  p.master = 1;
  track.volume = 1;
  clip.steps = [];
  clip.sequence = { version: 1, notes: [], lanes: [], locks: [], modulations: [] };
  p.samples = [{ id: "one", name: "Constant", sampleRate: 48000, pcm: [0.5, 0.5] }];
  for (const pad of p.pads) {
    pad.sampleId = "one";
    pad.playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
  }
  const worklet = await processor(),
    send = (data: unknown) => worklet.port.onmessage({ data });
  send({ op: "project", palette: prepareInstruments(p) });
  send({ op: "on", frame: 0, id: 1, pad: 0, track: 0, note: 60, velocity: 1, duration: 100000 });
  send({ op: "parameters", frame: 64, values: { "master.gain": 0.1 } });
  send({ op: "gesture", parameter: "master.gain", value: 0.9 });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  worklet.process([], [[a, b]]);
  expect(a[127]).toBeGreaterThan(0.48);
  send({ op: "gesture-end" });
  for (let block = 1; block <= 12; block++) {
    vi.stubGlobal("currentFrame", block * 128);
    worklet.process([], [[a, b]]);
  }
  expect(a[127]).toBeLessThan(0.09);
  send({ op: "reset" });
  for (let block = 13; block <= 16; block++) {
    vi.stubGlobal("currentFrame", block * 128);
    worklet.process([], [[a, b]]);
  }
  expect(a.every((v) => v === 0)).toBe(true);
});
it("releases muted owners and discards their already queued notes without silencing another track", async () => {
  const p = createDemoProject(),
    track = p.tracks[0];
  if (!track) throw new Error("Missing track");
  track.machine = machines.instantiate("xmp.midi");
  const w = await processor(),
    send = (data: unknown) => w.port.onmessage({ data });
  send({ op: "project", palette: prepareInstruments(p) });
  send({ op: "on", frame: 0, id: 1, pad: 0, track: 0, note: 60, velocity: 0.8, duration: 0 });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  w.process([], [[a, b]]);
  send({ op: "on", frame: 250, id: 2, pad: 0, track: 0, note: 64, velocity: 0.8, duration: 0 });
  send({
    op: "performance-now",
    tracks: [track.id],
    values: { "master.gain": 0.5, [`track.${track.id}.gain`]: 0 },
  });
  send({
    op: "performance-now",
    tracks: [],
    values: { "master.gain": 0.5, [`track.${track.id}.gain`]: 0.8 },
  });
  vi.stubGlobal("currentFrame", 128);
  w.process([], [[a, b]]);
  const midi = w.port.postMessage.mock.calls.map(([v]) => v.midi).filter(Boolean);
  expect(midi.map((e) => [e.kind, e.note])).toEqual([
    ["on", 60],
    ["off", 60],
  ]);
});
it("keeps the active stereo graph and queued ownership after rejecting a project replacement", async () => {
  const { editMix } = await import("../packages/core/src/mix.ts");
  const { emptyMix } = await import("../packages/core/src/mix-schema.ts");
  let p = createDemoProject();
  p.master = 1;
  p.samples = [{ id: "dc", name: "Original DC", sampleRate: 48000, pcm: [0.25, 0.25] }];
  for (const pad of p.pads) {
    pad.sampleId = "dc";
    pad.playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
  }
  const t = p.tracks[0];
  if (!t) throw Error("Missing fixture");
  t.volume = 1;
  p = editMix(p, (m) => {
    m.tracks.drums = { pan: 0, sends: [0, 0], inserts: [] };
  });
  const worklet = await processor(),
    palette = prepareInstruments(p);
  worklet.port.onmessage({ data: { op: "project", palette } });
  worklet.port.onmessage({
    data: { op: "on", frame: 0, id: 1, pad: 0, track: 0, note: 60, velocity: 1, duration: 0 },
  });
  const a = new Float32Array(128),
    b = new Float32Array(128);
  worklet.process([], [[a, b]]);
  expect(a[127]).toBe(0.25);
  worklet.port.onmessage({
    data: {
      op: "project",
      palette: { ...palette, mix: { bpm: 120, spec: { ...emptyMix(), returns: [[], [], []] } } },
    },
  });
  vi.stubGlobal("currentFrame", 128);
  worklet.process([], [[a, b]]);
  expect(a.every((v) => v === 0.25)).toBe(true);
  expect(b.every((v) => Math.abs(v) < 1e-10)).toBe(true);
  expect(worklet.port.postMessage).toHaveBeenCalledWith({ error: "Instrument command rejected" });
});
