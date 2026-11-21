import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lock from "./toolchain.lock.json" with { type: "json" };

const root = resolve(import.meta.dirname, "../..");
export async function vmCompiler() {
  const pin = lock.hosts[`${process.platform}-${process.arch}`];
  if (!pin) throw new Error("Pinned VM compiler is unavailable for this host");
  const directory = join(root, "build/sdk-toolchain"),
    archive = join(directory, "zig.tar.xz"),
    tool = join(directory, `zig-${lock.version}`),
    binary = join(tool, "zig");
  await mkdir(directory, { recursive: true });
  try {
    const receipt = JSON.parse(await readFile(join(tool, "xmp-compiler-receipt.json"), "utf8"));
    const digest = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    if (receipt.archiveSha256 !== pin.sha256 || receipt.binarySha256 !== digest)
      throw new Error("Cached VM compiler integrity mismatch");
    if (
      execFileSync(binary, ["version"], { encoding: "utf8", timeout: 15000 }).trim() !==
      lock.version
    )
      throw new Error("Cached compiler version mismatch");
    return binary;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await stat(archive);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-filesize",
        String(pin.bytes),
        "--max-time",
        "300",
        pin.url,
        "-o",
        `${archive}.partial`,
      ],
      { timeout: 310000 },
    );
    await rename(`${archive}.partial`, archive);
  }
  const bytes = await readFile(archive);
  if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
    throw new Error("Pinned VM compiler archive hash mismatch");
  const staging = join(directory, `extract-${process.pid}`);
  await mkdir(staging);
  try {
    execFileSync("tar", ["-xJf", archive, "--strip-components=1", "-C", staging], {
      timeout: 120000,
    });
    await writeFile(
      join(staging, "xmp-compiler-receipt.json"),
      JSON.stringify({
        version: lock.version,
        archiveSha256: pin.sha256,
        binarySha256: createHash("sha256")
          .update(await readFile(join(staging, "zig")))
          .digest("hex"),
      }),
    );
    await rename(staging, tool);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (
    execFileSync(binary, ["version"], { encoding: "utf8", timeout: 15000 }).trim() !== lock.version
  )
    throw new Error("Unexpected compiler version");
  return binary;
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("VM toolchain accepts no device targets");
  console.log(await vmCompiler());
}
