import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticBundle, GuestCommand, ServiceLifecycle } from "../os/guest/contract.ts";
// @ts-expect-error Node tooling is executable ESM.
import { releaseGate, VmProfile, vmQualification } from "../tools/os/policy.mjs";
// @ts-expect-error Node tooling is executable ESM.
import { bootVm, createVmSession, imageIdentity } from "../tools/os/vm.mjs";

const directories: string[] = [];
const hash = (b: string) => createHash("sha256").update(b).digest("hex");
async function fixture() {
  await mkdir("reports/unit-os", { recursive: true });
  const directory = await mkdtemp(resolve("reports/unit-os/test-"));
  directories.push(directory);
  const image = resolve(directory, "image");
  await mkdir(image);
  await writeFile(resolve(image, "kernel"), "kernel");
  await writeFile(resolve(image, "rootfs.cpio.gz"), "rootfs");
  await writeFile(
    resolve(image, "manifest.json"),
    JSON.stringify({
      buildId: "a".repeat(64),
      profile: "p10-qemu-x86_64-v1",
      kernelSha256: hash("kernel"),
      initramfsSha256: hash("rootfs"),
    }),
  );
  return { directory, image };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("standalone guest service contract", () => {
  it("cannot declare playable before storage and engine readiness", () => {
    const s = new ServiceLifecycle();
    expect(() => s.uiReady(0)).toThrow();
    expect(() => s.engineReady(0)).toThrow();
    s.storageReady(1);
    s.engineReady(2);
    s.uiReady(3);
    s.stop(4);
    expect(s.events.map((e) => e.event)).toEqual([
      "storage-ready",
      "engine-ready",
      "ui-ready",
      "saves-flushed",
      "engine-stopped",
      "shutdown",
    ]);
  });
  it("stops UI restart loops and bounds error/trace memory", () => {
    const s = new ServiceLifecycle();
    s.storageReady(0);
    s.engineReady(1);
    for (let i = 0; i < 3; i++) expect(s.uiCrash(i + 2)).toBe(true);
    expect(s.uiCrash(5)).toBe(false);
    expect(s.recovery).toBe(true);
    expect(() => s.uiReady(6)).toThrow();
    for (let i = 0; i < 100; i++) {
      s.error("COMMAND_REJECTED");
      s.event("project-saved", i);
    }
    expect(s.events).toHaveLength(64);
    expect(s.errors).toHaveLength(32);
  });
  it("redacts hostile diagnostics and rejects unbounded commands", () => {
    const bundle = diagnosticBundle(
      { buildId: "a".repeat(64), profile: "p10-qemu-x86_64-v1", kernel: "6.18.60" },
      [{ event: "ui-crashed", at: 4 }],
      ["PRIVATE_AUDIO_BYTES", "token=secret", "COMMAND_REJECTED"],
    );
    expect(bundle.errors).toEqual(["COMMAND_REJECTED"]);
    expect(JSON.stringify(bundle)).not.toMatch(/PRIVATE_AUDIO_BYTES|token=secret/);
    expect(() =>
      diagnosticBundle({ buildId: "bad", profile: "unknown", kernel: "secret" }, [], []),
    ).toThrow();
    for (const input of [
      { op: "pad", pad: 16 },
      { op: "rename", name: "x".repeat(81) },
      { op: "export", path: "/dev/disk0" },
      { op: "load-code", code: "..." },
    ])
      expect(GuestCommand.safeParse(input).success).toBe(false);
  });
});
describe("VM safety and release gates", () => {
  it("rejects networking, shares, passthrough and physical qualification flags", async () => {
    const profile = JSON.parse(await readFile("os/profile.json", "utf8"));
    expect(VmProfile.parse(profile).sampleRate).toBe(48000);
    for (const key of [
      "network",
      "hostShares",
      "usbPassthrough",
      "labAgentEnabled",
      "mpcDriversQualified",
    ])
      expect(VmProfile.safeParse({ ...profile, [key]: true }).success).toBe(false);
    expect(() =>
      releaseGate([{ id: "Akai-app", license: "unknown", vendorPayload: true }], {
        publicImage: true,
      }),
    ).toThrow(/Akai-app/);
    expect(() =>
      releaseGate([{ id: "linux", license: "GPL-2.0-only" }], { publicImage: true }),
    ).toThrow(/source\/notices/);
    expect(() =>
      releaseGate(
        [
          {
            id: "linux",
            license: "GPL-2.0-only",
            redistribution: "reviewed",
            correspondingSourceSha256: "invalid",
          },
        ],
        { publicImage: true },
      ),
    ).toThrow(/source\/notices/);
    const q = vmQualification({ passed: true, buildId: "a".repeat(64), profile: profile.id });
    expect(q.genericVmSoftwarePassed).toBe(true);
    expect(q.phaseQualified).toBe(false);
    expect(q.requiredPhysicalEvidence).toHaveLength(5);
  });
  it("uses only owned regular file-backed disks and verifies candidate bytes", async () => {
    const f = await fixture();
    const disk = await createVmSession(resolve(f.directory, "session"), f.image);
    expect(Object.isFrozen(disk)).toBe(true);
    await expect(createVmSession("/dev/disk0", f.image)).rejects.toThrow(/Owned/);
    await expect(bootVm({ ...disk, disk: "/dev/disk0" })).rejects.toThrow(/owned VM/);
    await writeFile(resolve(f.image, "kernel"), "changed");
    await expect(imageIdentity(f.image)).rejects.toThrow(/hash mismatch/);
  });
  it("rejects symlink ledgers, data images and QEMU option injection", async () => {
    const f = await fixture();
    const directory = resolve(f.directory, "session");
    await mkdir(directory);
    const owner = resolve(f.directory, "external-owner.json");
    await writeFile(owner, "{}");
    await symlink(owner, resolve(directory, "owner.json"));
    await expect(createVmSession(directory, f.image)).rejects.toThrow(/owner ledger/);
    await expect(
      createVmSession(resolve(f.directory, "bad,file=/dev/disk0"), f.image),
    ).rejects.toThrow(/Unsafe/);
    await rm(resolve(directory, "owner.json"));
    await symlink(owner, resolve(directory, "data.raw"));
    await expect(createVmSession(directory, f.image)).rejects.toThrow();
    expect(await readFile(owner, "utf8")).toBe("{}");
  });
});
