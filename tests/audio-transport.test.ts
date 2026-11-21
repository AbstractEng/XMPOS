import { createDemoProject } from "@xmp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioAudio } from "../apps/studio/src/audio.ts";

class FakeContext {
  currentTime = 0;
  state = "running";
  sampleRate = 48000;
  destination = {};
  onstatechange?: () => void;
  static latest: FakeContext;
  starts: number[] = [];
  stops = 0;
  constructor() {
    FakeContext.latest = this;
  }
  async resume() {}
  createGain() {
    const node = {
      gain: { value: 0, setTargetAtTime() {} },
      connect: (_target: unknown) => _target,
      disconnect() {},
    };
    return node;
  }
  createDynamicsCompressor() {
    return { threshold: { value: 0 }, ratio: { value: 0 }, connect: (_target: unknown) => _target };
  }
  createBuffer(_channels: number, _frames: number, _rate: number) {
    return { copyToChannel() {} };
  }
  createBufferSource() {
    return {
      buffer: undefined,
      onended: undefined,
      connect: (_target: unknown) => _target,
      disconnect() {},
      start: (at: number) => this.starts.push(at),
      stop: () => {
        this.stops++;
      },
    };
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("browser transport boundaries", () => {
  it("restarts a long clip from step zero at the scene launch and cancels scheduled sounds on stop", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const project = createDemoProject();
    project.bpm = 120;
    const clips = project.tracks[0]?.clips;
    if (!clips?.[0] || !clips[1]) throw new Error("Missing fixture clips");
    clips[0].steps = [];
    clips[1].length = 32;
    clips[1].steps = [{ pad: 0, step: 0, velocity: 1, probability: 1 }];
    const audio = new StudioAudio();
    audio.setProject(project);
    await audio.enable();
    audio.start("scene-0");
    audio.queueScene("scene-1");
    for (let tick = 0; tick < 84; tick++) {
      FakeContext.latest.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
    expect(FakeContext.latest.starts).toEqual([2.04]);
    expect(audio.lateSteps).toBe(0);
    audio.stop();
    expect(FakeContext.latest.stops).toBe(1);
    const count = FakeContext.latest.starts.length;
    vi.advanceTimersByTime(1000);
    expect(FakeContext.latest.starts.length).toBe(count);
  });
});
it("queues swing at a bar without restarting and schedules microtimed polyphony from the shared timeline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  class Context extends FakeContext {
    audioWorklet = { addModule: async () => {} };
  }
  const messages: { op: string; frame?: number; note?: number }[] = [];
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = {
        postMessage: (v: { op: string; frame?: number; note?: number }) => messages.push(v),
        onmessage: () => {},
      };
      connect() {}
    },
  );
  const p = createDemoProject(),
    track = p.tracks[0],
    clip = track?.clips[0];
  if (!track || !clip) throw new Error("Missing fixture");
  p.bpm = 120;
  clip.steps = [];
  clip.sequence = {
    version: 1,
    notes: [
      {
        id: "one",
        pad: 0,
        note: 60,
        position: 1,
        duration: 1,
        velocity: 0.5,
        probability: 1,
        microtiming: 0.1,
        condition: "always",
      },
      {
        id: "two",
        pad: 0,
        note: 64,
        position: 1,
        duration: 1,
        velocity: 0.7,
        probability: 1,
        microtiming: 0.1,
        condition: "always",
      },
    ],
    lanes: [],
    locks: [],
    modulations: [],
  };
  const audio = new StudioAudio();
  audio.setProject(p);
  await audio.enable();
  audio.start("scene-0");
  for (let tick = 0; tick < 20; tick++) {
    FakeContext.latest.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
  const initial = messages.filter((m) => m.op === "on");
  expect(initial.map((m) => [m.frame, m.note])).toEqual([
    [8520, 60],
    [8520, 64],
  ]);
  audio.setProject({ ...p, swing: 1 / 3 });
  expect(audio.pendingGroove).toBe(1 / 3);
  expect(messages.some((m) => m.op === "panic")).toBe(false);
  for (let tick = 0; tick < 80; tick++) {
    FakeContext.latest.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
  expect(audio.pendingGroove).toBeUndefined();
  expect(audio.playing).toBe(true);
  expect(audio.lateSteps).toBe(0);
  expect(
    messages
      .filter((m) => m.op === "on")
      .slice(2)
      .map((m) => m.frame),
  ).toEqual([106320, 106320]);
  audio.stop();
  expect(messages.some((m) => m.op === "reset")).toBe(true);
});
it("cancels a performance scene launch and stops a song at its declared boundary", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  class Context extends FakeContext {
    audioWorklet = { addModule: async () => {} };
  }
  const messages: { op: string; frame?: number; tracks?: string[] }[] = [];
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = {
        postMessage: (v: { op: string; frame?: number; tracks?: string[] }) => messages.push(v),
        onmessage: () => {},
      };
      connect() {}
    },
  );
  const { editPerformance, editChain } = await import("../packages/core/src/performance.ts");
  const p = editChain(
    editPerformance(createDemoProject(), () => {}),
    [{ id: "one", sceneId: "scene-0", repeats: 1 }],
  );
  p.bpm = 120;
  const clip = p.tracks[0]?.clips[0];
  if (!clip) throw new Error("Missing clip");
  clip.steps = [{ step: 0, pad: 0, velocity: 1, probability: 1 }];
  const audio = new StudioAudio(),
    stopped = vi.fn();
  audio.onStop = stopped;
  audio.setProject(p);
  await audio.enable();
  audio.start("scene-0", "song");
  audio.queueScene("scene-1");
  expect(audio.cancelLaunch()).toBe(true);
  for (let tick = 0; tick < 85; tick++) {
    FakeContext.latest.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
  expect(audio.playing).toBe(false);
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(audio.performanceSnapshot?.sceneId).toBe("scene-0");
  expect(messages.some((m) => m.op === "release" && m.frame === 97920)).toBe(true);
  expect(messages.filter((m) => m.op === "on")).toHaveLength(1);
});
it("schedules mix tempo boundaries and resumed effect phase on the actual Studio scheduler", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  class Context extends FakeContext {
    audioWorklet = { addModule: async () => {} };
  }
  const messages: {
    op: string;
    frame?: number;
    position?: number;
    bpm?: number;
    duration?: number;
  }[] = [];
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = {
        postMessage: (m: (typeof messages)[number]) => messages.push(m),
        onmessage: () => {},
      };
      connect() {}
    },
  );
  const { editMix } = await import("../packages/core/src/mix.ts");
  const { editPerformance } = await import("../packages/core/src/performance.ts");
  let p = editMix(createDemoProject(), (m) => {
    m.tempos = [{ step: 16, bpm: 60 }];
  });
  p.bpm = 120;
  const clip = p.tracks[0]?.clips[0];
  if (!clip) throw Error("Missing fixture");
  clip.length = 32;
  clip.steps = [
    { step: 16, pad: 0, velocity: 1, probability: 1, note: 60, duration: 1 },
    { step: 17, pad: 0, velocity: 1, probability: 1, note: 64, duration: 1 },
  ];
  p = editPerformance(p, (x) => {
    x.chain = [{ id: "song", sceneId: "scene-0", repeats: 1 }];
  });
  const audio = new StudioAudio();
  audio.setProject(p);
  await audio.enable();
  audio.start("scene-0", "song");
  for (let i = 0; i < 100; i++) {
    FakeContext.latest.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
  const clock = messages.find((m) => m.op === "clock" && m.position === 16);
  expect(clock?.frame).toBe(97920);
  expect(clock?.bpm).toBe(60);
  const notes = messages.filter((m) => m.op === "on");
  expect(notes.map((m) => m.frame)).toEqual([97920, 109920]);
  expect(notes.map((m) => m.duration)).toEqual([12000, 12000]);
  expect(audio.position).toBeCloseTo(17.84);
  audio.stop();
  p = editPerformance(p, (x) => {
    x.position = { occurrenceId: "song", offset: 16 };
  });
  audio.setProject(p);
  messages.length = 0;
  audio.start("scene-0", "song", true);
  const startClock = messages.find((m) => m.op === "clock");
  expect(startClock?.position).toBe(16);
  expect(startClock?.bpm).toBe(60);
  expect(messages.find((m) => m.op === "on")?.duration).toBe(12000);
  audio.stop();
});
