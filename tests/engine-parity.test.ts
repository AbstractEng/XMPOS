import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../examples/track-machines/register.ts";
import { synthPresets as allPresets } from "../packages/core/src/instrument-schema.ts";

import { type InstrumentPalette, VoiceRack } from "../packages/core/src/instruments.ts";
import type { MidiEvent, TrackMachine } from "../packages/core/src/machines.ts";
import { createEffect, emptyMix, type Mix } from "../packages/core/src/mix-schema.ts";
import { GoldenLog } from "./golden.ts";

// The recordings below were made with the original eight presets (the Classic page).
const synthPresets = allPresets.slice(0, 8);

// The C++ engine (native/include/xmp/rack.hpp, as WebAssembly) against the
// original TypeScript rack, driven by the same commands. JavaScript's Math and
// the C library differ in the last bit of some sin/exp/pow results, so audio
// is compared to within 1e-5 and everything else exactly.
type Rack = VoiceRack;
type Step = [frame: number, act: (rack: Rack) => unknown];

const sampler: TrackMachine = { id: "xmp.sampler", base: "audio", version: 1, state: {} };
const synth = (preset: number): TrackMachine => ({
  id: "xmp.subtractive",
  base: "audio",
  version: 1,
  state: { ...synthPresets[preset] },
});
const midi = (state: Record<string, unknown>): TrackMachine => ({
  id: "xmp.midi",
  base: "midi",
  version: 1,
  state,
});
const pulse: TrackMachine = {
  id: "example.pulse",
  base: "audio",
  version: 1,
  state: { level: 0.15 },
};
const transpose: TrackMachine = {
  id: "example.transpose",
  base: "midi",
  version: 1,
  state: { semitones: 7 },
};

// Original test tones: a decaying chirp and noise burst per pad, all different lengths.
function pads(modes: InstrumentPalette["pads"][number]["mode"][] = []) {
  return Array.from({ length: 16 }, (_, pad) => {
    const length = 900 + pad * 431,
      pcm = new Float32Array(length);
    let seed = pad + 1;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const t = i / 44100;
      pcm[i] =
        0.6 * Math.sin(2 * Math.PI * (110 + pad * 40) * t * (1 + 3 * t)) * Math.exp(-t * 9) +
        0.2 * ((seed / 2 ** 32) * 2 - 1) * Math.exp(-t * 60);
    }
    return {
      pcm,
      rate: pad % 3 === 0 ? 44100 : 48000,
      mode: modes[pad] ?? "one-shot",
      rootNote: 60,
      chokeGroup: pad === 2 || pad === 3 ? 1 : 0,
    };
  });
}

function run(palette: () => InstrumentPalette, steps: Step[], frames: number, blocks = [128]) {
  const result = (make: (p: InstrumentPalette, emit: (e: MidiEvent) => void) => Rack) => {
    const midi: MidiEvent[] = [];
    const rack = make(palette(), (e) => midi.push({ ...e }));
    const left = new Float32Array(frames),
      right = new Float32Array(frames),
      a = new Float32Array(4096),
      b = new Float32Array(4096),
      log: unknown[] = [];
    let next = 0,
      block = 0;
    for (let frame = 0; frame < frames; ) {
      while (steps[next] && (steps[next]?.[0] ?? 0) <= frame) log.push(steps[next++]?.[1](rack));
      const until = steps[next]?.[0] ?? frames;
      const n = Math.min(blocks[block++ % blocks.length] ?? 128, frames - frame, until - frame);
      rack.process(a, b, n);
      left.set(a.subarray(0, n), frame);
      right.set(b.subarray(0, n), frame);
      frame += n;
      log.push(rack.active);
    }
    return { left, right, midi, log, refused: rack.refused, meter: rack.meter };
  };
  return { engine: result((p, emit) => new VoiceRack(p, 48000, emit)) };
}

// One fingerprint per test. The audio is rounded to 1e-6 first: the SDK's
// machines run in JavaScript, whose Math may differ in the last bit between
// Node versions.
let golden: GoldenLog | undefined;
beforeEach(() => {
  golden = new GoldenLog(`engine/${expect.getState().currentTestName ?? ""}`);
});
afterEach(() => {
  if (golden?.count) golden.check();
});
const rounded = (pcm: Float32Array) => Array.from(pcm, (v) => Math.round(v * 1e6));
function expectSame({ engine }: ReturnType<typeof run>, minimumPeak = 0.01) {
  golden?.add({
    ...engine,
    left: rounded(engine.left),
    right: rounded(engine.right),
    midi: engine.midi.map((e) => ({ ...e, velocity: Math.round(e.velocity * 1e9) })),
    meter:
      engine.meter &&
      Object.fromEntries(
        Object.entries(engine.meter).map(([k, v]) => [k, Math.round(Number(v) * 1e6)]),
      ),
  });
  let peak = 0;
  for (let i = 0; i < engine.left.length; i++)
    peak = Math.max(peak, Math.abs(engine.left[i] ?? 0), Math.abs(engine.right[i] ?? 0));
  expect(peak, "the scenario makes sound").toBeGreaterThan(minimumPeak);
  return { peak };
}

describe("the C++ engine (recorded when it matched the TypeScript rack)", () => {
  it("plays one-shot, gate, loop and chromatic pads with choke groups", () => {
    const palette = (): InstrumentPalette => ({
      pads: pads(["one-shot", "gate", "one-shot", "one-shot", "loop", "chromatic"]),
      tracks: [{ id: "drums", machine: sampler, gain: 0.8 }],
    });
    const steps: Step[] = [
      [0, (r) => r.noteOn(1, 0, 0, 60, 0.9)],
      [100, (r) => r.noteOn(2, 1, 0, 60, 0.7, 3000)],
      [2000, (r) => r.noteOn(3, 3, 0, 60, 1)], // open hat
      [2500, (r) => r.noteOn(4, 2, 0, 60, 0.6)], // closed hat chokes it
      [4000, (r) => r.noteOn(5, 4, 0, 60, 0.5)],
      [9000, (r) => r.noteOff(5)],
      [10000, (r) => r.noteOn(6, 5, 0, 67, 0.8)],
      [10500, (r) => r.noteOn(7, 5, 0, 48, 0.8)],
      [11000, (r) => r.noteOn(6, 5, 0, 72, 0.4)], // same id restarts
      [16000, (r) => r.panic()],
      [16500, (r) => r.noteOn(8, 9, 0, 60, 0.3)],
    ];
    expectSame(run(palette, steps, 24000, [128, 1, 37, 300]));
  });

  it("plays every synth preset with gates, releases and smoothed automation", () => {
    for (let preset = 0; preset < synthPresets.length; preset++) {
      const base = {
        "master.gain": 0.9,
        "track.keys.gain": 0.7,
        "track.keys.effect.gain": 0.5,
        "track.keys.machine.xmp.subtractive.v1.cutoff": 0.3,
        "track.keys.machine.xmp.subtractive.v1.attack": 0.01,
      };
      const palette = (): InstrumentPalette => ({
        pads: pads(),
        tracks: [{ id: "keys", machine: synth(preset), gain: 0.7 }],
        parameterBase: base,
        sequenceMaster: 0.9,
      });
      const steps: Step[] = [
        [0, (r) => r.noteOn(1, 0, 0, 48, 0.9, 6000)],
        [3000, (r) => r.noteOn(2, 0, 0, 55, 0.6)],
        [
          5000,
          (r) =>
            r.applyParameters({ ...base, "track.keys.machine.xmp.subtractive.v1.cutoff": 0.8 }),
        ],
        [9000, (r) => r.noteOff(2)],
        [12000, (r) => r.applyParameters({ ...base, "track.keys.gain": 0.2, "master.gain": 0.5 })],
        [12100, (r) => r.noteOn(3, 0, 0, 84, 1, 2000)],
        [20000, (r) => r.resetParameters()],
        [20100, (r) => r.noteOn(4, 0, 0, 36, 0.8, 900)],
      ];
      expectSame(run(palette, steps, 30000, [128, 64]));
    }
  });

  it("routes MIDI tracks to the synth and emits the same MIDI", () => {
    const palette = (): InstrumentPalette => ({
      pads: pads(["gate"]),
      tracks: [
        { id: "seq", machine: midi({ channel: 3, destination: "keys" }), gain: 0.9 },
        { id: "keys", machine: synth(2), gain: 0.6 },
        { id: "out", machine: midi({ channel: 10 }), gain: 1 },
        { id: "lost", machine: midi({ channel: 1, destination: "missing" }), gain: 1 },
        { id: "drums", machine: sampler, gain: 0.8 },
        { id: "seq2", machine: midi({ channel: 2, destination: "drums" }), gain: 0.5 },
      ],
      parameterBase: { "track.out.machine.xmp.midi.v1.channel": 4 / 15 },
    });
    const steps: Step[] = [
      [0, (r) => r.noteOn(1, 0, 0, 60, 0.8, 2400)],
      [10, (r) => r.noteOn(2, 0, 2, 64, 0.5, 100)],
      [20, (r) => r.noteOn(3, 0, 3, 64, 0.5, 100)],
      [30, (r) => r.noteOn(4, 0, 5, 60, 0.7, 4000)],
      [500, (r) => r.noteOn(5, 0, 2, 65, 0.9)],
      [4000, (r) => r.noteOff(5)],
      [5000, (r) => r.setBlockedTracks(["keys"])],
      [5001, (r) => r.noteOn(6, 0, 0, 62, 0.8)],
      [6000, (r) => r.setBlockedTracks([])],
      [6001, (r) => r.isTrackBlocked(0)],
      [6002, (r) => r.noteOn(7, 0, 0, 67, 0.8, 1000)],
      [8000, (r) => r.releaseTrack("seq2")],
    ];
    expectSame(run(palette, steps, 12000));
  });

  it("mixes through every effect, sync, sends, returns, tempo changes and bypass", () => {
    const mix = (): Mix => {
      const m = emptyMix();
      const filter = {
        ...createEffect("filter", "f1"),
        sync: {
          division: 1,
          sequence: [0.2, 0.9, 0.5],
          phase: "transport" as const,
          loss: "hold-last-tempo" as const,
        },
      };
      const delay = {
        ...createEffect("delay", "d1"),
        sync: {
          division: 3,
          sequence: [0.5],
          phase: "transport" as const,
          loss: "hold-last-tempo" as const,
        },
      };
      m.tracks.drums = {
        pan: 0.2,
        sends: [0.4, 0.2],
        inserts: [createEffect("eq", "e1"), createEffect("compressor", "c1")],
      };
      m.tracks.keys = {
        pan: 0.8,
        sends: [0.1, 0.5],
        inserts: [filter, createEffect("distortion", "x1")],
      };
      m.returns = [
        [delay, createEffect("filter", "f2")],
        [createEffect("reverb", "r1"), createEffect("delay", "d2")],
      ];
      m.tempos = [{ step: 16, bpm: 140 }];
      return m;
    };
    const base = {
      "master.gain": 0.8,
      "track.drums.pan": 0.2,
      "track.keys.insert.x1.drive": 0.6,
      "track.drums.insert.e1.bypass": 0,
    };
    const palette = (): InstrumentPalette => ({
      pads: pads(["one-shot", "loop"]),
      tracks: [
        { id: "drums", machine: sampler, gain: 0.9 },
        { id: "keys", machine: synth(0), gain: 0.7 },
      ],
      mix: { spec: mix(), bpm: 120 },
      parameterBase: base,
      sequenceMaster: 0.8,
    });
    const steps: Step[] = [
      [0, (r) => r.noteOn(1, 0, 0, 60, 1)],
      [0, (r) => r.noteOn(2, 0, 1, 45, 0.9, 20000)],
      [3000, (r) => r.noteOn(3, 1, 0, 60, 0.7, 9000)],
      [
        6000,
        (r) =>
          r.applyParameters({
            ...base,
            "track.drums.pan": 0.9,
            "track.drums.insert.e1.bypass": 1,
            "track.keys.send.1": 0.9,
          }),
      ],
      [9000, (r) => r.clock(8, 120)],
      [20000, (r) => r.meter],
      [24000, (r) => r.noteOn(4, 0, 0, 60, 1)],
      [30000, (r) => r.clearTail()],
      [30500, (r) => r.noteOn(5, 0, 1, 57, 1, 4000)],
    ];
    expectSame(run(palette, steps, 40000, [128, 333]));
  });

  it("sends tracks to the shared performance delay", () => {
    const palette = (): InstrumentPalette => ({
      pads: pads(),
      tracks: [
        { id: "drums", machine: sampler, gain: 0.8 },
        { id: "keys", machine: synth(3), gain: 0.6 },
      ],
      delay: { seconds: 0.18, feedback: 0.6, wet: 0.5, sends: { drums: 0.7, keys: 0.3 } },
    });
    const steps: Step[] = [
      [0, (r) => r.noteOn(1, 0, 0, 60, 1)],
      [4000, (r) => r.noteOn(2, 0, 1, 60, 1, 3000)],
      [20000, (r) => r.noteOn(3, 6, 0, 60, 0.5)],
    ];
    expectSame(run(palette, steps, 36000));
  });

  it("runs the SDK's JavaScript machines alongside the engine, with and without a mixer", () => {
    for (const withMix of [false, true]) {
      const base = { "track.tone.machine.example.pulse.v1.level": 0.5, "track.tone.gain": 0.8 };
      const palette = (): InstrumentPalette => ({
        pads: pads(),
        tracks: [
          { id: "tone", machine: pulse, gain: 0.8 },
          { id: "shift", machine: transpose, gain: 1 },
          { id: "drums", machine: sampler, gain: 0.7 },
        ],
        parameterBase: base,
        ...(withMix ? { mix: { spec: emptyMix(), bpm: 120 } } : {}),
      });
      const steps: Step[] = [
        [0, (r) => r.noteOn(1, 0, 0, 69, 0.9, 6000)],
        [0, (r) => r.noteOn(2, 0, 2, 60, 0.9)],
        [100, (r) => r.noteOn(3, 0, 1, 60, 0.5, 2000)],
        [
          3000,
          (r) => r.applyParameters({ ...base, "track.tone.machine.example.pulse.v1.level": 0.1 }),
        ],
        [8000, (r) => r.noteOn(4, 0, 0, 76, 0.7)],
        [9000, (r) => r.noteOff(4)],
        [9500, (r) => r.panic()],
      ];
      expectSame(run(palette, steps, 12000, [128, 50]));
    }
  });

  it("keeps, re-gains or releases sounding voices when the palette changes", () => {
    const tracks = (gain: number, preset: number) => [
      { id: "drums", machine: sampler, gain },
      { id: "keys", machine: synth(preset), gain: 0.6 },
      { id: "seq", machine: midi({ channel: 1, destination: "keys" }), gain: 0.8 },
    ];
    const palette = (): InstrumentPalette => ({ pads: pads(["loop"]), tracks: tracks(0.8, 4) });
    const steps: Step[] = [
      [0, (r) => r.noteOn(1, 0, 0, 60, 0.9)],
      [0, (r) => r.noteOn(2, 0, 1, 50, 0.9)],
      [0, (r) => r.noteOn(3, 0, 2, 57, 0.9)],
      [6000, (r) => r.configure({ pads: pads(["loop"]), tracks: tracks(0.4, 4) })],
      [12000, (r) => r.configure({ pads: pads(), tracks: tracks(0.4, 1) })],
      [12001, (r) => r.noteOn(4, 0, 1, 62, 0.9, 3000)],
      [18000, (r) => r.configure({ pads: pads(), tracks: tracks(0, 1) })],
      [18001, (r) => r.noteOn(5, 0, 0, 60, 0.9)],
      [20000, (r) => r.removeTrack("keys")],
    ];
    expectSame(run(palette, steps, 26000));
  });

  it("refuses notes past the voice pool the same way", () => {
    const palette = (): InstrumentPalette => ({
      pads: pads(["loop"]),
      tracks: [{ id: "drums", machine: sampler, gain: 0.3 }],
    });
    const steps: Step[] = Array.from(
      { length: 40 },
      (_, i): Step => [i * 10, (r) => r.noteOn(i + 1, i % 16, 0, 60, 0.5)],
    );
    const result = run(palette, steps, 2000);
    expectSame(result);
    expect(result.engine.refused).toBe(8);
  });
});

describe("the committed WebAssembly engine", () => {
  it("was built from the C++ sources in this tree", async () => {
    const { createHash } = await import("node:crypto");
    const { sourceHash } = await import("../tools/engine/build-wasm.mjs");
    const generated = await import("../packages/core/src/generated/xmp-engine-wasm.ts");
    const { decodeBase64 } = await import("../packages/core/src/engine.ts");
    expect(generated.ENGINE_SOURCE_SHA256, "run `npm run engine:wasm`").toBe(await sourceHash());
    expect(
      createHash("sha256").update(decodeBase64(generated.ENGINE_WASM_BASE64)).digest("hex"),
    ).toBe(generated.ENGINE_WASM_SHA256);
  });
});
