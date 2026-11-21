import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { emulator } from "../os/vm.mjs";
import { kernelLock } from "./board.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";

// Runs the probe image's boot script under a real U-Boot (qemu_arm) on QEMU's
// ARM board, the same way the Live's distro boot does: find the bootable
// partition, source /boot/boot.scr.uimg. Checks both the XMP path and the
// stock fallback. A newer U-Boot than the Live's 2016 build: this validates
// the script's logic, not exact shell compatibility.

// Source from U-Boot's official GitHub mirror (ftp.denx.de was unreachable from
// the development network). Pinned on first download on 2026-11-10; this is not
// DENX's published tarball hash, which covers the .tar.bz2 on ftp.denx.de.
export const UBOOT = {
  version: "2021.07",
  url: "https://github.com/u-boot/u-boot/archive/refs/tags/v2021.07.tar.gz",
  sha256: "6cc8e2c9ed8898750c8979e0f75317818c1a7493b21f8ba4154f88888b675b5f",
  pinning: "trust on first download from the official GitHub mirror",
};

async function uboot() {
  const directory = join(root, "build/os-tools/u-boot");
  // "live-like": commands the Live's U-Boot 2016.05-inmusic lacks are removed too.
  const binary = join(directory, `u-boot-${UBOOT.version}-live-like.bin`);
  if (existsSync(binary)) return binary;
  await mkdir(directory, { recursive: true });
  const archive = join(root, `build/os-inputs/u-boot-${UBOOT.version}.tar.gz`);
  if (!existsSync(archive))
    execFileSync("curl", ["-fsSL", "--retry", "2", UBOOT.url, "-o", archive], { timeout: 600000 });
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== UBOOT.sha256)
    throw new Error("U-Boot source does not match its pinned hash");
  ensureBuilder(kernelLock());
  const out = await mkdtemp(join(directory, "build-"));
  // The Live's U-Boot sets fdtfile and board_name; give the test U-Boot the same.
  const script = [
    "mkdir -p /out /src",
    "tar -xzf /in-uboot.tgz -C /src",
    `cd /src/u-boot-${UBOOT.version}`,
    "make -s CROSS_COMPILE=arm-linux-gnueabihf- qemu_arm_defconfig",
    `printf '%s\\n' 'CONFIG_USE_PREBOOT=y' 'CONFIG_PREBOOT="setenv fdtfile rk3288-az01-mpc-acv8.dtb; setenv board_name az01; setenv fdt_addr_r 0x48000000; setenv ramdisk_addr_r 0x49000000"' 'CONFIG_BOOTDELAY=0' 'CONFIG_OF_LIBFDT=y' 'CONFIG_CMD_FDT=y' '# CONFIG_CMD_SETEXPR is not set' >> .config`,
    "make -s CROSS_COMPILE=arm-linux-gnueabihf- olddefconfig",
    // The Live's U-Boot has no setexpr (probe v5); refuse a test U-Boot that does.
    "! grep -q '^CONFIG_CMD_SETEXPR=y' .config",
    "make -s -j6 CROSS_COMPILE=arm-linux-gnueabihf- >/out/build.log 2>&1",
    "cp u-boot.bin /out/u-boot.bin",
  ].join("\n");
  await runContainer({
    image: kernelLock().builder.tag,
    copyIn: [{ from: archive, to: "/in-uboot.tgz" }],
    command: script,
    out,
    timeout: 3600000,
  });
  await copyFile(join(out, "u-boot.bin"), binary);
  return binary;
}

// A raw disk: MBR with one bootable Linux partition at 1 MiB holding the ext4 image.
function bootDisk(ext4, disk) {
  const image = readFileSync(ext4);
  const sectors = image.length / 512;
  const mbr = Buffer.alloc(512);
  mbr.writeUInt8(0x80, 446);
  mbr.writeUInt8(0x83, 450);
  mbr.writeUInt32LE(2048, 454);
  mbr.writeUInt32LE(sectors, 458);
  mbr.writeUInt16LE(0xaa55, 510);
  const fd = openSync(disk, "w");
  try {
    writeSync(fd, mbr, 0, 512, 0);
    writeSync(fd, image, 0, image.length, 2048 * 512);
  } finally {
    closeSync(fd);
  }
}

const MACHINE = ["-machine", "virt,highmem=off", "-cpu", "cortex-a15", "-m", "1024"];

// The device tree QEMU gives this exact machine, for the kernel hand-off run.
async function virtDtb(path) {
  const qemu = await emulator("armv7");
  const [flag, machine, ...rest] = MACHINE;
  execFileSync(
    qemu.binary,
    [
      "-no-user-config",
      "-nodefaults",
      flag,
      `${machine},dumpdtb=${path}`,
      ...rest,
      "-display",
      "none",
    ],
    { stdio: "ignore" },
  );
}

// `until` ends the run: by default U-Boot's hand-off; the kernel run waits for the probe.
function boot(firmware, disk, log, { seconds = 180, until = /Starting kernel/ } = {}) {
  return emulator("armv7").then(
    (qemu) =>
      new Promise((done, fail) => {
        const args = [
          "-no-user-config",
          "-nodefaults",
          ...MACHINE,
          "-display",
          "none",
          "-monitor",
          "none",
          "-serial",
          "stdio",
          "-nic",
          "none",
          "-no-reboot",
          "-bios",
          firmware,
          "-drive",
          `if=none,id=d0,file=${disk},format=raw,snapshot=on`,
          "-device",
          "virtio-blk-device,drive=d0",
        ];
        const child = spawn(qemu.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        const finish = () => child.kill("SIGKILL");
        child.stdout.on("data", (b) => {
          out += b.toString("utf8");
          if (until.test(out)) setTimeout(finish, 500);
        });
        child.stderr.on("data", (b) => {
          out += b.toString("utf8");
        });
        const timer = setTimeout(finish, seconds * 1000);
        child.once("error", fail);
        child.once("close", async () => {
          clearTimeout(timer);
          await writeFile(log, out);
          done(out);
        });
      }),
  );
}

export async function testBootScript() {
  const pointer = join(root, "artifacts/live-mk1/latest-probe-image.json");
  if (!existsSync(pointer))
    throw new Error("Build the probe image first: npm run live:probe-image");
  const imageDir = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  const firmware = await uboot();
  const run = await mkdtemp(join(root, "artifacts/live-mk1/uboot-test-"));
  // A copy of the probe rootfs whose boot.scr.uimg has the script part only (no
  // probe ramdisk part), to exercise the fallback.
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [
      { from: join(imageDir, "rootfs-xmp-probe.ext4"), to: "/in-rootfs.img" },
      { from: resolve(root, "os/live-mk1/xmp-probe.boot.cmd"), to: "/in-boot.cmd" },
    ],
    command: [
      "mkdir -p /out",
      "cp /in-rootfs.img /out/no-xmp-kernel.ext4",
      "mkimage -A arm -O linux -T script -C none -n xmp-probe -d /in-boot.cmd /tmp/script-only.uimg >/dev/null",
      "printf 'cd /boot\\nrm boot.scr.uimg\\nwrite /tmp/script-only.uimg boot.scr.uimg\\n' > /tmp/edit.debugfs",
      "debugfs -w -f /tmp/edit.debugfs /out/no-xmp-kernel.ext4 >/dev/null 2>&1",
    ].join("\n"),
    out: run,
    timeout: 1800000,
  });
  // A copy whose /boot/zImage is XMP's build of the same az01 kernel release and
  // whose device tree is QEMU's, so the kernel really runs after the hand-off and
  // shows whether it received the initramfs through /chosen. Akai's own kernel
  // cannot run on QEMU's board.
  const kernelDir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-kernel.json"), "utf8"))
      .directory,
  );
  await virtDtb(join(run, "virt.dtb"));
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [
      { from: join(imageDir, "rootfs-xmp-probe.ext4"), to: "/in-rootfs.img" },
      { from: join(kernelDir, "zImage"), to: "/in-zimage" },
      { from: join(run, "virt.dtb"), to: "/in-virt.dtb" },
    ],
    command: [
      "mkdir -p /out",
      "cp /in-rootfs.img /out/kernel-run.ext4",
      "printf 'cd /boot\\nrm zImage\\nwrite /in-zimage zImage\\nrm rk3288-az01-mpc-acv8.dtb\\nwrite /in-virt.dtb rk3288-az01-mpc-acv8.dtb\\n' > /tmp/edit.debugfs",
      "debugfs -w -f /tmp/edit.debugfs /out/kernel-run.ext4 >/dev/null 2>&1",
    ].join("\n"),
    out: run,
    timeout: 1800000,
  });
  bootDisk(join(run, "kernel-run.ext4"), join(run, "kernel.disk"));
  bootDisk(join(imageDir, "rootfs-xmp-probe.ext4"), join(run, "probe.disk"));
  bootDisk(join(run, "no-xmp-kernel.ext4"), join(run, "fallback.disk"));
  const probe = await boot(firmware, join(run, "probe.disk"), join(run, "probe.log"));
  const fallback = await boot(firmware, join(run, "fallback.disk"), join(run, "fallback.log"));
  const kernel = await boot(firmware, join(run, "kernel.disk"), join(run, "kernel.log"), {
    seconds: 420,
    until: /XMP-PROBE .*; halted|Kernel panic|Run \/sbin\/init/,
  });
  const result = {
    format: "xmp-uboot-script-test",
    version: 2,
    uboot: UBOOT,
    probe: {
      scriptFound: /boot\.scr\.uimg/.test(probe),
      startedProbe: probe.includes("XMP probe: starting"),
      chosenHasInitrd: /linux,initrd-start/.test(probe) && /linux,initrd-end/.test(probe),
      handedToKernel: probe.includes("Starting kernel"),
      fellBack: probe.includes("booting stock"),
    },
    kernel: {
      received: kernel.includes("Trying to unpack rootfs image as initramfs"),
      probeRan: kernel.includes("XMP-PROBE begin (probe mode)"),
      noInitrdError: !/INITRD:|Initramfs unpacking failed/.test(kernel),
    },
    fallback: {
      fellBack: fallback.includes("XMP probe files missing or invalid: booting stock"),
      startedProbe: fallback.includes("XMP probe: starting"),
      stockScriptHandedToKernel: fallback.includes("Starting kernel"),
    },
    scope:
      "Mainline U-Boot 2021.07 (qemu_arm) on QEMU virt, built without setexpr like the Live's. The Live's fdtfile and board_name are set, and fdt_addr_r and ramdisk_addr_r are defined at addresses that fit QEMU's memory map (the Live's own U-Boot defines them for its map). The Live runs an inMusic U-Boot 2016-era build.",
  };
  await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return { directory: run, result };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("U-Boot script test takes no options");
  const { directory, result } = await testBootScript();
  console.log(JSON.stringify({ directory: relative(root, directory), ...result }, null, 2));
}
