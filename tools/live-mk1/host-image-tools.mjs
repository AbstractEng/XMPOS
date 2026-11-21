import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { sha256File } from "./container.mjs";

export async function hostImageTools() {
  const lock = JSON.parse(
    await readFile(join(root, "os/live-mk1/host-image-tools.lock.json"), "utf8"),
  );
  const cache = join(root, "references/archives/host-image-tools");
  const at = join(root, "build/host-image-tools");
  const archive = join(cache, `e2fsprogs-${lock.release}.tar.xz`);
  const source = join(at, `e2fsprogs-${lock.release}`);
  await mkdir(cache, { recursive: true });
  await mkdir(at, { recursive: true });
  if (!existsSync(archive))
    execFileSync("curl", [
      "-fLsS",
      "--max-time",
      "120",
      "--max-filesize",
      String(lock.bytes),
      lock.url,
      "-o",
      archive,
    ]);
  if ((await sha256File(archive)) !== lock.sha256)
    throw new Error("Changed host filesystem-tool source");
  const paths = {
    debugfs: join(source, "debugfs/debugfs"),
    e2fsck: join(source, "e2fsck/e2fsck"),
    dumpe2fs: join(source, "misc/dumpe2fs"),
  };
  const receiptPath = join(at, "receipt.json");
  const previous = existsSync(receiptPath) ? JSON.parse(await readFile(receiptPath, "utf8")) : null;
  if (!previous || !Object.values(paths).every(existsSync)) {
    await rm(source, { recursive: true, force: true });
    execFileSync("tar", ["-xJf", archive, "-C", at], { timeout: 120000 });
    execFileSync("./configure", lock.configure, { cwd: source, timeout: 300000, stdio: "inherit" });
    execFileSync("make", ["-j2"], { cwd: source, timeout: 600000, stdio: "inherit" });
  }
  const binaries = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        { path, sha256: await sha256File(path) },
      ]),
    ),
  );
  const receipt = {
    format: lock.format,
    version: 1,
    sourceSha256: lock.sha256,
    release: lock.release,
    platform: process.platform,
    arch: process.arch,
    binaries,
    configure: lock.configure,
  };
  if (previous && JSON.stringify(previous) !== JSON.stringify(receipt))
    throw new Error("Changed cached host filesystem tools; rebuild from the pinned source");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...paths, receipt };
}
