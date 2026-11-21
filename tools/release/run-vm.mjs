import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { imageIdentity } from "../os/vm.mjs";
import { qualifyReleaseVm } from "./qualify-vm.mjs";

const mode = process.argv[2] ?? "P12";
if (!/^P12(?:_[23])?$/.test(mode) || process.argv.length > 3)
  throw new Error("Select implemented P12 VM recovery/update cases only");
const baseImage = await imageIdentity(resolve(root, "artifacts/os/p10"));
const candidate = await imageIdentity(resolve(root, "artifacts/os/update-candidate"));
const sourceHash = buildIdentity();
if (baseImage.manifest.sourceHash !== sourceHash || candidate.manifest.sourceHash !== sourceHash)
  throw new Error("Release VM images stale: run npm run release:images");
if (baseImage.manifest.buildId === candidate.manifest.buildId)
  throw new Error("Two separately identified VM image variants required");
const base = resolve(root, `reports/acceptance/P12-vm${mode === "P12" ? "" : `-${mode.at(-1)}`}`);
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(resolve(base, "run-"));
const metadata = {
  mode,
  sourceHash,
  buildId: baseImage.manifest.buildId,
  candidateBuildId: candidate.manifest.buildId,
  startedAt: new Date().toISOString(),
  physicalDeviceOperations: [],
  hardwareQualified: false,
};
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    "releaseVm",
    "--tags",
    `@${mode} and @implemented and @p12_vm`,
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
    timeout: 1500000,
    env: { ...process.env, XMP_RELEASE_EVIDENCE: directory, XMP_BUILD_HASH: sourceHash },
  },
);
metadata.exitCode = result.status ?? 1;
metadata.finishedAt = new Date().toISOString();
if (buildIdentity() !== sourceHash) {
  metadata.exitCode = 1;
  metadata.error = "Source changed during release VM run";
}
writeFileSync(resolve(directory, "run-metadata.json"), JSON.stringify(metadata, null, 2));
writeFileSync(resolve(base, "latest.json"), JSON.stringify({ directory }, null, 2));
const report = await qualifyReleaseVm(directory);
console.log(
  `P12 VM: ${report.checksPassed ? "SOFTWARE CHECKS PASSED" : "FAILED"}; physical/update hardware and full release qualification PENDING`,
);
process.exitCode = report.checksPassed ? 0 : 1;
