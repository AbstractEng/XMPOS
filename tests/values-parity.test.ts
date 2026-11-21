import { describe, expect, it } from "vitest";
import {
  createDemoProject,
  expandSong,
  type Project,
  ProjectSchema,
} from "../packages/core/src/index.ts";
import { synthPresets as allPresets } from "../packages/core/src/instrument-schema.ts";

import { createEffect, type EffectKind, emptyMix } from "../packages/core/src/mix-schema.ts";
import { parameterRegistry } from "../packages/core/src/parameters.ts";
import {
  PerformanceTransport,
  performanceValues,
  performanceWindow,
} from "../packages/core/src/performance.ts";
import { GoldenLog } from "./golden.ts";

// The recordings below were made with the original eight presets (the Classic page).
const synthPresets = allPresets.slice(0, 8);

// Parameter values during a performance (performanceValues, and the control
// changes of performanceWindow): the registry and every parameter's sources laid
// out once in the C++ sequencer, each playing clip's automation applied over
// them in C++, against the original TypeScript (which resolved every parameter
// in TypeScript and rebuilt a one-track project for each playing clip). Random
// mixes with inserts and returns, assigned sources (automation, step lock,
// macro, LFO), macros, and clip sequences with lanes, locks and modulation on
// their own track's, master and return parameters.
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const KINDS: EffectKind[] = ["eq", "filter", "delay", "reverb", "distortion", "compressor"];

function randomProject(seed: number): Project {
  const r = rng(seed),
    pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T,
    unit = () => Math.round(r() * 100) / 100,
    p = expandSong(createDemoProject());
  p.tracks.forEach((track, t) => {
    if (t > 0 && r() < 0.4)
      track.machine = {
        id: "xmp.subtractive",
        base: "audio",
        version: 1,
        state: { ...pick(synthPresets) },
      };
    track.volume = unit();
  });
  if (r() < 0.75) {
    const mix = emptyMix();
    for (const track of p.tracks)
      if (r() < 0.6)
        mix.tracks[track.id] = {
          pan: unit(),
          sends: [unit(), unit()],
          inserts: Array.from({ length: Math.floor(r() * 3) }, (_, i) =>
            createEffect(pick(KINDS), `fx${track.id}${i}`),
          ),
        };
    mix.returns = [
      Array.from({ length: Math.floor(r() * 3) }, (_, i) => createEffect(pick(KINDS), `r0${i}`)),
      Array.from({ length: Math.floor(r() * 3) }, (_, i) => createEffect(pick(KINDS), `r1${i}`)),
    ];
    p.mix = mix;
  }
  const registry = parameterRegistry(p).map((d) => d.id);
  // Assigned sources on some parameters (gains keep their base in the track).
  p.parameters = registry
    .filter((id) => !id.endsWith(".gain") && r() < 0.25)
    .map((id) => ({
      id,
      base: unit(),
      ...(r() < 0.4 ? { automation: unit() } : {}),
      ...(r() < 0.3 ? { stepLock: unit() } : {}),
      ...(r() < 0.3 ? { macro: unit() * 2 - 1 } : {}),
      ...(r() < 0.3 ? { lfo: unit() * 2 - 1 } : {}),
    }));
  for (const track of p.tracks)
    for (const clip of track.clips) {
      clip.length = pick([16, 32, 64] as const);
      if (r() < 0.3) continue;
      // Mostly its own parameters, sometimes master or a return's.
      const own = registry.filter((id) => id.startsWith(`track.${track.id}.`)),
        shared = registry.filter((id) => id === "master.gain" || id.startsWith("return.")),
        targets = () => (r() < 0.7 || !shared.length ? pick(own) : pick(shared));
      const lanes = [...new Set(Array.from({ length: Math.floor(r() * 4) }, targets))].map(
        (parameter) => {
          let at = 0;
          return {
            parameter,
            points: Array.from({ length: 1 + Math.floor(r() * 6) }, () => {
              at += Math.floor(r() * 8 * 4 + 1) / 4;
              return { position: Math.min(at, clip.length), value: unit() };
            }).filter((point, i, all) => i === 0 || point.position > (all[i - 1]?.position ?? 0)),
          };
        },
      );
      const keys = new Set<string>(),
        locks = [];
      for (let i = Math.floor(r() * 10); i > 0; i--) {
        const position = Math.floor(r() * clip.length),
          parameter = targets();
        if (keys.has(`${position}:${parameter}`)) continue;
        keys.add(`${position}:${parameter}`);
        locks.push({ position, parameter, value: unit() });
      }
      const modulations = Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({
        id: `mod${i}`,
        parameter: targets(),
        kind: pick(["macro", "lfo"] as const),
        amount: unit() * 2 - 1,
        cycles: pick([0.5, 1, 2, 3.5]),
        phase: unit(),
      }));
      clip.sequence = { version: 1, notes: [], locks, lanes, modulations };
    }
  const macros = Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({
    id: `macro${i}`,
    name: `Macro ${i}`,
    value: unit(),
    assignments: [
      ...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(registry))),
    ].map((parameter) => ({ parameter, amount: unit() * 2 - 1 })),
  }));
  p.performance = {
    version: 1,
    chain: [],
    end: "stop",
    macros,
    mutes: {},
    solos: [],
    events: [],
    delay: { steps: 1, feedback: 0.3, wet: 0, sends: {} },
  };
  return ProjectSchema.parse(p);
}

describe("parameter values in C++ (recorded when they matched the original TypeScript)", () => {
  it("across random projects, clips and positions", () => {
    const g = new GoldenLog("values/performances");
    let automated = 0,
      checked = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(500 + seed),
        p = randomProject(seed),
        ours = new PerformanceTransport(p);
      for (const t of [ours]) t.start(p.scenes[seed % p.scenes.length]?.id);
      for (let step = 0; step < 80; step++) {
        if (r() < 0.06) {
          const track = p.tracks[Math.floor(r() * p.tracks.length)],
            clip = track?.clips[Math.floor(r() * track.clips.length)]?.id ?? null;
          for (const t of [ours]) t.queueClip(track?.id ?? "", clip);
        }
        if (r() < 0.05 && p.performance?.macros[0]) {
          const event = {
            id: "live",
            at: step,
            kind: "macro" as const,
            macroId: p.performance.macros[0].id,
            value: r(),
          };
          for (const t of [ours]) t.control(event);
        }
        const a = performanceWindow(ours, step);
        g.add(a);
        const position = step + r();
        const va = performanceValues(ours, position);
        g.add(va);
        checked += a.controls.length + 1;
        const plain = performanceValues(
          ours,
          -1e9, // before everything: controls at position 0, clips at their start
        );
        automated += Object.keys(va.values).filter(
          (id) => va.values[id] !== plain.values[id],
        ).length;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    // Automation really changes values between positions.
    expect(automated).toBeGreaterThan(1000);
    g.check();
  }, 300000);
});
