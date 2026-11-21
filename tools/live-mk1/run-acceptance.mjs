import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { preflightTarget } from "../../acceptance/target-policy.mjs";

// Runs the Live Mk1 kernel and hardware-support contracts. "host" runs only
// the scenarios that need no container. There are no hardware options.
const mode = process.argv[2] ?? "all";
if (process.argv.length > 3 || !["all", "host", "emulated"].includes(mode))
  throw new Error("Usage: npm run bdd:live-mk1 [host|emulated]; no hardware options exist");
preflightTarget({ profile: "standalone" });
const base = join(root, "reports/acceptance/live-mk1");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "run-"));
const sourceHash = buildIdentity();
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    mode === "host" ? "liveMk1Host" : mode === "emulated" ? "liveMk1Emulated" : "liveMk1",
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
    timeout: 10800000,
    env: { ...process.env, XMP_LIVE_MK1_EVIDENCE: directory },
  },
);
const sourceUnchanged = sourceHash === buildIdentity();
writeFileSync(
  join(directory, "run-metadata.json"),
  `${JSON.stringify(
    {
      kind: "live-mk1-kernel-and-hardware-support",
      mode,
      sourceHash,
      sourceUnchanged,
      exitCode: result.status,
      physicalAccess: false,
      hardwareQualified: false,
    },
    null,
    2,
  )}\n`,
);
process.exitCode = result.status === 0 && sourceUnchanged ? 0 : 1;
