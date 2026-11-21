// A two-bar, original practice loop with no export tail or silent slice pads.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { importPortable } from "../../packages/core/src/assets.ts";
import { loadCore } from "../../packages/core/src/edits.ts";
import { exportWave } from "../../packages/core/src/wave-export.ts";

await loadCore();
const folder = new URL("../../apps/studio/public/manual-media/", import.meta.url);
const project = await importPortable(
  await readFile(new URL("first-groove.xmpsong", folder), "utf8"),
);
const chunks = [];
for await (const chunk of exportWave(project, "scene", project.scenes[0].id, 0)) chunks.push(chunk);
const oneBar = Buffer.concat(chunks),
  data = oneBar.subarray(44);
const loop = Buffer.concat([oneBar, data]);
loop.writeUInt32LE(loop.length - 8, 4);
loop.writeUInt32LE(data.length * 2, 40);
assert.ok((loop.length - 44) / 192000 <= 10);
for (let part = 0; part < 4; part++) {
  let power = 0,
    count = 0;
  const frames = (loop.length - 44) / 4;
  for (
    let frame = Math.floor((part * frames) / 4);
    frame < Math.floor(((part + 1) * frames) / 4);
    frame++
  ) {
    const v = loop.readInt16LE(44 + frame * 4) / 32768;
    power += v * v;
    count++;
  }
  assert.ok(Math.sqrt(power / count) > 0.005, `Slice ${part + 1} must contain music`);
}
await writeFile(new URL("first-groove.wav", folder), loop);
console.log(
  `Prepared ${((data.length * 2) / 192000).toFixed(3)} second two-bar loop; all four slices contain audio`,
);
