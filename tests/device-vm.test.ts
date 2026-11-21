import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DeviceCommand } from "../os/guest/device-contract.ts";
// @ts-expect-error Executable ESM tooling.
import { armElf } from "../tools/os/arm-build.mjs";
// @ts-expect-error Executable ESM tooling.
import { finishDeviceVm } from "../tools/os/device-client.mjs";
// @ts-expect-error Executable ESM tooling.
import { DeviceVmProfile, VmProfile } from "../tools/os/policy.mjs";

describe("guest Device and ARM boundaries", () => {
  it("requires a clean storage shutdown even when QEMU returns zero", async () => {
    const stopped = { code: 0, signal: null, log: 'XMPBOOT {"event":"storage-closed"}' };
    expect(await finishDeviceVm({ finish: async () => stopped })).toEqual(stopped);
    for (const bad of [
      { ...stopped, log: "Kernel panic - not syncing" },
      { ...stopped, log: `${stopped.log}\nOut of memory` },
      { ...stopped, signal: "SIGKILL" },
      { ...stopped, code: 1 },
    ])
      await expect(finishDeviceVm({ finish: async () => bad })).rejects.toThrow();
  });
  it("keeps graphical resources separate from the frozen P10 profile", () => {
    const p10 = JSON.parse(readFileSync("os/profile.json", "utf8"));
    const gui = JSON.parse(readFileSync("os/device-profile.json", "utf8"));
    expect(VmProfile.parse(p10).memoryMiB).toBe(1024);
    expect(DeviceVmProfile.parse(gui).memoryMiB).toBe(3072);
    expect(() => DeviceVmProfile.parse({ ...gui, usbPassthrough: true })).toThrow();
    expect(() => DeviceVmProfile.parse({ ...gui, network: true })).toThrow();
    expect(() => VmProfile.parse(gui)).toThrow();
  });
  it("accepts bounded touch controls and rejects scripts, hardware and oversized input", () => {
    expect(DeviceCommand.parse({ op: "device-click", x: 0, y: 999 }).op).toBe("device-click");
    for (const c of [
      { op: "device-click", x: 1600, y: 10 },
      { op: "device-status", script: "alert(1)" },
      { op: "device-control", kind: "action", id: "../etc" },
      { op: "device-select", id: "device-machine", value: "a".repeat(65) },
      { op: "device-chunk", offset: 2_000_001 },
      { op: "flash", device: "Force" },
    ])
      expect(DeviceCommand.safeParse(c).success).toBe(false);
  });
  it("requires static ARM32 hard-float ELF and rejects other ABIs and interpreters", () => {
    const b = Buffer.alloc(84);
    b.set(Buffer.from("7f454c460101", "hex"));
    b.writeUInt16LE(40, 18);
    b.writeUInt32LE(0x5000400, 36);
    b.writeUInt32LE(52, 28);
    b.writeUInt16LE(32, 42);
    b.writeUInt16LE(1, 44);
    expect(armElf(b).static).toBe(true);
    for (const [at, value] of [
      [4, 2],
      [18, 62],
      [37, 0],
      [52, 3],
    ]) {
      const wrong = Buffer.from(b);
      wrong[at as number] = value as number;
      expect(() => armElf(wrong)).toThrow();
    }
    expect(() => armElf(b.subarray(0, 60))).toThrow();
  });
});
