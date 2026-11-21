import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFlash } from "../tools/live-mk1/flash.mjs";
import { parseRootfsObservation } from "../tools/live-mk1/hardware-observation.mjs";

const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const serial = "TEST-LIVE-ONLY";
const report = (unit = serial) =>
  `===== compatible (board revision)\ninmusic,acv8 inmusic,az01 rockchip,rk3288 \n\n===== product code\nACV8 \n\n===== cpuinfo\nSerial\\t\\t: ${unit}\n\n===== block devices\nmajor minor #blocks name\n179 0 7636800 mmcblk0\n179 6 512000 mmcblk0p6\n\n===== mounts\n/dev/root / ext4 ro,relatime 0 0\n\n===== dmesg\nVFS: Mounted root (ext4 filesystem) readonly on device 179:6.\n`;
let state: string;
let folder: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "xmp-legacy-live-state-"));
  folder = mkdtempSync(join(tmpdir(), "xmp-legacy-live-image-"));
  writeFileSync(join(folder, "rootfs.ext4"), "synthetic test image");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      format: "xmp-live-mk1-probe-image",
      output: { file: "rootfs.ext4", sha256: hash("synthetic test image") },
    }),
  );
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});
function observation(text = report()) {
  writeFileSync(join(state, "unit-report.txt"), text);
  writeFileSync(
    join(state, "hardware-observation.json"),
    JSON.stringify({
      format: "xmp-live-mk1-hardware-observation",
      version: 1,
      bootloader: "0.4",
      report: { file: "unit-report.txt", sha256: hash(text) },
    }),
  );
}
function legacy({
  unit = serial,
  genericFailure = false,
  contradictory = false,
  product,
  bootloader = "0.4",
}: {
  unit?: string;
  genericFailure?: boolean;
  contradictory?: boolean;
  product?: string;
  bootloader?: string;
} = {}) {
  const calls: string[][] = [];
  const fastboot = (args: string[]) => {
    calls.push(args);
    if (args[0] === "devices") return { status: 0, output: `${unit}\t fastboot\n` };
    if (args[0] !== "getvar") return { status: 0, output: "OKAY" };
    if (args[1] === "version-bootloader")
      return { status: 0, output: `version-bootloader: ${bootloader}\nFinished.` };
    if (args[1] === "partition-type:rootfs")
      return { status: 0, output: "partition-type:rootfs: ext4\nFinished." };
    if (args[1] === "product" && product)
      return { status: 0, output: `product: ${product}\nFinished.` };
    return {
      status: genericFailure ? 1 : 0,
      output: genericFailure
        ? "USB transport error"
        : `${contradictory ? `${args[1]}: conflicting-value\n` : ""}getvar:${args[1]} FAILED (remote: 'Variable not implemented')\nFinished.`,
    };
  };
  return { calls, fastboot };
}
const quiet = () => {};
const writes = (calls: string[][]) => calls.filter((a) => a[0] !== "devices" && a[0] !== "getvar");
describe("Live bootloader 0.4 with unimplemented queries", () => {
  it("uses measured KiB and exact unit identity, without inventing fastboot values", async () => {
    observation();
    const f = legacy();
    const result = await runFlash({
      operation: "flash-rootfs",
      source: folder,
      fastboot: f.fastboot,
      stateDirectory: state,
      log: quiet,
    });
    expect(result.rootfsCapacityBytes).toBe(524288000);
    expect((result.identity as Record<string, unknown>).product).toBeNull();
    expect((result.identity as Record<string, unknown>)["partition-size:rootfs"]).toBeNull();
    expect(result.hardwareObservationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(writes(f.calls)).toEqual([]);
  });
  it("still requires the XMPOS owner confirmation; only the authorized rootfs sequence can write", async () => {
    observation();
    const f = legacy();
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: f.fastboot,
        stateDirectory: state,
        log: quiet,
        dryRun: false,
        answers: { flash: "NO" },
      }),
    ).rejects.toThrow(/Not confirmed/);
    expect(writes(f.calls)).toEqual([]);
    await runFlash({
      operation: "flash-rootfs",
      source: folder,
      fastboot: f.fastboot,
      stateDirectory: state,
      log: quiet,
      dryRun: false,
      answers: { flash: "XMPOS" },
    });
    expect(writes(f.calls).map((a) => a.slice(0, 2))).toEqual([
      ["oem", "inmusic-unlock-magic-7de5fbc22b8c524e"],
      ["flash", "rootfs"],
      ["reboot"],
    ]);
  });
  it("stops without evidence, for another unit, on transport errors, or on a changed bootloader", async () => {
    for (const patch of [
      {},
      { unit: "OTHER" },
      { genericFailure: true },
      { contradictory: true },
      { bootloader: "0.5" },
      { product: "unsupported" },
      { product: "ada2" },
    ]) {
      if (Object.keys(patch).length) observation();
      const f = legacy(patch);
      await expect(
        runFlash({
          operation: "flash-rootfs",
          source: folder,
          fastboot: f.fastboot,
          stateDirectory: state,
          log: quiet,
        }),
      ).rejects.toThrow();
      expect(writes(f.calls)).toEqual([]);
    }
  });
  it("binds the evidence to the preview and rejects tampering or a symlink", async () => {
    observation();
    const f = legacy();
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: f.fastboot,
        stateDirectory: state,
        log: quiet,
        expectedHardwareObservationSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/observation changed since preview/);
    writeFileSync(join(state, "unit-report.txt"), `${report()}tampered`);
    await expect(
      runFlash({ operation: "status", fastboot: f.fastboot, stateDirectory: state, log: quiet }),
    ).rejects.toThrow(/hash changed/);
    observation();
    const copy = join(folder, "unit-report.txt");
    writeFileSync(copy, report());
    rmSync(join(state, "unit-report.txt"));
    symlinkSync(copy, join(state, "unit-report.txt"));
    await expect(
      runFlash({ operation: "status", fastboot: f.fastboot, stateDirectory: state, log: quiet }),
    ).rejects.toThrow(/regular/);
    expect(writes(f.calls)).toEqual([]);
  });
  it("still refuses an image larger than the measured partition", async () => {
    observation(report().replace("512000", "1"));
    const f = legacy();
    writeFileSync(join(folder, "rootfs.ext4"), Buffer.alloc(8192));
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify({
        format: "xmp-live-mk1-probe-image",
        output: { file: "rootfs.ext4", sha256: hash(Buffer.alloc(8192)) },
      }),
    );
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: f.fastboot,
        stateDirectory: state,
        log: quiet,
      }),
    ).rejects.toThrow(/Invalid saved rootfs capacity/);
    observation(report().replace("512000", "4"));
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: f.fastboot,
        stateDirectory: state,
        log: quiet,
      }),
    ).rejects.toThrow(/larger than/);
    expect(writes(f.calls)).toEqual([]);
  });
  it("rejects Force, unsupported boards, duplicate serials and ambiguous root measurements", () => {
    for (const bad of [
      report().replace("inmusic,acv8", "inmusic,ada2"),
      report().replace("ACV8", "ACVA"),
      report().replace("rockchip,rk3288 ", "rockchip,rk3288-c "),
      report().replace("Serial", "Unknown"),
      `${report()}Serial: ${serial}\n`,
      report().replace("179:6", "179:7"),
      report().replace("179 6 512000 mmcblk0p6", "179 6 512000 mmcblk0p6\n179 6 512000 mmcblk0p6"),
    ])
      expect(() => parseRootfsObservation(bad)).toThrow();
  });
});
