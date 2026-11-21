import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildIdentity, root } from "../acceptance/lib/workspace.mjs";

// Runs the GitHub Actions jobs on this machine. The workflow file stays the
// single source of truth: every "npm run <script>" step of each job runs in
// order; machine setup (npm ci, apt-get, pip, browser installs) is skipped
// because a development Mac already has it.
// Usage: npm run ci:local [-- job-name ...]

export function workflowJobs(text) {
  const body = text.split(/\njobs:\n/)[1];
  if (!body) throw new Error("Workflow has no jobs section");
  const jobs = {};
  for (const block of body.split(/\n(?= {2}[a-z0-9-]+:\n)/)) {
    const name = /^ {2}([a-z0-9-]+):/.exec(block)?.[1];
    if (!name) continue;
    jobs[name] = [...block.matchAll(/- run: npm run ([a-z0-9:._-]+)\s*$/gm)].map((m) => m[1]);
  }
  return jobs;
}

if (process.argv[1] === import.meta.filename) {
  const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");
  const jobs = workflowJobs(workflow);
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const selected = process.argv.slice(2);
  for (const name of selected)
    if (!jobs[name]) throw new Error(`Unknown job ${name}; jobs: ${Object.keys(jobs).join(", ")}`);
  const names = selected.length ? selected : Object.keys(jobs);
  for (const name of names)
    for (const script of jobs[name])
      if (!scripts[script]) throw new Error(`Job ${name} runs missing script ${script}`);
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim() || null;
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const directory = join(root, "reports/ci-local", runId);
  mkdirSync(directory, { recursive: true });
  const sourceHash = buildIdentity();
  const summary = {
    kind: "xmp-local-ci",
    commit: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    sourceHash,
    startedAt: new Date().toISOString(),
    jobs: {},
  };
  for (const name of names) {
    const job = { result: "passed", steps: [] };
    summary.jobs[name] = job;
    for (const script of jobs[name]) {
      console.log(`\n=== ${name}: npm run ${script}`);
      const started = Date.now();
      const log = join(directory, `${name}--${script.replaceAll(":", "_")}.log`);
      const run = spawnSync("npm", ["run", script], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 7200000,
      });
      writeFileSync(log, `${run.stdout ?? ""}${run.stderr ?? ""}`);
      const step = {
        script,
        exit: run.status ?? 1,
        seconds: Math.round((Date.now() - started) / 1000),
        log: relative(root, log),
      };
      job.steps.push(step);
      console.log(`    exit ${step.exit} in ${step.seconds}s`);
      if (step.exit !== 0) {
        job.result = "failed";
        break;
      }
    }
  }
  summary.finishedAt = new Date().toISOString();
  summary.sourceUnchanged = buildIdentity() === sourceHash;
  summary.passed =
    summary.sourceUnchanged && Object.values(summary.jobs).every((j) => j.result === "passed");
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nLocal CI on ${summary.branch} @ ${summary.commit?.slice(0, 7)}`);
  for (const [name, job] of Object.entries(summary.jobs))
    console.log(`  ${job.result.padEnd(6)} ${name}`);
  if (!summary.sourceUnchanged)
    console.log("  Source changed during the run; results are not valid.");
  console.log(`Report: ${relative(root, join(directory, "summary.json"))}`);
  process.exitCode = summary.passed ? 0 : 1;
}
