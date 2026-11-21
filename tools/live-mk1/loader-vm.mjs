import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";
import { runContainer } from "./container.mjs";
import { runQemu } from "./probe-vm.mjs";

// Runs the XMP stick loader initramfs on QEMU's ARM board with the official
// az01 kernel. A stand-in "Akai" root disk (MBR signature 0x58504d31, so
// PARTUUID 58504d31-01) is named by root= exactly as on the Live. Three cases:
// no stick, a stick with an XMP system image, and a stick without one.

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const STOCK_PARTUUID = "58504d31-01";

async function testInit(role, out) {
  const zig = await vmCompiler();
  execFileSync(
    zig,
    [
      "cc",
      "-target",
      "arm-linux-musleabihf",
      "-static",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-DXMP_TEST_ROLE="${role}"`,
      "os/live-mk1/loader-test-init.c",
      "-o",
      out,
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: join(root, "build/arm/zig-cache"),
        ZIG_LOCAL_CACHE_DIR: join(root, "build/arm/zig-local-loader-test"),
      },
    },
  );
}

async function makeDisks(run) {
  await testInit("stock", join(run, "stock-init"));
  await testInit("xmp", join(run, "xmp-init"));
  const script = [
    "mkdir -p /out /w/stock/sbin /w/xmp/sbin /w/xmp/proc /w/xmp/sys /w/xmp/dev /w/xmp/media /w/stock/proc /w/stock/sys /w/stock/dev",
    "cp /in-stock-init /w/stock/sbin/init && cp /in-xmp-init /w/xmp/sbin/init && chmod 755 /w/stock/sbin/init /w/xmp/sbin/init",
    // A 64 MiB MBR disk with one partition at 1 MiB: mbr.py <path> <signature> <type>.
    `cat > /w/mbr.py <<'PY'
import struct, sys
path, signature, kind = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16)
size = 64 * 1024 * 1024
with open(path, 'r+b') as f:
    f.seek(440); f.write(struct.pack('<I', signature))
    f.seek(446); f.write(struct.pack('<B3sB3sII', 0, bytes(3), kind, bytes(3), 2048, size // 512 - 2048))
    f.seek(510); f.write(b'\\x55\\xaa')
PY`,
    'mk() { truncate -s 64M "$1"; }',
    'mbr_stock() { python3 /w/mbr.py "$1" 58504d31 83; }',
    'mbr_fat() { python3 /w/mbr.py "$1" 58504d32 0c; }',
    // Stand-in Akai root: ext4 in partition 1.
    "mk /out/stock.img && mbr_stock /out/stock.img",
    "mkfs.ext4 -q -F -L rootfs -d /w/stock -E offset=1048576 /out/stock.img 62M",
    // XMP system image and the stick holding it.
    "truncate -s 16M /w/system.img && mkfs.ext4 -q -F -L xmpsys -d /w/xmp /w/system.img",
    "mk /out/stick.img && mbr_fat /out/stick.img && mkfs.vfat -F 32 -n XMP --offset 2048 /out/stick.img $((62 * 1024)) >/dev/null",
    "mmd -i /out/stick.img@@1M ::xmp && mcopy -i /out/stick.img@@1M /w/system.img ::xmp/system.img",
    "mk /out/empty-stick.img && mbr_fat /out/empty-stick.img && mkfs.vfat -F 32 -n XMP --offset 2048 /out/empty-stick.img $((62 * 1024)) >/dev/null",
  ].join("\n");
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [
      { from: join(run, "stock-init"), to: "/in-stock-init" },
      { from: join(run, "xmp-init"), to: "/in-xmp-init" },
    ],
    command: script,
    out: run,
    timeout: 900000,
  });
}

export async function testLoaderInVm() {
  const pointer = join(root, "artifacts/live-mk1/latest-loader-image.json");
  if (!existsSync(pointer))
    throw new Error("Build the loader image first: npm run live:loader-image");
  const imageDir = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  const kernelDir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-kernel.json"), "utf8"))
      .directory,
  );
  const run = await mkdtemp(join(root, "artifacts/live-mk1/loader-vm-"));
  await makeDisks(run);
  const stock = join(run, "stock.img");
  const before = sha(await readFile(stock));
  const boot = (name, disks) =>
    runQemu({
      zImage: join(kernelDir, "zImage"),
      initramfs: join(imageDir, "probe.cpio.gz"),
      disks,
      log: join(run, `${name}.log`),
      seconds: 300,
      extra: ` root=PARTUUID=${STOCK_PARTUUID} rootwait ro`,
    });
  const noStick = await boot("no-stick", [stock]);
  const afterNoStick = sha(await readFile(stock));
  const withSystem = await boot("with-system", [stock, join(run, "stick.img")]);
  const afterSystem = sha(await readFile(stock));
  const emptyStick = await boot("empty-stick", [stock, join(run, "empty-stick.img")]);
  const afterEmpty = sha(await readFile(stock));
  const result = {
    format: "xmp-loader-vm-test",
    version: 1,
    noStick: {
      handedOver: noStick.log.includes("XMP-LOADER handing over to Akai's system"),
      mountedReadOnly: /XMP-LOADER root \/dev\/vd[a-z]1 mounted read-only/.test(noStick.log),
      stockInitRan: /LOADER-TEST stock pid=1 root_ro=1 root_writable=0/.test(noStick.log),
      rootDiskUnchanged: afterNoStick === before,
    },
    withSystem: {
      startedXmp: withSystem.log.includes("XMP-LOADER starting the XMP system from the stick"),
      xmpInitRan: /LOADER-TEST xmp pid=1 root_ro=0 root_writable=1 stick=1 proc=1/.test(
        withSystem.log,
      ),
      neverMountedRoot: !withSystem.log.includes("mounted read-only"),
      rootDiskUnchanged: afterSystem === before,
    },
    emptyStick: {
      noticedNoSystem: emptyStick.log.includes("has no xmp/system.img"),
      handedOver: /LOADER-TEST stock pid=1 root_ro=1/.test(emptyStick.log),
      rootDiskUnchanged: afterEmpty === before,
    },
    scope:
      "QEMU virt with the official az01 kernel; virtio disks stand in for the Live's eMMC rootfs and the USB stick. On the Live the loader also requires root= to be on the eMMC controller (ff0f0000).",
  };
  await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return { directory: run, result };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("Loader VM test takes no options");
  const { directory, result } = await testLoaderInVm();
  console.log(JSON.stringify({ directory: relative(root, directory), ...result }, null, 2));
}
