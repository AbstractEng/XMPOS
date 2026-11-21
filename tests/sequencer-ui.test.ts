// @vitest-environment happy-dom

import { createDemoProject } from "@xmp/core";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioAudio } from "../apps/studio/src/audio.ts";
import { installSequencerPanel } from "../apps/studio/src/sequencer-panel.ts";
import { emptySequence } from "../packages/core/src/sequencer.ts";
import { ProjectSession } from "../packages/core/src/session.ts";

function setup() {
  document.body.innerHTML = '<section id="sequencer-panel"></section>';
  const p = createDemoProject(),
    track = p.tracks[0],
    clip = track?.clips[0];
  if (!track || !clip) throw new Error("Missing fixture");
  clip.steps = [];
  clip.sequence = emptySequence();
  const session = new ProjectSession(p, true);
  let chosen = clip.id;
  const audio = {
    position: 0,
    playing: false,
    sampleRate: 48000,
    enable: vi.fn(async () => {}),
    start: vi.fn(() => {
      audio.playing = true;
    }),
    panic: vi.fn(),
    trigger: vi.fn(),
    automate: vi.fn(),
    clearAutomation: vi.fn(),
  };
  const host = {
    project: () => session.project,
    track: () => track.id,
    clip: () => chosen,
    pad: () => 0,
    scene: () => p.scenes[0]?.id ?? "scene-0",
    revision: () => session.revision,
    edit: (change: Parameters<ProjectSession["edit"]>[0]) => {
      session.edit(change);
      chosen = session.project.scenes[0]?.clips[track.id] ?? chosen;
      panel.draw();
    },
    status: vi.fn(),
    audio: audio as unknown as StudioAudio,
  };
  const panel = installSequencerPanel(host);
  panel.draw();
  return {
    panel,
    session,
    audio,
    clip: () => session.project.tracks[0]?.clips.find((c) => c.id === chosen),
  };
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const x = document.getElementById(id);
  if (!x) throw new Error(`Missing ${id}`);
  return x as T;
};
const input = (id: string, value: string) => {
  el<HTMLInputElement>(id).value = value;
};
afterEach(() => vi.unstubAllGlobals());
it("adds a chord, quantizes selected notes, restores timing and copies the complete pattern", () => {
  const f = setup();
  input("seq-position", "1.15");
  input("seq-pitches", "60,64,67");
  el("seq-add").click();
  expect(f.clip()?.sequence?.notes).toHaveLength(3);
  const row = document.querySelector<HTMLInputElement>("[data-note]");
  if (!row) throw new Error("Missing row");
  row.checked = true;
  row.dispatchEvent(new Event("change", { bubbles: true }));
  el("seq-quantize").click();
  expect(f.clip()?.sequence?.notes.map((n) => n.position)).toEqual([1, 1.15, 1.15]);
  el("seq-restore").click();
  expect(f.clip()?.sequence?.notes.map((n) => n.position)).toEqual([1.15, 1.15, 1.15]);
  el("seq-copy").click();
  expect(f.clip()?.name).toContain("copy");
  expect(f.clip()?.sequence?.notes).toHaveLength(3);
  expect(document.querySelectorAll("[data-note]:checked").length).toBe(0);
});
it("records note input as one undoable pass and preserves a draft if its destination changes", async () => {
  const f = setup();
  el("seq-record").click();
  await Promise.resolve();
  f.audio.position = 1.12;
  f.panel.noteOn(0, 60, 0.72);
  f.audio.position = 2.5;
  f.panel.noteOff(0);
  el("seq-finish").click();
  const n = f.clip()?.sequence?.notes[0];
  expect(n?.original?.position).toBe(1.12);
  expect(n?.velocity).toBe(0.72);
  f.session.undo();
  expect(f.clip()?.sequence?.notes).toHaveLength(0);
  f.audio.playing = false;
  el("seq-record").click();
  await Promise.resolve();
  f.audio.position = 1;
  f.panel.noteOn(0, 62, 0.5);
  f.audio.position = 2;
  f.panel.noteOff(0);
  f.session.edit((p) => ({ ...p, name: "Concurrent edit" }));
  el("seq-finish").click();
  expect(f.clip()?.sequence?.notes).toHaveLength(0);
  expect(el("seq-status").textContent).toContain("Download captured pass");
  expect(el<HTMLButtonElement>("seq-download-pass").disabled).toBe(false);
});
it("records touch and latch with gesture ownership and finalizes on transport stop", async () => {
  const f = setup();
  input("seq-auto-mode", "touch");
  el("seq-auto-record").click();
  await Promise.resolve();
  f.audio.position = 2;
  input("seq-value", "0.8");
  el("seq-value").dispatchEvent(new Event("input"));
  expect(f.audio.automate).toHaveBeenCalledWith(expect.any(Object), "master.gain");
  f.audio.position = 4;
  el("seq-value").dispatchEvent(new Event("pointerup"));
  expect(f.audio.clearAutomation).toHaveBeenCalled();
  f.audio.position = 8;
  f.panel.stop();
  expect(f.clip()?.sequence?.lanes[0]?.points).toEqual([
    { position: 0, value: 0.55 },
    { position: 2, value: 0.8 },
    { position: 4, value: 0.55 },
  ]);
  expect(el<HTMLButtonElement>("seq-auto-finish").disabled).toBe(true);
  expect(el("seq-status").textContent).toContain("disarmed");
  f.session.undo();
  expect(f.clip()?.sequence?.lanes).toHaveLength(0);
});
it("skips missed repeat ticks and cancels held input on release and stop", () => {
  const f = setup();
  f.audio.playing = true;
  f.audio.position = 0.25;
  el<HTMLInputElement>("seq-repeat").checked = true;
  expect(f.panel.noteOn(0, 60, 0.8)).toBe(true);
  f.panel.tick(2, 0.25);
  expect(f.audio.trigger).toHaveBeenCalledTimes(1);
  expect(f.audio.trigger.mock.calls[0]?.[1]).toBe(0.6);
  f.panel.tick(65, 8.125);
  expect(f.audio.trigger).toHaveBeenCalledTimes(2);
  f.panel.noteOff(0);
  f.panel.tick(66, 8.25);
  expect(f.audio.trigger).toHaveBeenCalledTimes(2);
  f.panel.stop();
});
