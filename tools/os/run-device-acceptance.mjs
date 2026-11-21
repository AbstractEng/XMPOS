import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";

if (process.argv.length !== 2) throw new Error("Device regression accepts no hardware options");
const base = join(root, "reports/acceptance/device-vm");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "run-")),
  sourceHash = buildIdentity();
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    "deviceVm",
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
    timeout: 2400000,
    env: { ...process.env, XMP_DEVICE_EVIDENCE: directory },
  },
);
const sourceUnchanged = sourceHash === buildIdentity();
writeFileSync(
  join(directory, "run-metadata.json"),
  JSON.stringify(
    {
      kind: "guest-device-and-arm-regression",
      sourceHash,
      sourceUnchanged,
      exitCode: result.status ?? 1,
      physicalDeviceOperations: [],
      hardwareQualified: false,
    },
    null,
    2,
  ),
);
writeFileSync(join(base, "latest.json"), JSON.stringify({ directory }));
process.exitCode = sourceUnchanged ? (result.status ?? 1) : 1;
