import { createDemoProject, expandSong, ProjectSchema } from "@xmp/core";
import { expect, it } from "vitest";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { machines } from "../packages/core/src/machines.ts";
import {
  deleteTrack,
  editChain,
  editPerformance,
  PerformanceTransport,
  performanceValues,
  performanceWindow,
} from "../packages/core/src/performance.ts";
import { SharedDelay } from "../packages/core/src/performance-dsp.ts";

function fixture() {
  const p = expandSong(createDemoProject());
  p.bpm = 120;
  p.master = 1;
  p.parameters = [];
  p.samples = [{ id: "one", name: "Impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] }];
  for (const pad of p.pads) pad.sampleId = "one";
  for (const t of p.tracks) {
    t.volume = 1;
    t.clips.forEach((c) => {
      c.steps = [];
    });
  }
  for (let i = 0; i < 2; i++) {
    const t = p.tracks[i];
    if (!t) throw new Error("Missing track");
    for (const c of t.clips) c.steps = [{ step: 0, pad: i, velocity: 1, probability: 1 }];
  }
  const t = p.tracks[0];
  if (t?.clips[1]) {
    t.clips[1].length = 64;
    t.clips[1].steps.push({ step: 48, pad: 0, velocity: 1, probability: 1 });
  }
  return editPerformance(p, () => {});
}
it("restarts a scene from zero but independent clip launches preserve other playheads", () => {
  const p = fixture(),
    a = new PerformanceTransport(p);
  a.start("scene-0");
  performanceWindow(a, 0);
  a.queueScene("scene-1");
  for (let s = 1; s < 16; s++) performanceWindow(a, s);
  const boundary = performanceWindow(a, 16);
  expect(boundary.snapshot.anchors.drums).toBe(16);
  expect(
    boundary.notes.filter((n) => n.trackId === "drums").map((n) => [n.position, n.frame]),
  ).toEqual([[16, 96000]]);
  a.queueClip("drums", "clip-0");
  for (let s = 17; s < 32; s++) performanceWindow(a, s);
  const independent = performanceWindow(a, 32);
  expect(independent.snapshot.anchors.drums).toBe(32);
  expect(independent.snapshot.anchors["track-1"]).toBe(16);
});
it("cancels launches and treats empty slots as stop while retaining delay history", () => {
  const p = fixture(),
    scene = p.scenes[2];
  if (scene) delete scene.clips.drums;
  const a = new PerformanceTransport(p);
  a.start("scene-0");
  a.advance(0);
  a.queueScene("scene-1");
  expect(a.cancelLaunch()).toBe(true);
  a.advance(16);
  expect(a.sceneId).toBe("scene-0");
  a.queueScene("scene-2");
  const w = performanceWindow(a, 32);
  expect(w.snapshot.clips.drums).toBeUndefined();
  expect(w.releases).toContain("drums");
  expect(w.notes.some((n) => n.trackId === "drums")).toBe(false);
});
it("freezes an active occurrence while applying future reorder by stable occurrence ID", () => {
  const p = editChain(fixture(), [
      { id: "a", sceneId: "scene-0", repeats: 2 },
      { id: "again", sceneId: "scene-0", repeats: 1 },
      { id: "long", sceneId: "scene-1", repeats: 1 },
      { id: "last", sceneId: "scene-2", repeats: 1 },
    ]),
    a = new PerformanceTransport(p);
  a.start("scene-0", "song");
  a.advance(4);
  a.setProject(
    editChain(p, [
      { id: "a", sceneId: "scene-0", repeats: 1 },
      { id: "last", sceneId: "scene-2", repeats: 1 },
      { id: "long", sceneId: "scene-1", repeats: 1 },
    ]),
  );
  a.advance(31);
  expect(a.sceneId).toBe("scene-0");
  expect(a.advance(32).snapshot.position?.occurrenceId).toBe("last");
  expect(a.advance(48).snapshot.position?.occurrenceId).toBe("long");
});
it("stops or loops a chain at the declared duration and resumes a saved occurrence offset", () => {
  for (const end of ["stop", "loop"] as const) {
    const p = editPerformance(
      editChain(fixture(), [{ id: "a", sceneId: "scene-0", repeats: 1 }]),
      (p) => {
        p.end = end;
        p.position = { occurrenceId: "a", offset: 8 };
      },
    );
    const a = new PerformanceTransport(p);
    a.start("scene-0", "song", true);
    expect(performanceWindow(a, 0).snapshot.position?.offset).toBe(8);
    expect(a.advance(8).snapshot.running).toBe(end === "loop");
  }
});
it("removes stale macro assignments and control events when their track is deleted", () => {
  const p = editPerformance(fixture(), (p) => {
    p.macros = [
      {
        id: "m",
        name: "Macro",
        value: 0.5,
        assignments: [{ parameter: "track.track-1.gain", amount: 0.5 }],
      },
    ];
    p.events = [{ id: "e", kind: "mute", trackId: "track-1", at: 4, value: true }];
  });
  const next = deleteTrack(p, "track-1"),
    a = new PerformanceTransport(next);
  a.start("scene-0");
  a.advance(0);
  a.control({ id: "move", kind: "macro", macroId: "m", at: 1, value: 1 });
  expect(next.performance?.macros[0]?.assignments).toHaveLength(0);
  expect(next.performance?.events).toHaveLength(0);
  expect(performanceValues(a, 1).values["track.drums.gain"]).toBe(1);
});
it("preserves real delay echoes after a source stops and bounds feedback", () => {
  const d = new SharedDelay({ seconds: 0.001, feedback: 0.5, wet: 1, sends: {} }, 48000),
    out = Array.from({ length: 145 }, (_, i) => d.process(i === 0 ? 1 : 0));
  expect(out[48]).toBe(1);
  expect(out[96]).toBe(0.5);
  expect(out[144]).toBe(0.25);
  expect(
    () => new SharedDelay({ seconds: 0.001, feedback: 1, wet: 1, sends: {} }, 48000),
  ).toThrow();
  d.clear();
  expect(d.process(0)).toBe(0);
});
it("does not substitute unavailable machine parameters or change another track", () => {
  const p = fixture(),
    track = p.tracks[1];
  if (track) track.machine = machines.instantiate("xmp.subtractive");
  const id = "track.track-1.machine.xmp.subtractive.v1.cutoff";
  const model = editPerformance(p, (p) => {
    p.macros = [{ id: "m", name: "Tone", value: 1, assignments: [{ parameter: id, amount: 0.2 }] }];
  });
  const a = new PerformanceTransport(model);
  a.start("scene-0");
  a.advance(0);
  expect(performanceValues(a, 0).values[id]).toBeGreaterThan(0.2);
  if (track) track.machine = machines.instantiate("xmp.midi");
  const replaced = structuredClone(model);
  const rt = replaced.tracks[1];
  if (rt) rt.machine = machines.instantiate("xmp.midi");
  a.setProject(replaced);
  expect(performanceValues(a, 0).unavailable).toContain(id);
  expect(performanceValues(a, 0).values[id]).toBeUndefined();
});
it("releases a MIDI owner when it is gated without opening any physical route", () => {
  const p = fixture(),
    t = p.tracks[0];
  if (t) t.machine = machines.instantiate("xmp.midi");
  const events: unknown[] = [];
  const rack = new VoiceRack(prepareInstruments(p), 48000, (e) => events.push(e));
  rack.noteOn(1, 0, 0, 60, 0.5, 0);
  rack.releaseTrack("drums");
  expect(events).toHaveLength(2);
  expect(rack.active).toBe(0);
});
it("rejects malformed chain and performance data before replacing a project", () => {
  const p = fixture();
  expect(() => editChain(p, [{ id: "a", sceneId: "missing", repeats: 1 }])).toThrow();
  expect(() =>
    editPerformance(p, (p) => {
      p.chain = [
        { id: "a", sceneId: "scene-0", repeats: 1 },
        { id: "a", sceneId: "scene-1", repeats: 1 },
      ];
    }),
  ).toThrow();
  expect(() =>
    editPerformance(p, (p) => {
      p.delay.feedback = Infinity;
    }),
  ).toThrow();
  ProjectSchema.parse(p);
});
it("resumes recorded control state at the saved song position and resets it on a song loop", () => {
  const p = editPerformance(
    editChain(fixture(), [
      { id: "intro", sceneId: "scene-0", repeats: 1 },
      { id: "long", sceneId: "scene-1", repeats: 1 },
    ]),
    (p) => {
      p.end = "loop";
      p.events = [{ id: "mute", kind: "mute", trackId: "drums", at: 16, value: true }];
      p.position = { occurrenceId: "long", offset: 8 };
    },
  );
  const a = new PerformanceTransport(p);
  a.start("scene-0", "song", true);
  performanceWindow(a, 0);
  expect(a.songOffset).toBe(24);
  expect(performanceValues(a, 0).blocked).toContain("drums");
  const loop = performanceWindow(a, 56);
  expect(loop.snapshot.position?.occurrenceId).toBe("intro");
  expect(performanceValues(a, 56).blocked).not.toContain("drums");
});
it("quantizes discrete machine controls and exposes their encoder increment", async () => {
  const { parameterRegistry, setParameter } = await import("../packages/core/src/parameters.ts");
  const p = fixture(),
    track = p.tracks[0];
  if (!track) throw new Error("Missing track");
  track.machine = machines.instantiate("xmp.midi");
  const id = `track.${track.id}.machine.xmp.midi.v1.channel`,
    definition = parameterRegistry(p).find((p) => p.id === id);
  expect(definition?.step).toBe(1 / 15);
  expect(setParameter(p, id, 1 / 15).tracks[0]?.machine?.state.channel).toBe(2);
  expect(setParameter(p, id, 0.51).tracks[0]?.machine?.state.channel).toBe(9);
});
