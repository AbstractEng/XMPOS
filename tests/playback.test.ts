import { describe, expect, it } from "vitest";
import * as wasm from "../packages/core/src/edits.ts";
import {
  createDemoProject,
  eventsAtStep,
  expandSong,
  type Project,
  ProjectSchema,
} from "../packages/core/src/index.ts";
import {
  PerformanceTransport,
  performanceControls,
  performanceValues,
  performanceWindow,
} from "../packages/core/src/performance.ts";
import { parameterFrame, timeline } from "../packages/core/src/sequencer.ts";
import { GoldenLog } from "./golden.ts";
import { performedProject, richProject, rng, sequencedProject } from "./project-fixtures.ts";

// Playback through the C++ core in WebAssembly (packages/core/src/edits.ts)
// against the TypeScript transport: the same random performances (starts,
// launches, live controls, chain edits while playing) give the same state,
// windows, scheduled commands, parameter values and controls.
type Outcome = { ok: true; value: unknown } | { ok: false; message: string };
const attempt = (f: () => unknown): Outcome => {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};
// Numbers equal to 1e-12 (the parity suites' tolerance for windows' frame arithmetic).
function close(a: unknown, b: unknown, path: string): string | undefined {
  if (typeof a === "number" && typeof b === "number")
    return a === b || Math.abs(a - b) < 1e-12 ? undefined : `${path}: ${a} vs ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = close(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(),
      kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) {
      const d = close(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
    return undefined;
  }
  return a === b ? undefined : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
function same(a: Outcome, b: Outcome, context: string) {
  expect(b.ok, `${context}\n${a.ok ? "" : a.message}\n${b.ok ? "" : b.message}`).toBe(a.ok);
  if (a.ok && b.ok) expect(close(a.value, b.value, "")).toBeUndefined();
  else if (!a.ok && !b.ok && !a.message.startsWith("[")) expect(b.message, context).toBe(a.message);
}
type Transport = {
  sceneId: string;
  running: boolean;
  mode: string;
  step: number;
  songOffset: number;
  clockOrigin: number;
  slots: Map<string, { clipId?: string; anchor: number }>;
  queuedScene?: { id: string; at: number };
  queuedClips: Map<string, { id: string | null; at: number }>;
  overrides: ReadonlyMap<string, boolean | number>;
};
const state = (t: Transport) => ({
  sceneId: t.sceneId,
  running: t.running,
  mode: t.mode,
  step: t.step,
  songOffset: t.songOffset,
  clockOrigin: t.clockOrigin,
  slots: [...t.slots],
  queuedScene: t.queuedScene ?? null,
  queuedClips: [...t.queuedClips],
  overrides: [...t.overrides],
});

describe("playback through the C++ core (WebAssembly)", () => {
  it("matches the TypeScript transport through random performances", () => {
    // The windows' scheduled commands, fingerprinted: recorded while they
    // matched performance-render.ts, which phase 9 retired.
    const g = new GoldenLog("playback/commands");
    let windows = 0,
      notes = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed * 104659),
        pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
      let project: Project = performedProject(seed);
      const a = new PerformanceTransport(project),
        b = new wasm.PerformanceTransport(project);
      const both = (name: string, fa: () => unknown, fb: () => unknown) => {
        same(attempt(fa), attempt(fb), `seed ${seed}: ${name}`);
        same(
          attempt(() => state(a)),
          attempt(() => state(b)),
          `seed ${seed}: state after ${name}`,
        );
      };
      both(
        "new",
        () => 0,
        () => 0,
      );
      for (let i = 0; i < 140; i++) {
        const roll = r();
        if (roll < 0.05 || i === 0) {
          const mode = r() < 0.5 ? "song" : "scene",
            scene = r() < 0.1 ? undefined : pick(project.scenes).id,
            resume = r() < 0.3;
          both(
            `start ${scene} ${mode}`,
            () => a.start(scene, mode, resume),
            () => b.start(scene, mode, resume),
          );
        } else if (roll < 0.09) {
          const scene = r() < 0.9 ? pick(project.scenes).id : "nowhere";
          both(
            "queueScene",
            () => a.queueScene(scene),
            () => b.queueScene(scene),
          );
        } else if (roll < 0.14) {
          const track = pick(project.tracks),
            clip = r() < 0.2 ? null : (pick(track.clips)?.id ?? null);
          both(
            "queueClip",
            () => a.queueClip(track.id, clip),
            () => b.queueClip(track.id, clip),
          );
        } else if (roll < 0.16)
          both(
            "cancel",
            () => a.cancelLaunch(),
            () => b.cancelLaunch(),
          );
        else if (roll < 0.17)
          both(
            "stop",
            () => a.stop(),
            () => b.stop(),
          );
        else if (roll < 0.23) {
          const event = {
            id: "live",
            at: Math.max(0, a.step),
            kind: pick(["mute", "solo"]),
            trackId: r() < 0.9 ? pick(project.tracks).id : "nowhere",
            value: r() < 0.5,
          };
          both(
            "control",
            () => a.control(event as never),
            () => b.control(event),
          );
        } else if (roll < 0.26) {
          const next = structuredClone(project);
          if (next.performance) {
            next.performance.chain = next.performance.chain.filter(() => r() < 0.8);
            if (r() < 0.5)
              next.performance.chain.push({
                id: `new-${i}`,
                sceneId: pick(next.scenes).id,
                repeats: 1,
              });
          }
          project = ProjectSchema.parse(next);
          const p = project;
          both(
            "setProject",
            () => a.setProject(p),
            () => b.setProject(p),
          );
        } else if (roll < 0.29) {
          const position = r() * 64;
          both(
            "values",
            () => performanceValues(a, position),
            () => wasm.performanceValues(b, position),
          );
        } else if (roll < 0.31) {
          const position = r() < 0.1 ? -1 : r() * 128,
            overrides = new Map(a.overrides);
          both(
            "controls",
            () => performanceControls(project, position, overrides),
            () => wasm.performanceControls(project, position, overrides),
          );
        } else if (roll < 0.33)
          both(
            "snapshot",
            () => a.snapshot(),
            () => b.snapshot(),
          );
        else {
          const step = Math.max(0, a.step) + (r() < 0.04 ? pick([-1, 5000, 0.5]) : 1),
            fill = r() < 0.2,
            swing = pick([0, 0.1]);
          let wa: unknown, wb: unknown;
          both(
            "window",
            () => {
              const w = performanceWindow(a, step, fill, swing, 48000);
              wa = w;
              return { window: w };
            },
            () => {
              const w = wasm.performanceWindow(b, step, fill, swing, 48000);
              wb = w;
              g.add(wasm.performanceCommands(w));
              return { window: w };
            },
          );
          if (wa && wb) {
            windows++;
            notes += (wa as { notes: unknown[] }).notes.length;
          }
        }
      }
    }
    expect(windows).toBeGreaterThan(500);
    expect(notes).toBeGreaterThan(100);
    g.check();
  }, 600000);

  it("plays projects without a performance or mix as the TypeScript does", () => {
    let notes = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = rng(seed * 7121),
        project: Project = seed % 2 ? sequencedProject(seed) : richProject(r);
      // Without a performance or mix, as the demo song is (parameters naming the mix go too).
      const strip = structuredClone(project);
      delete strip.performance;
      delete strip.mix;
      strip.parameters = strip.parameters.filter((x) =>
        /^(master\.gain|track\.[^.]+\.(gain|effect\.gain|machine\..*))$/.test(x.id),
      );
      const p = seed === 8 ? expandSong(createDemoProject()) : ProjectSchema.parse(strip);
      for (const scene of p.scenes.slice(0, 3)) {
        for (let step = 0; step < 40; step += 3) {
          const fill = step % 2 === 0,
            swing = seed % 3 ? 0 : 0.12;
          const a = attempt(() => timeline(p, scene.id, step, step + 1, fill, swing, 48000)),
            b = attempt(() => wasm.timeline(p, scene.id, step, step + 1, fill, swing, 48000));
          same(a, b, `timeline ${seed} ${scene.id} ${step}`);
          if (a.ok) notes += (a.value as unknown[]).length;
          same(
            attempt(() => eventsAtStep(p, scene.id, step)),
            attempt(() => wasm.eventsAtStep(p, scene.id, step)),
            `events ${seed} ${step}`,
          );
          same(
            attempt(() => parameterFrame(p, scene.id, step + 0.25)),
            attempt(() => wasm.parameterFrame(p, scene.id, step + 0.25)),
            `frame ${seed} ${step}`,
          );
        }
      }
      same(
        attempt(() => parameterFrame(p, "nowhere", 0)),
        attempt(() => wasm.parameterFrame(p, "nowhere", 0)),
        "missing scene",
      );
    }
    expect(notes).toBeGreaterThan(50);
  }, 600000);
});
