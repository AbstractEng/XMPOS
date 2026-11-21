import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fixtureHash } from "../acceptance/lib/fixtures.mjs";
import { buildIdentity, root, writeJson } from "../acceptance/lib/workspace.mjs";
import { preflightTarget } from "../acceptance/target-policy.mjs";

const mode = process.argv[2] ?? "current";
if (/^P12(?:_[1-4])?$/.test(mode) && process.argv.length === 3) {
  const result = spawnSync(process.execPath, ["tools/release/run.mjs", mode], {
    cwd: root,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
if (/^P10(?:_[1-4])?$/.test(mode) && process.argv.length === 3) {
  const result = spawnSync(process.execPath, ["tools/os/run-acceptance.mjs", mode], {
    cwd: root,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
if (
  ![
    "current",
    "design",
    "kits",
    "device",
    "sdk-supported",
    "acoustic",
    "planned",
    "foundation",
    "implemented",
    "P01",
    "P02",
    "P03",
    "P04",
    "P05",
    "P06",
    "P07",
    "P08",
    "P09",
    "P11",
    "layout",
    "release",
    "release_1",
    "release_2",
    "release_3",
    "release_4",
    ...["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P11"].flatMap((id) =>
      [1, 2, 3, 4].map((n) => `${id}_${n}`),
    ),
  ].includes(mode) ||
  process.argv.length > 3
)
  throw new Error(
    "Select current, design, acoustic, planned, foundation, implemented, P01 through P09, P11 or their substeps (P10 uses its separate VM runner); no physical target flags",
  );
preflightTarget({ profile: "standalone" });
const output = resolve(root, `reports/acceptance/${mode}`);
const evidence = resolve(output, "evidence");
mkdirSync(evidence, { recursive: true });
// Each invocation gets its own report namespace, so stale records cannot fill missing cases.
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidenceDirectory = resolve(evidence, runId);
mkdirSync(evidenceDirectory);
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const metadata = {
  kind: "host-contract-run",
  mode,
  startedAt: new Date().toISOString(),
  node: process.version,
  sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  sourceHash: buildIdentity(),
  fixtureHash,
  targetProfile: "host-contract",
  physicalAdapter: "absent",
  bootedImageHash: null,
  hardwareIdentity: null,
  hardwareQualification: false,
  evidenceDirectory: relative(root, evidenceDirectory),
};
writeJson(resolve(output, "run-metadata.json"), metadata);
const args = [
  "node_modules/@cucumber/cucumber/bin/cucumber.js",
  "--profile",
  mode === "sdk-supported"
    ? "supportedSdk"
    : mode === "device"
      ? "deviceWorkflow"
      : mode === "kits"
        ? "drumKits"
        : mode === "current"
          ? "default"
          : mode === "planned"
            ? "planned"
            : mode === "acoustic"
              ? "acoustic"
              : mode === "design"
                ? "design"
                : mode === "implemented"
                  ? "implemented"
                  : mode === "layout"
                    ? "performanceLayout"
                    : mode.startsWith("release")
                      ? "releaseDevelopment"
                      : mode.startsWith("P11")
                        ? "hardwareDevelopment"
                        : mode.startsWith("P09")
                          ? "sdk"
                          : mode.startsWith("P08")
                            ? "mix"
                            : mode.startsWith("P07")
                              ? "performance"
                              : mode.startsWith("P06")
                                ? "sequencer"
                                : mode.startsWith("P05")
                                  ? "instruments"
                                  : mode.startsWith("P03")
                                    ? "projects"
                                    : mode.startsWith("P04")
                                      ? "engine"
                                      : "foundation",
  "--format",
  "progress",
  "--format",
  `json:${output}/cucumber.json`,
  "--format",
  `junit:${output}/cucumber.xml`,
  "--format",
  `html:${output}/cucumber.html`,
];
if ((mode.startsWith("P0") || mode.startsWith("P11")) && mode !== "P04")
  args.push(
    "--tags",
    mode.startsWith("P11")
      ? `@${mode} and @implemented and @host_only`
      : mode.startsWith("P09")
        ? `@${mode} and @implemented`
        : mode.startsWith("P08")
          ? `@${mode} and @implemented`
          : mode.startsWith("P07")
            ? `@${mode} and @implemented and not @manual_layout`
            : mode.startsWith("P04")
              ? `@${mode} and @implemented and not @physical_measurement`
              : `@${mode}`,
  );
if (mode.startsWith("release"))
  args.push(
    "--tags",
    `@${mode === "release" ? "P12" : `P12_${mode.at(-1)}`} and @implemented and @host_only`,
  );
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
  // The aggregate includes two fresh dependency/toolchain/build rehearsals.
  timeout: mode === "implemented" ? 1800000 : 1200000,
  env: { ...process.env, XMP_EVIDENCE_DIR: evidenceDirectory, XMP_BUILD_HASH: metadata.sourceHash },
});
metadata.finishedAt = new Date().toISOString();
metadata.exitCode = result.status ?? 1;
if (result.error) metadata.error = result.error.message;
if (buildIdentity() !== metadata.sourceHash) {
  metadata.error = "Source changed during acceptance run";
  metadata.exitCode = 1;
}
writeJson(resolve(output, "run-metadata.json"), metadata);
process.exitCode = metadata.exitCode;
