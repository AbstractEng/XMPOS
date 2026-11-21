import {
  createDemoProject,
  encodeWav,
  eventsAtStep,
  parseProject,
  stepTime,
  toggleStep,
} from "@xmp/core";
import { ModuleManifest } from "@xmp/sdk";
import { describe, expect, it } from "vitest";

describe("musical timing", () => {
  it("places 16th notes on the audio clock without accumulating drift", () => {
    expect(stepTime(16, 120, 0)).toBe(2);
    expect(stepTime(1600000, 120, 0)).toBe(200000);
    expect(stepTime(1, 120, 0.5)).toBe(0.1875);
    expect(stepTime(2, 120, 0.5)).toBe(0.25);
    expect(() => stepTime(0, 0, 0)).toThrow();
  });
  it("respects probability, track mute and scene clip references", () => {
    const project = createDemoProject();
    expect(eventsAtStep(project, "scene-0", 0).some((event) => event.pad === 0)).toBe(true);
    expect(eventsAtStep(project, "scene-2", 0).some((event) => event.pad === 0)).toBe(false);
    const track = project.tracks[0];
    if (!track) throw new Error("No track");
    track.clips[0]?.steps.forEach((event) => {
      event.probability = 0;
    });
    expect(eventsAtStep(project, "scene-0", 0)).toEqual([]);
    track.muted = true;
    expect(eventsAtStep(project, "scene-1", 4)).toEqual([]);
  });
});
describe("project persistence", () => {
  it("round-trips patterns and embedded sample audio", () => {
    const project = createDemoProject();
    const edited = toggleStep(project, "drums", "clip-0", 5, 3);
    expect(parseProject(JSON.stringify(edited))).toEqual(edited);
    expect(project.tracks[0]?.clips[0]?.steps.some((e) => e.pad === 5 && e.step === 3)).toBe(false);
  });
  it("rejects broken references, newer versions and unsupported fields", () => {
    const project = createDemoProject();
    expect(() => parseProject(JSON.stringify({ ...project, version: 99 }))).toThrow();
    expect(() => parseProject(JSON.stringify({ ...project, deviceCommand: "write" }))).toThrow();
    if (project.pads[0]) project.pads[0].sampleId = "missing";
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
  it("rejects duplicate events and steps beyond the clip boundary", () => {
    const project = createDemoProject();
    project.tracks[0]?.clips[0]?.steps.push({ step: 16, pad: 0, velocity: 1, probability: 1 });
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
  it("rejects invalid edits and non-finite sample amplitudes", () => {
    const project = createDemoProject();
    expect(() => toggleStep(project, "drums", "clip-0", 16, 0)).toThrow();
    if (project.samples[0]) project.samples[0].pcm[0] = Number.POSITIVE_INFINITY;
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
});
describe("audio export", () => {
  it("writes interleaved stereo PCM16 and clamps amplitudes", () => {
    const wav = encodeWav([new Float32Array([-2, 0.5]), new Float32Array([2, -0.5])], 48000);
    const view = new DataView(wav);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(16384);
    expect(view.getInt16(50, true)).toBe(-16384);
  });
});
describe("preview module boundary", () => {
  it("refuses device permissions and incompatible APIs", () => {
    const manifest = {
      id: "test",
      name: "Test",
      version: "0.1.0",
      apiVersion: 1,
      kind: "instrument",
      license: "MIT",
      permissions: [],
      parameters: [],
    };
    expect(ModuleManifest.parse(manifest).id).toBe("test");
    expect(() => ModuleManifest.parse({ ...manifest, permissions: ["usb-write"] })).toThrow();
    expect(() => ModuleManifest.parse({ ...manifest, apiVersion: 2 })).toThrow();
  });
});
