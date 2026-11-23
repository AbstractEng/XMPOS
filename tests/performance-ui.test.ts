// @vitest-environment happy-dom
import type { Project } from "@xmp/core";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  audio: {
    playing: false,
    state: "off",
    sampleRate: 48000,
    lateSteps: 0,
    position: 12.25,
    clockAnchor: 4,
    queuedLaunch: undefined as string | undefined,
    performanceSnapshot: undefined,
    setProject: vi.fn(),
    enable: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    panic: vi.fn(),
    noteOff: vi.fn(),
    trigger: vi.fn(),
    queueScene: vi.fn(),
    cancelLaunch: vi.fn(),
    performanceControl: vi.fn(),
    automate: vi.fn(),
    clearAutomation: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock("../apps/studio/src/storage.ts", () => ({
  loadProjectState: async () => ({}),
  loadProjectSnapshot: async () =>
    (await import("./studio-project-fixture.ts")).studioProjectSnapshot(),
  saveProjectText: async () => {
    throw new Error("An existing Studio fixture must not be reseeded");
  },
  saveProject: mock.save,
}));
vi.mock("../apps/studio/src/audio.ts", () => ({
  StudioAudio: vi.fn(function MockAudio() {
    return mock.audio;
  }),
  renderScene: vi.fn(),
}));
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing ${id}`);
  return node as T;
};
const key = (node: HTMLElement, name: string) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
const change = (id: string, value: string) => {
  el<HTMLInputElement>(id).value = value;
  el(id).dispatchEvent(new Event("change", { bubbles: true }));
};
const state = () => ({
  project: JSON.stringify(mock.project),
  revision: el("app").dataset.projectRevision,
  undo: el("app").dataset.undoDepth,
  redo: el("app").dataset.redoDepth,
  clock: mock.audio.clockAnchor,
  queued: mock.audio.queuedLaunch,
});
const track = (id: string) => {
  const b = document.querySelector<HTMLButtonElement>(`[data-track="${id}"]`);
  if (!b) throw new Error("Missing track");
  b.click();
};
beforeAll(async () => {
  vi.useFakeTimers();
  mock.audio.setProject.mockImplementation((p: Project) => {
    mock.project = p;
  });
  mock.audio.queueScene.mockImplementation((id: string) => {
    mock.audio.queuedLaunch = id;
  });
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      throw new Error("Device access forbidden");
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  await import("../apps/studio/src/main.ts");
});
beforeEach(() => {
  mock.audio.playing = false;
  document.querySelector<HTMLButtonElement>('[data-view="all"]')?.click();
  track("drums");
});
afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("navigates primary preview views without opening an audio or hardware device", () => {
  document.querySelector<HTMLButtonElement>('[data-view="sounds"]')?.click();
  expect(el("instrument-panel").hidden).toBe(false);
  const sample = mock.project?.samples[1];
  if (!sample) throw new Error("Missing sound");
  change("sample-browser", sample.id);
  expect(mock.project?.pads[0]?.sampleId).toBe(sample.id);
  document.querySelector<HTMLButtonElement>('[data-view="pattern"]')?.click();
  expect(el("sequencer-panel").hidden).toBe(false);
  document.querySelector<HTMLButtonElement>('[data-step="1"]')?.click();
  expect(mock.project?.tracks[0]?.clips[0]?.steps.some((n) => n.step === 1 && n.pad === 0)).toBe(
    true,
  );
  document.querySelector<HTMLButtonElement>('[data-view="perform"]')?.click();
  document.querySelector<HTMLButtonElement>('[data-scene="scene-1"]')?.click();
  expect(mock.audio.queueScene).toHaveBeenCalledWith("scene-1");
  document.querySelector<HTMLButtonElement>('[data-view="mix"]')?.click();
  expect(document.querySelector<HTMLElement>(".mixer")?.hidden).toBe(false);
  expect(el("pads").closest("[hidden]")).not.toBeNull();
  el("track-gain").focus();
  expect(el("track-gain").dataset.parameter).toBe("track.drums.gain");
  expect(document.activeElement).toBe(el("track-gain"));
  expect(AudioContext).not.toHaveBeenCalled();
  expect(mock.audio.enable).not.toHaveBeenCalled();
});
async function failImport() {
  const file = {
    size: 2,
    name: "broken.wav",
    arrayBuffer: async () => new Uint8Array([0, 1]).buffer,
  };
  Object.defineProperty(el("sample-file"), "files", { configurable: true, value: [file] });
  el("sample-file").dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(el("error-dialog").hidden).toBe(false);
  expect(el("error-message").textContent).toContain("Could not import sample");
}
it("restores the same error assignment or clears it when a redraw changes the selected track", async () => {
  document.querySelector<HTMLButtonElement>('[data-view="mix"]')?.click();
  el("track-gain").focus();
  const before = state();
  await failImport();
  track("drums");
  el("error-close").click();
  expect(document.activeElement).toBe(el("track-gain"));
  expect(state()).toEqual(before);
  const other = mock.project?.tracks[1]?.volume,
    old = mock.project?.tracks[0]?.volume ?? 0;
  el("encoder-plus").click();
  expect(mock.project?.tracks[0]?.volume).toBeCloseTo(old + 0.01);
  expect(mock.project?.tracks[1]?.volume).toBe(other);
  el("track-gain").focus();
  await failImport();
  track("track-1");
  el("error-close").click();
  expect(document.activeElement).toBe(el("help"));
  const unchanged = JSON.stringify(mock.project);
  el("encoder-plus").click();
  expect(JSON.stringify(mock.project)).toBe(unchanged);
  expect(el("status").textContent).toContain("Select a valid parameter");
  expect(AudioContext).not.toHaveBeenCalled();
});
it("keeps performance state and scoped focus intact while Help survives a redraw", () => {
  if (!el<HTMLButtonElement>("perf-enable").disabled) el("perf-enable").click();
  mock.audio.playing = true;
  document.querySelector<HTMLButtonElement>('[data-scene="scene-1"]')?.click();
  document.querySelector<HTMLButtonElement>('[data-view="mix"]')?.click();
  el("track-gain").focus();
  const before = state(),
    calls = mock.audio.setProject.mock.calls.length,
    starts = mock.audio.start.mock.calls.length,
    stops = mock.audio.stop.mock.calls.length;
  key(el("track-gain"), "F1");
  expect(el("context-help").hidden).toBe(false);
  track("drums");
  key(el("help-close"), "Escape");
  expect(el("context-help").hidden).toBe(true);
  expect(document.activeElement).toBe(el("track-gain"));
  expect(state()).toEqual(before);
  expect(mock.audio.setProject).toHaveBeenCalledTimes(calls);
  expect(mock.audio.start).toHaveBeenCalledTimes(starts);
  expect(mock.audio.stop).toHaveBeenCalledTimes(stops);
  const other = mock.project?.tracks[1]?.volume,
    old = mock.project?.tracks[0]?.volume ?? 0;
  el("encoder-minus").click();
  expect(mock.project?.tracks[0]?.volume).toBeCloseTo(old - 0.01);
  expect(mock.project?.tracks[1]?.volume).toBe(other);
  expect(AudioContext).not.toHaveBeenCalled();
  mock.audio.playing = false;
});
