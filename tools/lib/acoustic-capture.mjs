import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, sha256 } from "../../acceptance/lib/workspace.mjs";
import {
  analyzeAcoustic,
  decodeAcousticWav,
  preflightAcoustic,
} from "../../packages/core/src/acoustic.ts";
export function collectAcousticCapture(
  directory,
  inventory,
  invoke = (args) =>
    spawnSync(resolve(root, "build/native/xmp_acoustic_capture"), args, {
      encoding: "utf8",
      timeout: 65000,
      maxBuffer: 1024 * 1024,
    }),
) {
  // Permission requesting happens in the native helper, before it prepares/starts either stream.
  preflightAcoustic(inventory, {
    platform: process.platform,
    ci: Boolean(process.env.CI) || process.env.GITHUB_ACTIONS === "true",
    capture: false,
  });
  const child = invoke(["--capture", directory]);
  const reportPath = resolve(directory, "device-capture.json");
  let capture;
  try {
    capture = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    capture = {
      outcome: "inconclusive",
      reason: "Capture helper produced no complete device report",
    };
  }
  if (child.status !== 0 || child.error)
    return {
      ...unqualified(capture),
      outcome: "inconclusive",
      reason: capture.reason ?? "Capture helper failed or timed out",
    };
  const path = resolve(directory, "capture.wav");
  return assessAcousticCapture(
    inventory,
    capture,
    existsSync(path) ? readFileSync(path) : undefined,
  );
}
function unqualified(capture) {
  return {
    physicalAudioQualified: false,
    formalLoopbackQualified: false,
    latencyMs: null,
    jitterMs: null,
    capture,
  };
}
// Pure evidence validation: usable in CI with explicitly synthetic fixtures, never opens streams.
export function assessAcousticCapture(inventory, capture, bytes) {
  const base = unqualified(capture);
  if (capture?.outcome !== "captured")
    return { ...base, outcome: "inconclusive", reason: capture?.reason ?? "No complete capture" };
  try {
    preflightAcoustic(capture, { platform: "darwin", ci: false, capture: true });
    for (const role of ["input", "output"])
      if (
        capture[role].uid !== inventory[role].uid ||
        capture[role].id !== inventory[role].id ||
        capture[role].sampleRate !== inventory[role].sampleRate
      )
        throw new Error("Selected built-in identity changed");
    if (
      capture.streamsStopped !== true ||
      capture.callbackErrors !== 0 ||
      capture.timestampDiscontinuities !== 0 ||
      capture.protectedDeviceOperations !== 0 ||
      capture.inputStreamsStarted !== 1 ||
      capture.outputStreamsStarted !== 1
    )
      throw new Error("Device callback/cleanup evidence incomplete");
    if (!bytes) throw new Error("Microphone WAV missing");
    const decoded = decodeAcousticWav(bytes);
    if (
      decoded.sampleRate !== capture.input.sampleRate ||
      decoded.samples.length !== capture.inputFrames
    )
      throw new Error("Capture metadata does not match WAV");
    return {
      ...analyzeAcoustic(decoded.samples, decoded.sampleRate),
      capture,
      captureHash: sha256(bytes),
    };
  } catch (error) {
    return { ...base, outcome: "inconclusive", reason: error.message };
  }
}
