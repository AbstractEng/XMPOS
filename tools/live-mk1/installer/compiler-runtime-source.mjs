import { execFileSync } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toolPath } from "./runtime.mjs";
export async function compilerRuntimeSource({ python, provided, compilerDirectory, cache }) {
  await mkdir(cache, { recursive: true });
  const archive = provided ? resolve(provided) : join(cache, "Zig-0.13.0-compiler-runtime.tar.gz");
  const script = join(import.meta.dirname, "compiler-rt-source.py"),
    lock = join(import.meta.dirname, "compiler-rt.lock.json");
  const run = (args) =>
    execFileSync(python, ["-B", "-I", "-S", ...[script, ...args, lock].map((p) => toolPath(p))], {
      timeout: 30000,
      encoding: "utf8",
      windowsHide: true,
    });
  if (!provided) {
    const existing = await lstat(archive).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (!existing) run(["make", compilerDirectory, archive]);
  }
  const s = await lstat(archive);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 16 * 1024 ** 2)
    throw new Error("Regular bounded compiler-runtime source archive required");
  run(["check", archive, "unused"]);
  return archive;
}
