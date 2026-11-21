import { expect, it } from "vitest";
import { createDemoProject, migrateProject, ProjectSchema } from "../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import {
  editMix,
  musicalPosition,
  musicalSeconds,
  validateRoute,
} from "../packages/core/src/mix.ts";
import {
  createEffect,
  EffectSchema,
  emptyMix,
  MixSchema,
} from "../packages/core/src/mix-schema.ts";
import { EffectProcessor, panGains, StereoMixer } from "../packages/core/src/mixer.ts";
import { parameterValue, setParameter } from "../packages/core/src/parameters.ts";
import {
  deleteTrack,
  editPerformance,
  PerformanceTransport,
  performanceValues,
} from "../packages/core/src/performance.ts";
import { emptySequence } from "../packages/core/src/sequencer.ts";

const near = (a: number, b: number, tolerance = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(tolerance);
it("uses equal-power pan, post-fader sends and meters the routed stereo master", () => {
  const mix = emptyMix();
  mix.tracks.a = { pan: 0, sends: [0.5, 0], inserts: [] };
  mix.tracks.b = { pan: 1, sends: [0, 0], inserts: [] };
  const engine = new StereoMixer(mix, ["a", "b"]);
  engine.process(Float64Array.from([0.4, 0.2]), 0.5);
  near(engine.left, 0.3);
  near(engine.right, 0.1);
  near(engine.meter().left, 0.3);
  near(engine.meter().right, 0.1);
  near(engine.meter().rms, Math.sqrt(0.05));
  const [l, r] = panGains(0.5);
  near(l, Math.SQRT1_2);
  near(l * l + r * r, 1);
});
it("rejects cycles and malformed replacements while the previous graph keeps sounding", () => {
  const p = editMix(createDemoProject(), () => {}),
    palette = prepareInstruments(p),
    rack = new VoiceRack(palette);
  expect(() => validateRoute("return.0", "return.1", p)).toThrow("Unsupported route");
  expect(() => MixSchema.parse({ ...p.mix, returns: [[], [], []] })).toThrow();
  rack.noteOn(1, 0, 0);
  expect(() =>
    rack.configure({
      ...palette,
      mix: { spec: { ...emptyMix(), returns: [[], [], []] } as never, bpm: 120 },
    }),
  ).toThrow();
  const a = new Float32Array(128),
    b = new Float32Array(128);
  rack.process(a, b);
  expect(a.some((v) => v !== 0)).toBe(true);
});
it("matches independent EQ, low-pass, delay, comb, waveshaper and compressor responses", () => {
  const filter = createEffect("filter", "filter");
  filter.params.cutoff = 0;
  const f = new EffectProcessor(filter);
  const a = 1 - Math.exp((-2 * Math.PI * 20) / 48000);
  near(f.process(1), a);
  near(f.process(0), a * (1 - a));
  const eq = new EffectProcessor(createEffect("eq", "eq"));
  near(eq.process(0.37), 0.37);
  const delay = createEffect("delay", "delay");
  delay.params = { time: 0.001, feedback: 0.5, wet: 1 };
  const d = new EffectProcessor(delay),
    samples = Array.from({ length: 385 }, (_, i) => d.process(i === 0 ? 1 : 0));
  near(samples[192] ?? 0, 1);
  near(samples[384] ?? 0, 0.375);
  expect(samples[191]).toBe(0);
  const reverb = createEffect("reverb", "reverb");
  reverb.params.wet = 1;
  const rv = new EffectProcessor(reverb);
  const comb = Array.from({ length: 6577 }, (_, i) => rv.process(i === 0 ? 1 : 0));
  near(comb[6576] ?? 0, 1);
  expect(comb.slice(0, 6576).every((v) => v === 0)).toBe(true);
  const distortion = new EffectProcessor(createEffect("distortion", "distortion"));
  near(distortion.process(0.2), 0.1 + (0.5 * Math.tanh(0.2 * 5.75)) / Math.tanh(5.75));
  const compressor = createEffect("compressor", "compressor");
  compressor.params = { threshold: 0.5, ratio: 1, makeup: 0 };
  const c = new EffectProcessor(compressor);
  let sample = 0;
  for (let i = 0; i < 48000; i++) sample = c.process(1);
  near(sample, 10 ** ((-24 * (1 - 1 / 20)) / 20), 1e-4);
});
it("bounds effect schemas and memory; bypass fades while delay history runs and clear erases tails", () => {
  const effect = createEffect("delay", "e");
  expect(() =>
    EffectSchema.parse({ ...effect, params: { ...effect.params, time: 1.001 } }),
  ).toThrow();
  expect(() =>
    EffectSchema.parse({ ...effect, params: { ...effect.params, feedback: NaN } }),
  ).toThrow();
  const engine = new EffectProcessor(effect);
  expect(engine.process(Infinity)).toBe(0);
  effect.params = { time: 0.001, feedback: 0, wet: 1 };
  const tail = new EffectProcessor(effect);
  tail.process(1);
  let value = 0;
  for (let i = 1; i <= 192; i++) value = tail.process(0, 0, 120, { "p.bypass": 1 }, "p");
  near(value, Math.exp(-192 / 480));
  tail.clear();
  for (let i = 0; i < 400; i++) expect(tail.process(0)).toBe(0);
});
it("migrates v5, preserves mix state and stable effect automation, and cleans deleted strips", () => {
  const p = createDemoProject(),
    v5 = { ...p, version: 5 };
  expect(migrateProject(v5).version).toBe(8);
  let mix = editMix(p, (m) => {
    m.tracks.drums = { pan: 0.5, sends: [0, 0], inserts: [createEffect("filter", "filter")] };
    m.returns[0] = [createEffect("delay", "send")];
  });
  mix = setParameter(mix, "track.drums.pan", 0.2);
  expect(parameterValue(mix, "track.drums.pan")).toBe(0.2);
  const t = mix.tracks[0],
    clip = t?.clips[0];
  if (!t || !clip) throw Error("Missing clip");
  clip.sequence = emptySequence();
  clip.sequence.lanes.push({
    parameter: "track.drums.insert.filter.bypass",
    points: [{ position: 0, value: 1 }],
  });
  mix = editPerformance(mix, (p) => {
    p.macros = [
      {
        id: "m",
        name: "Return",
        value: 1,
        assignments: [{ parameter: "return.0.insert.send.wet", amount: 0.1 }],
      },
    ];
  });
  const player = new PerformanceTransport(ProjectSchema.parse(mix));
  player.start("scene-0");
  player.advance(0);
  expect(performanceValues(player, 0).values["track.drums.insert.filter.bypass"]).toBe(1);
  near(performanceValues(player, 0).values["return.0.insert.send.wet"] ?? 0, 0.45);
  mix.tracks.push({ id: "second", name: "Second", volume: 1, muted: false, clips: [] });
  expect(deleteTrack(mix, "drums").mix?.tracks.drums).toBeUndefined();
});
it("holds tempo when a clock disappears and follows the bar map without changing musical phase", () => {
  const p = editMix(createDemoProject(), (m) => {
    m.tempos = [{ step: 16, bpm: 60 }];
  });
  p.bpm = 120;
  near(musicalSeconds(p, 16), 2);
  near(musicalSeconds(p, 32), 6);
  near(musicalPosition(p, 4), 24);
  const mix = emptyMix(),
    effect = createEffect("filter", "rhythm");
  effect.sync = { division: 1, sequence: [0, 1], phase: "transport", loss: "hold-last-tempo" };
  mix.tracks.a = { pan: 0, sends: [0, 0], inserts: [effect] };
  const engine = new StereoMixer(mix, ["a"]);
  engine.clock(1, 60);
  for (let i = 0; i < 240; i++) engine.process(Float64Array.of(0.25), 1);
  near(engine.step, 1.02);
  expect(engine.bpm).toBe(60);
  expect(Number.isFinite(engine.left)).toBe(true);
});
it("routes a bundled custom audio machine through stereo mix without changing its machine contract", async () => {
  await import("../apps/studio/src/track-machines.ts");
  const { machines } = await import("../packages/core/src/machines.ts");
  let p = createDemoProject();
  const t = p.tracks[0];
  if (!t) throw Error("Missing track");
  t.machine = machines.instantiate("example.pulse");
  p = editMix(p, (m) => {
    m.tracks.drums = { pan: 1, sends: [0, 0], inserts: [] };
  });
  const rack = new VoiceRack(prepareInstruments(p));
  expect(rack.noteOn(1, 0, 0, 60, 1, 480)).toBe(true);
  const a = new Float32Array(128),
    b = new Float32Array(128);
  rack.process(a, b);
  expect(a.every((v) => Math.abs(v) < 1e-10)).toBe(true);
  expect(b.some((v) => v !== 0)).toBe(true);
  rack.panic();
});
it("applies one 10 ms bypass fade through the rack without cascading parameter smoothing", () => {
  let p = createDemoProject();
  p.master = 1;
  p.parameters = [];
  const t = p.tracks[0];
  if (!t) throw Error("Missing track");
  t.volume = 1;
  p.samples = [{ id: "dc", name: "Original DC test", sampleRate: 48000, pcm: [0.1, 0.1] }];
  for (const pad of p.pads) pad.sampleId = "dc";
  const pad = p.pads[0];
  if (!pad) throw Error("Missing pad");
  pad.playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
  p = editMix(p, (m) => {
    const e = createEffect("distortion", "fade");
    e.params = { drive: 1, wet: 1 };
    m.tracks.drums = { pan: 0, sends: [0, 0], inserts: [e] };
  });
  const palette = prepareInstruments(p),
    rack = new VoiceRack(palette),
    a = new Float32Array(480),
    b = new Float32Array(480);
  rack.noteOn(1, 0, 0, 60, 1);
  rack.applyParameters({ ...palette.parameterBase, "track.drums.insert.fade.bypass": 1 });
  rack.process(a, b);
  const wet = Math.tanh(Math.fround(0.1) * 20) / Math.tanh(20);
  near(a[479] ?? 0, Math.fround(0.1) + (wet - Math.fround(0.1)) * Math.exp(-1));
});
