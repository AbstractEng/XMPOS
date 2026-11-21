import { describe, expect, it } from "vitest";
import {
  createDemoProject,
  expandSong,
  type Project,
  ProjectSchema,
} from "../packages/core/src/index.ts";
import { PerformanceTransport } from "../packages/core/src/performance.ts";
import { GoldenLog } from "./golden.ts";

// The C++ performance transport (native/include/xmp/transport.hpp, as
// WebAssembly) against the original TypeScript, driven by the same random
// sequences of starts, launches, clip changes, stops, project edits (including
// song chain edits mid-song) and clock advances. Every observable field and
// every result must be identical.
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomProject(r: () => number): Project {
  const p = expandSong(createDemoProject());
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  for (const track of p.tracks)
    for (const clip of track.clips) clip.length = pick([16, 32, 64] as const);
  // Some scenes leave tracks empty.
  for (const scene of p.scenes)
    for (const track of p.tracks) if (r() < 0.15) delete scene.clips[track.id];
  const chain = Array.from({ length: Math.floor(r() * 6) }, (_, i) => ({
    id: `occ-${i}`,
    sceneId: pick(p.scenes).id,
    repeats: 1 + Math.floor(r() * 3),
  }));
  p.performance = {
    ...(p.performance ?? {}),
    version: 1,
    chain,
    end: r() < 0.5 ? "loop" : "stop",
    mutes: {},
    solos: [],
    macros: [],
    events: [],
    delay: { steps: 3, feedback: 0.3, wet: 0.2, sends: {} },
    ...(chain.length && r() < 0.5
      ? {
          position: {
            occurrenceId: pick(chain).id,
            offset: Math.floor(r() * 32),
          },
        }
      : {}),
    ...(r() < 0.4
      ? {
          selection: {
            sceneId: p.scenes[0]?.id ?? "scene-0",
            clips: Object.fromEntries(
              p.tracks.filter(() => r() < 0.6).map((t) => [t.id, pick(t.clips).id]),
            ),
          },
        }
      : {}),
  } as Project["performance"];
  return ProjectSchema.parse(p);
}

function observe(t: PerformanceTransport) {
  return {
    sceneId: t.sceneId,
    running: t.running,
    mode: t.mode,
    step: t.step,
    songOffset: t.songOffset,
    clockOrigin: t.clockOrigin,
    queuedScene: t.queuedScene,
    queuedClips: [...t.queuedClips],
    slots: [...t.slots],
    snapshot: t.snapshot(),
  };
}
function attempt(f: () => unknown) {
  try {
    return { value: f() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe("the C++ transport (recorded when it matched the original TypeScript)", () => {
  it("through random performances", () => {
    const g = new GoldenLog("transport/performances");
    let advances = 0,
      songEnds = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed),
        project = randomProject(r),
        ours = new PerformanceTransport(project);
      let current = project;
      const both = (f: (t: PerformanceTransport) => unknown) => {
        const a = attempt(() => f(ours));
        g.add(a);
        g.add(observe(ours));
        return a;
      };
      for (let op = 0; op < 120; op++) {
        const roll = r();
        if (roll < 0.08) {
          const mode = r() < 0.6 ? "song" : "scene",
            scene = r() < 0.9 ? current.scenes[Math.floor(r() * 4)]?.id : "nowhere";
          const resume = r() < 0.5;
          both((t) => t.start(scene, mode, resume));
        } else if (roll < 0.14) {
          const scene = current.scenes[Math.floor(r() * 6)]?.id ?? "";
          both((t) => t.queueScene(scene));
        } else if (roll < 0.22) {
          const track = current.tracks[Math.floor(r() * current.tracks.length)];
          const clip = r() < 0.2 ? null : (track?.clips[Math.floor(r() * 4)]?.id ?? null);
          both((t) => t.queueClip(track?.id ?? "", clip));
        } else if (roll < 0.25) both((t) => t.cancelLaunch());
        else if (roll < 0.27) both((t) => t.stop());
        else if (roll < 0.33) {
          // Edit the song chain (and sometimes delete a track) while playing.
          const next = structuredClone(current);
          if (next.performance) {
            next.performance.chain = next.performance.chain
              .filter(() => r() < 0.8)
              .map((e) => ({ ...e, repeats: r() < 0.3 ? 1 + Math.floor(r() * 3) : e.repeats }));
            if (r() < 0.4)
              next.performance.chain.push({
                id: `occ-new-${op}`,
                sceneId: next.scenes[Math.floor(r() * 8)]?.id ?? "scene-0",
                repeats: 1,
              });
            if (
              !next.performance.chain.some((e) => e.id === next.performance?.position?.occurrenceId)
            )
              delete next.performance.position;
          }
          if (r() < 0.2 && next.tracks.length > 2) {
            const gone = next.tracks.pop();
            for (const s of next.scenes) if (gone) delete s.clips[gone.id];
            if (next.performance?.selection && gone)
              delete next.performance.selection.clips[gone.id];
          }
          current = ProjectSchema.parse(next);
          both((t) => t.setProject(current));
        } else {
          const step = Math.max(0, ours.step) + Math.floor(r() * (r() < 0.2 ? 200 : 9));
          const result = both((t) => t.advance(step)) as {
            value?: { snapshot: { running: boolean } };
          };
          advances++;
          if (result.value && !result.value.snapshot.running) songEnds++;
        }
      }
    }
    expect(advances).toBeGreaterThan(1000);
    expect(songEnds).toBeGreaterThan(15);
    g.check();
  }, 120000);

  it("refuses the same malformed advances", () => {
    const project = randomProject(rng(5));
    {
      const t = new PerformanceTransport(project);
      t.start(project.scenes[0]?.id, "scene");
      t.advance(10);
      expect(() => t.advance(9)).toThrow("Invalid performance clock advance");
      expect(() => t.advance(10.5)).toThrow("Invalid performance clock advance");
      expect(() => t.advance(10 + 5000)).toThrow("Invalid performance clock advance");
      expect(() => t.queueScene("nowhere")).toThrow("Unknown scene");
      expect(() => t.queueClip("drums", "nowhere")).toThrow("Unknown clip or track");
    }
  });
});
