import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { sha256, writeJson } from "./workspace.mjs";

const outcomes = new Set([
  "passed",
  "failed",
  "undefined",
  "pending",
  "skipped",
  "unsupported",
  "inconclusive",
  "ambiguous",
]);
export function latencyResult(capture) {
  if (
    capture?.calibrated !== true ||
    !Number.isFinite(capture.sampleRate) ||
    capture.sampleRate <= 0 ||
    !Number.isFinite(capture.frames) ||
    capture.frames < 0
  )
    return {
      outcome: "inconclusive",
      latencyMs: null,
      reason: "Missing capture or valid clock calibration",
    };
  return { outcome: "measured", latencyMs: (capture.frames / capture.sampleRate) * 1000 };
}
export function recordEvidence(directory, input, attachments = []) {
  if (!outcomes.has(input.outcome)) throw new Error("Unknown evidence outcome");
  const id = sha256(`${input.scenarioId}\0${input.profile}`).slice(0, 20);
  mkdirSync(resolve(directory, id), { recursive: true });
  const artifacts = attachments.map((item, index) => {
    if (!["log", "trace", "audio", "screenshot", "diff"].includes(item.kind))
      throw new Error("Unknown artifact kind");
    if (item.kind === "screenshot" && input.synthetic !== true && item.synthetic !== true)
      throw new Error("Real UI screenshots require a future trusted capture adapter");
    const path = `${id}/${index}.${{ audio: "wav", screenshot: "png" }[item.kind] ?? "json"}`;
    // Text artifacts have a strict public schema; arbitrary logs/projects/identifiers never enter reports.
    const body = ["log", "trace", "diff"].includes(item.kind)
      ? Buffer.from(
          JSON.stringify(
            (Array.isArray(item.data) ? item.data : [item.data]).map((entry) =>
              Object.fromEntries(
                ["event", "frame", "expectedFrame", "actualFrame", "deltaFrames", "outcome"]
                  .filter((key) => entry[key] !== undefined)
                  .map((key) => [key, entry[key]]),
              ),
            ),
          ),
        )
      : Buffer.from(item.data);
    writeFileSync(resolve(directory, path), body);
    return {
      kind: item.kind,
      path,
      sha256: sha256(body),
      synthetic: input.synthetic === true || item.synthetic === true,
    };
  });
  const record = {
    version: 1,
    scenarioId: input.scenarioId,
    profile: input.profile,
    buildHash: input.buildHash,
    fixtureHash: input.fixtureHash,
    outcome: input.outcome,
    synthetic: input.synthetic === true,
    interfaceVersion: 1,
    artifacts,
    deviceOperations: [],
    latency: input.latency ?? null,
  };
  writeJson(resolve(directory, `${id}.json`), record);
  return record;
}
export function evaluateGate({
  required,
  records,
  buildHash,
  fixtureHash,
  directory,
  allowSynthetic = false,
}) {
  const failures = [];
  for (const expected of required) {
    const label = `${expected.scenarioId} [${expected.profile}]`;
    const matches = records.filter(
      (record) => record.scenarioId === expected.scenarioId && record.profile === expected.profile,
    );
    if (matches.length !== 1) {
      failures.push(`${label}: missing or duplicate evidence`);
      continue;
    }
    const record = matches[0];
    if (record.outcome !== "passed") failures.push(`${label}: ${record.outcome}`);
    if (record.buildHash !== buildHash || record.fixtureHash !== fixtureHash)
      failures.push(`${label}: candidate/fixture mismatch`);
    if (record.synthetic && !allowSynthetic)
      failures.push(`${label}: synthetic evidence cannot qualify a real target`);
    if (["os-vm", "usb-lab"].includes(record.profile) && !record.synthetic)
      failures.push(`${label}: physical/boot attestation adapter unavailable`);
    if (!record.artifacts?.length) failures.push(`${label}: missing captures`);
    for (const item of record.artifacts ?? []) {
      const path = resolve(directory, item.path);
      if (!path.startsWith(`${resolve(directory)}${sep}`)) {
        failures.push(`${label}: artifact outside report`);
        continue;
      }
      try {
        if (sha256(readFileSync(path)) !== item.sha256) failures.push(`${label}: corrupt artifact`);
      } catch {
        failures.push(`${label}: absent artifact`);
      }
    }
    if (record.latency?.outcome === "inconclusive")
      failures.push(`${label}: inconclusive measurement`);
  }
  if (!required.length) failures.push("No required scenarios specified");
  return {
    complete: failures.length === 0,
    outcome: failures.length ? "blocked" : "passed",
    buildHash,
    fixtureHash,
    interfaceVersion: 1,
    failures,
    reports: records.map((record) => ({
      scenarioId: record.scenarioId,
      profile: record.profile,
      outcome: record.outcome,
    })),
  };
}
