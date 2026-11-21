import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  developmentGraph,
  encodeGraph,
  engineProfile,
} from "../../acceptance/lib/engine-target.mjs";
import { buildIdentity, root, sha256 } from "../../acceptance/lib/workspace.mjs";
import { armElf, buildArm } from "../os/arm-build.mjs";
import { emulator } from "../os/vm.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";
import { classifyCompatible, kernelLock } from "./board.mjs";

// Boots the official az01 kernel on the Mac's pinned qemu-system-arm (generic
// "virt" board) with a throwaway RAM-only initramfs. No disk, network, host
// share, USB passthrough or instrument is attached.

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const EPOCH = 1704067200;

// Deterministic newc cpio of a staged directory (regular files, dirs, symlinks).
export async function newcArchive(stage) {
  const entries = [];
  const walk = async (dir, prefix) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push([name, 0o040755, Buffer.alloc(0)]);
        await walk(path, name);
      } else if (entry.isSymbolicLink()) {
        const { readlink } = await import("node:fs/promises");
        entries.push([name, 0o120777, Buffer.from(await readlink(path))]);
      } else if (entry.isFile()) {
        const executable = name === "init" || /(^|\/)bin\//.test(name);
        entries.push([name, executable ? 0o100755 : 0o100644, await readFile(path)]);
      }
    }
  };
  await walk(stage, "");
  const chunks = [];
  const pad = (n) => Buffer.alloc((4 - (n % 4)) % 4);
  const record = (name, mode, data, index) => {
    const encoded = Buffer.from(`${name}\0`);
    const fields = [index, mode, 0, 0, 1, EPOCH, data.length, 0, 0, 0, 0, encoded.length, 0];
    const header = Buffer.from(
      `070701${fields.map((v) => v.toString(16).padStart(8, "0")).join("")}`,
    );
    chunks.push(header, encoded, pad(header.length + encoded.length), data, pad(data.length));
  };
  entries.forEach(([name, mode, data], i) => {
    record(name, mode, data, i + 1);
  });
  record("TRAILER!!!", 0, Buffer.alloc(0), entries.length + 1);
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

// Original one-second 440 Hz test tone, 48 kHz stereo PCM16.
export function testTone() {
  const rate = 48000;
  const frames = rate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// RMS of PCM16 samples in a RIFF WAV written by QEMU's wav audiodev.
export function wavRms(bytes) {
  const data = bytes.indexOf(Buffer.from("data"));
  if (bytes.length < 44 || data < 0) return 0;
  let sum = 0;
  let count = 0;
  for (let i = data + 8; i + 1 < bytes.length; i += 2) {
    const v = bytes.readInt16LE(i) / 32768;
    sum += v * v;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

// Original timing graph: one 20 ms decaying 880 Hz burst on every quarter
// note at 120 BPM (one-shot notes, duration 0), so onsets fall every 0.500 s.
export function timingGraph() {
  const pcm = Array.from({ length: 960 }, (_, i) =>
    Number((Math.sin((i * 2 * Math.PI * 880) / 48000) * 0.6 * (1 - i / 960)).toFixed(6)),
  );
  const graph = {
    bpm: 120,
    loopTicks: 3840,
    samples: [pcm],
    trackGains: Array(8).fill(1),
    master: 1,
    events: [0, 960, 1920, 2880].map((tick, i) => ({
      tick,
      sample: 0,
      id: i + 1,
      duration: 0,
      velocity: 1,
      track: 0,
    })),
  };
  const projectDocument = JSON.stringify({
    format: "xmp-engine-graph",
    version: 1,
    profileId: engineProfile.id,
    ...graph,
  });
  return { ...graph, projectHash: sha256(projectDocument), projectDocument };
}

// Onsets in a captured stereo PCM16 WAV: a frame above `threshold` after at
// least `quietSeconds` below it. Returns onset times in seconds.
export function onsets(bytes, threshold = 0.1, quietSeconds = 0.5) {
  const data = bytes.indexOf(Buffer.from("data"));
  if (data < 0) return [];
  const start = data + 8;
  const frames = Math.floor((bytes.length - start) / 4);
  const quiet = Math.round(quietSeconds * 48000);
  const found = [];
  let silent = quiet;
  for (let f = 0; f < frames; f++) {
    const l = Math.abs(bytes.readInt16LE(start + f * 4)) / 32768;
    const r = Math.abs(bytes.readInt16LE(start + f * 4 + 2)) / 32768;
    if (Math.max(l, r) >= threshold) {
      if (silent >= quiet) found.push(f / 48000);
      silent = 0;
    } else silent++;
  }
  return found;
}

async function stagePayload(stage) {
  let latest = existsSync(join(root, "artifacts/arm/latest.json"))
    ? JSON.parse(await readFile(join(root, "artifacts/arm/latest.json"), "utf8"))
    : null;
  latest =
    !latest || latest.sourceHash !== buildIdentity()
      ? (await buildArm()).directory
      : latest.directory;
  const arm = JSON.parse(await readFile(join(latest, "manifest.json"), "utf8"));
  await mkdir(join(stage, "xmp/bin"), { recursive: true });
  for (const dir of ["proc", "sys", "dev", "tmp"]) await mkdir(join(stage, dir));
  for (const name of ["xmp_sampler_test", "xmp_engine_test"]) {
    const bytes = await readFile(join(latest, "bin", name));
    if (sha(bytes) !== arm.binaries[name].sha256) throw new Error(`${name} hash mismatch`);
    await copyFile(join(latest, "bin", name), join(stage, "xmp/bin", name));
  }
  await writeFile(join(stage, "xmp/tone.wav"), testTone());
  // XMP's continuous ALSA engine (built against the G1 alsa-lib) and its graph.
  const enginePointer = join(root, "artifacts/live-mk1/latest-alsa-engine.json");
  if (!existsSync(enginePointer))
    throw new Error("Build the ALSA engine first: npm run live:alsa-engine");
  const engineDir = resolve(root, JSON.parse(await readFile(enginePointer, "utf8")).directory);
  const engineManifest = JSON.parse(await readFile(join(engineDir, "manifest.json"), "utf8"));
  const engineBytes = await readFile(join(engineDir, "xmp_alsa_engine"));
  if (sha(engineBytes) !== engineManifest.binary.sha256)
    throw new Error("ALSA engine hash mismatch");
  await writeFile(join(stage, "xmp/bin/xmp_alsa_engine"), engineBytes);
  await writeFile(join(stage, "xmp/timing.xmph"), encodeGraph(timingGraph()));
  await writeFile(join(stage, "xmp/engine.xmph"), encodeGraph(developmentGraph()));
  // Hardware-facing userspace built from the official G1 sources.
  const g1Pointer = join(root, "artifacts/live-mk1/latest-g1-userspace.json");
  if (!existsSync(g1Pointer))
    throw new Error("Build the G1 userspace first: npm run live:g1-userspace");
  const g1Dir = resolve(root, JSON.parse(await readFile(g1Pointer, "utf8")).directory);
  const g1 = JSON.parse(await readFile(join(g1Dir, "manifest.json"), "utf8"));
  await mkdir(join(stage, "opt/g1/bin"), { recursive: true });
  for (const [name, entry] of Object.entries(g1.binaries)) {
    const bytes = await readFile(join(g1Dir, "bin", name));
    if (sha(bytes) !== entry.sha256) throw new Error(`G1 ${name} hash mismatch`);
    await copyFile(join(g1Dir, "bin", name), join(stage, "opt/g1/bin", name));
  }
  execFileSync("cp", ["-R", join(g1Dir, "share"), join(stage, "opt/g1/share")]);
  const zig = await vmCompiler();
  execFileSync(
    zig,
    [
      "cc",
      "-target",
      "arm-linux-musleabihf",
      "-mcpu=cortex_a17",
      "-static",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "os/live-mk1/guest-init.c",
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
  return {
    alsaEngine: { directory: relative(root, engineDir), sha256: engineManifest.binary.sha256 },
    armSourceHash: arm.sourceHash,
    initSha256: sha(init),
    g1: { directory: relative(root, g1Dir), binaries: Object.keys(g1.binaries) },
  };
}

export function parseBootLog(log) {
  const decode = (hex) => Buffer.from(hex, "hex").toString("utf8");
  const files = {};
  const lists = {};
  const tests = {};
  for (const line of log.split(/\r?\n/)) {
    let m = /^XMP-FILE (\S+) ([0-9a-f]*)$/.exec(line);
    if (m) files[m[1]] = decode(m[2]);
    m = /^XMP-LIST (\S+) ([0-9a-f]*)$/.exec(line);
    if (m) lists[m[1]] = decode(m[2]).split("\n").filter(Boolean);
    m = /^XMP-MISSING (\S+) (\d+)$/.exec(line);
    if (m) files[m[1]] = null;
    m = /^XMP-TEST (\S+) (\d+)$/.exec(line);
    if (m) tests[m[1]] = { exit: Number(m[2]), output: "" };
    m = /^XMP-OUTPUT (\S+) ([0-9a-f]*)$/.exec(line);
    if (m && tests[m[1]]) tests[m[1]].output = decode(m[2]);
  }
  return {
    began: log.includes("XMP-LIVE-BOOT begin"),
    ended: log.includes("XMP-LIVE-BOOT end"),
    files,
    lists,
    tests,
  };
}

export async function bootKernel() {
  const lock = kernelLock();
  const pointer = join(root, "artifacts/live-mk1/latest-kernel.json");
  if (!existsSync(pointer)) throw new Error("Build the kernel first: npm run live:kernel -- build");
  const kernelDir = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  const kernel = JSON.parse(await readFile(join(kernelDir, "manifest.json"), "utf8"));
  const zImage = join(kernelDir, "zImage");
  if (sha(await readFile(zImage)) !== kernel.zImage.sha256)
    throw new Error("zImage does not match its manifest");
  const run = await mkdtemp(join(root, "artifacts/live-mk1/boot-"));
  const stage = join(run, "rootfs");
  await mkdir(stage);
  const payload = await stagePayload(stage);
  const initramfs = join(run, "initramfs.gz");
  await writeFile(initramfs, await newcArchive(stage));
  const qemu = await emulator("armv7");
  const vm = lock.vm;
  const audio = join(run, "usb-audio.wav");
  if (/[,\r\n]/.test(audio)) throw new Error("Unsafe QEMU path");
  const args = [
    "-no-user-config",
    "-nodefaults",
    "-machine",
    // The 32-bit az01 kernel has no LPAE: keep PCIe and RAM below 4 GiB.
    `${vm.machine},highmem=off`,
    "-accel",
    "tcg",
    "-cpu",
    vm.cpu,
    "-smp",
    String(vm.smp),
    "-m",
    String(vm.memoryMiB),
    "-display",
    "none",
    "-monitor",
    "none",
    "-serial",
    "stdio",
    "-nic",
    "none",
    "-no-reboot",
    "-kernel",
    zImage,
    "-initrd",
    initramfs,
    "-append",
    "console=ttyAMA0 rdinit=/init panic=-1 quiet loglevel=3",
    "-audiodev",
    `wav,id=snd0,path=${audio},out.frequency=48000,out.channels=2,out.format=s16`,
    "-device",
    "qemu-xhci,id=xhci",
    "-device",
    "usb-audio,bus=xhci.0,audiodev=snd0",
  ];
  const started = Date.now();
  const { log, stderr, code } = await new Promise((done, fail) => {
    const child = spawn(qemu.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
      if (out.length > 4 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (b) => {
      err += b.toString("utf8").slice(0, 65536);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), vm.bootLimitSeconds * 1000);
    child.once("error", fail);
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      done({ log: out, stderr: err, code: exit ?? signal });
    });
  });
  await writeFile(join(run, "serial.log"), log);
  const parsed = parseBootLog(log);
  const compatible = (parsed.files["/proc/device-tree/compatible"] ?? "")
    .split("\0")
    .filter(Boolean);
  const capture = existsSync(audio) ? await readFile(audio) : Buffer.alloc(0);
  const version = execFileSync(qemu.binary, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const report = {
    format: "xmp-live-mk1-boot",
    version: 2,
    sourceHash: buildIdentity(),
    kernel: {
      directory: relative(root, kernelDir),
      zImageSha256: kernel.zImage.sha256,
      release: kernel.kernelRelease,
    },
    payload,
    qemu: version,
    qemuExit: code,
    qemuErrors: stderr.trim(),
    seconds: Math.round((Date.now() - started) / 1000),
    machine: { ...vm },
    boot: {
      began: parsed.began,
      ended: parsed.ended,
      version: parsed.files["/proc/version"]?.trim() ?? null,
      realtime: parsed.files["/sys/kernel/realtime"]?.trim() ?? null,
      model: parsed.files["/proc/device-tree/model"]?.replace(/\0/g, "") ?? null,
      compatible,
      identity: classifyCompatible(compatible, lock),
      soundCards: parsed.files["/proc/asound/cards"] ?? null,
      usbDrivers: parsed.lists["/sys/bus/usb/drivers"] ?? [],
      powerSupplies: parsed.lists["/sys/class/power_supply"] ?? [],
    },
    tests: parsed.tests,
    usbAudio: { captureBytes: capture.length, rms: Number(wavRms(capture).toFixed(4)) },
    alsaEngine: (() => {
      const text = parsed.files["/tmp/alsa-engine.json"];
      let report = null;
      try {
        report = text ? JSON.parse(text) : null;
      } catch {
        report = null;
      }
      let timing = null;
      try {
        timing = parsed.files["/tmp/alsa-timing.json"]
          ? JSON.parse(parsed.files["/tmp/alsa-timing.json"])
          : null;
      } catch {
        timing = null;
      }
      // Capture order: G1 tone (~1 s), then the timing run, then the 32-voice stress
      // run (continuous tone). Quarter-note onsets are spaced 0.5 s; keep the first
      // run of onsets that follow that spacing.
      const all = onsets(capture, 0.1, 0.2);
      const beats = [];
      for (const t of all.slice(1)) {
        if (beats.length && t - (beats.at(-1) ?? t) > 1.5) break;
        beats.push(t);
      }
      const intervals = beats.slice(1).map((t, i) => t - (beats[i] ?? t));
      return {
        timing,
        stress: report,
        beatOnsets: beats.length,
        beatIntervalMeanSeconds: intervals.length
          ? Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(5))
          : null,
        beatIntervalMaxErrorMs: intervals.length
          ? Number((Math.max(...intervals.map((d) => Math.abs(d - 0.5))) * 1000).toFixed(2))
          : null,
      };
    })(),
    hardwareQualified: false,
    physicalAccess: false,
    scope: lock.vm.scope,
  };
  await writeFile(join(run, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    join(root, "artifacts/live-mk1/latest-boot.json"),
    `${JSON.stringify({ directory: relative(root, run) })}\n`,
  );
  return { directory: run, report };
}
