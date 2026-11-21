import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPATIBILITY, MPC_RUNTIME } from "../tools/live-mk1/compatibility.mjs";
import { installPreflight } from "../tools/live-mk1/install-preflight.mjs";
import { renderCompatibility } from "../tools/live-mk1/render-compatibility.mjs";

const host = { platform: "darwin", arch: "x64", osVersion: "13.4.1", nodeMajor: 24 };
const example = JSON.parse(readFileSync("docs/install-preflight.example.json", "utf8"));
// Deliberately synthetic profile-matching observations: no physical evidence.
function synthetic() {
  return {
    ...structuredClone(example),
    identityMatchesPinnedLive: true,
    loaderHashIndependentlyVerified: true,
    rootfs: { filesystem: "ext4", capacityBytes: 512 * 1024 * 1024, loaderBytes: 453051392 },
    updater: { ...example.updater, signatureVerified: true },
    stick: { ...example.stick, freeBytes: 1024 * 1024 * 1024, partitionTableReviewed: true },
    powerAndDataCableReviewed: true,
    recoveryImageVerified: true,
    setupDoctorPassed: true,
    workspaceFreeBytes: 16 * 1024 ** 3,
  };
}
const codes = (facts: unknown, actualHost = host) =>
  installPreflight(facts, actualHost).stops.map((stop) => stop.code);

describe("R02 offline compatibility preflight", () => {
  it("matches the runtime lock and keeps release clearance false even for matching observations", () => {
    expect(COMPATIBILITY.baseline.updaterImageSha256).toBe(MPC_RUNTIME.updaterImageSha256);
    expect(COMPATIBILITY.baseline.rootfsSha256).toBe(MPC_RUNTIME.rootfsSha256);
    expect(
      COMPATIBILITY.models.filter((model) => model.ownerRehearsalTarget).map((model) => model.id),
    ).toEqual(["live-mk1"]);
    const result = installPreflight(synthetic(), host);
    expect(result.observationsSatisfyProfile).toBe(true);
    expect(result.publicInstallationAllowed).toBe(false);
    expect(result.compatibilitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.scope).toContain("not");
  });
  it("permits preparation for an owner-operated first install without pretending a unit is already pinned", () => {
    const facts = {
      ...synthetic(),
      identityMatchesPinnedLive: false,
      firstUseOwnerConfirmationPlanned: true,
    };
    expect(codes(facts)).not.toContain("pinned-identity");
    expect(installPreflight(facts, host).publicInstallationAllowed).toBe(false);
  });
  it.each(["one", "one-plus", "one-g2", "force", "unknown"])(
    "refuses %s even when supplied Live observations otherwise match",
    (model) => {
      expect(codes({ ...synthetic(), model })).toContain("model");
    },
  );
  it("gives Force exclusion priority even when mixed with an alleged Live identity", () => {
    const facts = synthetic();
    facts.devices.push({ board: "inmusic,ada2", soc: "rockchip,rk3288" });
    expect(codes(facts)).toEqual(expect.arrayContaining(["protected", "identity"]));
  });
  it.each(
    [
      [],
      [{ board: "inmusic,acva", soc: "rockchip,rk3288" }],
      [{ board: "inmusic,acva2", soc: "rockchip,rk3288" }],
      [{ board: "inmusic,acv8", soc: "rockchip,rk3288-c" }],
      [{ board: "inmusic,acv8", soc: "unknown" }],
      [
        { board: "inmusic,acv8", soc: "rockchip,rk3288" },
        { board: "inmusic,acv8", soc: "rockchip,rk3288" },
      ],
    ].map((devices) => ({ devices })),
  )("refuses missing, wrong, untested or ambiguous boards: $devices", ({ devices }) => {
    expect(codes({ ...synthetic(), devices })).toContain("identity");
  });
  it.each(["3.10.0", "3.10.2", "unknown"])("refuses unsupported firmware %s", (mpcOsVersion) => {
    expect(codes({ ...synthetic(), mpcOsVersion })).toContain("firmware");
  });
  it("requires known bootloader, independently verified loader and readable sufficient rootfs capacity", () => {
    for (const capacityBytes of [null, 0, 8192]) {
      expect(codes({ ...synthetic(), rootfs: { ...synthetic().rootfs, capacityBytes } })).toContain(
        "rootfs-capacity",
      );
    }
    expect(codes({ ...synthetic(), bootloader: null })).toContain("bootloader");
    expect(codes({ ...synthetic(), loaderHashIndependentlyVerified: false })).toContain(
      "loader-receipt",
    );
    expect(codes({ ...synthetic(), identityMatchesPinnedLive: false })).toContain(
      "pinned-identity",
    );
  });
  it("rejects wrong updater bytes and unverified signatures", () => {
    for (const updater of [
      { ...synthetic().updater, imageSha256: "0".repeat(64) },
      { ...synthetic().updater, rootfsSha256: "0".repeat(64) },
      { ...synthetic().updater, signatureVerified: false },
    ])
      expect(codes({ ...synthetic(), updater })).toContain("updater");
  });
  it("refuses unsupported storage, insufficient space and unknown preparation receipts", () => {
    for (const changed of [
      { filesystem: "exfat" },
      { label: "MPC" },
      { capacityBytes: 1000 },
      { freeBytes: 0 },
      { freeBytes: 9000000000 },
      { partitionTableReviewed: false },
    ])
      expect(codes({ ...synthetic(), stick: { ...synthetic().stick, ...changed } })).toContain(
        "stick",
      );
    expect(codes({ ...synthetic(), workspaceFreeBytes: 500 * 1024 ** 2 })).toContain("workspace");
    for (const field of [
      "powerAndDataCableReviewed",
      "recoveryImageVerified",
      "setupDoctorPassed",
    ]) {
      expect(codes({ ...synthetic(), [field]: false })).toContain("preparation");
    }
  });
  it("does not confuse SDK or cross-build support with installer host qualification", () => {
    for (const changed of [
      { arch: "arm64" },
      { platform: "linux" },
      { osVersion: "14.0" },
      { nodeMajor: 22 },
    ]) {
      expect(codes(synthetic(), { ...host, ...changed })).toContain("host");
    }
  });
  it("bounds inputs and refuses unknown fields rather than accepting arbitrary instructions", () => {
    for (const facts of [
      { ...synthetic(), command: "flash" },
      { ...synthetic(), model: "a".repeat(161) },
      { ...synthetic(), workspaceFreeBytes: -1 },
      { ...synthetic(), devices: Array(5).fill(synthetic().devices[0]) },
    ]) {
      expect(() => installPreflight(facts, host)).toThrow();
    }
    expect(codes(example)).toEqual(
      expect.arrayContaining(["rootfs-capacity", "loader-receipt", "stick", "workspace"]),
    );
  });
  it("CLI refuses oversized, symlinked and incomplete records without a hardware route", () => {
    const at = mkdtempSync(join(tmpdir(), "xmp-offline-preflight-"));
    const run = (path: string) =>
      spawnSync(process.execPath, ["tools/live-mk1/install-preflight.mjs", path], {
        encoding: "utf8",
        timeout: 5000,
      });
    try {
      const path = join(at, "facts.json");
      writeFileSync(path, " ".repeat(16385));
      expect(run(path).stderr).toContain("16 KiB");
      writeFileSync(path, "{}");
      expect(run(path).status).toBe(1);
      symlinkSync(path, join(at, "link.json"));
      expect(run(join(at, "link.json")).stderr).toContain("regular JSON file");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
  it("keeps README, manual, product fragment and release-notes draft identical to the canonical model matrix", () => {
    expect(() => renderCompatibility(true)).not.toThrow();
  });
});
