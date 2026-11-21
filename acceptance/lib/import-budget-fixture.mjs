import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { createDemoProject, MAX_SONG_BYTES } from "../../packages/core/src/index.ts";
import { MAX_IMPORT_RSS_BYTES } from "../../packages/core/src/input.ts";

const project = createDemoProject();
const text = await exportPortable(project);
const corrupt = JSON.parse(text);
corrupt.assets[0].pcm[0] = 0.99;
const failures = [];
for (const candidate of [
  " ".repeat(MAX_SONG_BYTES + 1),
  JSON.stringify(corrupt),
  `${"[".repeat(40)}0${"]".repeat(40)}`,
]) {
  try {
    await importPortable(candidate);
    throw new Error("Unexpected import success");
  } catch (error) {
    if (error.message === "Unexpected import success") throw error;
    failures.push(error.message);
  }
}
const rssBytes = process.resourceUsage().maxRSS * 1024;
console.log(
  JSON.stringify({ failures, rssBytes, rssBudgetBytes: MAX_IMPORT_RSS_BYTES, committedChanges: 0 }),
);
process.exitCode = rssBytes <= MAX_IMPORT_RSS_BYTES ? 0 : 1;
