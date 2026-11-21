import { describe, expect, it } from "vitest";
import {
  createDemoProject,
  expandSong,
  type Project,
  ProjectSchema,
} from "../packages/core/src/index.ts";
import { machines } from "../packages/core/src/machines.ts";
import { setMidiDestination } from "../packages/core/src/midi-routing.ts";
import { emptyMix } from "../packages/core/src/mix-schema.ts";
import {
  PerformanceTransport,
  performanceControls,
  performanceValues,
  performanceWindow,
} from "../packages/core/src/performance.ts";
import { GoldenLog } from "./golden.ts";

// The C++ performance controls (native/include/xmp/controls.hpp, as
// WebAssembly) against the original TypeScript on random projects: mutes,
// solos (with MIDI routing), macros and their offsets, recorded events, live
// overrides, unavailable assignments, and the window's notes, frames and
// control changes under tempo maps and swing. Everything must be identical.
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomProject(r: () => number): Project {
  let p = expandSong(createDemoProject());
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  p.swing = pick([0, 0.1, 0.33, 0.5]);
  const [a, b, c] = p.tracks;
  if (a && b && c && r() < 0.7) {
    a.machine = machines.instantiate("xmp.midi");
    b.machine = machines.instantiate(r() < 0.5 ? "xmp.subtractive" : "xmp.sampler");
    c.machine = machines.instantiate("xmp.midi");
    p = setMidiDestination(p, a.id, b.id);
  }
  for (const t of p.tracks) t.muted = r() < 0.1;
  const ids = p.tracks.map((t) => t.id);
  const cutoff = (id: string) => `track.${id}.machine.xmp.subtractive.v1.cutoff`;
  const parameters = [
    ...ids.map((id) => `track.${id}.gain`),
    ...ids.map(cutoff), // valid only on a synth track
    "master.gain",
  ];
  const macros = Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({
    id: `m${i}`,
    name: `Macro ${i}`,
    value: r(),
    assignments: [
      ...new Set(Array.from({ length: Math.floor(r() * 4) }, () => pick(parameters))),
    ].map((parameter) => ({ parameter, amount: r() * 2 - 1 })),
  }));
  let at = 0;
  const events = Array.from({ length: Math.floor(r() * 40) }, (_, i) => {
    at += Math.floor(r() * 6);
    const roll = r();
    return roll < 0.35 && macros.length
      ? { id: `e${i}`, at, kind: "macro" as const, macroId: pick(macros).id, value: r() }
      : {
          id: `e${i}`,
          at,
          kind: roll < 0.7 ? ("mute" as const) : ("solo" as const),
          trackId: pick(ids),
          value: r() < 0.5,
        };
  });
  p.performance = {
    version: 1,
    chain: [],
    end: "stop",
    macros,
    mutes: Object.fromEntries(ids.filter(() => r() < 0.3).map((id) => [id, r() < 0.6])),
    solos: ids.filter(() => r() < 0.15),
    events,
    delay: { steps: 1, feedback: 0.3, wet: 0, sends: {} },
  };
  if (r() < 0.6) {
    let step = 0;
    p.mix = {
      ...emptyMix(),
      tempos: Array.from({ length: Math.floor(r() * 5) }, () => {
        step += 16 * (1 + Math.floor(r() * 3));
        return { step, bpm: 60 + Math.floor(r() * 120) };
      }),
    };
  }
  return ProjectSchema.parse(p);
}
function randomOverrides(r: () => number, p: Project) {
  const o = new Map<string, boolean | number>();
  for (let i = 0; i < Math.floor(r() * 5); i++) {
    const roll = r(),
      track = p.tracks[Math.floor(r() * p.tracks.length)]?.id ?? "",
      macro = p.performance?.macros[Math.floor(r() * (p.performance?.macros.length ?? 0))]?.id;
    if (roll < 0.3 && macro) o.set(`macro:${macro}`, r());
    else o.set(`${roll < 0.65 ? "mute" : "solo"}:${track}`, r() < 0.5);
  }
  return o;
}

describe("the C++ performance controls (recorded when they matched the original TypeScript)", () => {
  it("at random positions with random overrides", () => {
    const g = new GoldenLog("controls/positions");
    let blocked = 0,
      offsets = 0,
      unavailable = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed),
        p = randomProject(r);
      for (let i = 0; i < 25; i++) {
        const position = r() < 0.8 ? Math.floor(r() * 250) : r() * 250,
          overrides = randomOverrides(r, p);
        const ours = performanceControls(p, position, overrides);
        g.add(ours);
        blocked += ours.blocked.length;
        offsets += Object.keys(ours.offsets).length;
        unavailable += ours.unavailable.length;
      }
    }
    // The random projects exercise every part.
    expect(blocked).toBeGreaterThan(200);
    expect(offsets).toBeGreaterThan(200);
    expect(unavailable).toBeGreaterThan(20);
    g.check();
  }, 120000);

  it("through random performance windows", () => {
    const g = new GoldenLog("controls/windows");
    let notes = 0,
      controls = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(1000 + seed),
        p = randomProject(r),
        ours = new PerformanceTransport(p),
        scene = p.scenes[Math.floor(r() * p.scenes.length)]?.id;
      ours.start(scene);
      const fill = r() < 0.3;
      for (let step = 0; step < 96; step++) {
        if (r() < 0.05) {
          const track = p.tracks[Math.floor(r() * p.tracks.length)]?.id ?? "";
          const event = {
            id: "live",
            at: step,
            kind: "mute" as const,
            trackId: track,
            value: r() < 0.5,
          };
          ours.control(event);
        }
        const a = performanceWindow(ours, step, fill);
        g.add(a);
        notes += a.notes.length;
        controls += a.controls.length;
        if (step % 17 === 0) g.add(performanceValues(ours, step));
      }
    }
    expect(notes).toBeGreaterThan(40);
    expect(controls).toBeGreaterThan(1000);
    g.check();
  }, 120000);

  it("refuses the same invalid positions", () => {
    const p = randomProject(rng(3));
    for (const f of [performanceControls]) {
      expect(() => f(p, -1)).toThrow("Invalid control position");
      expect(() => f(p, Number.NaN)).toThrow("Invalid control position");
      expect(() => f(p, 1000001)).toThrow("Invalid control position");
    }
  });
});
