import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightTarget } from "../acceptance/target-policy.mjs";
import {
  fastbootArgs,
  getvarValue,
  readIdentity,
  runFlash,
  systemFastboot,
  UNLOCK,
  verifiedSystemFastboot,
} from "../tools/live-mk1/flash.mjs";

// A fake fastboot: records every argv and answers like U-Boot's fastboot.
function fakeFastboot(identity: Record<string, string>, devices = 1) {
  const calls: string[][] = [];
  const fastboot = (args: string[]) => {
    calls.push(args);
    if (args[0] === "devices")
      return {
        status: 0,
        output: Array.from({ length: devices }, (_, i) => `SERIAL${i}\tfastboot`).join("\n"),
      };
    if (args[0] === "getvar") {
      const name = args[1] ?? "";
      return { status: 0, output: `${name}: ${identity[name] ?? ""}\nFinished.` };
    }
    return { status: 0, output: "OKAY" };
  };
  return { calls, fastboot };
}
const live = {
  product: "az01",
  "version-bootloader": "2016.05-inmusic",
  "partition-type:rootfs": "ext4",
  "partition-size:rootfs": "0x1f400000",
};
const writes = (calls: string[][]) => calls.filter((c) => c[0] !== "devices" && c[0] !== "getvar");

let folder: string;
let state: string;
let image: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "xmp-flash-image-"));
  state = mkdtempSync(join(tmpdir(), "xmp-flash-state-"));
  const bytes = Buffer.from("synthetic ext4 image for tests");
  image = join(folder, "rootfs-test.ext4");
  writeFileSync(image, bytes);
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      format: "xmp-live-mk1-probe-image",
      output: {
        file: "rootfs-test.ext4",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }),
  );
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});
const quiet = () => {};

describe("fastboot command allow-list", () => {
  it("produces only the authorized commands", () => {
    expect(fastbootArgs("devices")).toEqual(["devices"]);
    expect(fastbootArgs("getvar:partition-size:rootfs")).toEqual([
      "getvar",
      "partition-size:rootfs",
    ]);
    expect(fastbootArgs("unlock")).toEqual(["oem", UNLOCK]);
    expect(fastbootArgs("flash-rootfs", "/x/rootfs.ext4")).toEqual([
      "flash",
      "rootfs",
      "/x/rootfs.ext4",
    ]);
    expect(fastbootArgs("reboot")).toEqual(["reboot"]);
  });
  it("refuses everything else", () => {
    for (const step of [
      "erase",
      "format",
      "flash-bootloader",
      "getvar:serialno",
      "oem format",
      "boot",
    ])
      expect(() => fastbootArgs(step)).toThrow(/not authorized/);
    expect(() => fastbootArgs("flash-rootfs", "/x/uboot.bin")).toThrow(/ext4/);
  });
  it("parses getvar output", () => {
    expect(getvarValue("product: az01\nFinished.", "product")).toBe("az01");
    expect(getvarValue("Finished.", "product")).toBeNull();
    expect(
      getvarValue(
        "(bootloader) partition-size:rootfs: 0x20000000\r\nFinished.",
        "partition-size:rootfs",
      ),
    ).toBe("0x20000000");
    expect(getvarValue("product: az01\n(bootloader) product: az01", "product")).toBe("az01");
    expect(getvarValue("product: az01\nproduct: ada2", "product")).toBeNull();
  });
});

describe("fastboot devices parsing", () => {
  it("accepts the tab-space format printed by platform-tools 37", async () => {
    const identity = await readIdentity((args) =>
      args[0] === "devices"
        ? { status: 0, output: "SERIAL\t fastboot\n" }
        : { status: 0, output: `${args[1]}: x\nFinished.` },
    );
    expect(identity.product).toBe("x");
    expect(identity.serial).toBe("SERIAL");
  });
});

describe("Live Mk1 flash guards", () => {
  it("refuses another unit with otherwise identical firmware fields, including status", async () => {
    await runFlash({
      operation: "flash-rootfs",
      source: folder,
      dryRun: false,
      fastboot: fakeFastboot(live).fastboot,
      log: quiet,
      stateDirectory: state,
      answers: { flash: "XMPOS" },
    });
    const original = fakeFastboot(live),
      alternate = (args: string[]) =>
        args[0] === "devices"
          ? { status: 0, output: "OTHER-UNIT\tfastboot" }
          : original.fastboot(args);
    for (const operation of ["status", "flash-rootfs"] as const)
      await expect(
        runFlash({
          operation,
          source: folder,
          fastboot: alternate,
          log: quiet,
          stateDirectory: state,
        }),
      ).rejects.toThrow(/does not match/);
    expect(writes(original.calls)).toEqual([]);
  });

  it("keeps legacy records unpinned until the owner confirms XMPOS confirms enrolment and the flash", async () => {
    const file = join(state, "fastboot-identity.json");
    writeFileSync(file, JSON.stringify({ identity: live }));
    const original = readFileSync(file, "utf8"),
      fake = fakeFastboot(live);
    const result = await runFlash({
      operation: "status",
      fastboot: fake.fastboot,
      log: quiet,
      stateDirectory: state,
    });
    expect(result.unitPinned).toBe(false);
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        dryRun: false,
        fastboot: fake.fastboot,
        log: quiet,
        stateDirectory: state,
        answers: { flash: "NO" },
      }),
    ).rejects.toThrow(/Not confirmed/);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(writes(fake.calls)).toEqual([]);
  });

  it("logs all allowed read commands and treats failed discovery/getvar as unknown", async () => {
    const fake = fakeFastboot(live);
    const result = await runFlash({
      operation: "status",
      fastboot: fake.fastboot,
      log: quiet,
      stateDirectory: state,
    });
    const text = readFileSync(String(result.logFile), "utf8");
    for (const args of fake.calls) expect(text).toContain(`$ fastboot ${args.join(" ")}`);
    await expect(readIdentity(() => ({ status: 1, output: "SERIAL\tfastboot" }))).rejects.toThrow(
      /devices failed/,
    );
    const identity = await readIdentity((args) =>
      args[0] === "devices"
        ? { status: 0, output: "SERIAL\tfastboot" }
        : { status: 1, output: `${args[1]}: invented` },
    );
    expect(identity["partition-size:rootfs"]).toBeNull();
  });
  it("dry run reads the device but sends no write", async () => {
    const { calls, fastboot } = fakeFastboot(live);
    const result = await runFlash({
      operation: "flash-rootfs",
      source: folder,
      fastboot,
      log: quiet,
      stateDirectory: state,
    });
    expect(result.dryRun).toBe(true);
    expect(writes(calls)).toEqual([]);
  });

  it("writes exactly unlock, rootfs and reboot after both confirmations", async () => {
    const { calls, fastboot } = fakeFastboot(live);
    await runFlash({
      operation: "flash-rootfs",
      source: folder,
      dryRun: false,
      fastboot,
      log: quiet,
      stateDirectory: state,
      answers: { flash: "XMPOS" },
    });
    expect(writes(calls)).toEqual([["oem", UNLOCK], ["flash", "rootfs", image], ["reboot"]]);
  });

  it("writes nothing without the XMPOS confirmation", async () => {
    for (const answers of [{ flash: "" }, { flash: "yes" }]) {
      const fresh = mkdtempSync(join(tmpdir(), "xmp-flash-state-"));
      const { calls, fastboot } = fakeFastboot(live);
      await expect(
        runFlash({
          operation: "flash-rootfs",
          source: folder,
          dryRun: false,
          fastboot,
          log: quiet,
          stateDirectory: fresh,
          answers,
        }),
      ).rejects.toThrow(/nothing written/);
      expect(writes(calls)).toEqual([]);
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("refuses a Force, several devices, no device, or a different device", async () => {
    const force = fakeFastboot({ ...live, product: "ada2" });
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: force.fastboot,
        log: quiet,
        stateDirectory: state,
      }),
    ).rejects.toThrow(/Protected Force/);
    expect(writes(force.calls)).toEqual([]);
    for (const count of [0, 2]) {
      const many = fakeFastboot(live, count);
      await expect(
        runFlash({
          operation: "status",
          fastboot: many.fastboot,
          log: quiet,
          stateDirectory: state,
        }),
      ).rejects.toThrow(count ? /More than one/ : /No device in update mode/);
    }
    // Record the Live, then present a different device.
    await runFlash({
      operation: "flash-rootfs",
      source: folder,
      dryRun: false,
      fastboot: fakeFastboot(live).fastboot,
      log: quiet,
      stateDirectory: state,
      answers: { flash: "XMPOS" },
    });
    const other = fakeFastboot({ ...live, "version-bootloader": "different" });
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: other.fastboot,
        log: quiet,
        stateDirectory: state,
      }),
    ).rejects.toThrow(/does not match the recorded MPC Live/);
    expect(writes(other.calls)).toEqual([]);
  });

  it("refuses a tampered image or one larger than the rootfs partition", async () => {
    writeFileSync(image, "tampered");
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: fakeFastboot(live).fastboot,
        log: quiet,
        stateDirectory: state,
      }),
    ).rejects.toThrow(/manifest hash/);
    const bytes = Buffer.from("x".repeat(64));
    writeFileSync(image, bytes);
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify({
        format: "xmp-live-mk1-probe-image",
        output: {
          file: "rootfs-test.ext4",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
    );
    const tiny = fakeFastboot({ ...live, "partition-size:rootfs": "0x10" });
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot: tiny.fastboot,
        log: quiet,
        stateDirectory: state,
      }),
    ).rejects.toThrow(/larger than the rootfs partition/);
    expect(writes(tiny.calls)).toEqual([]);
  });

  it("refuses an old or unpinned loader before any write", async () => {
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify({
        ...manifest,
        format: "xmp-live-mk1-loader-image",
        source: { imageSha256: "a".repeat(64) },
      }),
    );
    const { calls, fastboot } = fakeFastboot(live);
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot,
        log: quiet,
        stateDirectory: state,
      }),
    ).rejects.toThrow(/3.10.1/);
    expect(writes(calls)).toEqual([]);
  });

  it("refuses an image manifest path that escapes its folder", async () => {
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify({
        format: "xmp-live-mk1-loader-image",
        output: { file: "../outside.ext4", sha256: "0".repeat(64) },
      }),
    );
    const { calls, fastboot } = fakeFastboot(live);
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot,
        log: quiet,
        stateDirectory: state,
      }),
    ).rejects.toThrow(/manifest/);
    expect(writes(calls)).toEqual([]);
  });

  it("refuses unreadable or non-ext4 rootfs geometry before any write", async () => {
    for (const patch of [
      { "partition-size:rootfs": "unknown" },
      { "partition-size:rootfs": "0x0" },
      { "partition-type:rootfs": "fat" },
    ]) {
      const { calls, fastboot } = fakeFastboot({ ...live, ...patch });
      await expect(
        runFlash({
          operation: "flash-rootfs",
          source: folder,
          fastboot,
          log: quiet,
          stateDirectory: state,
        }),
      ).rejects.toThrow(/rootfs|capacity/);
      expect(writes(calls)).toEqual([]);
    }
  });

  it("target policy keeps the Force protected and the scope narrow", () => {
    expect(() =>
      preflightTarget({
        profile: "live-mk1-rootfs",
        device: { product: "Force" },
        operation: "status",
      }),
    ).toThrow(/Protected Force/);
    expect(() =>
      preflightTarget({ profile: "live-mk1-rootfs", device: live, operation: "flash-bootloader" }),
    ).toThrow(/outside the Live Mk1 authorization/);
    expect(
      preflightTarget({ profile: "live-mk1-rootfs", device: live, operation: "status" }).operation,
    ).toBe("status");
  });
});

describe("installer preview binding and XMPOS confirmation", () => {
  it("rejects the previous phrase, whitespace and lowercase before any write", async () => {
    for (const flash of ["FLASH MPC LIVE", "xmpos", "XMPOS ", " XMPOS"]) {
      const f = fakeFastboot(live);
      await expect(
        runFlash({
          operation: "flash-rootfs",
          source: folder,
          dryRun: false,
          fastboot: f.fastboot,
          stateDirectory: state,
          log: quiet,
          answers: { flash },
        }),
      ).rejects.toThrow(/Not confirmed/);
      expect(writes(f.calls)).toEqual([]);
    }
  });
  it("refuses a changed unit, changed image or unknown product after preview", async () => {
    const cases = [
      { expectedIdentity: { ...live, serial: "OTHER" } },
      { expectedImageSha256: "0".repeat(64) },
    ];
    for (const extra of cases) {
      const f = fakeFastboot(live);
      await expect(
        runFlash({
          operation: "flash-rootfs",
          source: folder,
          dryRun: false,
          fastboot: f.fastboot,
          stateDirectory: state,
          log: quiet,
          answers: { flash: "XMPOS" },
          ...extra,
        }),
      ).rejects.toThrow(/changed since preview/);
      expect(writes(f.calls)).toEqual([]);
    }
    const other = fakeFastboot({ ...live, product: "unsupported-mpc" });
    await expect(
      runFlash({
        operation: "status",
        fastboot: other.fastboot,
        stateDirectory: state,
        log: quiet,
      }),
    ).rejects.toThrow(/Unsupported fastboot product/);
    expect(writes(other.calls)).toEqual([]);
  });
});

describe("graphical installer's device runner stays in the flash tool", () => {
  it("refuses extra arguments and every non-authorized command before spawning fastboot", () => {
    for (const args of [
      ["erase", "rootfs"],
      ["devices", "--anything"],
      ["flash", "bootloader", image],
      ["reboot", "bootloader"],
    ]) {
      expect(() => systemFastboot(args)).toThrow(/allow-list/);
    }
  });
  it("refuses a changed downloaded executable without opening a device", () => {
    expect(() =>
      verifiedSystemFastboot(["devices"], { executable: image, sha256: "f".repeat(64) }),
    ).toThrow(/USB support changed/);
  });
});

describe("bootloader protocol failure despite exit status zero", () => {
  it("normalizes FAILED from the verified executable before treating it as success", () => {
    const tool = join(folder, "synthetic-fastboot");
    writeFileSync(tool, '#!/bin/sh\nprintf "%s\\n" "FAILED (remote: unimplemented)"\n', {
      mode: 0o700,
    });
    const result = verifiedSystemFastboot(["getvar", "product"], {
      executable: tool,
      sha256: createHash("sha256").update(readFileSync(tool)).digest("hex"),
    });
    expect(result.status).toBe(1);
  });
  it("stops on failed unlock and never continues to flash or reboot", async () => {
    const f = fakeFastboot(live);
    const fastboot = (args: string[]) => {
      const r = f.fastboot(args);
      return args[0] === "oem" ? { status: 0, output: "FAILED (remote: denied)" } : r;
    };
    await expect(
      runFlash({
        operation: "flash-rootfs",
        source: folder,
        fastboot,
        stateDirectory: state,
        log: quiet,
        dryRun: false,
        answers: { flash: "XMPOS" },
      }),
    ).rejects.toThrow(/fastboot oem failed/);
    expect(writes(f.calls).map((a) => a[0])).toEqual(["oem"]);
  });
});
