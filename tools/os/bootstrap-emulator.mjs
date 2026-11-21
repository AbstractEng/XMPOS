import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const lock = JSON.parse(readFileSync(join(root, "os/emulator.lock.json"), "utf8"));
if (process.argv.length > 2) throw new Error("No emulator/device overrides supported");
if (process.platform !== "darwin")
  throw new Error("Install QEMU >= 8.2 using your supported system package manager on Linux");
function run(program, args, cwd = root) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit", timeout: 1800000 });
  if (result.status !== 0)
    throw new Error(`${program} failed: ${result.error?.message ?? result.status}`);
}
const prefix = join(root, "build/os-tools/qemu");
if (existsSync(join(prefix, "bin/qemu-system-x86_64"))) {
  run(join(prefix, "bin/qemu-system-x86_64"), ["--version"]);
  console.log("Owned emulator already built");
} else {
  for (const dependency of ["pkg-config", "glib-2.0", "pixman-1"]) {
    const result = spawnSync(
      dependency === "pkg-config" ? "which" : "pkg-config",
      dependency === "pkg-config" ? [dependency] : ["--exists", dependency],
    );
    if (result.status !== 0)
      throw new Error(
        "Install build prerequisites: Homebrew glib, pixman, pkg-config; Xcode command line tools; npm run bootstrap",
      );
  }
  const python = join(root, ".venv/bin/python"),
    ninja = join(root, ".venv/bin/ninja");
  if (!existsSync(python) || !existsSync(ninja)) throw new Error("Run npm run bootstrap first");
  run(python, ["-m", "pip", "install", `meson==${lock.meson}`]);
  const archive = join(root, "build/os-inputs/qemu-8.2.10.tar.xz");
  mkdirSync(join(root, "build/os-inputs"), { recursive: true });
  if (!existsSync(archive)) run("curl", ["-fsSL", "--retry", "2", lock.url, "-o", archive]);
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== lock.sha256)
    throw new Error("QEMU source integrity mismatch");
  // QEMU's Makefile does not support a source/build path containing spaces.
  const scratch = mkdtempSync(join(tmpdir(), "xmp-qemu-build-"));
  run("tar", ["-xf", archive, "-C", scratch]);
  // Keep configure's interpreter paths free of spaces while preserving the venv.
  const wrap = (name, target) => {
    const path = join(scratch, name);
    const quoted = `'${target.replaceAll("'", "'\\''")}'`;
    writeFileSync(path, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
    return path;
  };
  const pythonWrapper = wrap("python3", python);
  const ninjaWrapper = wrap("ninja", ninja);
  const output = join(scratch, "out");
  mkdirSync(output);
  run(
    join(scratch, `qemu-${lock.version}/configure`),
    [
      "--target-list=x86_64-softmmu",
      "--disable-werror",
      "--disable-containers",
      "--disable-docs",
      "--disable-gtk",
      "--disable-sdl",
      "--disable-cocoa",
      "--disable-coreaudio",
      "--disable-vmnet",
      "--disable-hvf",
      "--disable-vnc",
      "--disable-slirp",
      "--disable-libusb",
      "--disable-libssh",
      "--disable-gnutls",
      "--disable-tools",
      "--audio-drv-list=",
      `--python=${pythonWrapper}`,
      `--ninja=${ninjaWrapper}`,
    ],
    output,
  );
  run(ninja, ["-j4", "qemu-system-x86_64"], output);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  cpSync(join(output, "qemu-system-x86_64"), join(prefix, "bin/qemu-system-x86_64"));
  cpSync(join(scratch, `qemu-${lock.version}/pc-bios`), join(prefix, "share"), { recursive: true });
  writeFileSync(join(root, "build/os-tools/qemu-build-path.txt"), `${scratch}\n`);
}
writeFileSync(
  join(root, "build/os-tools/emulator.json"),
  JSON.stringify(
    {
      binary: join(prefix, "bin/qemu-system-x86_64"),
      bios: join(prefix, "share"),
      version: lock.version,
      sourceSha256: lock.sha256,
      physicalAudioBackend: false,
      usbBackend: false,
    },
    null,
    2,
  ),
);
