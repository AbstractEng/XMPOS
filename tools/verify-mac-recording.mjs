import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "../acceptance/lib/workspace.mjs";

if (
  process.platform !== "darwin" ||
  process.env.CI ||
  process.env.GITHUB_ACTIONS === "true" ||
  process.argv.length !== 2
)
  throw new Error("Explicit Mac-only recording verification; no flags or CI");
const parent = resolve(root, "reports/verification");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(resolve(parent, "p05-recording-"));
chmodSync(directory, 0o700);
const r = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    "p05MacRecording",
    "--format",
    "progress",
    "--format",
    `json:${directory}/cucumber.json`,
    "--format",
    `junit:${directory}/cucumber.xml`,
  ],
  {
    cwd: root,
    stdio: "inherit",
    timeout: 60000,
    env: { ...process.env, XMP_RECORD_CHECK_DIR: directory },
  },
);
console.log(`Local microphone evidence: ${directory}`);
process.exitCode = r.status ?? 2;
