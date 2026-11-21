import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadCore, renderExchange } from "../packages/core/src/edits.ts";
import { saveStreamExport } from "../packages/core/src/export-sink.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { emptyPerformance } from "../packages/core/src/performance-schema.ts";
import { exportWave } from "../packages/core/src/wave-export.ts";
// @ts-expect-error Node's file sink is shared with the CLI.
import { fileExportSink } from "../tools/lib/export-sink.mjs";

await loadCore();
function fixture() {
  const p = createDemoProject();
  p.samples = [{ id: "impulse", name: "Original impulse", sampleRate: 48000, pcm: [0.5, 0, 0] }];
  for (const pad of p.pads) pad.sampleId = "impulse";
  p.performance = emptyPerformance();
  p.performance.chain = [{ id: "one", sceneId: "scene-0", repeats: 1 }];
  return p;
}
it("streamed WAV is byte-identical to the existing short renderer including tempo changes, swing, effects and tail", async () => {
  const p = fixture();
  p.swing = 0.13;
  const expected = new Uint8Array(renderExchange(p, "song", "scene-0", 0.5).wav);
  const parts: Uint8Array[] = [];
  for await (const bytes of exportWave(p, "song", "scene-0", 0.5)) {
    expect(bytes.length).toBeLessThanOrEqual(16384);
    parts.push(bytes);
  }
  expect(Buffer.concat(parts)).toEqual(Buffer.from(expected));
});
it("exports beyond both the old frame and 1024-step limits with bounded chunks and the right duration", async () => {
  const p = fixture();
  p.bpm = 124;
  p.performance!.chain = [
    { id: "one", sceneId: "scene-0", repeats: 16 },
    { id: "two", sceneId: "scene-0", repeats: 16 },
    { id: "three", sceneId: "scene-0", repeats: 16 },
    { id: "four", sceneId: "scene-0", repeats: 16 },
    { id: "five", sceneId: "scene-0", repeats: 8 },
  ];
  let count = 0;
  let expected = 0;
  for await (const bytes of exportWave(p, "song")) {
    expect(bytes.length).toBeLessThanOrEqual(16384);
    if (!count) expected = new DataView(bytes.buffer).getUint32(40, true) + 44;
    count += bytes.length;
  }
  expect(count).toBe(expected);
  expect((count - 44) / 192000).toBeCloseTo((1152 * 15) / 124 + 2, 4);
}, 30000);
it("rejects looping/over-budget songs and aborts partial output while preserving an existing destination", async () => {
  const p = fixture();
  p.performance!.end = "loop";
  await expect(exportWave(p, "song").next()).rejects.toThrow("finite chain");
  p.performance!.end = "stop";
  p.bpm = 30;
  p.performance!.chain = Array.from({ length: 64 }, (_, i) => ({
    id: `block-${i}`,
    sceneId: "scene-0",
    repeats: 16,
  }));
  await expect(exportWave(p, "song").next()).rejects.toThrow("thirty minutes");
  const dir = await mkdtemp(join(tmpdir(), "xmp-wave-abort-"));
  try {
    const out = join(dir, "song.wav");
    await writeFile(out, "original");
    async function* failing() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
      throw new Error("render failure");
    }
    await expect(saveStreamExport(fileExportSink(out, true), true, failing())).rejects.toThrow(
      "render failure",
    );
    expect(await readFile(out, "utf8")).toBe("original");
    expect(await readdir(dir)).toEqual(["song.wav"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
