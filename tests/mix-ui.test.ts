// @vitest-environment happy-dom
import type { Project } from "@xmp/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { encodeMidi, loadCore } from "../packages/core/src/edits.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const mock = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  audio: {
    playing: false,
    state: "off",
    sampleRate: 48000,
    lateSteps: 0,
    midiTrace: [],
    setProject: vi.fn(),
    enable: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    panic: vi.fn(),
    noteOff: vi.fn(),
    trigger: vi.fn(),
    queueScene: vi.fn(),
    automate: vi.fn(),
    clearAutomation: vi.fn(),
  },
}));
vi.mock("../apps/studio/src/storage.ts", () => ({
  loadProjectState: async () => ({}),
  loadProjectSnapshot: async () =>
    (await import("./studio-project-fixture.ts")).studioProjectSnapshot(),
  saveProjectText: async () => {
    throw new Error("An existing Studio fixture must not be reseeded");
  },
  saveProject: vi.fn(),
}));
vi.mock("../apps/studio/src/audio.ts", () => ({
  StudioAudio: vi.fn(function MockMixAudio() {
    return mock.audio;
  }),
  renderScene: vi.fn(),
}));
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const e = document.getElementById(id);
  if (!e) throw Error(`Missing ${id}`);
  return e as T;
};
const change = (id: string, value: string) => {
  el<HTMLInputElement>(id).value = value;
  el(id).dispatchEvent(new Event("change", { bubbles: true }));
};
const input = (selector: string, value: string) => {
  const e = document.querySelector<HTMLInputElement>(selector);
  if (!e) throw Error(`Missing ${selector}`);
  e.value = value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeAll(async () => {
  vi.useFakeTimers();
  mock.audio.setProject.mockImplementation((p: Project) => {
    mock.project = p;
  });
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      throw Error("Device access forbidden");
    }),
  );
  vi.stubGlobal(
    "showOpenFilePicker",
    vi.fn(() => {
      throw Error("No physical files opened by test");
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  await import("../apps/studio/src/main.ts");
});
afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("edits selected-track mix and stable insert parameters with undo while audio is disabled", () => {
  document.querySelector<HTMLButtonElement>('[data-view="mix"]')?.click();
  el("mix-enable").click();
  expect(mock.project?.mix).toBeDefined();
  input('[data-parameter="track.drums.pan"]', "0.1");
  expect(mock.project?.parameters.find((p) => p.id === "track.drums.pan")?.base).toBe(0.1);
  change("fx-kind", "delay");
  el("fx-install").click();
  expect(mock.project?.mix?.tracks.drums?.inserts[0]?.kind).toBe("delay");
  const id = mock.project?.mix?.tracks.drums?.inserts[0]?.id;
  input(`[data-parameter="track.drums.insert.${id}.wet"]`, "0.75");
  expect(mock.project?.parameters.find((p) => p.id.endsWith(`.${id}.wet`))?.base).toBe(0.75);
  el("undo").click();
  expect(mock.project?.parameters.find((p) => p.id.endsWith(`.${id}.wet`))).toBeUndefined();
  mock.audio.playing = true;
  change("fx-kind", "filter");
  el("fx-install").click();
  expect(el("status").textContent).toContain("Stop playback");
  expect(mock.project?.mix?.tracks.drums?.inserts[0]?.kind).toBe("delay");
  mock.audio.playing = false;
});
it("stages MIDI and requires explicit replacement, guards stale selection and keeps undo", async () => {
  const bytes = encodeMidi({
      ppq: 960,
      endTick: 3840,
      ignoredEvents: 0,
      tempos: [{ tick: 0, micros: 500000 }],
      notes: [{ track: 0, channel: 0, note: 64, velocity: 100, tick: 240, duration: 480 }],
    }),
    before = JSON.stringify(mock.project);
  const file = {
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer,
    name: "test.mid",
  };
  Object.defineProperty(el("midi-file"), "files", { configurable: true, value: [file] });
  el("midi-file").dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(JSON.stringify(mock.project)).toBe(before);
  expect(el("midi-keep").hidden).toBe(false);
  el("midi-keep").click();
  expect(
    mock.project?.tracks[0]?.clips[0]?.sequence?.notes.map((n) => [n.note, n.position, n.duration]),
  ).toEqual([[64, 1, 2]]);
  el("undo").click();
  expect(JSON.stringify(mock.project)).toBe(before);
  el("midi-file").dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  input('[data-parameter="track.drums.pan"]', "0.2");
  const current = JSON.stringify(mock.project);
  el("midi-keep").click();
  expect(el("status").textContent).toContain("reopen MIDI");
  expect(JSON.stringify(mock.project)).toBe(current);
});
it("exports MIDI and tests virtual clock without enabling audio or opening physical MIDI", () => {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture"),
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}),
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  el("export-scene-midi").click();
  expect(el("status").textContent).toContain("download requested");
  expect(click).toHaveBeenCalled();
  el("midi-virtual").click();
  expect(el("status").textContent).toContain("192 clock pulses");
  expect(el("status").textContent).toContain("Physical output unavailable");
  expect(mock.audio.enable).not.toHaveBeenCalled();
  expect(AudioContext).not.toHaveBeenCalled();
  create.mockRestore();
  revoke.mockRestore();
  click.mockRestore();
});
