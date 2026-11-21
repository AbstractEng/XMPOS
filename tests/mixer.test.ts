import { describe, expect, it } from "vitest";
import {
  createEffect,
  type Effect,
  type EffectKind,
  emptyMix,
  type Mix,
} from "../packages/core/src/mix-schema.ts";
import { EffectProcessor, panGains, StereoMixer } from "../packages/core/src/mixer.ts";
import { GoldenLog } from "./golden.ts";
import { rng } from "./project-fixtures.ts";

// The mixer and effects one sample at a time through the C++ engine
// (packages/core/src/mixer.ts) on random effects (every kind, sync, bypass,
// automated values) and random mixes (pans, sends, inserts, returns, tempo
// changes), against fingerprints recorded while they matched the original
// TypeScript mixer (tests/golden.ts).
const KINDS: EffectKind[] = ["eq", "filter", "delay", "reverb", "distortion", "compressor"];
function randomEffect(r: () => number, id: string): Effect {
  const kind = KINDS[Math.floor(r() * KINDS.length)] as EffectKind,
    e = createEffect(kind, id);
  for (const k of Object.keys(e.params)) if (r() < 0.6) e.params[k] = Math.round(r() * 100) / 100;
  if (r() < 0.2) e.bypass = true;
  if ((kind === "filter" || kind === "delay") && r() < 0.4)
    e.sync = {
      division: [0.25, 0.5, 1, 2][Math.floor(r() * 4)] ?? 1,
      sequence: Array.from({ length: 1 + Math.floor(r() * 4) }, () => Math.round(r() * 100) / 100),
      phase: "transport",
      loss: "hold-last-tempo",
    };
  return e;
}
const signal = (r: () => number, i: number) =>
  Math.sin(i * 0.031) * 0.6 + (r() * 2 - 1) * 0.2 + (i % 997 === 0 ? 3 : 0);

describe("the mixer through the C++ engine", () => {
  it("runs every effect", () => {
    const g = new GoldenLog("mixer/effects");
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed * 7919),
        e = randomEffect(r, `fx${seed}`),
        ours = new EffectProcessor(e);
      let step = 0;
      for (let i = 0; i < 3000; i++) {
        const values: Record<string, number> | undefined =
          r() < 0.3
            ? Object.fromEntries(
                [...Object.keys(e.params), "bypass"]
                  .filter(() => r() < 0.5)
                  .map((k) => [`p.${k}`, Math.round(r() * 100) / 100]),
              )
            : undefined;
        const x = signal(r, i);
        const a = g.add(ours.process(x, step, 120, values, "p"));
        expect(Number.isFinite(a) && Math.abs(a) <= 16).toBe(true);
        step += 0.01;
        if (i === 1500) {
          ours.clear();
        }
      }
    }
    g.check();
  });

  it("mixes", () => {
    const g = new GoldenLog("mixer/mixes");
    for (let seed = 1; seed <= 24; seed++) {
      const r = rng(seed * 104729),
        tracks = ["a", "b", "c", "d"].slice(0, 1 + Math.floor(r() * 4)),
        mix: Mix = emptyMix();
      for (const t of tracks)
        mix.tracks[t] = {
          pan: Math.round(r() * 100) / 100,
          sends: [Math.round(r() * 100) / 100, Math.round(r() * 100) / 100],
          inserts: Array.from({ length: Math.floor(r() * 3) }, (_, i) =>
            randomEffect(r, `${t}fx${i}`),
          ),
        };
      mix.returns = [
        Array.from({ length: Math.floor(r() * 3) }, (_, i) => randomEffect(r, `r0fx${i}`)),
        Array.from({ length: Math.floor(r() * 3) }, (_, i) => randomEffect(r, `r1fx${i}`)),
      ];
      if (r() < 0.5) mix.tempos = [{ step: 16, bpm: 90 + Math.floor(r() * 60) }];
      const ours = new StereoMixer(mix, tracks, 48000, 120);
      if (r() < 0.5) ours.clock(14, 140);
      const inputs = new Float64Array(8),
        ids = tracks.flatMap((t) => [`track.${t}.pan`, `track.${t}.send.0`, `track.${t}.send.1`]);
      for (let i = 0; i < 4000; i++) {
        for (let k = 0; k < tracks.length; k++) inputs[k] = signal(r, i + k * 13);
        const values =
          r() < 0.2
            ? Object.fromEntries(ids.filter(() => r() < 0.3).map((id) => [id, r()]))
            : undefined;
        ours.process(inputs, 0.8, values);
        g.add([ours.left, ours.right]);
        if (i % 1000 === 999) {
          g.add(ours.meter(i === 1999));
          g.add(ours.step);
          g.add(ours.bpm);
        }
      }
      ours.clear();
    }
    g.check();
  });

  it("refuses what the original refused", () => {
    expect(panGains(0.5)).toEqual([Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)]);
    expect(() => panGains(1.1)).toThrow("Invalid pan");
    expect(() => new EffectProcessor(createEffect("eq", "e"), 7999)).toThrow("Invalid effect rate");
    expect(() => new StereoMixer(emptyMix(), ["a", "a"])).toThrow("Invalid mixer preparation");
    expect(() => new StereoMixer(emptyMix(), ["a"]).clock(-1, 120)).toThrow("Invalid effect clock");
  });
});
