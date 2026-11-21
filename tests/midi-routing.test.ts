import { expect, it } from "vitest";
import { exportPortable, importPortable } from "../packages/core/src/assets.ts";
import { loadCore, renderPerformance } from "../packages/core/src/edits.ts";
import { createDemoProject, expandSong, ProjectSchema } from "../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { type MidiEvent, machines } from "../packages/core/src/machines.ts";
import { midiDestination, setMidiDestination } from "../packages/core/src/midi-routing.ts";
import { editMix } from "../packages/core/src/mix.ts";
import {
  deleteTrack,
  editPerformance,
  performanceControls,
} from "../packages/core/src/performance.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

function fixture(engine = "xmp.subtractive") {
  let p = expandSong(createDemoProject());
  p.master = 1;
  for (const track of p.tracks) {
    track.volume = 1;
    for (const clip of track.clips) {
      clip.steps = [];
      delete clip.sequence;
    }
  }
  must(p.tracks[0]).machine = machines.instantiate("xmp.midi");
  must(p.tracks[1]).machine = machines.instantiate(engine);
  must(p.tracks[2]).machine = machines.instantiate("xmp.midi");
  p = setMidiDestination(p, must(p.tracks[0]).id, must(p.tracks[1]).id);
  return p;
}
function capture(rack: VoiceRack, frames = 16000) {
  const all = new Float32Array(frames),
    left = new Float32Array(128),
    right = new Float32Array(128);
  for (let at = 0; at < frames; at += 128) {
    const n = Math.min(128, frames - at);
    rack.process(left, right, n);
    all.set(left.subarray(0, n), at);
  }
  return all;
}
const peak = (pcm: Float32Array) => pcm.reduce((p, n) => Math.max(p, Math.abs(n)), 0);

it("renders routed synth notes identically to direct notes and retains paired MIDI events", () => {
  const p = fixture(),
    events: MidiEvent[] = [];
  const routed = new VoiceRack(prepareInstruments(p), 48000, (e) => events.push(e));
  const direct = new VoiceRack(prepareInstruments(p));
  expect(routed.noteOn(1, 0, 0, 57, 0.7, 2400)).toBe(true);
  direct.noteOn(1, 0, 1, 57, 0.7, 2400);
  const pcm = capture(routed);
  expect(peak(pcm)).toBeGreaterThan(0.01);
  expect(pcm).toEqual(capture(direct));
  expect(events.map((e) => [e.kind, e.note, e.channel])).toEqual([
    ["on", 57, 1],
    ["off", 57, 1],
  ]);
  expect(routed.active).toBe(0);
});

it("routes sampler pad indices and chromatic pitch, preserving MIDI lifetime beyond short samples", () => {
  const p = fixture("xmp.sampler");
  p.samples = [{ id: "pulse", name: "Original impulse", sampleRate: 48000, pcm: [1, 0, 0, 0] }];
  for (const pad of p.pads) pad.sampleId = "pulse";
  const events: MidiEvent[] = [],
    rack = new VoiceRack(prepareInstruments(p), 48000, (e) => events.push(e));
  rack.noteOn(1, 7, 0, 60, 0.5, 200);
  expect(capture(rack, 100)[0]).toBe(0.5);
  expect(events.map((e) => e.kind)).toEqual(["on"]);
  expect(rack.active).toBe(1);
  capture(rack, 200);
  expect(events.map((e) => e.kind)).toEqual(["on", "off"]);
  expect(rack.active).toBe(0);
  must(p.pads[7]).playback = { mode: "chromatic", rootNote: 60, chokeGroup: 0 };
  const pitched = new VoiceRack(prepareInstruments(p));
  pitched.noteOn(2, 7, 0, 48, 1, 20);
  expect(Array.from(capture(pitched, 4))).toEqual([1, 0.5, 0, 0]);
});

it("balances source and destination gains and uses the destination stereo strip", () => {
  let p = fixture("xmp.sampler");
  p.samples = [{ id: "dc", name: "Original constant", sampleRate: 48000, pcm: [0.5, 0.5] }];
  for (const pad of p.pads) {
    pad.sampleId = "dc";
    pad.playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
  }
  must(p.tracks[0]).volume = 0.5;
  must(p.tracks[1]).volume = 0.5;
  p = editMix(p, (mix) => {
    mix.tracks[must(p.tracks[1]).id] = { pan: 1, sends: [0, 0], inserts: [] };
  });
  const rack = new VoiceRack(prepareInstruments(p)),
    left = new Float32Array(128),
    right = new Float32Array(128);
  rack.noteOn(1, 0, 0, 60, 1, 10000);
  rack.process(left, right);
  expect(Math.abs(must(left[127]))).toBeLessThan(1e-6);
  expect(right[127]).toBeCloseTo(0.125, 4);
});

it("releases only the stopped MIDI source, but destination mutes release all incoming voices", () => {
  let p = fixture();
  p = setMidiDestination(p, must(p.tracks[2]).id, must(p.tracks[1]).id);
  const events: MidiEvent[] = [],
    rack = new VoiceRack(prepareInstruments(p), 48000, (e) => events.push(e));
  rack.noteOn(1, 0, 0, 48, 1);
  rack.noteOn(2, 0, 2, 60, 1);
  capture(rack, 1000);
  rack.releaseTrack(must(p.tracks[0]).id);
  expect(events.filter((e) => e.kind === "off").map((e) => e.id)).toEqual([1]);
  expect(peak(capture(rack, 1000))).toBeGreaterThan(0.01);
  rack.setBlockedTracks([must(p.tracks[1]).id]);
  expect(peak(capture(rack, 1000).subarray(500))).toBe(0);
  expect(events.filter((e) => e.kind === "off").map((e) => e.id)).toEqual([1, 2]);
  expect(rack.noteOn(3, 0, 2, 60, 1)).toBe(false);
  rack.setBlockedTracks([]);
  expect(rack.noteOn(4, 0, 2, 60, 1)).toBe(true);
  rack.panic();
  capture(rack, 500);
  expect(rack.active).toBe(0);
});

it("retargets without held notes and silences unavailable or cyclic routes instead of recursing", () => {
  let p = fixture();
  const events: MidiEvent[] = [],
    rack = new VoiceRack(prepareInstruments(p), 48000, (e) => events.push(e));
  rack.noteOn(1, 0, 0, 60, 1);
  capture(rack, 500);
  p = setMidiDestination(p, must(p.tracks[0]).id, must(p.tracks[3]).id);
  rack.configure(prepareInstruments(p));
  capture(rack, 500);
  expect(events.map((e) => e.kind)).toEqual(["on", "off"]);
  expect(rack.active).toBe(0);
  for (const destination of ["absent", must(p.tracks[0]).id, must(p.tracks[2]).id]) {
    must(must(p.tracks[0]).machine).state.destination = destination;
    rack.configure(prepareInstruments(p));
    expect(rack.noteOn(2, 0, 0)).toBe(false);
    expect(peak(capture(rack, 500))).toBe(0);
  }
  for (const bad of [3, "../usb", "x".repeat(65)]) {
    must(must(p.tracks[0]).machine).state.destination = bad;
    expect(() => ProjectSchema.parse(p)).toThrow();
  }
});

it("keeps route state portable, rejects invalid UI edits and preserves legacy MIDI silence", async () => {
  const p = fixture();
  expect(await importPortable(await exportPortable(p))).toEqual(p);
  expect(midiDestination(p.tracks, must(p.tracks[0]))).toBe(p.tracks[1]);
  for (const target of ["absent", must(p.tracks[0]).id, must(p.tracks[2]).id])
    expect(() => setMidiDestination(p, must(p.tracks[0]).id, target)).toThrow();
  const clear = setMidiDestination(p, must(p.tracks[0]).id);
  const events: MidiEvent[] = [],
    rack = new VoiceRack(prepareInstruments(clear), 48000, (e) => events.push(e));
  rack.noteOn(1, 0, 0, 64, 1, 200);
  expect(peak(capture(rack, 1000))).toBe(0);
  expect(events.map((e) => e.kind)).toEqual(["on", "off"]);
  expect(must(must(p.tracks[0]).machine).state.destination).toBe(must(p.tracks[1]).id);
});

it("supports source or destination solo and destination mute in scene exports", () => {
  let p = fixture();
  must(must(p.tracks[0]).clips[0]).steps = [
    { step: 0, pad: 0, velocity: 1, probability: 1, note: 60, duration: 2 },
  ];
  p = editPerformance(p, (performance) => {
    performance.solos = [must(p.tracks[0]).id];
  });
  expect(performanceControls(p, 0).blocked).not.toContain(must(p.tracks[1]).id);
  expect(
    peak(renderPerformance(p, { mode: "scene", steps: 2, tailSeconds: 0.01 }).pcm),
  ).toBeGreaterThan(0.01);
  p = editPerformance(p, (performance) => {
    performance.solos = [must(p.tracks[1]).id];
  });
  expect(performanceControls(p, 0).blocked).not.toContain(must(p.tracks[0]).id);
  p = editPerformance(p, (performance) => {
    performance.mutes[must(p.tracks[1]).id] = true;
  });
  expect(peak(renderPerformance(p, { mode: "scene", steps: 2, tailSeconds: 0.01 }).pcm)).toBe(0);
});

it("clears incoming routes when a destination is deleted so a reused ID cannot retarget them", () => {
  const p = fixture();
  const next = deleteTrack(p, must(p.tracks[1]).id);
  expect(must(next.tracks[0]).machine?.state.destination).toBeUndefined();
  expect(must(p.tracks[0]).machine?.state.destination).toBe(must(p.tracks[1]).id);
});

it("keeps the shared 32-voice limit and refuses excess routed demand with paired cleanup", () => {
  const p = fixture(),
    events: MidiEvent[] = [],
    rack = new VoiceRack(prepareInstruments(p), 48000, (e) => events.push(e));
  for (let id = 1; id <= 32; id++) expect(rack.noteOn(id, 0, 0, 60, 1)).toBe(true);
  expect(rack.noteOn(33, 0, 0, 60, 1)).toBe(false);
  expect(rack.refused).toBe(1);
  rack.panic();
  capture(rack, 500);
  expect(rack.active).toBe(0);
  expect(events.filter((e) => e.kind === "on")).toHaveLength(32);
  expect(events.filter((e) => e.kind === "off")).toHaveLength(32);
});
