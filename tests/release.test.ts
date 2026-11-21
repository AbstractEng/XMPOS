import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Test workspace hashing is executable Node ESM.
import { sha256 } from "../acceptance/lib/workspace.mjs";
// @ts-expect-error Release tooling is executable Node ESM.
import * as capsule from "../tools/release/capsule.mjs";
// @ts-expect-error Release tooling is executable Node ESM.
import { evaluateSoak } from "../tools/release/soak.mjs";
// @ts-expect-error Release tooling is executable Node ESM.
import { VmUpdateStore } from "../tools/release/update.mjs";

const { sealImage, signManifest, verifyCapsule, verifyEnvelope } = capsule;
const directories: string[] = [];
afterEach(async () => {
  for (const p of directories.splice(0)) await rm(p, { recursive: true, force: true });
});
async function fixture() {
  await mkdir("reports/unit-release", { recursive: true });
  const directory = await mkdtemp(resolve("reports/unit-release/test-"));
  directories.push(directory);
  const image = resolve(directory, "image");
  await mkdir(image);
  const manifest = {
    buildId: "a".repeat(64),
    sourceHash: "b".repeat(64),
    profile: "p10-qemu-x86_64-v1",
    kernelSha256: sha256("kernel"),
    initramfsSha256: sha256("rootfs"),
  };
  for (const [name, text] of Object.entries({
    "manifest.json": JSON.stringify(manifest),
    kernel: "kernel",
    "rootfs.cpio.gz": "rootfs",
    "sources.json": "{}",
    "sbom.json": "[]",
    "THIRD-PARTY-NOTICES.txt": "Development notice fixture",
  }))
    await writeFile(resolve(image, name), text);
  const keys = generateKeyPairSync("ed25519"),
    envelope = await sealImage(image, 2, keys.privateKey);
  return { directory, image, keys, envelope };
}
describe("signed VM development releases", () => {
  it("binds every component and its target/dependencies to a pinned signer", async () => {
    const f = await fixture();
    expect((await verifyCapsule(f.image, f.envelope, f.keys.publicKey)).manifest.sequence).toBe(2);
    const other = generateKeyPairSync("ed25519");
    expect(() => verifyEnvelope(f.envelope, other.publicKey)).toThrow(/signature/);
    const tampered = structuredClone(f.envelope);
    tampered.manifest.sequence = 3;
    expect(() => verifyEnvelope(tampered, f.keys.publicKey)).toThrow(/signature/);
    await writeFile(resolve(f.image, "rootfs.cpio.gz"), "corrupt");
    await expect(verifyCapsule(f.image, f.envelope, f.keys.publicKey)).rejects.toThrow(/Corrupted/);
  });
  it("rejects validly signed wrong-target, dependency and downgrade requests before store writes", async () => {
    const f = await fixture(),
      output = resolve(f.directory, "update-store"),
      store = new VmUpdateStore(output, f.keys.publicKey);
    for (const manifest of [
      { ...f.envelope.manifest, target: "fixture-unsupported-board" },
      { ...f.envelope.manifest, compatibility: { project: 99, sdk: 2, dsp: 1 } },
    ]) {
      await expect(
        store.attempt(f.image, signManifest(manifest, f.keys.privateKey)),
      ).rejects.toThrow(/Wrong VM|Incompatible/);
      expect(existsSync(output)).toBe(false);
    }
    expect(() => verifyEnvelope(f.envelope, f.keys.publicKey, 2)).toThrow(/Stale/);
    expect(() => new VmUpdateStore("/dev/disk0", f.keys.publicKey)).toThrow(/owned/);
  });
  it("rejects missing/duplicate notices and file substitution", async () => {
    const f = await fixture(),
      body = structuredClone(f.envelope.manifest);
    body.files[1] = body.files[0];
    expect(() => signManifest(body, f.keys.privateKey)).toThrow(/duplicate/);
    await writeFile(resolve(f.image, "THIRD-PARTY-NOTICES.txt"), "changed notices");
    await expect(verifyCapsule(f.image, f.envelope, f.keys.publicKey)).rejects.toThrow(/Corrupted/);
    expect(await readFile(resolve(f.image, "kernel"), "utf8")).toBe("kernel");
  });
});
describe("soak evidence refuses unsupported duration claims", () => {
  it("cannot turn a short sampler run into an eight-hour V1 or hardware pass", () => {
    const report = {
      profile: "p12-host-sampler-soak-v1",
      requestedSeconds: 60,
      elapsedSeconds: 60.1,
      native: {
        frames: 2880000,
        callbacks: 11250,
        callbackMaxNs: 100000,
        on: 960,
        off: 960,
        boundedMetrics: true,
        captureFrames: 96000,
        callbackP99IsUpperBound: true,
        auditFaults: 0,
        overruns: 0,
        traceDrops: 0,
        queueDrops: 0,
        callbackP99Ns: 100000,
      },
      rssGrowthMiB: 1,
      saveChecks: 6,
      controlsApplied: 6,
    };
    expect(evaluateSoak(report)).toMatchObject({
      developmentChecksPassed: true,
      fullV1EightHourQualified: false,
      samplerEightHourRunComplete: false,
      hardwareQualified: false,
    });
    expect(evaluateSoak({ ...report, native: { ...report.native, overruns: 2 } })).toMatchObject({
      measurementsComplete: true,
      developmentChecksPassed: false,
      hardwareQualified: false,
    });
    expect(evaluateSoak({ ...report, requestedSeconds: 28800 }).completedRequestedRun).toBe(false);
    expect(evaluateSoak({ ...report, elapsedSeconds: 1 }).completedRequestedRun).toBe(false);
    expect(evaluateSoak({ ...report, rssGrowthMiB: null }).developmentChecksPassed).toBe(false);
  });
});
