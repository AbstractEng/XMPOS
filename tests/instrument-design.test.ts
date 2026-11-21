// @vitest-environment happy-dom
import type { Project } from "@xmp/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  audio: {
    playing: false,
    state: "off",
    sampleRate: 48000,
    lateSteps: 0,
    setProject: vi.fn(),
    enable: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    trigger: vi.fn(),
    queueScene: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock("../apps/studio/src/storage.ts", () => ({
  loadProjectState: async () => ({}),
  saveProject: mock.save,
}));
vi.mock("../apps/studio/src/audio.ts", () => ({
  StudioAudio: vi.fn(function StudioAudioMock() {
    return mock.audio;
  }),
  renderScene: vi.fn(),
}));
const node = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element as T;
};
const key = (target: HTMLElement, name: string) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );
const latestProject = () => {
  if (!mock.project) throw new Error("No project was sent to the audio boundary");
  return mock.project;
};

beforeAll(async () => {
  vi.useFakeTimers();
  mock.audio.setProject.mockImplementation((project: Project) => {
    mock.project = project;
  });
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      throw new Error("Audio device access forbidden in UI tests");
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

it("opens contextual help and restores focus without changing music or transport", () => {
  // Leave a real unsaved edit and a queued scene in the actual UI before requesting help.
  document.querySelector<HTMLButtonElement>('[data-step="1"]')?.click();
  mock.audio.playing = true;
  document.querySelector<HTMLButtonElement>('[data-scene="scene-1"]')?.click();
  const before = JSON.stringify(latestProject());
  const calls = mock.audio.setProject.mock.calls.length;
  const scene = document.querySelector('[data-scene="scene-1"]')?.outerHTML;
  const undo = node<HTMLButtonElement>("undo").disabled;
  const control = node<HTMLInputElement>("swing");
  control.focus();
  key(control, "F1");
  expect(node("context-help").hidden).toBe(false);
  expect(node("help-title").textContent).toBe("Give the beat a swing");
  expect(node("help-body").textContent).toContain("exact 2:1");
  expect(document.activeElement).toBe(node("help-close"));
  // Reading help must not leak pad shortcuts into the performance behind it.
  key(node("help-close"), "1");
  key(node("help-close"), " ");
  key(node("help-close"), "Escape");
  expect(node("context-help").hidden).toBe(true);
  expect(document.activeElement).toBe(control);
  expect(mock.audio.setProject).toHaveBeenCalledTimes(calls);
  expect(JSON.stringify(latestProject())).toBe(before);
  expect(mock.audio.playing).toBe(true);
  expect(document.querySelector('[data-scene="scene-1"]')?.outerHTML).toBe(scene);
  expect(node<HTMLButtonElement>("undo").disabled).toBe(undo);
  for (const method of [
    mock.audio.enable,
    mock.audio.start,
    mock.audio.stop,
    mock.audio.trigger,
    mock.save,
  ])
    expect(method).not.toHaveBeenCalled();
  expect(AudioContext).not.toHaveBeenCalled();
  mock.audio.playing = false;
});

it("keeps Help available on buttons and falls back safely after a control is replaced", () => {
  node("save").focus();
  node("help").click();
  expect(node("help-title").textContent).toBe("Keep your work");
  node("help-close").click();
  expect(document.activeElement).toBe(node("save"));
  const step = document.querySelector<HTMLButtonElement>('[data-step="0"]');
  if (!step) throw new Error("Missing step");
  step.focus();
  key(step, "F1");
  expect(node("help-title").textContent).toBe("Build a pattern");
  // A scene redraw can replace step buttons while help remains open.
  document.querySelector<HTMLButtonElement>('[data-track="drums"]')?.click();
  key(node("help-close"), "Escape");
  expect(document.activeElement).toBe(node("help"));
  expect(node("help").getAttribute("aria-expanded")).toBe("false");
});

it("uses musical swing labels and an exact triplet without changing existing notes", () => {
  const notes = JSON.stringify(latestProject().tracks);
  expect(node("swing-value").textContent).toBe("50% · Straight");
  node("swing-triplet").click();
  expect(latestProject().swing).toBe(1 / 3);
  expect(node("swing-value").textContent).toBe("66.7% · Triplet");
  node("undo").click();
  expect(latestProject().swing).toBe(0);
  expect(node("swing-value").textContent).toBe("50% · Straight");
  const slider = node<HTMLInputElement>("swing");
  slider.value = "62";
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(latestProject().swing).toBe(0.24);
  expect(node("swing-value").textContent).toBe("62%");
  expect(JSON.stringify(latestProject().tracks)).toBe(notes);
  node("swing-straight").click();
  expect(latestProject().swing).toBe(0);
  expect(AudioContext).not.toHaveBeenCalled();
});
