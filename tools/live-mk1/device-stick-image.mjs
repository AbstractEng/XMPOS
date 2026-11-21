import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { armElf } from "../os/arm-build.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";
import { ARM_DEVICE_IMAGE } from "./device-build.mjs";
import { verifyG1Archives } from "./g1-userspace.mjs";
import { alsaLibStatic } from "./session-image.mjs";

// Phase 3: the full XMP Device app as a system image for the XMP stick loader
// on the owner's MPC Live Mk1 (AGENTS.md authorizations 2-4). It is the ARM
// Device rootfs (pinned Alpine with Node, Chromium and the kiosk display stack)
// plus, from this repository only:
//   /sbin/init                      os/live-mk1/live-init
//   /opt/xmp/live.mjs               os/guest/live.ts (the app service)
//   /usr/lib/xmp/xmp-live-input     native/src/live_input.cpp
// The emulator variant also carries the Live twin. No Akai files are included.
//
//   npm run live:device-image   ->  artifacts/live-mk1/device-image-*/system-device.img

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function buildDeviceStickImage() {
  const sourceHash = buildIdentity();
  const rootfs = join(root, ARM_DEVICE_IMAGE, "rootfs.cpio.gz");
  if (!existsSync(rootfs))
    throw new Error("Build the ARM Device image first: npm run live:device:build");
  const alsa = (await verifyG1Archives()).find((a) => a.id === "alsa-lib");
  const probe = {
    builder: { tag: "xmp-live-mk1-probe:1", dockerfile: "os/live-mk1/probe.Dockerfile" },
  };
  const imageId = ensureBuilder(probe);
  const alsaStatic = await alsaLibStatic(alsa, imageId);
  execFileSync(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "os/vite.config.ts"],
    {
      cwd: root,
      env: { ...process.env, XMP_LIVE_BUILD: "1" },
      stdio: "ignore",
      timeout: 300000,
    },
  );
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const out = await mkdtemp(join(root, "artifacts/live-mk1/device-image-"));
  const prefix = "/opt/g1";
  const cxx = `arm-linux-gnueabihf-g++ -std=c++17 -O2 -static -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard -Wall -Wextra -Werror -Inative/include -I/stage${prefix}/include`;
  const cc = `arm-linux-gnueabihf-gcc -std=gnu11 -O2 -static -mcpu=cortex-a17 -mfloat-abi=hard -Wall -Wextra -Werror -I/stage${prefix}/include`;
  const libs = `-L/stage${prefix}/lib -lasound -lpthread -lm -ldl -lrt`;
  const tree = (name) => [
    // Device nodes in the archive cannot be created here (no capabilities) and
    // are not needed: the kernel's devtmpfs provides /dev at boot.
    `mkdir -p /w/${name}`,
    `(cd /w/${name} && gzip -dc /in-rootfs.cpio.gz | cpio -idm --quiet --no-absolute-filenames 2>/w/${name}.cpio.log) || grep -v "Cannot mknod" /w/${name}.cpio.log | grep . && exit 1 || true`,
    `test -x /w/${name}/usr/lib/chromium/chromium && test -x /w/${name}/usr/bin/cage && test -x /w/${name}/usr/bin/node`,
    // The loader starts /sbin/init: XMP's Live init replaces busybox's.
    `rm -f /w/${name}/sbin/init && install -m 755 os/live-mk1/live-init /w/${name}/sbin/init`,
    `install -m 644 /in-live.mjs /w/${name}/opt/xmp/live.mjs`,
    `mkdir -p /w/${name}/usr/lib/xmp /w/${name}/media/xmp /w/${name}/data && install -m 755 /w/xmp-live-input /w/${name}/usr/lib/xmp/xmp-live-input`,
    `echo "XMP Device for the MPC Live Mk1 (${name}), source ${sourceHash}" > /w/${name}/etc/xmp-release`,
  ];
  const script = [
    "mkdir -p /out /stage /w",
    "tar -C /stage -xf /in-alsa-lib-static.tar",
    "cd /xmp",
    `${cxx} native/src/live_input.cpp ${libs} -o /w/xmp-live-input 2>/out/compile.log`,
    `${cc} os/live-mk1/live-twin.c ${libs} -o /w/live-twin 2>>/out/compile.log`,
    "arm-linux-gnueabihf-strip /w/xmp-live-input /w/live-twin",
    ...tree("live"),
    ...tree("emulator"),
    "install -m 755 /w/live-twin /w/emulator/usr/lib/xmp/xmp-live-twin",
    "cp /w/xmp-live-input /out/",
    // Size: the tree plus 25% and 64 MiB of headroom.
    "for n in live emulator; do size=$(du -sm /w/$n | cut -f1); size=$((size + size / 4 + 64)); truncate -s ${size}M /out/system-device-$n.img && mkfs.ext4 -q -F -L xmpdevice -m 0 -d /w/$n /out/system-device-$n.img; done",
    "mv /out/system-device-live.img /out/system-device.img",
    "e2fsck -fn /out/system-device.img > /out/fsck.log 2>&1",
  ].join("\n");
  await runContainer({
    image: probe.builder.tag,
    copyIn: [
      { from: alsaStatic.tarball, to: "/in-alsa-lib-static.tar" },
      { from: rootfs, to: "/in-rootfs.cpio.gz" },
      { from: join(root, "build/live-app/live.mjs"), to: "/in-live.mjs" },
      { from: resolve(root, "native"), to: "/xmp-native" },
      { from: resolve(root, "os/live-mk1"), to: "/xmp-os" },
    ],
    command: `mkdir -p /xmp/os && cp -R /xmp-native /xmp/native && cp -R /xmp-os /xmp/os/live-mk1\n${script}`,
    out,
    timeout: 3600000,
  });
  const files = {};
  for (const name of ["system-device.img", "system-device-emulator.img", "xmp-live-input"]) {
    const bytes = await readFile(join(out, name));
    files[name] = { sha256: sha(bytes), bytes: bytes.length };
    if (name === "xmp-live-input") Object.assign(files[name], armElf(bytes));
  }
  const manifest = {
    format: "xmp-live-mk1-device-image",
    version: 1,
    sourceHash,
    base: relative(root, rootfs),
    files,
    stickPath: "xmp/system.img",
    containsVendorFiles: false,
    copiedToDevice: false,
  };
  if (sourceHash !== buildIdentity())
    throw new Error("Source changed during the Device image build");
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, "artifacts/live-mk1/latest-device-image.json"),
    `${JSON.stringify({ directory: relative(root, out), sourceHash })}\n`,
  );
  return { directory: out, manifest };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("Device stick image build takes no options");
  const { directory, manifest } = await buildDeviceStickImage();
  console.log(
    JSON.stringify({ directory: relative(root, directory), files: manifest.files }, null, 2),
  );
}
