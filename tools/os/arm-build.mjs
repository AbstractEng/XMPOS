import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function armElf(bytes) {
  if (
    bytes.length < 52 ||
    bytes.toString("hex", 0, 6) !== "7f454c460101" ||
    bytes.readUInt16LE(18) !== 40 ||
    !(bytes.readUInt32LE(36) & 0x400)
  )
    throw new Error("ARM ELF32 little-endian EABI hard-float artifact required");
  // A static userspace payload must not require a dynamic interpreter.
  const offset = bytes.readUInt32LE(28),
    size = bytes.readUInt16LE(42),
    count = bytes.readUInt16LE(44);
  if (size < 32 || count > 64 || offset + size * count > bytes.length)
    throw new Error("Invalid ARM program headers");
  for (let i = 0; i < count; i++)
    if (bytes.readUInt32LE(offset + i * size) === 3)
      throw new Error("ARM development binaries must be static");
  return { machine: "ARM", bits: 32, endian: "little", hardFloat: true, static: true };
}
export async function fileLedger(directory, prefix = "") {
  const ledger = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Symlink artifact rejected");
    if (entry.isDirectory()) Object.assign(ledger, await fileLedger(directory, name));
    else if (entry.isFile()) ledger[name] = sha(await readFile(join(directory, name)));
  }
  return ledger;
}
export async function buildArm() {
  const sourceHash = buildIdentity(),
    zig = await vmCompiler();
  await mkdir(join(root, "build/arm"), { recursive: true });
  const directory = await mkdtemp(join(root, "build/arm/build-"));
  await mkdir(join(directory, "bin"));
  const env = {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: join(root, "build/arm/zig-cache"),
    ZIG_LOCAL_CACHE_DIR: join(directory, "zig-local"),
  };
  const common = [
    "-target",
    "arm-linux-musleabihf",
    "-mcpu=cortex_a17",
    "-static",
    "-O1",
    "-ffp-contract=off",
    "-fno-builtin",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I",
    "native/include",
  ];
  const wraps = [
    "malloc",
    "calloc",
    "realloc",
    "free",
    "pthread_mutex_lock",
    "open",
    "read",
    "write",
    "fwrite",
    "socket",
    "send",
    "recv",
  ].map((s) => `-Wl,-wrap,${s}`);
  const recipes = [
    [
      "xmp_parity_render",
      "cc",
      [
        "-std=c99",
        "-D_POSIX_C_SOURCE=200809L",
        "-Inative/include/xmp",
        "native/src/parity_render.c",
        "native/src/parity_dsp.c",
        "-lm",
      ],
    ],
    [
      "xmp_sampler_test",
      "c++",
      [
        "-std=c++17",
        "native/tests/sampler_test.cpp",
        "native/src/sampler.cpp",
        "native/src/gain.cpp",
      ],
    ],
    [
      "xmp_engine_test",
      "c++",
      [
        "-std=c++17",
        "native/tests/engine_test.cpp",
        "native/src/engine.cpp",
        "native/src/rt_audit.cpp",
        "native/src/rt_wrap_linux.cpp",
        "-pthread",
        ...wraps,
      ],
    ],
  ];
  const binaries = {};
  for (const [name, language, flags] of recipes) {
    const args = [language, ...common, ...flags, "-o", join(directory, "bin", name)];
    execFileSync(zig, args, { cwd: root, env, stdio: "inherit", timeout: 600000 });
    const bytes = await readFile(join(directory, "bin", name));
    binaries[name] = {
      ...armElf(bytes),
      sha256: sha(bytes),
      bytes: bytes.length,
      flags: args.slice(1, -2),
    };
  }
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
    cwd: root,
    stdio: "inherit",
    timeout: 120000,
  });
  await cp(join(root, "dist"), join(directory, "studio"), { recursive: true });
  const manifest = {
    format: "xmp-arm-development",
    version: 1,
    target: "arm-linux-musleabihf",
    cpu: "cortex-a17",
    sourceHash,
    compiler: "Zig 0.13.0 (pinned archive)",
    binaries,
    files: await fileLedger(join(directory, "studio")),
    deviceViewDefault: true,
    kernelIncluded: false,
    bootloaderIncluded: false,
    mpcBootable: false,
    mpcDriversQualified: false,
    physicalAccess: false,
    publicRedistributionApproved: false,
    scope:
      "Static ARMv7 native engine tests and declarative DSP runner plus offline Device web assets; not an MPC firmware image",
  };
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during ARM build");
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(root, "artifacts/arm"), { recursive: true });
  await writeFile(
    join(root, "artifacts/arm/latest.json"),
    JSON.stringify({ directory, sourceHash }),
  );
  return { directory, manifest };
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2)
    throw new Error("ARM development build accepts no device deployment options");
  const result = await buildArm();
  console.log(
    JSON.stringify({
      directory: result.directory,
      target: result.manifest.target,
      mpcBootable: false,
    }),
  );
}
