import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  developmentGraph,
  operations,
  startEngineHost,
} from "../../acceptance/lib/engine-target.mjs";
import { buildIdentity, root, scenarioWorkspace, sha256 } from "../../acceptance/lib/workspace.mjs";

export const soakProfile = Object.freeze({
  id: "p12-host-sampler-soak-v1",
  developmentSeconds: 60,
  maximumSeconds: 28800,
  sampleRate: 48000,
  blockFrames: 256,
  voices: 32,
  captureFrames: 96000,
  rssGrowthMiB: 32,
  callbackDeadlineFraction: 0.8,
  fullV1Workload: false,
  physicalAudio: false,
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function rss(pid) {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 3000,
  });
  const value = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(value) || value <= 0)
    throw new Error("Native RSS measurement unavailable");
  return value / 1024;
}
function saveSnapshot(workspace, text) {
  const path = workspace.path("soak-project.json"),
    temp = workspace.path("soak-project.pending");
  writeFileSync(temp, text, { mode: 0o600 });
  const fd = openSync(temp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(temp, path);
  const dir = openSync(workspace.directory, "r");
  fsyncSync(dir);
  closeSync(dir);
  if (sha256(readFileSync(path)) !== sha256(text))
    throw new Error("Soak save changed project identity");
}
export function soakMeasurementsComplete(report) {
  const n = report?.native,
    count = (v) => Number.isSafeInteger(v) && v >= 0;
  return (
    report?.profile === soakProfile.id &&
    count(report.requestedSeconds) &&
    report.requestedSeconds >= 1 &&
    report.requestedSeconds <= 28800 &&
    Number.isFinite(report.elapsedSeconds) &&
    report.elapsedSeconds >= report.requestedSeconds &&
    n?.boundedMetrics === true &&
    n.callbackP99IsUpperBound === true &&
    [
      "frames",
      "callbacks",
      "overruns",
      "callbackP99Ns",
      "callbackMaxNs",
      "auditFaults",
      "traceDrops",
      "queueDrops",
      "captureFrames",
      "on",
      "off",
    ].every((key) => count(n[key])) &&
    n.frames === report.requestedSeconds * 48000 &&
    n.captureFrames === Math.min(n.frames, 96000) &&
    Number.isFinite(report.rssGrowthMiB) &&
    report.rssGrowthMiB >= 0 &&
    count(report.saveChecks) &&
    report.saveChecks > 0 &&
    count(report.controlsApplied) &&
    report.controlsApplied > 0
  );
}
export function evaluateSoak(report) {
  const failures = [];
  if (!soakMeasurementsComplete(report)) failures.push("Incomplete measured soak evidence");
  if (
    report?.profile !== soakProfile.id ||
    !Number.isInteger(report.requestedSeconds) ||
    report.requestedSeconds < 1 ||
    report.requestedSeconds > soakProfile.maximumSeconds
  )
    failures.push("Unknown soak profile/duration");
  const native = report?.native;
  if (
    !native ||
    native.frames !== report.requestedSeconds * 48000 ||
    report.elapsedSeconds < report.requestedSeconds ||
    native.boundedMetrics !== true ||
    native.captureFrames > 96000 ||
    !native.callbackP99IsUpperBound
  )
    failures.push("Missing complete bounded wall-clock run");
  if (
    native &&
    (native.auditFaults ||
      native.overruns ||
      native.traceDrops ||
      native.queueDrops ||
      native.callbackP99Ns > (256 / 48000) * 1e9 * 0.8)
  )
    failures.push("Callback/event safety limit failed");
  if (
    !Number.isFinite(report?.rssGrowthMiB) ||
    report.rssGrowthMiB > 32 ||
    !report.saveChecks ||
    !report.controlsApplied
  )
    failures.push("Missing memory, edit or save evidence");
  return {
    measurementsComplete: soakMeasurementsComplete(report),
    developmentChecksPassed: !failures.length && report.requestedSeconds >= 60,
    failures,
    completedRequestedRun: !failures.length,
    samplerEightHourRunComplete: !failures.length && report.requestedSeconds === 28800,
    fullV1EightHourQualified: false,
    hardwareQualified: false,
    formalLoopbackQualified: false,
  };
}
export async function runSoak(workspace, seconds = 60) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 28800)
    throw new Error("Virtual sampler duration must be 1..28800 seconds");
  const graph = developmentGraph(),
    sourceHash = buildIdentity(),
    started = process.hrtime.bigint();
  const host = await startEngineHost(workspace, { graph, seconds, boundedMetrics: true });
  const warmupSeconds = seconds >= 1800 ? 900 : Math.min(10, seconds / 3);
  let minRss = Infinity,
    maxRss = 0,
    samples = 0,
    saves = 0,
    controls = 0,
    lastWork = -10;
  const observations = [];
  try {
    const start = await host.client.request(operations.start);
    if (start.status !== 5) throw new Error("Soak start rejected");
    while (host.child.exitCode === null && host.child.signalCode === null) {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      if (elapsed - lastWork >= 10 && elapsed < seconds - 2) {
        let state;
        try {
          state = await host.client.snapshot();
        } catch (error) {
          if (host.child.exitCode !== null) break;
          throw error;
        }
        const memory = rss(host.child.pid);
        samples++;
        if (elapsed >= warmupSeconds) {
          minRss = Math.min(minRss, memory);
          maxRss = Math.max(maxRss, memory);
        }
        observations.push({ elapsedSeconds: elapsed, frame: state.frame, rssMiB: memory });
        if (observations.length > 64) observations.shift();
        // Reserve a full bar for host sampling/IPC; a snapshot can be just before a boundary.
        const target = (Math.floor(state.tick / 3840) + 2) * 3840;
        const tempo = await host.client.request(operations.tempo, {
          timestamp: target,
          value: controls % 2 ? 120 : 118,
        });
        if (tempo.status !== 5)
          throw new Error(
            `Scheduled soak control rejected: status=${tempo.status}, snapshotTick=${state.tick}, target=${target}`,
          );
        controls++;
        const applied = await host.client.snapshot();
        saveSnapshot(
          workspace,
          JSON.stringify({
            format: "xmp-soak-checkpoint",
            version: 1,
            projectHash: graph.projectHash,
            project: JSON.parse(graph.projectDocument),
            transport: {
              frame: applied.frame,
              tick: applied.tick,
              bpm: applied.bpm,
              revision: applied.revision,
            },
          }),
        );
        saves++;
        lastWork = elapsed;
      }
      await pause(100);
    }
    const native = await host.finish(),
      elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const capture = readFileSync(workspace.path("engine-capture.wav"));
    const report = {
      profile: soakProfile.id,
      sourceHash,
      nativeBinaryHash: host.identity.nativeBinaryHash,
      fixtureHash: graph.projectHash,
      requestedSeconds: seconds,
      elapsedSeconds,
      warmupSeconds,
      native,
      rssSamples: samples,
      rssGrowthMiB: minRss === Infinity ? null : Math.max(0, maxRss - minRss),
      controlsApplied: controls,
      saveChecks: saves,
      checkpointHash: sha256(readFileSync(workspace.path("soak-project.json"))),
      observations,
      captureHash: sha256(capture),
      virtualAudioOnly: true,
      fullV1Workload: false,
    };
    return { report, evaluation: evaluateSoak(report), capture };
  } finally {
    await host.finish();
  }
}
export async function overloadProbe(workspace) {
  const host = await startEngineHost(workspace, {
    graph: developmentGraph(),
    seconds: 10,
    boundedMetrics: true,
  });
  try {
    await host.client.request(operations.start);
    for (let id = 1000; id < 1064; id++)
      await host.client.request(operations.noteOn, { a: id, b: 0, value: 1 });
    const overloaded = await host.client.snapshot();
    const stopped = await host.client.request(operations.stop);
    const document = JSON.stringify(await host.client.project(stopped));
    saveSnapshot(workspace, document);
    if (
      !overloaded.refused ||
      stopped.status !== 5 ||
      stopped.running ||
      stopped.projectHash !== host.graph.projectHash
    )
      throw new Error("Bounded overload did not preserve transport/project state");
    return {
      refused: overloaded.refused,
      stopped: !stopped.running,
      projectHash: stopped.projectHash,
      savedHash: sha256(readFileSync(workspace.path("soak-project.json"))),
      physicalAudioQualified: false,
    };
  } finally {
    await host.finish();
  }
}
if (process.argv[1] === import.meta.filename) {
  const seconds =
    process.argv.length === 2
      ? 60
      : process.argv.length === 4 && process.argv[2] === "--seconds"
        ? Number(process.argv[3])
        : NaN;
  const workspace = scenarioWorkspace();
  try {
    const result = await runSoak(workspace, seconds);
    const directory = resolve(root, "reports/release-soak");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, "report.json"),
      JSON.stringify({ ...result.report, evaluation: result.evaluation }, null, 2),
    );
    copyFileSync(workspace.path("engine-capture.wav"), resolve(directory, "capture.wav"));
    console.log(JSON.stringify(result.evaluation, null, 2));
    process.exitCode = result.evaluation.completedRequestedRun ? 0 : 1;
  } finally {
    workspace.close();
  }
}
