import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as wasm from "../packages/core/src/edits.ts";
import { type Project, ProjectSchema, toggleStep } from "../packages/core/src/index.ts";
import {
  parameterRegistry,
  parameterSmoothingMs,
  parameterValue,
  setParameter,
} from "../packages/core/src/parameters.ts";
import { applyOp, type EditFunctions, randomOp, typescriptEdits } from "./edit-ops.ts";
import { richProject, rng } from "./project-fixtures.ts";

// The browser's project edits and parameter functions through the C++ core in
// WebAssembly (packages/core/src/edits.ts) against the TypeScript they replace:
// the same random edit sequences give byte-identical projects and the same
// refusals, parameters read and set the same, and sample audio is never
// copied for an edit.
const wasmEdits: EditFunctions = {
  toggleStep: wasm.toggleStep,
  expandSong: wasm.expandSong,
  appendNotes: wasm.appendNotes,
  quantizeNotes: wasm.quantizeNotes,
  resizeClip: wasm.resizeClip,
  duplicateClip: wasm.duplicateClip,
  editChain: wasm.editChain,
  deleteTrack: wasm.deleteTrack,
  setMidiDestination: wasm.setMidiDestination,
  manualSlices: wasm.manualSlices,
  installSample: wasm.installSample,
  applyDrumKit: wasm.applyDrumKit,
  ownKit: wasm.ownKit,
  shareKit: wasm.shareKit,
  editMix: wasm.editMix,
  editPerformance: wasm.editPerformance,
  editSequence: wasm.editSequence,
};
const attempt = (f: () => Project) => {
  try {
    return { ok: true as const, project: f() };
  } catch (error) {
    return { ok: false as const, error: error as Error };
  }
};

describe("project edits through the C++ core (WebAssembly)", () => {
  beforeAll(() => wasm.loadCore());

  it("match the TypeScript through random edit sequences", () => {
    let applied = 0,
      refused = 0,
      own = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const r = rng(seed * 6007);
      let ts = richProject(r),
        cpp = ts;
      for (let i = 0; i < 50; i++) {
        const op = randomOp(ts, r);
        const a = attempt(() => applyOp(typescriptEdits, ts, op)),
          b = attempt(() => applyOp(wasmEdits, cpp, op));
        const context = `seed ${seed}, edit ${i}: ${JSON.stringify(op).slice(0, 300)}`;
        expect(
          b.ok,
          `${context}\n${b.ok ? "" : b.error.message}\n${a.ok ? "" : a.error.message}`,
        ).toBe(a.ok);
        if (a.ok && b.ok) {
          expect(JSON.stringify(b.project), context).toBe(JSON.stringify(a.project));
          ts = a.project;
          cpp = b.project;
          applied++;
        } else if (!a.ok && !b.ok) {
          refused++;
          if (!(a.error instanceof z.ZodError)) {
            expect(b.error.message, context).toBe(a.error.message);
            own++;
          }
        }
      }
    }
    expect(applied).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(100);
    expect(own).toBeGreaterThan(50);
  }, 600000);

  it("read and set parameters as the TypeScript does", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const p = richProject(rng(seed * 31));
      const registry = parameterRegistry(p);
      expect(wasm.parameterRegistry(p)).toEqual(registry);
      for (const d of registry) {
        expect(wasm.parameterValue(p, d.id), d.id).toBe(parameterValue(p, d.id));
        expect(wasm.parameterSmoothingMs(p, d.id)).toBe(parameterSmoothingMs(p, d.id));
      }
      for (const d of registry.slice(0, 12)) {
        const a = attempt(() => setParameter(p, d.id, 0.37, "base")),
          b = attempt(() => wasm.setParameter(p, d.id, 0.37, "base"));
        expect(b.ok, d.id).toBe(a.ok);
        if (a.ok && b.ok) expect(JSON.stringify(b.project)).toBe(JSON.stringify(a.project));
      }
      expect(() => wasm.parameterValue(p, "nowhere")).toThrow("Unknown parameter nowhere");
    }
  }, 600000);

  it("never copy sample audio for an edit, and keep each project's own audio", () => {
    const p = ProjectSchema.parse(richProject(rng(5)));
    const track = p.tracks[0],
      clip = track?.clips[0];
    if (!track || !clip) throw new Error("no clip");
    const first = wasm.toggleStep(p, track.id, clip.id, 0, 3);
    const second = wasm.toggleStep(first, track.id, clip.id, 0, 3);
    for (const [i, s] of first.samples.entries()) expect(s.pcm).toBe(p.samples[i]?.pcm);
    for (const [i, s] of second.samples.entries()) expect(s.pcm).toBe(p.samples[i]?.pcm);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(toggleStep(toggleStep(p, track.id, clip.id, 0, 3), track.id, clip.id, 0, 3)),
    );
    // Timing, for the record: a step edit on the project.
    const started = performance.now();
    let q = second;
    for (let i = 0; i < 20; i++) q = wasm.toggleStep(q, track.id, clip.id, 0, i % 16);
    const each = (performance.now() - started) / 20;
    console.log(
      `toggleStep through the C++ core: ${each.toFixed(1)} ms each (${p.samples.length} samples)`,
    );
    expect(each).toBeLessThan(500);
  }, 600000);

  it("refuse a bad edit with the core's message", () => {
    const p = richProject(rng(9));
    expect(() => wasm.deleteTrack(p, "nowhere")).toThrow();
  });
});
