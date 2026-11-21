import { describe, expect, it } from "vitest";
import * as wasm from "../packages/core/src/edits.ts";
import { loadCore, renderInstrumentScene, renderProjectScene } from "../packages/core/src/edits.ts";
import {
  createDemoProject,
  expandSong,
  migrateProject,
  type Project,
  ProjectSchema,
  trackPads,
} from "../packages/core/src/index.ts";
import { installSample, ownKit, shareKit } from "../packages/core/src/instruments.ts";
import { machines } from "../packages/core/src/machines.ts";
import { setMidiDestination } from "../packages/core/src/midi-routing.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

// Project format 7: a track may hold its own kit of 16 pads; the others play
// the project's pads, as every track did before.
const tone = (frames: number, step: number) =>
  Float32Array.from({ length: frames }, (_, i) => Math.fround(Math.sin(i * step) * 0.5));
const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

// Two kit tracks playing pad 0 on step 0 of scene 0.
function twoKits(): Project {
  const p = expandSong(createDemoProject());
  const second = p.tracks[1];
  if (!second) throw new Error("no second track");
  second.clips[0] = { id: "beat", name: "Beat", length: 16, steps: [] };
  second.clips[0].steps.push({ step: 0, pad: 0, velocity: 0.9, probability: 1 });
  const scene = p.scenes[0];
  if (scene) scene.clips[second.id] = "beat";
  return ProjectSchema.parse(p);
}

describe("per-track kits (project format 7)", () => {
  it("opens version 6 projects unchanged: no track has a kit of its own", () => {
    const v6 = { ...structuredClone(createDemoProject()), version: 6 };
    const p = migrateProject(v6);
    expect(p.version).toBe(8);
    expect(p.tracks.every((t) => t.pads === undefined)).toBe(true);
    expect(trackPads(p, p.tracks[0]?.id)).toBe(p.pads);
  });

  it("gives a track its own kit, edits it alone, and shares the project's again", () => {
    let p = twoKits();
    const id = p.tracks[1]?.id ?? "";
    const before = renderProjectScene(p, "scene-0");
    p = ownKit(p, id);
    expect(p.tracks[1]?.pads).toEqual(p.pads);
    // An own kit that is still a copy sounds exactly the same.
    expect(bytes(renderProjectScene(p, "scene-0"))).toEqual(bytes(before));
    p = installSample(p, 0, "Own take", 48000, tone(400, 0.2), id);
    expect(p.tracks[1]?.pads?.[0]?.sampleId).toMatch(/^take-/);
    expect(p.pads[0]?.sampleId).toBe("sample-0");
    expect(p.samples.some((s) => s.id === "sample-0")).toBe(true);
    expect(bytes(renderProjectScene(p, "scene-0"))).not.toEqual(bytes(before));
    // The C++ core makes the same edits and the same sound.
    let q = wasm.ownKit(twoKits(), id);
    q = wasm.installSample(q, 0, "Own take", 48000, tone(400, 0.2), id);
    expect(JSON.stringify(q)).toBe(JSON.stringify(p));
    expect(bytes(wasm.renderProjectScene(q, "scene-0"))).toEqual(
      bytes(renderProjectScene(p, "scene-0")),
    );
    // Back to the project's pads: the take nothing plays any more goes.
    const shared = shareKit(p, id);
    expect(shared.tracks[1]?.pads).toBeUndefined();
    expect(shared.samples.some((s) => s.id.startsWith("take-"))).toBe(false);
    expect(JSON.stringify(wasm.shareKit(p, id))).toBe(JSON.stringify(shared));
  });

  it("applies a drum kit to one track's kit and keeps the project's sounds", () => {
    const base = ownKit(twoKits(), "track-1");
    const kit = {
      name: "Mine",
      samples: [{ name: "Thud", sampleRate: 48000, pcm: [0.5, 0.25, 0] }],
    };
    const p = wasm.applyDrumKit(base, kit, "track-1");
    expect(p.tracks[1]?.pads?.[0]?.name).toBe("Thud");
    expect(p.pads.map((x) => x.sampleId)).toEqual(base.pads.map((x) => x.sampleId));
    expect(p.samples.filter((s) => s.id.startsWith("kit-"))).toHaveLength(2);
    // Without a kit of its own, the track's kit is the project's.
    const shared = wasm.applyDrumKit(twoKits(), kit, "track-1");
    expect(shared.pads[0]?.name).toBe("Thud");
    expect(shared.tracks.every((t) => !t.pads)).toBe(true);
  });

  it("plays a MIDI track routed to a kit with that kit's pads", () => {
    let p = ownKit(twoKits(), "track-1");
    p = installSample(p, 0, "Own take", 48000, tone(2000, 0.05), "track-1");
    const source = p.tracks[2];
    if (!source) throw new Error("no third track");
    source.machine = machines.instantiate("xmp.midi");
    source.clips[0] = { id: "midi", name: "Midi", length: 16, steps: [] };
    source.clips[0].steps.push({ step: 4, pad: 0, velocity: 0.9, probability: 1 });
    const scene = p.scenes[0];
    if (scene) scene.clips[source.id] = "midi";
    p = setMidiDestination(ProjectSchema.parse(p), source.id, "track-1");
    // The routed note sounds the take; through the project's pads it would not.
    const own = renderInstrumentScene(p, "scene-0", 16).pcm,
      other = renderInstrumentScene(setMidiDestination(p, source.id, "drums"), "scene-0", 16).pcm;
    expect(Array.from(own)).not.toEqual(Array.from(other));
    expect(Array.from(wasm.renderInstrumentScene(p, "scene-0", 16).pcm)).toEqual(Array.from(own));
  });

  it("refuses a kit that is not 16 pads or plays a missing sample", () => {
    const p = ownKit(twoKits(), "track-1");
    const short = structuredClone(p);
    short.tracks[1]?.pads?.pop();
    expect(() => ProjectSchema.parse(short)).toThrow();
    const missing = structuredClone(p);
    const pad = missing.tracks[1]?.pads?.[3];
    if (pad) pad.sampleId = "nowhere";
    expect(() => ProjectSchema.parse(missing)).toThrow(/Missing sample nowhere/);
  });
});
