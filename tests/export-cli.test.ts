import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { exportPortable } from "../packages/core/src/assets.ts";
import { decodeMidi, loadCore } from "../packages/core/src/edits.ts";
import { createDemoProject } from "../packages/core/src/index.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

it("commits real CLI WAV/MIDI files, applies legacy master gain and preserves existing destinations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xmp-export-test-"));
  try {
    const p = createDemoProject();
    p.bpm = 300;
    p.master = 0.25;
    p.samples = [{ id: "impulse", name: "Original impulse", sampleRate: 48000, pcm: [0.5, 0, 0] }];
    for (const pad of p.pads) pad.sampleId = "impulse";
    const t = p.tracks[0];
    if (!t) throw Error("Missing track");
    t.volume = 1;
    for (const c of t.clips) c.steps = [{ step: 0, pad: 0, velocity: 1, probability: 1 }];
    const source = join(directory, "project.xmp.json"),
      wav = join(directory, "scene.wav"),
      mid = join(directory, "scene.mid");
    writeFileSync(source, await exportPortable(p));
    const run = (destination: string, format: string, overwrite = false) =>
      spawnSync(
        process.execPath,
        [
          resolve("tools/export-project.mjs"),
          source,
          destination,
          "scene",
          format,
          "scene-0",
          ...(overwrite ? ["--overwrite"] : []),
        ],
        { encoding: "utf8" },
      );
    const rendered = run(wav, "wav");
    expect(rendered.status, rendered.stderr).toBe(0);
    const bytes = readFileSync(wav);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(bytes.readInt16LE(44)).toBe(4096);
    expect(run(wav, "wav").status).not.toBe(0);
    expect(readFileSync(wav)).toEqual(bytes);
    expect(run(wav, "wav", true).status).toBe(0);
    const exported = run(mid, "mid");
    expect(exported.status, exported.stderr).toBe(0);
    expect(decodeMidi(readFileSync(mid)).notes.map((n) => [n.note, n.tick])).toEqual([[36, 0]]);
    expect(readdirSync(directory).some((n) => n.endsWith(".partial"))).toBe(false);
    expect(run(source, "wav", true).status).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Runs the real export CLI end to end; give it CPU headroom.
}, 30_000);
