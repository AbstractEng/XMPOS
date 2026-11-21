import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  auditMvp,
  loadMvp,
  MVP_TIERS,
  mvpSourceHashes,
  summarizeMvp,
} from "../acceptance/lib/mvp.mjs";
import { buildIdentity, json, root, writeJson } from "../acceptance/lib/workspace.mjs";
import { preflightTarget } from "../acceptance/target-policy.mjs";

// Usage: npm run mvp:verify [-- --tier core|browser|vm|all]
// Runs the existing host, browser and VM gates. Never selects a physical target.
const args = process.argv.slice(2);
const tierIndex = args.indexOf("--tier");
const tier = tierIndex === -1 ? "all" : args[tierIndex + 1];
if (![...MVP_TIERS, "all"].includes(tier) || args.length !== (tierIndex === -1 ? 0 : 2))
  throw new Error("Usage: npm run mvp:verify [-- --tier core|browser|vm|all]; no target flags");
preflightTarget({ profile: "standalone" });

const mvp = loadMvp();
const problems = auditMvp(mvp, json(resolve(root, "package.json")).scripts);
if (problems.length) {
  console.error(`MVP traceability failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
const selected = tier === "all" ? MVP_TIERS : MVP_TIERS.slice(0, MVP_TIERS.indexOf(tier) + 1);
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const directory = resolve(root, "reports/mvp", runId);
mkdirSync(directory, { recursive: true });
const sourceHash = buildIdentity();
const results = {};
const timings = {};
for (const [name, gate] of Object.entries(mvp.gates)) {
  if (!selected.includes(gate.tier)) continue;
  console.log(`\n=== MVP gate ${name}: ${gate.command.join(" ")}`);
  const started = Date.now();
  const run = spawnSync(gate.command[0], gate.command.slice(1), {
    cwd: root,
    stdio: "inherit",
    timeout: 1800000,
  });
  timings[name] = Math.round((Date.now() - started) / 1000);
  results[name] = run.status === 0 ? "passed" : "failed";
}
const summary = summarizeMvp(mvp, results);
const sourceUnchanged = buildIdentity() === sourceHash;
const report = {
  kind: "xmp-mvp-verification",
  mvp: mvp.id,
  tiers: selected,
  sourceHash,
  sourceUnchanged,
  sources: mvpSourceHashes(mvp),
  word: mvp.sources.externalSpecification,
  hardwareQualification: false,
  physicalAdapter: "absent",
  gates: Object.fromEntries(
    Object.keys(mvp.gates).map((name) => [
      name,
      { result: results[name] ?? "not-run", seconds: timings[name] ?? null },
    ]),
  ),
  ...summary,
  validated: summary.validated && sourceUnchanged,
};
writeJson(resolve(directory, "summary.json"), report);
writeJson(resolve(root, "reports/mvp/latest.json"), { directory: relative(root, directory) });

console.log(`\nXMP MVP (${mvp.id}) — tiers: ${selected.join(", ")}`);
for (const requirement of report.requirements)
  console.log(`  ${requirement.status.padEnd(9)} ${requirement.id} ${requirement.title}`);
console.log(
  report.validated
    ? "MVP validated on this source build (software only; no hardware qualification)."
    : report.failed
      ? "MVP gate failure: see the gate output above."
      : "Partial run: requirements marked not-run need the remaining tiers.",
);
console.log(`Report: ${relative(root, resolve(directory, "summary.json"))}`);
process.exitCode = report.failed || !sourceUnchanged ? 1 : 0;
