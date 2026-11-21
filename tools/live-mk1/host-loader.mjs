import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { newcArchive } from "./boot.mjs";
import { MPC_RUNTIME, requireSupportedUpdater } from "./compatibility.mjs";
import { sha256File } from "./container.mjs";
import { hostImageTools } from "./host-image-tools.mjs";
import { publishArtifactPointer, temporaryArtifact, writeManifest } from "./image-artifacts.mjs";
import { pythonRun, toolPath } from "./installer/runtime.mjs";
import { requirePreparationSpace, reusableHostLoader } from "./loader-preparation.mjs";
import { diffLedgers, EXPECTED_LOADER_CHANGES, loaderPayload } from "./probe-image.mjs";
import { stockImageFromUpdater } from "./stock-image.mjs";

export function loaderScript(source, ramdiskBytes) {
  if (!Number.isSafeInteger(ramdiskBytes) || ramdiskBytes < 1 || ramdiskBytes > 8 * 1024 ** 2)
    throw new Error("Bounded loader ramdisk required");
  let result = source.replaceAll("xmp.probe=6", "xmp.loader=1");
  for (const address of [0x04000000, 0x49000000])
    result = result.replaceAll(
      `@XMP_INITRD_END_0x${address.toString(16).padStart(8, "0")}@`,
      `0x${(address + ramdiskBytes).toString(16).padStart(8, "0")}`,
    );
  if (result.includes("@XMP_")) throw new Error("Unresolved loader script address");
  return result;
}

function run(program, args, log) {
  const result =
    program === "python3"
      ? pythonRun(args, {
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 8 * 1024 ** 2,
        })
      : spawnSync(
          program,
          args.map((arg) => toolPath(arg)),
          { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 ** 2, windowsHide: true },
        );
  if (log)
    return writeFile(log, `${result.stdout ?? ""}${result.stderr ?? ""}`).then(() => {
      if (result.error || result.status !== 0)
        throw new Error(
          `Local loader command failed: ${program}: ${result.error?.message ?? result.status}; see ${log}`,
        );
      return result.stdout;
    });
  if (result.error || result.status !== 0)
    throw new Error(`Local loader audit failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export async function buildHostLoader(app, { expectedUpdaterImageSha256 } = {}) {
  const sourceHash = buildIdentity();
  if (
    !existsSync(
      join(root, "artifacts/live-mk1", `stock-rootfs-${MPC_RUNTIME.updaterImageSha256}.ext4`),
    )
  )
    await requirePreparationSpace(root, 1.5 * 1024 ** 3);
  const stock = await stockImageFromUpdater(app);
  requireSupportedUpdater(stock.receipt.updaterImageSha256);
  if (
    stock.sha256 !== MPC_RUNTIME.rootfsSha256 ||
    (expectedUpdaterImageSha256 !== undefined &&
      expectedUpdaterImageSha256 !== stock.receipt.updaterImageSha256)
  )
    throw new Error("Unexpected signed 3.10.1 stock baseline");
  const tools = await hostImageTools();
  const out = await temporaryArtifact("loader-host-");
  try {
    const stage = join(out, "loader-rootfs");
    await mkdir(stage);
    const payload = await loaderPayload(stage);
    const ramdisk = await newcArchive(stage);
    await writeFile(join(out, "probe.cpio.gz"), ramdisk, { flag: "wx" });
    await writeFile(
      join(out, "boot.cmd"),
      loaderScript(
        await readFile(join(root, "os/live-mk1/xmp-probe.boot.cmd"), "utf8"),
        ramdisk.length,
      ),
      { flag: "wx" },
    );
    const audit = join(root, "tools/live-mk1/loader-audit.py");
    run("python3", [
      "-I",
      audit,
      "script",
      join(out, "boot.cmd"),
      join(out, "probe.cpio.gz"),
      join(out, "boot.scr.uimg"),
    ]);
    const reused = await reusableHostLoader(root, {
      updaterSha256: stock.receipt.updaterImageSha256,
      stockSha256: stock.sha256,
      stockBytes: (await stat(stock.image)).size,
      initSha256: payload.initSha256,
      toolsSha256: tools.receipt.sourceSha256,
      files: {
        "boot.cmd": await readFile(join(out, "boot.cmd")),
        "probe.cpio.gz": ramdisk,
        "boot.scr.uimg": await readFile(join(out, "boot.scr.uimg")),
      },
    });
    if (reused) {
      await rm(out, { recursive: true });
      return reused;
    }
    await requirePreparationSpace(out, (await stat(stock.image)).size + 128 * 1024 ** 2);
    const outputFile = "rootfs-xmp-loader.ext4",
      image = join(out, outputFile);
    // A regular artifact file only. APFS clone keeps unchanged owner-local blocks shared.
    await copyFile(stock.image, image, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await run(tools.e2fsck, ["-fn", stock.image], join(out, "original-fsck.log"));
    const scriptPath = toolPath(join(out, "boot.scr.uimg"));
    if (/["\r\n]/.test(scriptPath)) throw new Error("Unsupported local artifact path");
    const edit = join(out, "edit.debugfs");
    await writeFile(edit, `rm /boot/boot.scr.uimg\nwrite "${scriptPath}" /boot/boot.scr.uimg\n`, {
      flag: "wx",
    });
    await run(tools.debugfs, ["-w", "-f", edit, image], join(out, "edit.log"));
    await run(tools.e2fsck, ["-fn", image], join(out, "result-fsck.log"));
    const before = JSON.parse(
      run("python3", ["-I", audit, "ledger", stock.image, join(out, "original.ledger")]),
    );
    const after = JSON.parse(
      run("python3", ["-I", audit, "ledger", image, join(out, "result.ledger")]),
    );
    const changes = diffLedgers(
      await readFile(join(out, "original.ledger"), "utf8"),
      await readFile(join(out, "result.ledger"), "utf8"),
    );
    if (
      JSON.stringify(changes) !== JSON.stringify(EXPECTED_LOADER_CHANGES) ||
      after.inodes.length !== 3 ||
      after.inodes.some(
        (inode) => !Number.isInteger(inode) || inode < 1 || inode > after.perGroup,
      ) ||
      before.kernelTarget !== after.kernelTarget
    )
      throw new Error("Loader changes or U-Boot inode placement differ from the authorized recipe");
    const manifest = {
      format: "xmp-live-mk1-loader-image",
      version: 6,
      sourceHash,
      builtAt: new Date().toISOString(),
      source: {
        signedBy: "inMusic (team XV2563R65Q)",
        imageName: stock.receipt.imageName,
        imageSha256: stock.receipt.updaterImageSha256,
        partitionSha1: stock.receipt.compressedPartitionSha1,
        originalRootfsSha256: stock.sha256,
      },
      output: { file: outputFile, sha256: await sha256File(image) },
      changes,
      unchangedFiles:
        (await readFile(join(out, "original.ledger"), "utf8")).trim().split("\n").length - 1,
      kernel: {
        source: "Akai stock /boot/zImage (unchanged)",
        release: after.kernelTarget.replace(/^.*zImage-/, ""),
      },
      bootScript:
        "os/live-mk1/xmp-probe.boot.cmd (v6): two-part legacy script, pinned host e2fsprogs; no Docker",
      ubootInodes: { perGroup: after.perGroup, files: after.inodes, allInGroup0: true },
      loader: {
        ...payload,
        source: "os/live-mk1/loader-init.c",
        behaviour:
          "USB XMP image read-only with RAM overlay; otherwise authorized ro,noload root= handover to Akai init",
      },
      filesystemCheck:
        (await readFile(join(out, "result-fsck.log"), "utf8"))
          .split("\n")
          .filter((line) => /files.*blocks/.test(line))
          .at(-1) ?? "e2fsck -fn exit 0; see result-fsck.log",
      builder: tools.receipt,
      containsVendorFirmware: true,
      redistribution: "forbidden: contains Akai firmware; keep local, never commit",
      flashed: false,
    };
    if (sourceHash !== buildIdentity()) throw new Error("Source changed during host loader build");
    await writeManifest(join(out, "manifest.json"), manifest);
    await writeManifest(join(out, "stock-receipt.json"), stock.receipt);
    await publishArtifactPointer("latest-loader-image.json", { directory: relative(root, out) });
    return { directory: out, manifest, reused: false };
  } catch (error) {
    if (!existsSync(join(out, "manifest.json"))) await rm(out, { recursive: true, force: true });
    if (error.code === "ENOSPC")
      throw new Error(
        "The disk filled while preparing the loader. The incomplete copy was removed; free more space and try again. Your existing loader and stock recovery image are preserved.",
      );
    throw error;
  }
}
