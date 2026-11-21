import { createDemoProject } from "@xmp/core";
import { describe, expect, it } from "vitest";
import {
  decodeSnapshot,
  developmentGraph,
  encodeCommand,
  encodeGraph,
  projectGraph,
} from "../acceptance/lib/engine-target.mjs";
// @ts-expect-error Host hashing is intentionally outside browser code.
import { sha256 } from "../acceptance/lib/workspace.mjs";
import { encodeWav } from "../packages/core/src/index.ts";
import { analyzeLoopback, type ClockCalibration } from "../packages/core/src/latency.ts";

function calibration(): ClockCalibration {
  return {
    version: 1,
    sampleRate: 48000,
    bufferFrames: 256,
    clockRatio: 1,
    clockOffsetFrames: 0,
    captureStartFrame: 0,
    maximumResidualFrames: 0,
    independentCalibration: true,
    physicalFixtureObserved: false,
    synthetic: true,
    emittedFrames: Array.from({ length: 1000 }, (_, i) => i * 6000),
  };
}
describe("bounded native control and graph preparation", () => {
  it("encodes fixed-size timestamped requests and refuses unsupported response framing", () => {
    const message = encodeCommand(7, 42, { timestamp: 3840, value: 90 });
    expect(message).toHaveLength(40);
    expect(message.readBigUInt64LE(16)).toBe(3840n);
    expect(message.readDoubleLE(32)).toBe(90);
    expect(() => decodeSnapshot(Buffer.alloc(175))).toThrow("Invalid");
  });
  it("binds an immutable project document and refuses bad graph identities and references", () => {
    const graph = developmentGraph();
    const first = graph.events[0];
    if (!first) throw new Error("Missing graph fixture event");
    expect(encodeGraph(graph).toString("ascii", 0, 4)).toBe("XMPH");
    expect(sha256(graph.projectDocument)).toBe(graph.projectHash);
    expect(() => encodeGraph({ ...graph, projectHash: "0".repeat(64) })).toThrow("hash");
    expect(() => encodeGraph({ ...graph, events: [{ ...first, sample: 99 }] })).toThrow(
      "reference",
    );
    expect(() => encodeGraph({ ...graph, trackGains: [1] })).toThrow();
    expect(() => encodeGraph({ ...graph, samples: [[NaN]] })).toThrow();
  });
  it("uses musical clip duration instead of sample tails to define the repeating loop", async () => {
    const project = createDemoProject();
    project.samples = [{ id: "impulse", name: "Impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] }];
    for (const pad of project.pads) pad.sampleId = "impulse";
    const graph = await projectGraph(project, "scene-0");
    expect(graph.loopTicks).toBe(3840);
    expect(JSON.parse(graph.projectDocument).project.id).toBe(project.id);
    expect(encodeGraph(graph).length).toBeGreaterThan(96);
  });
});
describe("calibrated loopback evidence", () => {
  it("never defaults missing or invalid measurement to zero or a passing threshold", () => {
    expect(analyzeLoopback(undefined, undefined)).toMatchObject({
      outcome: "inconclusive",
      p95Ms: null,
      thresholdPassed: false,
    });
    const clock = calibration();
    for (const invalid of [
      { ...clock, sampleRate: 44100 },
      { ...clock, clockRatio: 1.001 },
      { ...clock, independentCalibration: false },
      { ...clock, maximumResidualFrames: 2 },
      { ...clock, synthetic: false, physicalFixtureObserved: false },
    ])
      expect(analyzeLoopback(new Uint8Array(44), invalid).outcome).toBe("inconclusive");
  });
  it("computes the p95 tail and keeps synthetic provenance separate from hardware qualification", () => {
    const pcm = new Float32Array(6000000),
      clock = calibration();
    clock.emittedFrames.forEach((frame, index) => {
      pcm[frame + (index < 949 ? 480 : 1008)] = 0.5;
    });
    const result = analyzeLoopback(new Uint8Array(encodeWav([pcm], 48000)), clock);
    expect(result.outcome).toBe("measured");
    expect(result.p50Ms).toBe(10);
    expect(result.p95Ms).toBe(21);
    expect(result.thresholdPassed).toBe(false);
    expect(result.physicalQualification).toBe(false);
    expect(result.synthetic).toBe(true);
  });
  it("rejects missing trials, ambiguous peaks and truncated captures", () => {
    const clock = calibration();
    const pcm = new Float32Array(6000000);
    clock.emittedFrames.forEach((frame) => {
      pcm[frame + 480] = 0.5;
    });
    pcm[0] = 0.5;
    pcm[800] = 0.5;
    expect(analyzeLoopback(new Uint8Array(encodeWav([pcm], 48000)), clock).reason).toContain(
      "Ambiguous",
    );
    expect(analyzeLoopback(new Uint8Array(44), clock).outcome).toBe("inconclusive");
    expect(
      analyzeLoopback(new Uint8Array(encodeWav([new Float32Array(8)], 48000)), clock).outcome,
    ).toBe("inconclusive");
  });
});
it("prepares raw note ticks and a version-two groove header instead of baking swing twice", async () => {
  const p = createDemoProject();
  p.swing = 1 / 3;
  const clip = p.tracks[0]?.clips[0];
  if (!clip) throw new Error("Missing clip");
  clip.steps = [{ step: 1, pad: 0, velocity: 1, probability: 1 }];
  const graph = await projectGraph(p, "scene-0"),
    bytes = encodeGraph(graph);
  expect(graph.events[0]?.tick).toBe(240);
  expect(graph.swing).toBe(1 / 3);
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readDoubleLE(96)).toBe(1 / 3);
});
