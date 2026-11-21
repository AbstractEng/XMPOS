import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";

// Zig 0.13 supplies the linker and WASI libc. Use a pinned prebuilt libc++
// because that Zig release tries to compile its thread implementation for
// the browser's single-threaded C++ target.
export async function wasiSysroot() {
  const dir = join(root, "build/wasi-toolchain");
  const archive = join(dir, "wasi-sysroot-20.tar.gz");
  const expected = "80e95a591ee91b693375576308a3eba0054af7318afdb19e1f00b6efacad58fa";
  await mkdir(dir, { recursive: true });
  let bytes = await readFile(archive).catch(() => undefined);
  if (!bytes) {
    const url =
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-20/wasi-sysroot-20.0.tar.gz";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`WASI SDK download failed (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("WASI SDK archive failed verification");
  await writeFile(archive, bytes);
  execFileSync("tar", ["-xzf", archive, "-C", dir], { env: { ...process.env, LC_ALL: "C" } });
  return join(dir, "wasi-sysroot");
}
