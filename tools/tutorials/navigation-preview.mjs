// Rebuild only lesson 1 with the approved layout, current palette and Fenrir voice.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

execFileSync(process.execPath, [resolve(import.meta.dirname, "render.mjs"), "--navigation-only"], {
  stdio: "inherit",
});
