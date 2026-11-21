import { describe, expect, it } from "vitest";
import {
  expandSong,
  installSample,
  ownKit,
  PerformanceTransport,
  recordLoop,
  samplerInput,
} from "../packages/core/src/edits.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { type LoopCore, loopModule } from "../packages/core/src/loop-engine.ts";
import { openProject, saveSong } from "../packages/core/src/project-io.ts";
import { ProjectSession } from "../packages/core/src/session.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function project() {
  const p = expandSong(createDemoProject());
  p.bpm = 120;
  required(p.tracks[0]).machine = { id: "xmp.sampler", version: 1, base: "audio", state: {} };
  return p;
}
describe("synced sampler loops", () => {
  it("runs the native capture clock in Wasm, monitors between takes and loops at the exact end frame", async () => {
    const instance = await WebAssembly.instantiate(await loopModule(), {
      wasi_snapshot_preview1: {
        clock_time_get: () => 8,
        fd_close: () => 8,
        fd_seek: () => 8,
        fd_write: () => 8,
      },
    });
    const c = instance.exports as unknown as LoopCore;
    c._initialize();
    const input = new Float32Array(c.memory.buffer, c.lp_input(), 128);
    input.fill(0.5);
    c.lp_process(0, 1, 1, 1);
    expect(new Float32Array(c.memory.buffer, c.lp_left(), 128)[0]).toBe(0.125);
    expect(c.lp_queue(138, 64)).toBe(1);
    c.lp_process(128, 1, 0, 0.25);
    expect(c.lp_state()).toBe(3);
    expect(c.lp_frames()).toBe(64);
    const out = new Float32Array(c.memory.buffer, c.lp_left(), 128);
    expect(out[73]).toBe(0);
    expect(out[74]).toBe(0.125);
    c.lp_handoff(270);
    c.lp_process(256, 1, 0, 0.25);
    expect(c.lp_state()).toBe(4);
    expect(out[13]).toBe(0.125);
    expect(out[14]).toBe(0);
    expect(c.lp_queue(400, 64)).toBe(1);
    c.lp_process(384, 0, 0, 1);
    expect(c.lp_state()).toBe(6);
  });
  it("uses the same threshold recorder for stopped takes, trimming only after capture", async () => {
    const instance = await WebAssembly.instantiate(await loopModule(), {
      wasi_snapshot_preview1: {
        clock_time_get: () => 8,
        fd_close: () => 8,
        fd_seek: () => 8,
        fd_write: () => 8,
      },
    });
    const c = instance.exports as unknown as LoopCore;
    c._initialize();
    c.lp_arm_threshold();
    const input = new Float32Array(c.memory.buffer, c.lp_input(), 128);
    c.lp_process(0, 1, 1, 1);
    expect(c.lp_state()).toBe(1);
    input.fill(0.5);
    c.lp_process(128, 1, 1, 1);
    expect(c.lp_state()).toBe(2);
    c.lp_stop_threshold();
    expect(c.lp_state()).toBe(3);
    c.lp_prepare_take();
    const pcm = new Float32Array(c.memory.buffer, c.lp_pcm(), c.lp_length());
    expect(pcm.length).toBe(256);
    expect(pcm[0]).toBe(0);
    expect(pcm[255]).toBe(1);
    c.lp_arm_threshold();
    c.lp_cancel();
    expect(c.lp_state()).toBe(5);
  });
  it("creates a four-bar clip on the selected pad as one undoable, portable change", async () => {
    const original = project(),
      session = new ProjectSession(original, true);
    const track = required(original.tracks[0]).id,
      scene = required(original.scenes[0]).id;
    session.edit((p) => recordLoop(p, track, scene, 7, "Live loop", new Float32Array(384000), 4));
    const next = session.project,
      selected = required(next.tracks[0]),
      clip = selected.clips.find((c) => c.id === required(next.scenes[0]).clips[track]);
    expect(clip?.length).toBe(64);
    expect(clip?.steps).toEqual([{ step: 0, pad: 7, velocity: 1, probability: 1 }]);
    expect(selected.pads?.[7]?.playback?.mode).toBe("one-shot");
    expect(selected.pads?.[6]).toEqual(original.pads[6]);
    expect(next.tracks.slice(1)).toEqual(original.tracks.slice(1));
    expect(next.extensions?.["xmp.sampler-input"]?.data).toEqual({
      tracks: { [track]: { monitor: true, bars: 4 } },
    });
    const reopened = await openProject(await saveSong(next));
    expect(reopened).toEqual(next);
    expect(session.historyDepth).toBe(1);
    session.undo();
    expect(session.project).toEqual(original);
  }, 30000);
  it("keeps recordings above the old sample limit intact with a required bounded profile", async () => {
    const original = project(),
      track = required(original.tracks[0]).id;
    const next = installSample(
      ownKit(original, track),
      3,
      "Slow four bars",
      48000,
      new Float32Array(1536000),
      track,
    );
    expect(next.extensions?.["xmp.extended-samples"]).toEqual({
      version: 1,
      required: true,
      data: {},
    });
    const reopened = await openProject(await saveSong(next));
    const pad = required(required(reopened.tracks[0]).pads?.[3]);
    expect(reopened.samples.find((s) => s.id === pad.sampleId)?.pcm.length).toBe(1536000);
    expect(() =>
      samplerInput(
        {
          ...original,
          extensions: { "xmp.sampler-input": { version: 2, data: { future: true } } },
        },
        track,
        true,
        4,
      ),
    ).toThrow(/newer/);
  }, 30000);
  it("records into older/default kit tracks whose sampler machine is implicit", () => {
    const p = createDemoProject(),
      track = required(p.tracks[0]),
      scene = required(p.scenes[0]);
    delete track.machine;
    p.bpm = 300;
    const recorded = recordLoop(p, track.id, scene.id, 0, "Mic take", new Float32Array(153600), 4);
    expect(recorded.tracks[0]?.machine?.id).toBe("xmp.sampler");
    const future = structuredClone(p);
    required(future.tracks[0]).machine = {
      id: "xmp.sampler",
      version: 42,
      base: "audio",
      state: { future: true },
    };
    const before = JSON.stringify(future);
    expect(() =>
      recordLoop(future, track.id, scene.id, 0, "Mic take", new Float32Array(153600), 4),
    ).toThrow(/sampler track/);
    expect(JSON.stringify(future)).toBe(before);
    expect(recorded.tracks[0]?.clips.find((c) => c.id === scene.clips[track.id])?.length).toBe(64);
  });
  it("launches a completed take on its chosen future loop boundary regardless of the normal launch grid", () => {
    const p = project(),
      track = required(p.tracks[0]).id,
      clip = required(required(p.tracks[0]).clips[0]).id;
    const transport = new PerformanceTransport(p);
    transport.start(required(p.scenes[0]).id);
    transport.advance(17);
    transport.queueClipAt(track, clip, 80);
    expect(transport.queuedClips.get(track)?.at).toBe(80);
    transport.advance(79);
    expect(transport.queuedClips.has(track)).toBe(true);
    transport.advance(80);
    expect(transport.queuedClips.has(track)).toBe(false);
    expect(transport.slots.get(track)?.anchor).toBe(80);
  });
});
