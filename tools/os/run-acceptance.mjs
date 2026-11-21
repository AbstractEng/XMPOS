import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { qualify } from "./qualify.mjs";
import { imageIdentity } from "./vm.mjs";

const mode = process.argv[2] ?? "P10";
if (!/^P10(?:_[1-4])?$/.test(mode) || process.argv.length > 3)
  throw new Error("Select P10 or P10_1 through P10_4; no physical targets");
const image = await imageIdentity(resolve(root, "artifacts/os/p10"));
const sourceHash = buildIdentity();
if (image.manifest.sourceHash !== sourceHash)
  throw new Error("Image source is stale; run npm run os:build");
const base = resolve(root, `reports/acceptance/${mode}`);
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(resolve(base, "run-"));
const metadata = {
  kind: "booted-generic-os",
  mode,
  sourceHash,
  buildId: image.manifest.buildId,
  profile: image.manifest.profile,
  startedAt: new Date().toISOString(),
  directory,
  physicalDeviceOperations: [],
  physicalQualification: false,
};
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    "osVm",
    "--tags",
    `@${mode} and @implemented`,
    "--format",
    "progress",
    "--format",
    `json:${directory}/cucumber.json`,
    "--format",
    `junit:${directory}/cucumber.xml`,
    "--format",
    `html:${directory}/cucumber.html`,
  ],
  {
    cwd: root,
    stdio: "inherit",
    timeout: 1200000,
    env: { ...process.env, XMP_OS_EVIDENCE: directory, XMP_BUILD_HASH: sourceHash },
  },
);
metadata.finishedAt = new Date().toISOString();
metadata.exitCode = result.status ?? 1;
if (sourceHash !== buildIdentity()) {
  metadata.exitCode = 1;
  metadata.error = "Source changed during run";
}
writeFileSync(resolve(directory, "run-metadata.json"), JSON.stringify(metadata, null, 2));
writeFileSync(resolve(base, "latest.json"), JSON.stringify({ directory }, null, 2));
const gate = await qualify(directory);
console.log(
  `${mode}: ${gate.checksPassed ? "CHECKS PASSED" : "FAILED"}; full phase, physical audio and MPC qualification PENDING`,
);
process.exitCode = gate.checksPassed ? 0 : 1;
