import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { parseAz01, verifyAz01 } from "./az01-image.mjs";
import { sha256File } from "./container.mjs";
import { pythonRun } from "./installer/runtime.mjs";
import { checkUpdater } from "./probe-image.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_ROOTFS = 512 * 1024 * 1024;

// This helper authenticates the container hash, not its publisher. Its only
// production callers first authenticate the owner-supplied app with checkUpdater.
export async function prepareVerifiedStock(
  imagePath,
  cacheDirectory,
  { maxBytes = MAX_ROOTFS } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > MAX_ROOTFS)
    throw new Error("Invalid rootfs extraction bound");
  const input = await lstat(imagePath);
  if (!input.isFile() || input.isSymbolicLink() || input.size > 1024 * 1024 * 1024)
    throw new Error("Bounded regular update image required");
  const bytes = await readFile(imagePath);
  const container = verifyAz01(bytes, parseAz01(bytes));
  if (
    !container.verified ||
    !container.compatible.includes("inmusic,acv8") ||
    container.compatible.includes("inmusic,ada2") ||
    container.partition.name !== "rootfs" ||
    container.partition.compression !== "xz" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(container.name)
  )
    throw new Error("Expected a verified Live Mk1 rootfs/xz container");
  const directory = resolve(cacheDirectory);
  const allowed = [resolve(root, "artifacts"), resolve(root, "build")];
  if (!allowed.some((base) => directory.startsWith(base + sep)))
    throw new Error("Owned local build/artifact directory required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error("Symlink cache directory refused");
  const imageSha256 = sha(bytes);
  let destination = join(directory, `stock-rootfs-${imageSha256}.ext4`);
  let cached;
  try {
    cached = await lstat(destination);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!cached) {
    const legacy = join(directory, `stock-rootfs-${container.name}.ext4`);
    try {
      cached = await lstat(legacy);
      destination = legacy;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (cached && (!cached.isFile() || cached.isSymbolicLink()))
    throw new Error("Regular cached stock rootfs required");
  const stage = await mkdtemp(join(directory, ".stock-verify-"));
  try {
    const temporary = join(stage, "original.ext4");
    const result = pythonRun(
      [
        "-I",
        join(root, "tools/live-mk1/stock-rootfs.py"),
        imagePath,
        String(container.partition.offset),
        String(container.partition.size),
        container.partition.hash,
        cached ? "-" : temporary,
        String(maxBytes),
      ],
      { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `Stock rootfs extraction failed: ${result.error?.message ?? result.stderr.trim()}`,
      );
    const extracted = JSON.parse(result.stdout);
    if (
      !/^[a-f0-9]{64}$/.test(extracted.sha256 ?? "") ||
      !Number.isSafeInteger(extracted.bytes) ||
      extracted.bytes > maxBytes ||
      (!cached &&
        ((await stat(temporary)).size !== extracted.bytes ||
          (await sha256File(temporary)) !== extracted.sha256))
    )
      throw new Error("Stock extraction receipt mismatch");
    if (cached) {
      if (
        !cached.isFile() ||
        cached.isSymbolicLink() ||
        cached.size !== extracted.bytes ||
        (await sha256File(destination)) !== extracted.sha256
      )
        throw new Error(
          "Cached stock rootfs differs from fresh verified extraction; refusing restore",
        );
    } else {
      // No overwrite, even if another process creates the destination meanwhile.
      await link(temporary, destination);
    }
    const receipt = {
      format: "xmp-local-stock-rootfs",
      version: 1,
      target: "inmusic,acv8",
      updaterImageSha256: imageSha256,
      compressedPartitionSha1: container.partition.hash,
      imageName: container.name,
      output: { file: destination.split(sep).at(-1), ...extracted },
      verifiedAgainstFreshExtraction: true,
      containsVendorFirmware: true,
      redistribution: "forbidden: owner-local stock recovery image",
      hardwareAccess: false,
    };
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    const stagedReceipt = join(stage, "receipt.json");
    await writeFile(stagedReceipt, text, { flag: "wx" });
    try {
      await link(stagedReceipt, `${destination}.json`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await lstat(`${destination}.json`);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 65536 ||
        (await readFile(`${destination}.json`, "utf8")) !== text
      )
        throw new Error("Cached stock receipt differs; refusing to overwrite it");
    }
    return {
      image: destination,
      sha256: extracted.sha256,
      label: `Akai stock ${container.name}`,
      receipt,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function stockImageFromUpdater(app) {
  const updater = checkUpdater(app);
  const result = await prepareVerifiedStock(updater.image, join(root, "artifacts/live-mk1"));
  result.receipt.updaterSignatureVerified = true;
  return result;
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: npm run live:prepare-stock -- "<owner-supplied Updater.app>"; local extraction only',
    );
  const result = await stockImageFromUpdater(process.argv[2]);
  console.log(JSON.stringify({ image: relative(root, result.image), ...result.receipt }, null, 2));
}
