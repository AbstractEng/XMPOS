import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { kernelLock } from "./board.mjs";
import { runContainer } from "./container.mjs";
import { runQemu } from "./probe-vm.mjs";
import {
  analyseWav,
  EXPECTED_STARTUP,
  hardware,
  liveDtb,
  liveLikeDevices,
  PEAK_LIMIT,
  parsePpm,
  sentBytes,
} from "./session-vm.mjs";

// Phase 3 test: the full XMP Device app from the stick, on the Live-like QEMU
// machine (os/live-mk1/hardware.json) through the XMP stick loader:
//   - live-init, xmp-live-input and the app service start from the image;
//   - Chromium runs full-screen in cage on the 800x1280 screen, rotated 270;
//   - the twin's controller sends Play, a pad and Stop; the app plays the demo
//     song through the -12 dB capped ALSA chain to the "MPC Live Audio" card;
//   - the twin's power button switches the machine off cleanly.
// Real time (no -icount): Chromium is too slow under instruction counting.

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const DEVICE_SCRIPT = [
  "# wait until the app has connected to its hardware feed, then play",
  "0.5 wait /tmp/xmp-app-ready",
  "8.0 p1 90 52 7F 80 52 00",
  "9.0 p1 99 25 64",
  "9.3 p1 89 25 00",
  "20.0 p1 90 51 7F 80 51 00",
  "",
].join("\n");

async function makeMedia(run, systemImage) {
  await writeFile(join(run, "device-script.txt"), DEVICE_SCRIPT);
  const script = [
    "mkdir -p /out /w/stock/sbin",
    `cat > /w/mbr.py <<'PY'
import struct, sys, os
path, signature, kind = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16)
size = os.path.getsize(path)
with open(path, 'r+b') as f:
    f.seek(440); f.write(struct.pack('<I', signature))
    f.seek(446); f.write(struct.pack('<B3sB3sII', 0, bytes(3), kind, bytes(3), 2048, size // 512 - 2048))
    f.seek(510); f.write(b'\\x55\\xaa')
PY`,
    "truncate -s 32M /out/stock.img && python3 /w/mbr.py /out/stock.img 58504d31 83",
    "echo stock > /w/stock/sbin/marker && mkfs.ext4 -q -F -L rootfs -d /w/stock -E offset=1048576 /out/stock.img 31M",
    // A 2 GiB stick: the 860 MB image plus the 512 MiB data.img made at first start.
    "truncate -s 2G /out/stick.img && python3 /w/mbr.py /out/stick.img 58504d32 0c",
    "mkfs.vfat -F 32 -n XMP --offset 2048 /out/stick.img $((2047 * 1024)) >/dev/null",
    "mmd -i /out/stick.img@@1M ::xmp && mcopy -i /out/stick.img@@1M /in-system.img ::xmp/system.img",
    "mcopy -i /out/stick.img@@1M /in-device-script.txt ::xmp/twin-script.txt",
  ].join("\n");
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [
      { from: systemImage, to: "/in-system.img" },
      { from: join(run, "device-script.txt"), to: "/in-device-script.txt" },
    ],
    command: script,
    out: run,
    timeout: 1800000,
  });
}

async function readStick(run) {
  const files = {
    device: "xmp/logs/device.txt",
    input: "xmp/logs/input.txt",
    received: "xmp/twin/controller-received.txt",
    twin: "xmp/twin/twin-log.txt",
  };
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [{ from: join(run, "stick.img"), to: "/in-stick.img" }],
    command: [
      "mkdir -p /out",
      ...Object.entries(files).map(
        ([name, path]) =>
          `mcopy -n -i /in-stick.img@@1M ::${path} /out/stick.${name} 2>/dev/null || : > /out/stick.${name}`,
      ),
      "(mdir -i /in-stick.img@@1M ::xmp/data.img >/dev/null 2>&1 && echo yes || echo no) > /out/stick.data",
    ].join("\n"),
    out: run,
    timeout: 600000,
  });
  const read = (name) => readFile(join(run, `stick.${name}`), "utf8");
  return {
    device: await read("device"),
    input: await read("input"),
    received: await read("received"),
    twin: await read("twin"),
    dataImage: (await read("data")).trim() === "yes",
  };
}

export async function testDeviceInVm() {
  const hw = hardware();
  const pointer = join(root, "artifacts/live-mk1/latest-device-image.json");
  const loaderPointer = join(root, "artifacts/live-mk1/latest-loader-image.json");
  if (!existsSync(pointer))
    throw new Error("Build the Device image first: npm run live:device-image");
  if (!existsSync(loaderPointer))
    throw new Error("Build the loader image first: npm run live:loader-image");
  const imageDir = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  const loaderDir = resolve(root, JSON.parse(await readFile(loaderPointer, "utf8")).directory);
  const kernelDir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-kernel.json"), "utf8"))
      .directory,
  );
  const run = await mkdtemp(join(root, "artifacts/live-mk1/device-vm-"));
  await makeMedia(run, join(imageDir, "system-device-emulator.img"));
  const dtb = await liveDtb(run, hw);
  const stock = join(run, "stock.img");
  const before = sha(await readFile(stock));
  kernelLock();
  const boot = await runQemu({
    zImage: join(kernelDir, "zImage"),
    initramfs: join(loaderDir, "probe.cpio.gz"),
    disks: [stock],
    log: join(run, "device.log"),
    seconds: 3000,
    extra: ` root=PARTUUID=58504d31-01 rootwait ro isolcpus=${hw.board.isolatedCpus} dummy_hcd.num=3`,
    smp: hw.board.cpus,
    memoryMiB: hw.board.memoryMiB,
    dtb,
    qemuArgs: liveLikeDevices(hw, join(run, "stick.img"), join(run, "device.wav")),
    pressPowerWhen: /XMP-TWIN script done/,
    screenshots: [
      { when: /XMP-TWIN script: \/tmp\/xmp-app-ready appeared/, file: join(run, "app.ppm") },
      { when: /XMP-TWIN script: sent 3 bytes to port 1 \(99 25/, file: join(run, "playing.ppm") },
      { when: /XMP-TWIN script done/, file: join(run, "played.ppm") },
    ],
  });
  const after = sha(await readFile(stock));
  const stick = await readStick(run);
  const wavBytes = existsSync(join(run, "device.wav"))
    ? await readFile(join(run, "device.wav"))
    : Buffer.alloc(0);
  const wav = wavBytes.length > 44 ? analyseWav(wavBytes) : null;
  const shot = existsSync(join(run, "played.ppm"))
    ? parsePpm(await readFile(join(run, "played.ppm")))
    : null;
  // A rendered app: many distinct colours, mostly not black.
  let colours = 0,
    lit = 0;
  if (shot) {
    const seen = new Set();
    for (let y = 0; y < shot.height; y += 8)
      for (let x = 0; x < shot.width; x += 8) {
        const [r, g, b] = shot.pixel(x, y);
        seen.add((r << 16) | (g << 8) | b);
        if (r + g + b > 30) lit++;
      }
    colours = seen.size;
    lit /= Math.ceil(shot.height / 8) * Math.ceil(shot.width / 8);
  }
  const sent = sentBytes(stick.received);
  const result = {
    format: "xmp-device-vm-test",
    version: 1,
    boot: {
      loaderStartedXmp: boot.log.includes("XMP-LOADER starting the XMP system from the stick"),
      liveBoardAccepted: stick.device.includes("board linux,dummy-virt inmusic,acv8"),
      loopbackOnly: stick.device.includes("network interfaces up besides loopback: none"),
      dataImageOnStick: stick.dataImage,
    },
    controls: {
      inputServiceAllowedCard: /audio card \d+ allowed \(MPC Live Audio\)/.test(stick.input),
      startupBytesExactOnPrivatePort: sent.private === EXPECTED_STARTUP && sent.public === "",
      appConnected: stick.device.includes("app connected to /hardware"),
    },
    display: {
      cageStarted: stick.device.includes("cage started"),
      turnedToLandscape: /display \S+ turned to landscape \(ok\)/.test(stick.device),
      appRendered:
        !!shot && shot.width === hw.display.framebuffer.xres && colours > 20 && lit > 0.2,
    },
    audio: {
      cappedChain: /audio: card \d+ through the -12 dB cap/.test(stick.device),
      playedSound: !!wav && wav.peak > 0.01,
      peakWithinMinus12dBFS: !!wav && wav.peak <= PEAK_LIMIT + 1 / 32768,
    },
    shutdown: {
      powerButtonHandled:
        stick.input.includes("power button") && stick.device.includes("power button"),
      switchedOff: /XMP-DEVICE session ended; powering off/.test(boot.log),
      rootDiskUnchanged: after === before,
    },
    measured: {
      colours,
      litFraction: Number(lit.toFixed(3)),
      peakDbfs: wav ? Number((20 * Math.log10(Math.max(wav.peak, 1e-9))).toFixed(2)) : null,
    },
    scope:
      "QEMU virt shaped like the Live, the official az01 kernel source, the XMP stick loader and the Device system image (emulator variant: the same image plus the Live twin). Software rendering on a virtio GPU stands in for the Live's DSI panel; QEMU's usb-audio (patched ID and name) for its audio card.",
  };
  await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return { directory: run, result };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("Device VM test takes no options");
  const { directory, result } = await testDeviceInVm();
  console.log(JSON.stringify({ directory: relative(root, directory), ...result }, null, 2));
}
