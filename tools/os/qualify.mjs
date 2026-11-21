import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIdentity, root, sha256 } from "../../acceptance/lib/workspace.mjs";
import { checkWorkspace } from "../check-acceptance-plan.mjs";
import { vmQualification } from "./policy.mjs";
import { imageIdentity } from "./vm.mjs";

export async function qualify(directory) {
  if (!resolve(directory).startsWith(`${resolve(root, "reports/acceptance")}/`))
    throw new Error("Owned acceptance report required");
  const metadata = JSON.parse(readFileSync(resolve(directory, "run-metadata.json")));
  const image = await imageIdentity(resolve(root, "artifacts/os/p10"));
  const sourceHash = buildIdentity(),
    failures = [];
  if (
    metadata.exitCode !== 0 ||
    metadata.sourceHash !== sourceHash ||
    image.manifest.sourceHash !== sourceHash ||
    metadata.buildId !== image.manifest.buildId
  )
    failures.push("Failed, stale or mismatched candidate/run");
  const records = readdirSync(directory)
    .filter((p) => p.startsWith("case-"))
    .map((p) => JSON.parse(readFileSync(resolve(directory, p, "evidence.json"))));
  const required = checkWorkspace(root).scenarios.filter(
    (s) =>
      s.path === "features/10-standalone-os.feature" &&
      s.tags.includes("@implemented") &&
      (metadata.mode === "P10" || s.tags.includes(`@${metadata.mode}`)),
  );
  let boots = 0;
  for (const s of required) {
    const matches = records.filter((r) => r.scenarioId === `${s.path}:${s.name}`);
    if (matches.length !== 1) {
      failures.push(`Missing/duplicate evidence: ${s.name}`);
      continue;
    }
    const r = matches[0];
    if (r.outcome !== "passed" || r.sourceHash !== sourceHash || r.physicalDeviceOperations.length)
      failures.push(`Invalid scenario evidence: ${s.name}`);
    for (const b of r.booted) {
      boots++;
      if (
        b.buildId !== image.manifest.buildId ||
        b.profile !== image.manifest.profile ||
        b.hostShares ||
        b.controlListeners ||
        b.labAgentEnabled ||
        b.networkInterfaces.join() !== "lo"
      )
        failures.push(`Invalid boot profile: ${s.name}`);
    }
    for (const capture of r.captures) {
      if (
        !capture.audio.startsWith(`${resolve(directory)}/`) ||
        sha256(readFileSync(capture.audio)) !== capture.audioHash
      )
        failures.push(`Missing/corrupt audio: ${s.name}`);
      if (!capture.log.includes('XMPBOOT {"event":"storage-closed"}'))
        failures.push(`Unclean shutdown: ${s.name}`);
    }
  }
  if (!required.length) failures.push("No required cases");
  if (metadata.mode === "P10" && boots < 8) failures.push("Missing real guest journeys");
  const qualification = vmQualification({
    passed: !failures.length && metadata.mode === "P10",
    buildId: image.manifest.buildId,
    profile: image.manifest.profile,
  });
  const result = {
    ...qualification,
    checksPassed: !failures.length,
    sourceHash,
    mode: metadata.mode,
    boots,
    failures,
    scope:
      "P10 generic console OS development profile; host image-policy cases remain identified separately",
    reportDirectory: directory,
  };
  writeFileSync(resolve(directory, "qualification.json"), JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length > 2) throw new Error("Uses latest P10 run; no device flags");
  const latest = JSON.parse(readFileSync(resolve(root, "reports/acceptance/P10/latest.json")));
  const result = await qualify(latest.directory);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.checksPassed ? 0 : 1;
}
