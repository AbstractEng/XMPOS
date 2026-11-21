import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";

if (process.argv.length !== 2) throw new Error("Fixed generic VM only; no hardware flags");
const base = join(root, "reports/acceptance/sdk-supported-vm");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "run-")),
  sourceHash = buildIdentity();
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    "supportedSdkVm",
    "--format",
    "progress",
    "--format",
    `json:${directory}/cucumber.json`,
    "--format",
    `junit:${directory}/cucumber.xml`,
    "--format",
    `html:${directory}/cucumber.html`,
  ],
  { cwd: root, stdio: "inherit", timeout: 1800000 },
);
const metadata = {
  kind: "booted-generic-native-parity",
  sourceHash,
  sourceUnchanged: sourceHash === buildIdentity(),
  exitCode: result.status ?? 1,
  hardwareQualified: false,
  physicalDeviceOperations: [],
};
writeFileSync(join(directory, "run-metadata.json"), JSON.stringify(metadata, null, 2));
writeFileSync(join(base, "latest.json"), JSON.stringify({ directory }));
process.exitCode = metadata.sourceUnchanged ? metadata.exitCode : 1;
