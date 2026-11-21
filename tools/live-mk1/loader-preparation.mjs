import { createHash } from "node:crypto";
import { lstat, readFile, statfs } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { sha256File } from "./container.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function requirePreparationSpace(directory, requiredBytes, measure = statfs) {
  const fs = await measure(directory);
  const available = Number(fs.bavail) * Number(fs.bsize);
  if (!Number.isSafeInteger(available) || available < requiredBytes)
    throw new Error(
      `Not enough free space to prepare installation files. Free at least ${Math.ceil(requiredBytes / 1024 ** 2)} MiB here; ${Math.floor(available / 1024 ** 2)} MiB is available. Your existing loader and recovery image are preserved.`,
    );
  return available;
}
async function file(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error("Regular bounded cached loader file required");
  return readFile(path);
}
export async function reusableHostLoader(root, expected) {
  try {
    const pointer = JSON.parse(
      await file(join(root, "artifacts/live-mk1/latest-loader-image.json"), 16384),
    );
    const directory = resolve(root, pointer.directory);
    const base = resolve(root, "artifacts/live-mk1") + sep;
    if (!directory.startsWith(base) || (await lstat(directory)).isSymbolicLink()) return null;
    const manifest = JSON.parse(await file(join(directory, "manifest.json"), 1024 ** 2));
    if (
      manifest.format !== "xmp-live-mk1-loader-image" ||
      manifest.version !== 6 ||
      manifest.source?.imageSha256 !== expected.updaterSha256 ||
      manifest.source?.originalRootfsSha256 !== expected.stockSha256 ||
      manifest.loader?.initSha256 !== expected.initSha256 ||
      manifest.builder?.sourceSha256 !== expected.toolsSha256 ||
      !manifest.ubootInodes?.allInGroup0 ||
      JSON.stringify(manifest.changes) !==
        JSON.stringify({ changed: ["boot/boot.scr.uimg"], added: [], removed: [] }) ||
      !/^[A-Za-z0-9._-]+\.ext4$/.test(manifest.output?.file ?? "") ||
      !/^[a-f0-9]{64}$/.test(manifest.output?.sha256 ?? "")
    )
      return null;
    for (const [name, bytes] of Object.entries(expected.files))
      if (sha(await file(join(directory, name), 8 * 1024 ** 2)) !== sha(bytes)) return null;
    const image = join(directory, manifest.output.file);
    const info = await lstat(image);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== expected.stockBytes ||
      (await sha256File(image)) !== manifest.output.sha256
    )
      return null;
    return { directory, manifest, reused: true };
  } catch (error) {
    if (error.code === "EACCES") throw error;
    return null; // Invalid/changed cache is never promoted or overwritten.
  }
}
