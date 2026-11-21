import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIdentity, root, sha256 } from "../../acceptance/lib/workspace.mjs";
import { checkWorkspace } from "../check-acceptance-plan.mjs";
import { imageIdentity } from "../os/vm.mjs";
export async function qualifyReleaseVm(directory) {
  if (!resolve(directory).startsWith(`${resolve(root, "reports/acceptance")}/`))
    throw new Error("Owned release VM evidence required");
  const meta = JSON.parse(readFileSync(resolve(directory, "run-metadata.json"))),
    sourceHash = buildIdentity(),
    failures = [];
  const base = await imageIdentity(resolve(root, "artifacts/os/p10")),
    candidate = await imageIdentity(resolve(root, "artifacts/os/update-candidate"));
  if (
    meta.exitCode !== 0 ||
    meta.sourceHash !== sourceHash ||
    base.manifest.sourceHash !== sourceHash ||
    candidate.manifest.sourceHash !== sourceHash ||
    meta.buildId !== base.manifest.buildId ||
    meta.candidateBuildId !== candidate.manifest.buildId
  )
    failures.push("Failed/stale/mismatched VM candidate or run");
  if (!/^P12(?:_[23])?$/.test(meta.mode)) failures.push("Unsupported VM selector");
  const required = checkWorkspace(root).scenarios.filter(
    (s) =>
      s.path === "features/12-release.feature" &&
      s.tags.includes("@implemented") &&
      s.tags.includes("@p12_vm") &&
      s.tags.includes(`@${meta.mode}`),
  );
  const records = readdirSync(directory)
    .filter((p) => p.startsWith("case-"))
    .map((p) => JSON.parse(readFileSync(resolve(directory, p, "evidence.json"))));
  let boots = 0,
    powerCuts = 0;
  for (const s of required) {
    const matches = records.filter((r) => r.scenarioId === `${s.path}:${s.name}`);
    if (matches.length !== 1) {
      failures.push(`Missing/duplicate case: ${s.name}`);
      continue;
    }
    const r = matches[0];
    if (
      r.outcome !== "passed" ||
      r.sourceHash !== sourceHash ||
      r.physicalDeviceOperations.length ||
      !r.boots.length ||
      r.captures.length !== r.boots.length
    )
      failures.push(`Invalid guest evidence: ${s.name}`);
    for (const b of r.boots) {
      boots++;
      if (
        ![meta.buildId, meta.candidateBuildId].includes(b.buildId) ||
        b.profile !== "p10-qemu-x86_64-v1" ||
        b.networkInterfaces.join() !== "lo" ||
        b.hostShares ||
        b.controlListeners ||
        b.labAgentEnabled
      )
        failures.push(`Unexpected guest profile: ${s.name}`);
    }
    for (const capture of r.captures) {
      if (
        !capture.audio.startsWith(`${resolve(directory)}/`) ||
        sha256(readFileSync(capture.audio)) !== capture.sha256
      )
        failures.push(`Corrupt capture: ${s.name}`);
      if (capture.fault) {
        powerCuts++;
        if (capture.signal !== "SIGKILL" || !r.checks?.checkpoint?.point)
          failures.push(`Missing named power-cut receipt: ${s.name}`);
      } else if (capture.code !== 0 || !capture.log.includes('XMPBOOT {"event":"storage-closed"}'))
        failures.push(`Unclean nonfault shutdown: ${s.name}`);
    }
  }
  if (!required.length) failures.push("No required release VM cases");
  const report = {
    format: "xmp-p12-vm-qualification",
    sourceHash,
    buildId: meta.buildId,
    candidateBuildId: meta.candidateBuildId,
    checksPassed: !failures.length,
    boots,
    powerCuts,
    failures,
    hardwareQualified: false,
    fullPhaseQualified: false,
    publicRedistributionApproved: false,
    pending: [
      "Live Mk1 physical qualification and approved update layout",
      "eight-hour final V1 workload",
      "graphical/native parity and public redistribution review",
    ],
  };
  writeFileSync(resolve(directory, "qualification.json"), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] === import.meta.filename) {
  const latest = JSON.parse(readFileSync(resolve(root, "reports/acceptance/P12-vm/latest.json")));
  const report = await qualifyReleaseVm(latest.directory);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.checksPassed ? 0 : 1;
}
