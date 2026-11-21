import {
  createDemoProject,
  createLegacyDemoProject,
  expandSong,
  openProject,
  ProjectSchema,
  parseProject,
  toggleStep,
} from "@xmp/core";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPortable, hashSample, importPortable } from "../packages/core/src/assets.ts";
import { loadCore, prepareScene, renderProjectScene } from "../packages/core/src/edits.ts";
import { preflightProjectText } from "../packages/core/src/input.ts";
import {
  advanceParameter,
  clearParameterSource,
  parameterValue,
  resolveParameter,
  setParameter,
  smoothParameter,
} from "../packages/core/src/parameters.ts";
import { ProjectSession } from "../packages/core/src/session.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture item");
  return value;
}
type MutableBundle = { assets: { pcm: number[] }[]; project: { samples: { assetHash: string }[] } };
function smallProject() {
  const project = createDemoProject();
  project.samples = [{ id: "impulse", name: "Impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] }];
  for (const pad of project.pads) pad.sampleId = "impulse";
  return project;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("versioned musical model and portable assets", () => {
  it("migrates version-two embedded and portable projects without changing musical values", async () => {
    const current = smallProject(),
      older = { ...current, version: 2 };
    expect(parseProject(JSON.stringify(older))).toEqual(current);
    const portable = JSON.parse(await exportPortable(current));
    portable.project.version = 2;
    expect(await importPortable(JSON.stringify(portable))).toEqual(current);
  });
  it("migrates a version-one file without changing its recovery text or notes", () => {
    const original = JSON.stringify(createLegacyDemoProject());
    const result = openProject(original);
    expect(result.migrated).toBe(true);
    expect(result.originalText).toBe(original);
    expect(result.project.version).toBe(8);
    expect(result.project.tracks).toEqual(JSON.parse(original).tracks);
  });
  it("expands to eight independent tracks and sixteen mapped scenes", () => {
    const original = smallProject(),
      song = expandSong(original);
    expect(song.tracks).toHaveLength(8);
    expect(song.scenes).toHaveLength(16);
    const edited = toggleStep(song, "track-1", "track-1-clip-0", 5, 3);
    expect(edited.tracks[1]?.clips[0]?.steps).toHaveLength(1);
    expect(song.tracks[1]?.clips[0]?.steps).toHaveLength(0);
    expect(song.tracks[0]?.clips.slice(0, 4)).toEqual(original.tracks[0]?.clips);
    expect(original.tracks).toHaveLength(1);
  });
  it("rejects broken parameter and slice references", () => {
    const project = smallProject();
    expect(() =>
      ProjectSchema.parse({ ...project, parameters: [{ id: "track.absent.gain", base: 0.5 }] }),
    ).toThrow("Unknown parameter");
    required(project.pads[0]).slice = { start: 0, end: 99 };
    expect(() => parseProject(JSON.stringify(project))).toThrow("slice");
  });
  it("hashes format/rate/content and deduplicates identical content across sample IDs", async () => {
    const project = smallProject();
    project.samples.push({ ...required(project.samples[0]), id: "alias", name: "Same sound" });
    required(project.pads[1]).sampleId = "alias";
    const text = await exportPortable(project),
      bundle = JSON.parse(text);
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.project.samples).toHaveLength(2);
    expect(await importPortable(text)).toEqual(project);
    expect(await hashSample(24000, [0.5])).not.toEqual(await hashSample(48000, [0.5]));
  });
  it("rejects missing, duplicate, corrupt and path-like asset identifiers", async () => {
    const text = await exportPortable(smallProject());
    for (const mutate of [
      (x: MutableBundle) => {
        required(x.assets[0]).pcm[0] = 0.7;
      },
      (x: MutableBundle) => {
        x.assets = [];
      },
      (x: MutableBundle) => {
        x.assets.push(required(x.assets[0]));
      },
      (x: MutableBundle) => {
        required(x.project.samples[0]).assetHash = "../sample.wav";
      },
    ]) {
      const bundle = JSON.parse(text);
      mutate(bundle);
      await expect(importPortable(JSON.stringify(bundle))).rejects.toThrow();
    }
  });
  it("rejects structural amplification before parsing and validates slice rendering", () => {
    expect(() => preflightProjectText(`${"[".repeat(33)}0${"]".repeat(33)}`)).toThrow("structure");
    expect(() => preflightProjectText(JSON.stringify({ name: "x".repeat(1025) }))).toThrow(
      "string budget",
    );
    const project = smallProject();
    project.pads.forEach((pad) => {
      pad.slice = { start: 1, end: 4 };
    });
    expect(
      new Uint8Array(renderProjectScene(project, "scene-0"))
        .slice(44)
        .every((value) => value === 0),
    ).toBe(true);
  });
});
describe("parameter sources and recoverable editing", () => {
  it("smooths independently of block size with explicit initialization and bounds", () => {
    const halfway = smoothParameter(0, 1, 48000, 10, 240),
      whole = smoothParameter(0, 1, 48000, 10, 480);
    expect(smoothParameter(halfway, 1, 48000, 10, 240)).toBeCloseTo(whole, 14);
    expect(whole).toBeCloseTo(1 - Math.exp(-1), 14);
    expect(smoothParameter(0.2, 0.8, 48000, 0, 1)).toBe(0.8);
    expect(smoothParameter(0.2, 0.8, 48000, 10, 0)).toBe(0.2);
    expect(() => smoothParameter(0, NaN, 48000, 10, 480)).toThrow();
    expect(() => smoothParameter(0, 1, 0, 10, 480)).toThrow();
    expect(advanceParameter(smallProject(), "master.gain", 0, 480)).toBeCloseTo(
      0.55 * (1 - Math.exp(-1)),
      14,
    );
  });

  it("applies the documented precedence, clamp and lock release", () => {
    let project = smallProject();
    for (const [source, value] of [
      ["base", 0.2],
      ["automation", 0.4],
      ["stepLock", 0.7],
      ["macro", 0.1],
      ["lfo", -0.2],
    ] as const)
      project = setParameter(project, "track.drums.gain", value, source);
    expect(parameterValue(project, "track.drums.gain")).toBeCloseTo(0.6, 10);
    project = clearParameterSource(project, "track.drums.gain", "stepLock");
    expect(parameterValue(project, "track.drums.gain")).toBeCloseTo(0.3, 10);
    expect(resolveParameter({ base: 1, macro: 1 })).toBe(1);
    expect(resolveParameter({ base: 0, lfo: -1 })).toBe(0);
    expect(() => setParameter(project, "master.gain", Infinity)).toThrow();
  });
  it("keeps undo/redo and dirty status after a storage failure", async () => {
    const original = smallProject(),
      session = new ProjectSession(original, true);
    session.edit((project) => setParameter(project, "track.drums.effect.gain", 0.7));
    await expect(
      session.save({
        save: async () => {
          throw new Error("Quota exceeded");
        },
      }),
    ).rejects.toThrow("Quota");
    expect(session.dirty).toBe(true);
    expect(session.error).toContain("Unsaved");
    session.undo();
    expect(session.project).toEqual(original);
    session.redo();
    expect(parameterValue(session.project, "track.drums.effect.gain")).toBe(0.7);
  });
  it("refuses stale asynchronous imports and preserves current edits", async () => {
    const session = new ProjectSession(smallProject(), true);
    const incoming = await exportPortable(smallProject());
    const opening = session.open(incoming);
    session.edit((project) => ({ ...project, name: "Edit while importing" }));
    await expect(opening).rejects.toThrow("changed during import");
    expect(session.project.name).toBe("Edit while importing");
  });
  it("does not mark newer edits saved when an older snapshot commits", async () => {
    const session = new ProjectSession(smallProject(), true);
    session.edit((project) => ({ ...project, name: "Snapshot" }));
    let finish: () => void = () => {};
    const pending = session.save({
      save: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await Promise.resolve();
    await Promise.resolve();
    session.edit((project) => ({ ...project, name: "Newer edit" }));
    finish();
    await pending;
    expect(session.dirty).toBe(true);
    session.undo();
    expect(session.dirty).toBe(false);
  });
  it("uses slices and parameter gain in a bounded render plan", () => {
    const project = smallProject();
    project.bpm = 120;
    required(project.pads[0]).slice = { start: 0, end: 1 };
    const plan = prepareScene(project, "scene-0");
    expect(plan.sampleRate).toBe(48000);
    expect(plan.events.length).toBeGreaterThan(0);
    expect(plan.samples.some((sample) => sample.length === 1)).toBe(true);
  });
});
describe("browser transaction boundaries", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.resetModules();
  });
  async function database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xmp-studio-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function overwrite(text: string) {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put(text, "autosave");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  it("keeps the old snapshot on transaction abort, with an actionable quota error", async () => {
    const storage = await import("../apps/studio/src/storage.ts");
    const original = smallProject();
    await storage.saveProject(original);
    const session = new ProjectSession(original, true);
    session.edit((project) => ({ ...project, name: "Unsaved" }));
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (args[1] === "autosave") throw new DOMException("Storage full", "QuotaExceededError");
      return put.apply(this, args);
    });
    await expect(session.save({ save: storage.saveProject })).rejects.toThrow("Storage full");
    expect(session.dirty).toBe(true);
    expect((await storage.loadProjectState()).project).toEqual(original);
    expect(session.canUndo).toBe(true);
  });
  it("recovers a validated previous snapshot after a damaged current record", async () => {
    const storage = await import("../apps/studio/src/storage.ts");
    const original = smallProject();
    await storage.saveProject(original);
    await storage.saveProject({ ...original, name: "Later save" });
    await overwrite("{truncated");
    const recovered = await storage.loadProjectState();
    expect(recovered.recovered).toBe(true);
    expect(recovered.project).toEqual(original);
    await storage.saveProject({ ...original, name: "Recovered edit" });
    expect((await storage.loadProjectState()).project?.name).toBe("Recovered edit");
  });
  it("rejects a stale tab rather than overwriting a newer committed project", async () => {
    const first = await import("../apps/studio/src/storage.ts");
    const original = smallProject();
    await first.saveProject(original);
    vi.resetModules();
    const second = await import("../apps/studio/src/storage.ts");
    await second.loadProjectState();
    await first.saveProject({ ...original, name: "First tab changed" });
    await expect(second.saveProject({ ...original, name: "Stale tab" })).rejects.toThrow(
      "Another tab",
    );
    expect((await first.loadProjectState()).project?.name).toBe("First tab changed");
  });
});
