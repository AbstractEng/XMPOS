import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, sha256, writeJson } from "../acceptance/lib/workspace.mjs";
import { analyzeLoopback } from "../packages/core/src/latency.ts";

const capture = resolve(root, "artifacts/loopback/capture.wav"),
  calibration = resolve(root, "artifacts/loopback/calibration.json");
const bytes = existsSync(capture) ? readFileSync(capture) : undefined;
const calibrationText = existsSync(calibration) ? readFileSync(calibration) : undefined;
let clock;
try {
  clock = calibrationText ? JSON.parse(calibrationText) : undefined;
} catch {}
const measured = analyzeLoopback(bytes, clock);
const result = {
  ...measured,
  captureHash: bytes ? sha256(bytes) : null,
  calibrationHash: calibrationText ? sha256(calibrationText) : null,
  qualification:
    "Physical fixture and calibration still require review; this analyzer cannot certify hardware provenance",
};
mkdirSync(resolve(root, "reports/loopback"), { recursive: true });
writeJson(resolve(root, "reports/loopback/measurement.json"), result);
console.log(
  JSON.stringify({
    outcome: result.outcome,
    p95Ms: result.p95Ms,
    physicalQualification: false,
    reason: result.reason,
  }),
);
process.exitCode = result.outcome === "measured" && result.thresholdPassed ? 0 : 2;
