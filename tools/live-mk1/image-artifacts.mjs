import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { sha256File } from "./container.mjs";
import { pythonRun, toolPath } from "./installer/runtime.mjs";

export const IMAGE_BYTES = 32 * 1024 * 1024;
export const lockFile = join(root, "os/live-mk1/mpc-runtime.lock.json");
export const runtimeLockHash = () => sha256File(lockFile);
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function regularFile(path, maximum = 64 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum)
    throw new Error(`Bounded regular file required: ${path}`);
  return { sha256: await sha256File(path), bytes: info.size };
}
export async function readJson(path) {
  await regularFile(path, 256 * 1024);
  return JSON.parse(await readFile(path, "utf8"));
}
export async function inputDirectory(path) {
  const at = resolve(path);
  if (!(await lstat(at)).isDirectory() || (await realpath(at)) !== at)
    throw new Error("Regular non-symlink input directory required");
  return at;
}
async function artifactParent(parent) {
  const base = resolve(root, "artifacts");
  if (parent !== base && !parent.startsWith(base + sep))
    throw new Error("Artifact output required");
  const segments = [base, ...relative(base, parent).split(sep).filter(Boolean)];
  let current;
  for (const segment of segments) {
    current = current ? join(current, segment) : segment;
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
      throw new Error("Symlink artifact parent refused");
  }
}
export async function newArtifactDirectory(path) {
  const at = resolve(path);
  if (!at.startsWith(resolve(root, "artifacts") + sep))
    throw new Error("New output directory under artifacts/ required");
  await artifactParent(dirname(at));
  await mkdir(at, { mode: 0o700 });
  return at;
}
export async function publishArtifactPointer(name, value) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error("Invalid artifact pointer name");
  const base = join(root, "artifacts/live-mk1");
  await artifactParent(base);
  const temporary = join(base, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, join(base, name));
}
export async function temporaryArtifact(prefix) {
  const base = join(root, "artifacts/live-mk1");
  await artifactParent(base);
  return mkdtemp(join(base, prefix));
}
export function pythonRuntime(args) {
  const result = pythonRun(["-I", join(root, "tools/live-mk1/owner-runtime.py"), ...args], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Image/runtime audit failed: ${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}
export async function makeExt4(tree, output) {
  // All operands are regular local artifact paths. No mount, device or shell.
  const image = await open(output, "wx", 0o600);
  try {
    await image.truncate(IMAGE_BYTES);
  } finally {
    await image.close();
  }
  const mke2fs = process.env.XMP_INSTALLER_RESOURCES
    ? join(
        process.env.XMP_INSTALLER_RESOURCES,
        process.platform === "win32" ? "image-tools/bin/mke2fs.exe" : "image-tools/mke2fs",
      )
    : "mke2fs";
  const version = spawnSync(mke2fs, ["-V"], { encoding: "utf8", timeout: 10000 });
  if (version.error || version.status !== 0)
    throw new Error("Install e2fsprogs (mke2fs) for local image assembly");
  const env = { ...process.env, MKE2FS_CONFIG: toolPath(join(root, "os/live-mk1/mke2fs.conf")) };
  const result = spawnSync(
    mke2fs,
    [
      "-q",
      "-t",
      "ext4",
      "-F",
      "-b",
      "4096",
      "-I",
      "256",
      "-m",
      "0",
      "-L",
      "xmpsys",
      "-O",
      "extent,^64bit,^has_journal,^orphan_file",
      "-E",
      "lazy_itable_init=0",
      "-d",
      toolPath(tree),
      toolPath(output),
    ],
    { env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Local ext4 creation failed: ${result.error?.message ?? result.stderr.trim()}`);
  return {
    tool: "mke2fs",
    version: (version.stderr || version.stdout).trim(),
    ...(await regularFile(output)),
  };
}
export async function writeManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
