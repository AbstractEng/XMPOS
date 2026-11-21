import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { emulator } from "../os/vm.mjs";
import { kernelLock } from "./board.mjs";
import { runContainer } from "./container.mjs";

// Runs the step 4 probe initramfs on QEMU's ARM board with the official az01
// kernel and checks that it writes its report only to the XMPPROBE card and
// never changes any other disk. The guest disks are files in an owned folder.

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeReportCard(directory) {
  // A 64 MiB MBR disk with one FAT32 partition labelled XMPPROBE at 1 MiB.
  const script = [
    "mkdir -p /out",
    "truncate -s 64M /out/card.img",
    // One MBR partition entry: type 0x0c (FAT32 LBA), start LBA 2048, to the end.
    `python3 - <<'PY'
import struct
path = '/out/card.img'
sectors = 64 * 1024 * 1024 // 512
entry = struct.pack('<B3sB3sII', 0, b'\\0\\0\\0', 0x0C, b'\\0\\0\\0', 2048, sectors - 2048)
with open(path, 'r+b') as f:
    f.seek(446)
    f.write(entry + bytes(48) + b'\\x55\\xaa')
PY`,
    "mkfs.vfat -F 32 -n XMPPROBE --offset 2048 /out/card.img $((62 * 1024)) >/dev/null",
  ].join("\n");
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [],
    command: script,
    out: directory,
    timeout: 600000,
  });
  return join(directory, "card.img");
}

async function readReports(directory, card) {
  const script = [
    "mkdir -p /out/reports",
    "mcopy -n -i /in-card.img@@1M '::xmp-*.txt' /out/reports/ 2>/dev/null || true",
  ].join("\n");
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [{ from: card, to: "/in-card.img" }],
    command: script,
    out: directory,
    timeout: 600000,
  });
  const folder = join(directory, "reports");
  const names = existsSync(folder) ? await readdir(folder) : [];
  return Promise.all(names.map((name) => readFile(join(folder, name), "utf8")));
}

export async function runQemu({
  zImage,
  initramfs,
  disks,
  log,
  seconds,
  extra = "",
  pressPower = false,
  // Extra QEMU arguments (for example an emulated USB audio device).
  qemuArgs = [],
  // Press the power button once the log matches this, instead of at a halt.
  pressPowerWhen = null,
  // Live-like machine: cores, memory, a device tree to boot with, and
  // QEMU's instruction-counting clock (emulated time independent of host load).
  smp = 2,
  memoryMiB = 512,
  dtb = null,
  icount = null,
  // [{ when: /regex/, file }]: QMP screendump (PPM) once the log matches.
  screenshots = [],
  // { when: /regex/, run: async () => {} }: host-side actions during the boot
  // (for example talking to the bridge socket); its result is returned.
  during = null,
}) {
  const qemu = await emulator("armv7");
  const vm = kernelLock().vm;
  // QMP lets the test press QEMU virt's power button (a gpio-keys KEY_POWER, like the Live's).
  const qmp = join(tmpdir(), `xmp-qmp-${process.pid}-${Date.now()}.sock`);
  const args = [
    ...(pressPower || pressPowerWhen || screenshots.length
      ? ["-qmp", `unix:${qmp},server=on,wait=off`]
      : []),
    "-no-user-config",
    "-nodefaults",
    "-machine",
    `${vm.machine},highmem=off`,
    "-accel",
    "tcg",
    "-cpu",
    vm.cpu,
    "-smp",
    String(smp),
    "-m",
    String(memoryMiB),
    ...(dtb ? ["-dtb", dtb] : []),
    ...(icount ? ["-icount", icount] : []),
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
    `console=ttyAMA0 rdinit=/init xmp.probe=3${extra}`,
    ...disks.flatMap((disk, i) => [
      "-drive",
      `if=none,id=d${i},file=${disk},format=raw`,
      "-device",
      `virtio-blk-device,drive=d${i}`,
    ]),
    ...qemuArgs,
  ];
  return new Promise((done, fail) => {
    const child = spawn(qemu.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      out += b.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), seconds * 1000);
    // v2 halts and waits for the owner to switch off: stop QEMU once it says so.
    let halted = false;
    let pressed = false;
    const qmpSend = (command) => {
      const socket = createConnection(qmp);
      socket.on("error", () => {});
      socket.on("connect", () => {
        socket.write('{"execute":"qmp_capabilities"}\n');
        setTimeout(() => socket.end(`${JSON.stringify(command)}\n`), 500);
      });
    };
    const press = () => qmpSend({ execute: "system_powerdown" });
    const shots = screenshots.map((shot) => ({ ...shot, taken: false }));
    let duringStarted = false,
      duringResult;
    const watch = setInterval(() => {
      if (during && !duringStarted && during.when.test(out)) {
        duringStarted = true;
        duringResult = during.run().catch((error) => ({ error: error.message }));
      }
      for (const shot of shots)
        if (!shot.taken && shot.when.test(out)) {
          shot.taken = Date.now();
          qmpSend({ execute: "screendump", arguments: { filename: shot.file } });
        }
      // Power is pressed only once every due screenshot has been written: the
      // guest can run faster than real time, and a session that has switched
      // off shows no screen.
      const shotPending = shots.some(
        (shot) =>
          (!shot.taken && shot.when.test(out)) || (shot.taken && Date.now() - shot.taken < 2000),
      );
      if (pressPowerWhen && !pressed && !shotPending && pressPowerWhen.test(out)) {
        pressed = true;
        press();
      }
      if (!halted && /XMP-(PROBE|LOADER|SESSION) .*; halted/.test(out)) {
        halted = true;
        if (pressPower) {
          // Press the power button; the probe must switch the machine off (QEMU then exits).
          press();
          setTimeout(() => child.kill("SIGTERM"), 60000);
        } else setTimeout(() => child.kill("SIGTERM"), 2000);
      }
    }, 250);
    child.once("error", fail);
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      clearInterval(watch);
      rmSync(qmp, { force: true });
      await writeFile(log, out);
      done({
        code,
        signal,
        log: out,
        halted,
        timedOut: signal === "SIGKILL",
        during: await duringResult,
      });
    });
  });
}

export async function testProbeInVm() {
  const pointer = join(root, "artifacts/live-mk1/latest-probe-image.json");
  if (!existsSync(pointer))
    throw new Error("Build the probe image first: npm run live:probe-image");
  const imageDir = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  const kernelDir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-kernel.json"), "utf8"))
      .directory,
  );
  const run = await mkdtemp(join(root, "artifacts/live-mk1/probe-vm-"));
  const card = await makeReportCard(run);
  const protectedDisk = join(run, "protected.img");
  await writeFile(protectedDisk, randomBytes(32 * 1024 * 1024));
  const before = { protected: sha(await readFile(protectedDisk)) };
  const zImage = join(kernelDir, "zImage");
  const initramfs = join(imageDir, "probe.cpio.gz");

  // Run 1: a protected disk and the XMPPROBE card.
  const withCard = await runQemu({
    zImage,
    initramfs,
    disks: [protectedDisk, card],
    log: join(run, "with-card.log"),
    seconds: 300,
    pressPower: true,
  });
  const reports = await readReports(run, card);
  // Run 2: no card; the probe must halt without writing anything.
  const bare = join(run, "protected-only.img");
  await writeFile(bare, await readFile(protectedDisk));
  const bareBefore = sha(await readFile(bare));
  const withoutCard = await runQemu({
    zImage,
    initramfs,
    disks: [bare],
    log: join(run, "without-card.log"),
    seconds: 300,
  });
  // Run 3: report mode (how the systemd service runs it inside Akai's system),
  // started as an ordinary process by the emulator-only self-test switch.
  const reportDir = join(run, "report-mode");
  await mkdir(reportDir);
  const reportCard = await makeReportCard(reportDir);
  const reportDisk = join(reportDir, "protected.img");
  await writeFile(reportDisk, await readFile(protectedDisk));
  const reportMode = await runQemu({
    zImage,
    initramfs,
    disks: [reportDisk, reportCard],
    log: join(run, "report-mode.log"),
    seconds: 400,
    extra: " xmp.selftest=report xmp.fallback=probe-file-not-loaded",
  });
  const stockReports = await readReports(reportDir, reportCard);
  const result = {
    format: "xmp-probe-vm-test",
    version: 4,
    withCard: {
      halted: withCard.halted,
      wroteReport: withCard.log.includes("XMP-PROBE wrote"),
      haltedShowingSuccess: withCard.log.includes("XMP-PROBE end: report written; halted"),
      neverRestarted: !/reboot: Restarting/.test(withCard.log),
      powerButtonSwitchesOff:
        withCard.log.includes("XMP-PROBE powering off (power button)") &&
        /reboot: Power down/.test(withCard.log),
      reports: reports.length,
      reportSections: (reports[0]?.match(/^===== /gm) ?? []).length,
      reportHasKernel: /6\.18\.44-az01/.test(reports[0] ?? ""),
      reportHasCompatible: /linux,dummy-virt/.test(reports[0] ?? ""),
      reportComplete: (reports[0] ?? "").includes("XMP-PROBE end"),
      protectedDiskUnchanged: sha(await readFile(protectedDisk)) === before.protected,
    },
    withoutCard: {
      halted: withoutCard.halted,
      refusedToWrite: withoutCard.log.includes(
        "no XMPPROBE partition found, nothing written; halted",
      ),
      neverRestarted: !/reboot: Restarting/.test(withoutCard.log),
      diskUnchanged: sha(await readFile(bare)) === bareBefore,
    },
    reportMode: {
      ranAsService: reportMode.log.includes("XMP-PROBE begin (report mode)"),
      exitedCleanly: reportMode.log.includes("report mode exited 0"),
      reports: stockReports.length,
      recordsFallbackStage: /xmp\.fallback=probe-file-not-loaded/.test(stockReports[0] ?? ""),
      reportComplete: (stockReports[0] ?? "").includes("XMP-PROBE end"),
      touchedNoScreen: !reportMode.log.includes("halted (press the power button"),
      protectedDiskUnchanged: sha(await readFile(reportDisk)) === before.protected,
    },
    scope:
      "QEMU virt with the official az01 kernel; the card and protected disk are virtio disks. Real MPC eMMC detection (controller ff0f0000) is exercised only on hardware.",
  };
  await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (reports[0]) await writeFile(join(run, "report-sample.txt"), reports[0]);
  return { directory: run, result };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("Probe VM test takes no options");
  const { directory, result } = await testProbeInVm();
  console.log(JSON.stringify({ directory: relative(root, directory), ...result }, null, 2));
}
