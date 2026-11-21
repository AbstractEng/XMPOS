import { describe, expect, it } from "vitest";
import {
  createDemoProject,
  eventsAtStep,
  expandSong,
  type Project,
  ProjectSchema,
  stepTime,
} from "../packages/core/src/index.ts";
import { synthPresets } from "../packages/core/src/instrument-schema.ts";
import { parameterRegistry } from "../packages/core/src/parameters.ts";
import {
  groovePosition,
  notesInWindow,
  parameterFrame,
  timeline,
} from "../packages/core/src/sequencer.ts";
import { GoldenLog } from "./golden.ts";
import { rng, sequencedProject } from "./project-fixtures.ts";

// The C++ sequencer (native/include/xmp/sequencer.hpp, as WebAssembly) against
// the original TypeScript on randomized projects: which notes play, in what
// order, on which frame, with which velocity and duration, and every automated
// parameter value. Everything must match exactly except the LFO, where the C
// library's sin may differ from JavaScript's in the last bit.

const scrub = (frame: Record<string, number>) =>
  Object.fromEntries(Object.entries(frame).map(([k, v]) => [k, Math.round(v * 1e12) / 1e12]));

describe("the C++ sequencer matches the TypeScript sequencer", () => {
  it("swing and step times agree exactly", () => {
    const g = new GoldenLog("sequencer/groove");
    const r = rng(7);
    for (let i = 0; i < 5000; i++) {
      const position = r() * 1000,
        swing = r() * 0.5,
        step = Math.floor(r() * 100000),
        bpm = 30 + r() * 270;
      g.add(groovePosition(position, swing));
      g.add(stepTime(step, bpm, swing));
    }
    g.check();
  });

  it("chooses the same notes, order, frames and parameter values on random projects", () => {
    const g = new GoldenLog("sequencer/projects");
    let notes = 0,
      events = 0,
      frames = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const project = sequencedProject(seed),
        r = rng(seed * 31);
      for (const scene of project.scenes.slice(0, 6)) {
        for (let i = 0; i < 12; i++) {
          const from = Math.floor(r() * 400 * 4) / 4,
            to = from + 0.25 + Math.floor(r() * 64 * 4) / 4,
            fill = r() < 0.5,
            swing = r() < 0.5 ? project.swing : Math.round(r() * 50) / 100;
          const window = notesInWindow(project, scene.id, from, Math.min(to, from + 64), fill);
          g.add(window);
          const timed = timeline(project, scene.id, from, from + 1, fill, swing, 44100);
          g.add(timed);
          notes += window.length;
        }
        for (let step = 0; step < 140; step += 1 + Math.floor(r() * 3)) {
          const ours = eventsAtStep(project, scene.id, step);
          g.add(ours);
          events += ours.length;
        }
        for (let i = 0; i < 10; i++) {
          const position = Math.floor(r() * 300 * 16) / 16,
            offsets: Record<string, number> =
              r() < 0.4 ? { "track.drums.gain": Math.round((r() * 2 - 1) * 100) / 100 } : {};
          g.add(scrub(parameterFrame(project, scene.id, position, offsets)));
          frames++;
        }
      }
    }
    // The comparison covered real material, not empty windows.
    expect(notes).toBeGreaterThan(800);
    expect(events).toBeGreaterThan(200);
    expect(frames).toBe(960);
    g.check();
  }, 180000);

  it("rejects the same malformed requests", () => {
    const project = sequencedProject(3);
    for (const call of [
      () => notesInWindow(project, "scene-0", -1, 4),
      () => notesInWindow(project, "scene-0", 4, 4),
      () => notesInWindow(project, "scene-0", 0, 65),
      () => notesInWindow(project, "missing", 0, 4),
      () => parameterFrame(project, "scene-0", -1),
      () => parameterFrame(project, "missing", 0),
      () => groovePosition(1, 0.6),
    ])
      expect(call).toThrow();
    expect(eventsAtStep(project, "missing", 0)).toEqual([]);
  });
});

describe("the committed WebAssembly sequencer", () => {
  it("was built from the C++ sources in this tree", async () => {
    const { createHash } = await import("node:crypto");
    const { MODULES, sourceHash } = await import("../tools/engine/build-wasm.mjs");
    const generated = await import("../packages/core/src/generated/xmp-sequencer-wasm.ts");
    const { decodeBase64 } = await import("../packages/core/src/engine.ts");
    const module = MODULES.find((m) => m.name === "sequencer");
    expect(generated.SEQUENCER_SOURCE_SHA256, "run `npm run engine:wasm`").toBe(
      await sourceHash(module),
    );
    expect(
      createHash("sha256").update(decodeBase64(generated.SEQUENCER_WASM_BASE64)).digest("hex"),
    ).toBe(generated.SEQUENCER_WASM_SHA256);
  });
});
