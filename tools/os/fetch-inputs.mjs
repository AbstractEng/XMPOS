import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../.."),
  lockName = process.argv[2] ?? "inputs.lock.json";
const LOCKS = {
  "inputs.lock.json": "build/os-inputs",
  "device-inputs.lock.json": "build/os-inputs",
  // Alpine package filenames carry no architecture, so ARM inputs get their own cache.
  "live-mk1/arm-device-inputs.lock.json": "build/os-inputs-armv7",
};
if (!Object.hasOwn(LOCKS, lockName) || process.argv.length > 3)
  throw new Error("Frozen development lock required");
const lock = JSON.parse(await readFile(join(root, "os", lockName), "utf8")),
  directory = join(root, LOCKS[lockName]);
if ((lock.cacheDirectory ?? "build/os-inputs") !== LOCKS[lockName])
  throw new Error("Lock cache directory mismatch");
await mkdir(directory, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
for (const c of [lock.base, ...lock.packages]) {
  if (
    !/^[a-zA-Z0-9+_.-]+$/.test(c.file) ||
    !c.url.startsWith("https://dl-cdn.alpinelinux.org/alpine/v3.23/")
  )
    throw new Error("Unapproved locked input path");
  const path = join(directory, c.file);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!bytes) {
    const temp = `${path}.download`;
    try {
      const p = spawnSync("curl", ["-fsSL", "--retry", "2", c.url, "-o", temp], {
        timeout: 180000,
        encoding: "utf8",
      });
      if (p.status !== 0)
        throw new Error(
          `Input download failed: ${c.id} (${c.url}): ${p.error?.message ?? p.stderr.slice(-1000) ?? p.status}`,
        );
      bytes = await readFile(temp);
      if (bytes.length !== c.bytes || sha(bytes) !== c.sha256)
        throw new Error(`Input integrity mismatch: ${c.id}`);
      await rename(temp, path);
    } finally {
      try {
        await unlink(temp);
      } catch (e) {
        if (e.code !== "ENOENT") console.error("Temporary download cleanup failed");
      }
    }
  }
  if (bytes.length !== c.bytes || sha(bytes) !== c.sha256)
    throw new Error(`Pinned input mismatch: ${c.id}`);
}
console.log(JSON.stringify({ pinnedInputs: lock.packages.length + 1, downloadsVerified: true }));
