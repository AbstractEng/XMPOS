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
    midiTrace: [],
    setProject: vi.fn(),
    enable: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    trigger: vi.fn(),
    queueScene: vi.fn(),
    panic: vi.fn(),
    noteOff: vi.fn(),
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
  StudioAudio: vi.fn(function AudioMock() {
    return mock.audio;
  }),
  renderScene: vi.fn(),
}));
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing ${id}`);
  return value as T;
};
const change = (id: string, value: string) => {
  el<HTMLInputElement>(id).value = value;
  el(id).dispatchEvent(new Event("change", { bubbles: true }));
};
beforeAll(async () => {
  vi.useFakeTimers();
  mock.audio.setProject.mockImplementation((p: Project) => {
    mock.project = p;
  });
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      throw new Error("Device output forbidden in UI contracts");
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
it("selects machines per track and edits synth state without changing another track", () => {
  const original = JSON.stringify(mock.project?.tracks[1]);
  change("machine-type", "xmp.subtractive");
  expect(mock.project?.tracks[0]?.machine?.id).toBe("xmp.subtractive");
  expect(el("synth-controls").hidden).toBe(false);
  const cutoff = document.querySelector<HTMLInputElement>('[data-machine-param="cutoff"]');
  if (!cutoff) throw new Error("Missing machine parameter");
  cutoff.value = "1200";
  cutoff.dispatchEvent(new Event("change", { bubbles: true }));
  expect(mock.project?.tracks[0]?.machine?.state.cutoff).toBe(1200);
  expect(JSON.stringify(mock.project?.tracks[1])).toBe(original);
  change("machine-type", "xmp.midi");
  expect(el("machine-state").textContent).toContain("physical output disabled");
  expect(mock.project?.tracks[0]?.machine?.base).toBe("midi");
  const destination = mock.project?.tracks[1]?.id;
  if (!destination) throw new Error("Missing routing destination");
  change("midi-destination", destination);
  expect(mock.project?.tracks[0]?.machine?.state.destination).toBe(destination);
  expect(JSON.stringify(mock.project?.tracks[1])).toBe(original);
  el("undo").click();
  expect(mock.project?.tracks[0]?.machine?.state.destination).toBeUndefined();
  el("undo").click();
  expect(mock.project?.tracks[0]?.machine?.id).toBe("xmp.subtractive");
  expect(AudioContext).not.toHaveBeenCalled();
});
it("edits non-destructive sample slices through Studio and restores them with undo", () => {
  change("machine-type", "xmp.sampler");
  const original = JSON.stringify(mock.project?.samples);
  change("wave-start", "10");
  change("wave-end", "200");
  el("crop").click();
  expect(mock.project?.pads[0]?.slice).toEqual({ start: 10, end: 200 });
  el<HTMLInputElement>("reverse").checked = true;
  el("reverse").dispatchEvent(new Event("change", { bubbles: true }));
  expect(mock.project?.pads[0]?.edit?.reverse).toBe(true);
  expect(el("waveform-info").textContent).toContain("190 playable frames");
  el<HTMLInputElement>("slice-boundaries").value = "0, 100, 200";
  el("manual-slices").click();
  expect(mock.project?.pads[1]?.slice).toEqual({ start: 100, end: 200 });
  el("undo").click();
  expect(mock.project?.pads[1]?.slice).toBeUndefined();
  expect(JSON.stringify(mock.project?.samples)).toBe(original);
  expect(AudioContext).not.toHaveBeenCalled();
});
it("requires an armed source and exposes resampling as one undoable project edit", async () => {
  expect(el<HTMLButtonElement>("start-record").disabled).toBe(true);
  el("arm-record").click();
  await Promise.resolve();
  expect(el("record-status").textContent).toContain("monitoring");
  el<HTMLInputElement>("monitor-levels").checked = true;
  el("arm-record").click();
  await Promise.resolve();
  expect(el("record-status").textContent).toContain("Choose a WAV");
  const before = JSON.stringify(mock.project);
  el("resample").click();
  expect(mock.project?.samples.some((s) => s.name === "Resampled master")).toBe(true);
  expect(el("record-status").textContent).toContain("Two bars");
  el("undo").click();
  expect(JSON.stringify(mock.project)).toBe(before);
  expect(AudioContext).not.toHaveBeenCalled();
});
it("plays successive pad notes and releases keys without starting late notes after key-up", async () => {
  change("machine-type", "xmp.subtractive");
  mock.audio.enable.mockResolvedValue(undefined);
  mock.audio.trigger.mockReturnValue(77);
  const down = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const up = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  down("z");
  await Promise.resolve();
  up("z");
  down("x");
  await Promise.resolve();
  up("x");
  const notes = mock.audio.trigger.mock.calls.map((call) => call[4]);
  expect(notes).toEqual([48, 50]);
  expect(mock.audio.noteOff).toHaveBeenCalledWith(77);
  const count = mock.audio.trigger.mock.calls.length;
  down("c");
  up("c");
  await Promise.resolve();
  expect(mock.audio.trigger).toHaveBeenCalledTimes(count);
  expect(AudioContext).not.toHaveBeenCalled();
});

it("clears recorded notes on the selected pad with the legacy clear action", () => {
  const positions = document.getElementById("seq-pitches") as HTMLInputElement;
  positions.value = "60,64";
  el("seq-add").click();
  expect(mock.project?.tracks[0]?.clips[0]?.sequence?.notes).toHaveLength(2);
  el("clear").click();
  expect(mock.project?.tracks[0]?.clips[0]?.sequence?.notes).toHaveLength(0);
  expect(mock.audio.panic).toHaveBeenCalled();
});

it("lets Space activate the drum-kit disclosure without starting transport", () => {
  const summary = document.querySelector("#kit-picker summary");
  if (!summary) throw new Error("Missing kit disclosure");
  const starts = mock.audio.start.mock.calls.length;
  const event = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
  });
  summary.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(mock.audio.start).toHaveBeenCalledTimes(starts);
});
