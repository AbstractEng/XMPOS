import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Builds qemu-system-arm from the same pinned QEMU source as the x86 emulator.
// No USB passthrough, network, display or host audio backend is compiled in.
// XMP patches (os/live-mk1/qemu-*.patch) are applied to the verified source:
// qemu-usb-audio-ids.patch lets the emulated USB audio device carry the Live
// audio card's USB ID and name, so the Live session binary can be tested.
const root = resolve(import.meta.dirname, "../..");
const lock = JSON.parse(readFileSync(join(root, "os/emulator.lock.json"), "utf8"));
if (process.argv.length > 2) throw new Error("No emulator or device overrides supported");
const run = (program, args, cwd = root) => {
  const result = spawnSync(program, args, { cwd, stdio: "inherit", timeout: 3600000 });
  if (result.status !== 0)
    throw new Error(`${program} failed: ${result.error?.message ?? result.status}`);
};
const prefix = join(root, "build/os-tools/qemu");
const binary = join(prefix, "bin/qemu-system-arm");
const PATCHES = ["os/live-mk1/qemu-usb-audio-ids.patch"];
const patchHash = createHash("sha256")
  .update(PATCHES.map((p) => readFileSync(join(root, p), "utf8")).join("\n"))
  .digest("hex");
const recorded = (() => {
  try {
    return JSON.parse(readFileSync(join(root, "build/os-tools/emulator-arm.json"), "utf8"))
      .patchesSha256;
  } catch {
    return null;
  }
})();
if (!existsSync(binary) || recorded !== patchHash) {
  const python = join(root, ".venv/bin/python"),
    ninja = join(root, ".venv/bin/ninja");
  if (!existsSync(python) || !existsSync(ninja)) throw new Error("Run npm run bootstrap first");
  for (const dependency of ["glib-2.0", "pixman-1"]) {
    const check = spawnSync("pkg-config", ["--exists", dependency], { timeout: 15000 });
    if (check.status !== 0)
      throw new Error(
        "ARM QEMU needs pkg-config, GLib and pixman development packages on the host",
      );
  }
  run(python, ["-m", "pip", "install", `meson==${lock.meson}`]);
  mkdirSync(join(root, "build/os-inputs"), { recursive: true });
  const archive = join(root, "build/os-inputs/qemu-8.2.10.tar.xz");
  if (!existsSync(archive)) run("curl", ["-fsSL", "--retry", "2", lock.url, "-o", archive]);
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== lock.sha256)
    throw new Error("QEMU source integrity mismatch");
  // QEMU's build does not support paths containing spaces.
  const scratch = mkdtempSync(join(tmpdir(), "xmp-qemu-arm-"));
  run("tar", ["-xf", archive, "-C", scratch]);
  for (const patch of PATCHES)
    run(
      "patch",
      ["-p1", "--forward", "-i", join(root, patch)],
      join(scratch, `qemu-${lock.version}`),
    );
  // configure cannot quote interpreter paths containing spaces; use wrappers.
  const wrap = (name, target) => {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\nexec "${target}" "$@"\n`, { mode: 0o755 });
    return path;
  };
  const pythonWrapper = wrap("python3", python);
  const ninjaWrapper = wrap("ninja", ninja);
  const output = join(scratch, "out");
  mkdirSync(output);
  run(
    join(scratch, `qemu-${lock.version}/configure`),
    [
      "--target-list=arm-softmmu",
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
      "--disable-usb-redir",
      "--disable-libssh",
      "--disable-gnutls",
      "--disable-tools",
      "--audio-drv-list=",
      `--python=${pythonWrapper}`,
      `--ninja=${ninjaWrapper}`,
    ],
    output,
  );
  run(ninjaWrapper, ["-j4", "qemu-system-arm"], output);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  cpSync(join(output, "qemu-system-arm"), binary);
}
run(binary, ["--version"]);
writeFileSync(
  join(root, "build/os-tools/emulator-arm.json"),
  `${JSON.stringify(
    {
      binary,
      version: lock.version,
      sourceSha256: lock.sha256,
      targets: ["arm-softmmu"],
      physicalAudioBackend: false,
      usbBackend: false,
      patches: PATCHES,
      patchesSha256: patchHash,
    },
    null,
    2,
  )}\n`,
);
