import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { buildAz01 } from "../tools/live-mk1/az01-image.mjs";
import { MPC_RUNTIME } from "../tools/live-mk1/compatibility.mjs";
import { runFlash, UNLOCK } from "../tools/live-mk1/flash.mjs";

// Only the app-authentication seam is synthetic here. The container parser,
// bounded stock extraction/cache check and flash transaction run unchanged.
// Every fastboot invocation is an injected in-memory fake, never a device.
vi.mock("../tools/live-mk1/probe-image.mjs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  checkUpdater: (path: string) => ({ path, image: join(path, "Update.img") }),
}));

it("rehearses first rootfs installation and exact stock restoration without extra fastboot commands", async () => {
  mkdirSync("build", { recursive: true });
  const at = mkdtempSync(resolve("build/r01-rehearsal-"));
  let recovered: string | undefined;
  try {
    const stock = Buffer.alloc(8192, 0x52);
    stock.writeUInt16LE(0xef53, 1080);
    const compressed = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read()))",
      ],
      { input: stock },
    );
    if (compressed.status !== 0) throw new Error(String(compressed.stderr));
    writeFileSync(
      join(at, "Update.img"),
      buildAz01("SYNTHETIC-RECOVERY", ["inmusic,acv8"], compressed.stdout),
    );
    const loader = Buffer.from("Synthetic local loader, not bootable or distributable");
    const image = join(at, "rootfs-xmp-loader.ext4");
    writeFileSync(image, loader);
    writeFileSync(
      join(at, "manifest.json"),
      JSON.stringify({
        format: "xmp-live-mk1-loader-image",
        source: { imageSha256: MPC_RUNTIME.updaterImageSha256 },
        output: {
          file: "rootfs-xmp-loader.ext4",
          sha256: createHash("sha256").update(loader).digest("hex"),
        },
      }),
    );
    const calls: string[][] = [];
    const identity: Record<string, string> = {
      product: "az01",
      "version-bootloader": "TEST",
      "partition-type:rootfs": "ext4",
      "partition-size:rootfs": "0x1f400000",
    };
    const fastboot = (args: string[]) => {
      calls.push(args);
      return {
        status: 0,
        output:
          args[0] === "devices"
            ? "SYNTHETIC\tfastboot"
            : args[0] === "getvar"
              ? `${args[1]}: ${identity[args[1] ?? ""]}`
              : "OKAY",
      };
    };
    const common = {
      source: at,
      dryRun: false,
      fastboot,
      stateDirectory: join(at, "state"),
      answers: { flash: "XMPOS" },
      log: () => {},
    };
    await runFlash({ ...common, operation: "flash-rootfs" });
    await runFlash({ ...common, operation: "restore-stock" });
    const writes = calls.filter((c) => c[0] !== "devices" && c[0] !== "getvar");
    recovered = writes[4]?.[2];
    expect(writes).toEqual([
      ["oem", UNLOCK],
      ["flash", "rootfs", image],
      ["reboot"],
      ["oem", UNLOCK],
      ["flash", "rootfs", recovered],
      ["reboot"],
    ]);
    if (!recovered) throw new Error("Missing restored image");
    expect(readFileSync(recovered)).toEqual(stock);
    writeFileSync(recovered, Buffer.alloc(stock.length, 0x58));
    calls.length = 0;
    await expect(runFlash({ ...common, operation: "restore-stock" })).rejects.toThrow(
      /Cached stock rootfs differs/,
    );
    expect(calls.every((c) => c[0] === "devices" || c[0] === "getvar")).toBe(true);
  } finally {
    rmSync(at, { recursive: true, force: true });
    if (recovered) {
      rmSync(recovered, { force: true });
      rmSync(`${recovered}.json`, { force: true });
    }
  }
});
