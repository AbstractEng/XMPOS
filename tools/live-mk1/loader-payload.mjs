import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { armElf } from "../os/arm-build.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function loaderPayload(stage) {
  for (const dir of ["proc", "sys", "dev"]) await mkdir(join(stage, dir));
  const zig = await vmCompiler();
  execFileSync(
    zig,
    [
      "cc",
      "-target",
      "arm-linux-musleabihf",
      "-mcpu=cortex_a17",
      "-static",
      "-s",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "os/live-mk1/loader-init.c",
      "-o",
      join(stage, "init"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: join(root, "build/arm/zig-cache"),
        ZIG_LOCAL_CACHE_DIR: join(stage, "..", "zig-local"),
      },
    },
  );
  const init = await readFile(join(stage, "init"));
  armElf(init);
  return { initSha256: sha(init) };
}
