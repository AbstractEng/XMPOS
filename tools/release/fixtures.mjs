import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha } from "./capsule.mjs";
export function capsulePolicyFixture(directory, sourceHash) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    format: "xmp-os-image",
    version: 1,
    buildId: sha("never-booted capsule policy fixture"),
    sourceHash,
    profile: "p10-qemu-x86_64-v1",
    kernelSha256: sha("original policy fixture kernel bytes"),
    initramfsSha256: sha("original policy fixture rootfs bytes"),
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    kernel: "original policy fixture kernel bytes",
    "rootfs.cpio.gz": "original policy fixture rootfs bytes",
    "sources.json": "{}",
    "sbom.json": "[]",
    "THIRD-PARTY-NOTICES.txt": "Original policy fixture; no bootable image or vendor payload",
  };
  for (const [name, text] of Object.entries(files))
    writeFileSync(resolve(directory, name), text, { flag: "wx", mode: 0o600 });
  return manifest;
}
export function releaseEvidenceFixture(sourceHash, imageBuildId) {
  return {
    sourceHash,
    imageBuildId,
    observedSoakOverruns: 0,
    evidence: ["host-contract", "os-vm", "reliability-vm", "sampler-soak"].map((kind) => ({
      kind,
      sourceHash,
      imageBuildId: kind.endsWith("vm") ? imageBuildId : null,
      evidenceHash: sha(`explicit synthetic policy receipt ${kind}`),
      checksPassed: true,
    })),
  };
}
export function soakPolicyFixture() {
  return {
    profile: "p12-host-sampler-soak-v1",
    requestedSeconds: 60,
    elapsedSeconds: 60.1,
    native: {
      frames: 2880000,
      callbacks: 11250,
      boundedMetrics: true,
      captureFrames: 96000,
      callbackP99IsUpperBound: true,
      callbackP99Ns: 100000,
      callbackMaxNs: 120000,
      auditFaults: 0,
      overruns: 0,
      traceDrops: 0,
      queueDrops: 0,
      on: 960,
      off: 960,
    },
    rssGrowthMiB: 1,
    controlsApplied: 6,
    saveChecks: 6,
  };
}
