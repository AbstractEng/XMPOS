import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCore, prepareScene } from "../../packages/core/src/edits.ts";
import { command, root } from "./workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();
export function nativeSongCapture(project, sceneId, workspace) {
  const plan = prepareScene(project, sceneId);
  const bytes = Buffer.alloc(
    16 + plan.samples.reduce((n, sample) => n + 4 + sample.length * 4, 0) + plan.events.length * 12,
  );
  let cursor = 0;
  bytes.write("XMPS", cursor);
  cursor += 4;
  for (const value of [plan.frames, plan.samples.length, plan.events.length]) {
    bytes.writeUInt32LE(value, cursor);
    cursor += 4;
  }
  for (const sample of plan.samples) {
    bytes.writeUInt32LE(sample.length, cursor);
    cursor += 4;
    for (const value of sample) {
      bytes.writeFloatLE(value, cursor);
      cursor += 4;
    }
  }
  for (const event of plan.events) {
    bytes.writeUInt32LE(event.frame, cursor);
    bytes.writeUInt32LE(event.sample, cursor + 4);
    bytes.writeFloatLE(event.velocity, cursor + 8);
    cursor += 12;
  }
  writeFileSync(workspace.path("song.xmps"), bytes);
  command(resolve(root, "build/native/xmp_song_render"), [
    workspace.path("song.xmps"),
    workspace.path("native-song.wav"),
  ]);
  return { audio: readFileSync(workspace.path("native-song.wav")), events: plan.events };
}
