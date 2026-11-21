import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originalKits } from "../apps/studio/src/bundled-drum-kits.ts";
import { applyDrumKit, type DrumKit, validateDrumKit } from "../packages/core/src/drum-kits.ts";
import * as wasm from "../packages/core/src/edits.ts";
import {
  createDemoProject,
  migrateProject,
  type Project,
  ProjectSchema,
} from "../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { sampleInUse } from "../packages/core/src/pads.ts";

// XMP Velvet, the multi-sampled groove kit (native/include/xmp/velvet_kit.hpp),
// and project format 8's velocity layers of round-robin takes that play it.
const root = join(import.meta.dirname, "..");
const file = join(root, "apps/studio/public/kits/xmp/xmp-velvet.xmpkit");
const bytes = readFileSync(file);
const kit: DrumKit = validateDrumKit(JSON.parse(bytes.toString("utf8")));

// One hit on `pad` at `velocity` through the engine, after `before` earlier hits.
function hit(project: Project, pad: number, velocity: number, before = 0, frames = 4096) {
  const rack = new VoiceRack(prepareInstruments(project), 48000);
  const left = new Float32Array(frames),
    right = new Float32Array(frames);
  // Earlier hits ring out first (every sound is under half a second).
  for (let i = 0; i < before; i++) {
    rack.noteOn(100 + i, pad, 0, 60, velocity);
    for (let k = 0; k < 8; k++) rack.process(left, right, 4096);
  }
  rack.noteOn(1, pad, 0, 60, velocity);
  rack.process(left, right);
  return left;
}
const peak = (pcm: Float32Array) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
// Brightness: how much of the signal is in its sample-to-sample changes.
const brightness = (pcm: Float32Array) => {
  let d = 0,
    e = 0;
  for (let i = 1; i < pcm.length; i++) {
    d += ((pcm[i] ?? 0) - (pcm[i - 1] ?? 0)) ** 2;
    e += (pcm[i] ?? 0) ** 2;
  }
  return d / Math.max(e, 1e-12);
};

describe("XMP Velvet", () => {
  it("is the file the browser checks, inside a project's budgets", () => {
    const entry = originalKits.find((k) => k.id === "xmp-velvet");
    expect(entry?.bytes, "run `npm run kits:velvet`").toBe(bytes.length);
    expect(entry?.sha256, "run `npm run kits:velvet`").toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(kit.samples).toHaveLength(16);
    let frames = 0,
      takes = 0;
    for (const sound of kit.samples) {
      expect(sound.layers?.length).toBeGreaterThanOrEqual(2);
      expect(sound.layers?.at(-1)?.upTo).toBe(1);
      for (const layer of sound.layers ?? [])
        for (const take of layer.takes) {
          frames += take.pcm.length;
          takes++;
        }
    }
    expect(takes).toBeGreaterThanOrEqual(60);
    expect(frames).toBeLessThan(650000);
    expect(kit.samples.map((s) => s.name).slice(0, 4)).toEqual([
      "Kick",
      "Snare",
      "Closed hat",
      "Open hat",
    ]);
  });

  it("loads as layered pads in both cores, byte for byte", () => {
    const base = createDemoProject();
    const ts = applyDrumKit(base, kit),
      cpp = wasm.applyDrumKit(base, kit);
    expect(JSON.stringify(cpp)).toBe(JSON.stringify(ts));
    expect(ts.version).toBe(8);
    expect(ts.pads.every((p) => p.layers && p.layers.length >= 2)).toBe(true);
    // Each take is a sample; the loudest layer's first take is the pad's own sound.
    for (const pad of ts.pads) {
      expect(pad.layers?.at(-1)?.samples[0]).toBe(pad.sampleId);
      for (const layer of pad.layers ?? [])
        for (const id of layer.samples) expect(sampleInUse(ts, id)).toBe(true);
    }
    expect(ts.samples.length).toBeLessThanOrEqual(128);
    expect(ts.pads.find((p) => p.name === "Closed hat")?.playback?.chokeGroup).toBe(1);
  });

  it("plays soft hits darker and quieter, and hard hits brighter and louder", () => {
    const project = applyDrumKit(createDemoProject(), kit);
    for (const pad of [0, 1, 2, 12]) {
      const soft = hit(project, pad, 0.2),
        hard = hit(project, pad, 1);
      expect(peak(hard), `pad ${pad + 1}`).toBeGreaterThan(peak(soft) * 1.6);
      expect(brightness(hard), `pad ${pad + 1}`).toBeGreaterThan(brightness(soft));
    }
  });

  it("rotates round-robin takes, so repeated hits differ", () => {
    const project = applyDrumKit(createDemoProject(), kit);
    // The snare's medium layer has three takes: hits 1, 2 and 3 differ; hit 4 is hit 1 again.
    const takes = [0, 1, 2, 3].map((before) => hit(project, 1, 0.6, before));
    expect(takes[1]).not.toEqual(takes[0]);
    expect(takes[2]).not.toEqual(takes[1]);
    expect(Array.from(takes[3] ?? [])).toEqual(Array.from(takes[0] ?? []));
  });
});

describe("project format 8: multi-sampled pads", () => {
  const layered = () => {
    const p = structuredClone(createDemoProject()) as Project;
    p.samples.push(
      { id: "soft", name: "Soft", sampleRate: 48000, pcm: [0.1, 0.1, 0.1] },
      { id: "hard", name: "Hard", sampleRate: 48000, pcm: [0.9, 0.9, 0.9] },
    );
    const pad = p.pads[0];
    if (pad)
      pad.layers = [
        { upTo: 0.5, samples: ["soft"] },
        { upTo: 1, samples: ["hard", pad.sampleId] },
      ];
    return p;
  };
  it("opens version 7 projects unchanged", () => {
    const v7 = { ...structuredClone(createDemoProject()), version: 7 };
    const p = migrateProject(v7);
    expect(p.version).toBe(8);
    expect(p.pads.some((pad) => pad.layers)).toBe(false);
  });
  it("checks layers in both cores", () => {
    expect(() => ProjectSchema.parse(layered())).not.toThrow();
    const bad = (change: (p: Project) => void, message: string) => {
      const p = layered();
      change(p);
      expect(() => ProjectSchema.parse(p)).toThrow(message);
      expect(() =>
        wasm.toggleStep(p, p.tracks[0]?.id ?? "", p.tracks[0]?.clips[0]?.id ?? "", 0, 0),
      ).toThrow(message);
    };
    bad((p) => {
      const l = p.pads[0]?.layers;
      if (l?.[0]) l[0].upTo = 1;
    }, "Pad layers must rise in velocity");
    bad((p) => {
      const l = p.pads[0]?.layers;
      if (l?.[1]) l[1].upTo = 0.9;
    }, "A pad's last layer must reach full velocity");
    bad((p) => {
      const l = p.pads[0]?.layers;
      if (l?.[0]) l[0].samples = ["nowhere"];
    }, "Missing sample nowhere");
    bad((p) => {
      const pad = p.pads[0];
      if (pad) pad.slice = { start: 0, end: 1 };
    }, "A layered pad has no slice");
  });
  it("picks the layer by velocity", () => {
    const p = layered();
    // Soft layer 0.1 at 0.6 + 0.4 × 0.3; hard layer 0.9 at 0.6 + 0.4 × 0.9.
    const soft = peak(hit(p, 0, 0.3, 0, 2)),
      hard = peak(hit(p, 0, 0.9, 0, 2));
    expect(soft).toBeGreaterThan(0);
    expect(hard / soft).toBeCloseTo((0.9 * 0.96) / (0.1 * 0.72), 1);
  });
  it("reclaims the replaced kit's velocity layers in both cores", () => {
    const before = layered();
    const replacement = {
      name: "Single hit",
      samples: [{ name: "Kick", sampleRate: 48000, pcm: [0.25] }],
    };
    const ts = applyDrumKit(before, replacement);
    const cpp = wasm.applyDrumKit(before, replacement);
    expect(cpp).toEqual(ts);
    expect(cpp.samples.map(({ name }) => name)).toEqual(["Kick", "Empty"]);
  });

  it("drops a pad's layers when its sound is replaced", () => {
    const p = wasm.installSample(layered(), 0, "Take", 48000, new Float32Array([0.5, 0.5]));
    expect(p.pads[0]?.layers).toBeUndefined();
    expect(p.samples.some((s) => s.id === "soft")).toBe(false);
  });
});

const haveCompiler = spawnSync("c++", ["--version"]).status === 0;
describe.skipIf(!haveCompiler)("the kit file", () => {
  it("is what the C++ generator writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "xmp-velvet-"));
    const binary = join(dir, "velvet");
    execFileSync("c++", [
      "-std=c++17",
      "-O1",
      `-I${join(root, "native/include")}`,
      join(root, "native/src/velvet_kit.cpp"),
      "-o",
      binary,
    ]);
    execFileSync(binary, [join(dir, "kit.xmpkit")]);
    const fresh: DrumKit = JSON.parse(readFileSync(join(dir, "kit.xmpkit"), "utf8"));
    // Within the file's rounding, whatever the compiler's floating point.
    for (const [s, sound] of fresh.samples.entries())
      for (const [l, layer] of (sound.layers ?? []).entries())
        for (const [t, take] of layer.takes.entries()) {
          const committed = kit.samples[s]?.layers?.[l]?.takes[t]?.pcm ?? [];
          expect(take.pcm.length, `${sound.name} ${l}.${t}`).toBe(committed.length);
          let worst = 0;
          for (const [i, v] of take.pcm.entries())
            worst = Math.max(worst, Math.abs(v - (committed[i] ?? 0)));
          expect(worst, `${sound.name} ${l}.${t}`).toBeLessThanOrEqual(0.0002);
        }
  }, 120000);
});
