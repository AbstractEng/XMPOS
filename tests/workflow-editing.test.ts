// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DeviceController, deviceDemo } from "../apps/studio/src/device/controller.ts";
import { workbenchQlinks } from "../apps/studio/src/device/workbench-view.ts";
import { noteName, padNote, rootPitch, scaleName } from "../packages/core/src/pad-scale.ts";
import { renderSampleEdit, sampleEdit } from "../packages/core/src/sample-edit.ts";
import { ProjectSession } from "../packages/core/src/session.ts";
import { chainBarRanges, expressionEdit, recordPosition } from "../packages/core/src/workflow.ts";
import { ContractAudio } from "./helpers/device-audio.ts";

describe("musical editing contract", () => {
  it("defaults to C major across all sixteen pads without changing saved pitches", async () => {
    expect(Array.from({ length: 16 }, (_, pad) => padNote(pad))).toEqual([
      48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74,
    ]);
    expect(padNote(2, 0, "chromatic")).toBe(50);
    expect(padNote(2, 0, "harmonic-minor")).toBe(51);
    // Any root, minor forms and the modes.
    expect(Array.from({ length: 8 }, (_, p) => padNote(p, 0, "dorian", rootPitch(2)))).toEqual([
      50, 52, 53, 55, 57, 59, 60, 62,
    ]);
    expect(padNote(5, 0, "melodic-minor", rootPitch(9))).toBe(66);
    expect(padNote(6, 0, "minor")).toBe(58);
    expect(padNote(3, 0, "lydian")).toBe(54);
    expect(padNote(1, 0, "phrygian")).toBe(49);
    expect(padNote(4, 0, "locrian")).toBe(54);
    expect(padNote(6, 0, "mixolydian")).toBe(58);
    expect(scaleName("dorian", 2)).toBe("D Dorian");
    expect(scaleName("chromatic", 5)).toBe("Chromatic");
    expect(noteName(padNote(2))).toBe("E3");
    const project = deviceDemo(),
      before = structuredClone(project.tracks);
    const c = new DeviceController(project, new ContractAudio());
    c.setMachine("xmp.subtractive");
    c.show("play");
    expect(c.scale).toBe("major");
    expect(c.project.tracks[0]?.clips).toEqual(before[0]?.clips);
    expect(() => padNote(-1)).toThrow();
    expect(() => padNote(16)).toThrow();
  });
  it("groups a continuous gesture into one undo and cancels without a history entry", () => {
    const session = new ProjectSession(deviceDemo()),
      before = session.project;
    session.beginGesture();
    session.edit((p) => ({ ...p, bpm: 120 }));
    session.edit((p) => ({ ...p, bpm: 124 }));
    session.endGesture();
    expect(session.historyDepth).toBe(1);
    expect(session.project.bpm).toBe(124);
    session.undo();
    expect(session.project).toBe(before);
    session.beginGesture();
    session.edit((p) => ({ ...p, bpm: 130 }));
    session.endGesture(true);
    expect(session.project).toBe(before);
    expect(session.historyDepth).toBe(0);
    expect(session.redoDepth).toBe(1);
    session.redo();
    expect(session.project.bpm).toBe(124);
  });
  it("selection preserves an existing hit; velocity, condition conversion and locks undo independently", async () => {
    const c = new DeviceController(deviceDemo(), new ContractAudio());
    c.show("steps");
    const before = c.project;
    c.workbench.toggleStep(0);
    expect(c.project).toBe(before);
    expect(c.step).toBe(0);
    c.workbench.setValue("expression:velocity", 55);
    expect(c.workbench.hit?.velocity).toBe(0.55);
    await c.button("undo");
    expect(c.project).toEqual(before);
    c.edit((p) =>
      expressionEdit(p, c.trackId, c.clip?.id ?? "", 0, 0, undefined, { condition: "fill" }),
    );
    expect(c.clip?.sequence?.notes.find((n) => n.position === 0)?.condition).toBe("fill");
    expect(c.clip?.steps.some((s) => s.pad === 0 && s.step === 0)).toBe(false);
    expect(() =>
      expressionEdit(structuredClone(c.project), c.trackId, c.clip?.id ?? "", 0, 2, undefined, {
        velocity: 0.5,
      }),
    ).toThrow();
    await c.button("undo");
    expect(c.project).toEqual(before);
  });
  it("uses milliseconds and hertz in synth editors, retaining normalized hardware ranges", async () => {
    const c = new DeviceController(deviceDemo(), new ContractAudio());
    c.setMachine("xmp.subtractive");
    c.show("sound");
    c.nav.qPage = 1;
    const q = workbenchQlinks(c);
    expect(q[0]?.display).toBe("750 Hz");
    expect(q[1]?.display).toBe("5 ms");
    const before = c.project;
    c.workbench.setValue("machine:attack", 25);
    expect(c.track.machine?.state.attack).toBeCloseTo(0.025);
    await c.button("undo");
    expect(c.project).toEqual(before);
    expect(() => c.workbench.setValue("machine:attack", 3000)).toThrow();
  });
  it("isolates the chromatic sampler and its sample edits from the shared kit", async () => {
    const c = new DeviceController(deviceDemo(), new ContractAudio()),
      before = c.project;
    await c.workbench.action("machine:melodic-sampler");
    expect(c.workbench.pitched).toBe(true);
    expect(c.track.pads?.every((p) => p.playback?.mode === "chromatic")).toBe(true);
    expect(c.project.pads).toEqual(before.pads);
    await c.button("undo");
    expect(c.project).toEqual(before);
    await c.workbench.action("machine:melodic-sampler");
    await c.workbench.action("machine:xmp.sampler");
    expect(c.workbench.pitched).toBe(false);
  });
  it("shows bar ranges from actual scene lengths and repeats", () => {
    const p = deviceDemo();
    const scene = p.scenes[0],
      clip = p.tracks[0]?.clips[0];
    if (!scene || !clip) throw new Error("Fixture missing");
    clip.length = 32;
    p.performance = {
      version: 1,
      chain: [
        { id: "a", sceneId: scene.id, repeats: 2 },
        { id: "b", sceneId: scene.id, repeats: 1 },
      ],
      end: "stop",
      macros: [],
      mutes: {},
      solos: [],
      events: [],
      delay: { steps: 1, feedback: 0, wet: 0, sends: {} },
    };
    expect(chainBarRanges(p)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
  });
  it("records with fractional quantize strength and preserves an unquantized performance", () => {
    expect(recordPosition(2.3, 16, 0)).toBeCloseTo(2.3);
    expect(recordPosition(2.3, 16, 0.5)).toBeCloseTo(2.15);
    expect(recordPosition(2.3, 16, 1)).toBe(2);
    expect(recordPosition(15.8, 16, 1)).toBe(0);
    expect(() => recordPosition(1, 16, 1.5)).toThrow();
  });
  it("processes an edit inside the chosen bounds with fades and never mutates the source", () => {
    const pcm = [0, 0.2, 0.4, 0.6, 0.8, 0],
      before = [...pcm],
      edit = sampleEdit(pcm.length);
    edit.start = 1;
    edit.end = 5;
    edit.reverse = true;
    edit.level = 0.5;
    expect(Array.from(renderSampleEdit(pcm, 48000, edit))).toEqual(
      expect.arrayContaining([expect.closeTo(0.4), expect.closeTo(0.1)]),
    );
    expect(pcm).toEqual(before);
    edit.end = 999;
    expect(() => renderSampleEdit(pcm, 48000, edit)).toThrow();
  });
  it("applies all launch grid choices in the actual transport", async () => {
    for (const grid of [0, 4, 16, 32, 64] as const) {
      const audio = new ContractAudio(),
        c = new DeviceController(deviceDemo(), audio);
      const select = document.createElement("select");
      select.id = "wb-launch";
      select.innerHTML = `<option value="${grid}">${grid}</option>`;
      c.workbench.change(select);
      await c.button("play-start");
      audio.advance(2);
      await c.pad(8);
      const queued = audio.transport?.queuedClips.get(c.trackId);
      expect(queued?.at).toBe(grid === 0 ? 3 : grid);
    }
  });
});
