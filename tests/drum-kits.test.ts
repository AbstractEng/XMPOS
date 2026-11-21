// @vitest-environment happy-dom
import { createDemoProject, encodeWav, type Project } from "@xmp/core";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDrumKitPanel } from "../apps/studio/src/drum-kit-panel.ts";
import { loadKits, saveKit } from "../apps/studio/src/kit-storage.ts";
import { exportPortable, importPortable } from "../packages/core/src/assets.ts";
import { applyDrumKit, drumKitFromWavs } from "../packages/core/src/drum-kits.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { ProjectSession } from "../packages/core/src/session.ts";

const wav = (name: string, strength = 0.5) => ({
  name,
  bytes: new Uint8Array(
    encodeWav(
      [
        Float32Array.from(
          { length: 2400 },
          (_, i) => strength * Math.exp(-i / 250) * Math.sin(i * 0.12),
        ),
      ],
      48000,
    ),
  ),
});
const files = () => [
  wav("Snare.wav"),
  wav("Kick 02.wav"),
  wav("Closed Hat.wav"),
  wav("Kick 01.wav"),
  wav("Open Hat.wav"),
];
const kit = () => drumKitFromWavs("Test kit", files());
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads an ordered kit atomically, silences unused pads and preserves the song through undo", async () => {
  const original = createDemoProject();
  const pad = original.pads[0];
  if (!pad) throw new Error("Missing fixture pad");
  pad.slice = { start: 10, end: 200 };
  pad.edit = { reverse: true, normalize: true };
  pad.playback = { mode: "loop", rootNote: 48, chokeGroup: 2 };
  const session = new ProjectSession(original),
    selected = kit();
  expect(selected.samples.map((s) => s.name)).toEqual([
    "Kick 01",
    "Snare",
    "Closed Hat",
    "Open Hat",
    "Kick 02",
  ]);
  session.edit((p) => applyDrumKit(p, selected));
  expect(session.project.tracks).toEqual(original.tracks);
  expect(session.project.scenes).toEqual(original.scenes);
  expect(session.project.bpm).toBe(original.bpm);
  expect(session.project.pads[0]?.slice).toBeUndefined();
  expect(session.project.pads[0]?.edit).toBeUndefined();
  expect(session.project.pads[0]?.playback?.mode).toBe("one-shot");
  expect(
    session.project.samples.find((s) => s.id === session.project.pads[15]?.sampleId)?.pcm,
  ).toEqual([0]);
  expect(await importPortable(await exportPortable(session.project))).toEqual(session.project);
  expect(session.historyDepth).toBe(1);
  session.undo();
  expect(session.project).toEqual(original);
});

it("rejects malformed, oversized and excessive kit inputs without changing the project", () => {
  const session = new ProjectSession(createDemoProject()),
    before = session.project;
  for (const candidates of [
    [],
    Array.from({ length: 17 }, () => wav("kick.wav")),
    [wav("kick.wav"), { name: "broken.wav", bytes: new Uint8Array(44) }],
  ])
    expect(() =>
      session.edit((p) => applyDrumKit(p, drumKitFromWavs("Bad", candidates))),
    ).toThrow();
  const oversized = {
    name: "Large",
    samples: Array.from({ length: 3 }, () => ({
      name: "Long",
      sampleRate: 48000,
      pcm: Array(400000).fill(0),
    })),
  };
  expect(() => session.edit((p) => applyDrumKit(p, oversized))).toThrow("budget");
  expect(session.project).toBe(before);
  expect(session.historyDepth).toBe(0);
});

it("renders imported hits and leaves unassigned pads silent without opening audio hardware", () => {
  const project = applyDrumKit(createDemoProject(), kit());
  const render = (pad: number) => {
    const rack = new VoiceRack(prepareInstruments(project)),
      left = new Float32Array(128),
      right = new Float32Array(128);
    rack.noteOn(1, pad, 0, 60, 0.8);
    rack.process(left, right);
    return left;
  };
  expect(render(0).some((v) => Math.abs(v) > 0.001)).toBe(true);
  expect(render(15).every((v) => v === 0)).toBe(true);
});

it("persists a bounded kit library and keeps existing kits when it is full", async () => {
  for (let i = 0; i < 8; i++) await saveKit({ ...kit(), name: `Kit ${i}` });
  expect((await loadKits()).map((v) => v.kit.name)).toEqual(
    expect.arrayContaining(["Kit 0", "Kit 7"]),
  );
  await expect(saveKit(kit())).rejects.toThrow("eight kits");
  expect(await loadKits()).toHaveLength(8);
});

function panel() {
  const session = new ProjectSession(createDemoProject());
  document.body.innerHTML = '<div id="kit-tools"></div>';
  const controls = installDrumKitPanel(document, {
    project: () => session.project,
    revision: () => session.revision,
    mutate: (change: (p: Project) => Project) => {
      session.edit(change);
    },
  });
  return { session, ...controls };
}
function upload(
  candidates: { name: string; bytes: Uint8Array; arrayBuffer?: () => Promise<ArrayBuffer> }[],
) {
  const input = document.getElementById("kit-files") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: candidates.map((file) => ({
      name: file.name,
      size: file.bytes.length,
      arrayBuffer: file.arrayBuffer ?? (async () => file.bytes.buffer),
    })),
  });
  input.dispatchEvent(new Event("change"));
}
const kitStatus = () => document.getElementById("kit-status")?.textContent;
it("imports through the Studio controls, reloads the library and switches back to the original kit", async () => {
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      throw new Error("No physical audio");
    }),
  );
  const view = panel();
  await view.initialized;
  (document.getElementById("kit-name") as HTMLInputElement).value = "Local drums";
  upload(files());
  await vi.waitFor(() => expect(kitStatus()).toContain("Loaded Local drums"));
  expect(view.session.project.pads[0]?.name).toBe("Kick 01");
  expect(view.session.historyDepth).toBe(1);
  const choice = document.getElementById("kit-choice") as HTMLSelectElement;
  choice.value = "original";
  document.getElementById("kit-load")?.click();
  expect(view.session.project.samples).toHaveLength(16);
  view.session.undo();
  expect(view.session.project.pads[0]?.name).toBe("Kick 01");
  const reloaded = panel();
  await reloaded.initialized;
  expect(document.getElementById("kit-choice")?.textContent).toContain("Local drums");
  expect(AudioContext).not.toHaveBeenCalled();
});

it("keeps an edited project intact when asynchronous WAV reading becomes stale", async () => {
  const view = panel();
  await view.initialized;
  let finish: (value: ArrayBuffer) => void = () => {};
  const pending = new Promise<ArrayBuffer>((resolve) => {
    finish = resolve;
  });
  const source = wav("Kick.wav");
  upload([{ ...source, arrayBuffer: () => pending }]);
  view.session.edit((p) => ({ ...p, name: "Keep my edits" }));
  finish(source.bytes.buffer as ArrayBuffer);
  await vi.waitFor(() => expect(kitStatus()).toContain("Project changed during import"));
  expect(view.session.project.name).toBe("Keep my edits");
  expect(view.session.project.pads[0]?.name).toBe("Kick");
  expect(await loadKits()).toHaveLength(0);
});
