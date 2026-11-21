import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";

const sha = async (path) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};

/** Native UI builds need the official WASI libc++; all tools stay in build/. */
export async function uiCompiler() {
  const lock = JSON.parse(
    await readFile(new URL("./ui-toolchain.lock.json", import.meta.url), "utf8"),
  );
  const pin = lock.hosts[`${process.platform}-${process.arch}`];
  if (!pin) throw new Error("No pinned native UI compiler for this build host");
  const cache = join(root, "build/wasi-sdk-34"),
    archive = join(cache, `${pin.asset}.tar.gz`);
  await mkdir(cache, { recursive: true });
  try {
    await stat(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        "300",
        `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/${pin.asset}.tar.gz`,
        "-o",
        `${archive}.partial`,
      ],
      { timeout: 310000, stdio: "inherit" },
    );
    if ((await sha(`${archive}.partial`)) !== pin.sha256)
      throw new Error("Native UI compiler archive hash mismatch");
    await rename(`${archive}.partial`, archive);
  }
  if ((await sha(archive)) !== pin.sha256) throw new Error("Changed native UI compiler archive");
  const directory = join(cache, pin.asset),
    binary = join(directory, "bin/clang++");
  try {
    await stat(binary);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    execFileSync("tar", ["-xzf", archive, "-C", cache], { timeout: 120000, stdio: "inherit" });
  }
  const receiptPath = join(directory, "xmp-compiler-receipt.json"),
    hash = await sha(binary);
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.archive !== pin.sha256 || receipt.binary !== hash)
      throw new Error("Changed native UI compiler");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(receiptPath, JSON.stringify({ archive: pin.sha256, binary: hash }));
  }
  return binary;
}
