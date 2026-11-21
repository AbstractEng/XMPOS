import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DevelopmentVmProfile } from "./policy.mjs";

const root = resolve(import.meta.dirname, "../.."),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const ownedSessions = new WeakSet();
const activeSessions = new WeakSet();
const activeDisks = new Set();
const PROFILE_FILES = {
  "p10-qemu-x86_64-v1": "os/profile.json",
  "device-qemu-x86_64-v1": "os/device-profile.json",
  "device-qemu-armv7-az01-v1": "os/live-mk1/device-profile.json",
};
export async function emulator(architecture = "x86_64") {
  if (architecture === "armv7") {
    try {
      const config = JSON.parse(
        await readFile(join(root, "build/os-tools/emulator-arm.json"), "utf8"),
      );
      return { binary: config.binary };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      throw new Error("ARM emulator unavailable; run npm run live:emulator");
    }
  }
  try {
    const config = JSON.parse(await readFile(join(root, "build/os-tools/emulator.json"), "utf8"));
    return { binary: config.binary, bios: config.bios };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const binary = spawnSync("which", ["qemu-system-x86_64"], { encoding: "utf8" });
  if (binary.status !== 0)
    throw new Error(
      "QEMU unavailable; run npm run os:emulator or install QEMU >= 8.2 from a supported package manager",
    );
  return { binary: binary.stdout.trim() };
}
export async function imageIdentity(image) {
  const requested = resolve(image);
  if (
    !requested.startsWith(`${root}/`) ||
    !["build", "artifacts", "reports"].includes(requested.slice(root.length + 1).split("/")[0])
  )
    throw new Error("Owned workspace image required");
  const directory = await realpath(requested);
  if (!directory.startsWith(`${await realpath(root)}/`)) throw new Error("Escaping image rejected");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  for (const [name, key] of [
    ["kernel", "kernelSha256"],
    ["rootfs.cpio.gz", "initramfsSha256"],
  ]) {
    const path = join(directory, name),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || sha(await readFile(path)) !== manifest[key])
      throw new Error("Image artifact hash mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.buildId) || !Object.hasOwn(PROFILE_FILES, manifest.profile))
    throw new Error("Unknown image identity");
  return { directory, manifest };
}
export async function createVmSession(directory, image = join(root, "artifacts/os/p10")) {
  const requested = resolve(directory);
  if (/[,\r\n]/.test(requested)) throw new Error("Unsafe QEMU filename");
  if (
    !requested.startsWith(`${root}/`) ||
    (!requested.slice(root.length + 1).startsWith("reports/") &&
      !requested.slice(root.length + 1).startsWith("artifacts/"))
  )
    throw new Error("Owned workspace VM session required");
  await mkdir(requested, { recursive: true, mode: 0o700 });
  if ((await lstat(requested)).isSymbolicLink()) throw new Error("Symlink VM session rejected");
  const session = await realpath(requested);
  if (!session.startsWith(`${await realpath(root)}/`))
    throw new Error("Escaping VM session rejected");
  const identity = await imageIdentity(image),
    profile = DevelopmentVmProfile.parse(
      JSON.parse(await readFile(join(root, PROFILE_FILES[identity.manifest.profile]), "utf8")),
    ),
    owner = join(session, "owner.json"),
    disk = join(session, "data.raw");
  let previous;
  try {
    if (!(await lstat(owner)).isFile()) throw new Error("Regular owner ledger required");
    previous = JSON.parse(await readFile(owner, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (
    previous &&
    (previous.buildId !== identity.manifest.buildId || previous.profile !== profile.id)
  )
    throw new Error("VM data disk belongs to another image");
  if (!previous) {
    const file = await open(disk, "wx", 0o600);
    try {
      await file.truncate(profile.dataMiB * 1024 * 1024);
    } finally {
      await file.close();
    }
    await writeFile(
      owner,
      JSON.stringify({
        format: "xmp-vm-session",
        buildId: identity.manifest.buildId,
        profile: profile.id,
        initializationAuthorized: true,
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  const diskInfo = await lstat(disk);
  if (
    !diskInfo.isFile() ||
    diskInfo.isSymbolicLink() ||
    diskInfo.size !== profile.dataMiB * 1024 * 1024
  )
    throw new Error("Invalid file-backed data disk");
  const result = Object.freeze({ session, disk, ...identity, profile: Object.freeze(profile) });
  ownedSessions.add(result);
  return result;
}
export async function cloneVmSession(base, directory, image = base?.directory) {
  if (!ownedSessions.has(base) || activeSessions.has(base) || activeDisks.has(base.disk))
    throw new Error("A stopped owned VM session is required for a data snapshot");
  const target = await createVmSession(directory, image);
  if (target.disk === base.disk) throw new Error("Snapshot must use a separate disk");
  const info = await lstat(base.disk);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== base.profile.dataMiB * 1024 * 1024)
    throw new Error("Regular owned source disk required");
  await copyFile(base.disk, target.disk);
  const ledger = JSON.parse(await readFile(join(target.session, "owner.json"), "utf8"));
  ledger.initializationAuthorized = false;
  ledger.snapshotOf = base.manifest.buildId;
  await writeFile(join(target.session, "owner.json"), JSON.stringify(ledger), { mode: 0o600 });
  return target;
}
export async function bootVm(session, { startupUiFailure = false, faultInjection = false } = {}) {
  if (!ownedSessions.has(session))
    throw new Error("Use an owned VM session; physical disk overrides prohibited");
  if (activeSessions.has(session) || activeDisks.has(session.disk))
    throw new Error("Owned VM session is already running");
  await imageIdentity(session.directory);
  const diskInfo = await lstat(session.disk);
  if (
    !diskInfo.isFile() ||
    diskInfo.isSymbolicLink() ||
    diskInfo.size !== session.profile.dataMiB * 1024 * 1024
  )
    throw new Error("Invalid file-backed data disk");
  const qemu = await emulator(session.profile.architecture),
    run = await mkdtemp(join(session.session, "boot-")),
    audio = join(run, "audio.wav"),
    bootLog = join(run, "boot.log"),
    profile = session.profile;
  const ownerPath = join(session.session, "owner.json");
  if (!(await lstat(ownerPath)).isFile()) throw new Error("Regular owner ledger required");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  const initialize = owner.initializationAuthorized === true;
  if (initialize) {
    owner.initializationAuthorized = false;
    await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  }
  const arm = profile.architecture === "armv7";
  const args = [
    "-no-user-config",
    "-nodefaults",
    "-machine",
    // The 32-bit az01 kernel has no LPAE: keep virt's PCIe and RAM below 4 GiB.
    arm ? `${profile.machine},highmem=off` : profile.machine,
    "-accel",
    "tcg",
    "-cpu",
    profile.cpu,
    "-m",
    String(profile.memoryMiB),
    "-smp",
    String(profile.vcpus),
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
    join(session.directory, "kernel"),
    "-initrd",
    join(session.directory, "rootfs.cpio.gz"),
    "-append",
    `console=${arm ? "ttyAMA0" : "ttyS0,115200"} panic=-1 init=/init xmp.build=${session.manifest.buildId}${startupUiFailure ? " xmp.ui-start-fault=1" : ""}${initialize ? " xmp.initialize-data=1" : ""}${faultInjection ? " xmp.fixture-faults=1" : ""}`,
    "-drive",
    `if=none,id=xmpdata,file=${session.disk},format=raw,cache=writeback`,
    ...(arm
      ? [
          // Generic ARM board: virtio-mmio disk and a USB Audio Class device on
          // xHCI, which the official az01 kernel drives with snd-usb-audio.
          "-device",
          "virtio-blk-device,drive=xmpdata",
          "-device",
          "qemu-xhci,id=xhci",
          "-device",
          "usb-audio,bus=xhci.0,audiodev=xmp",
        ]
      : [
          "-device",
          "virtio-blk-pci,drive=xmpdata",
          "-device",
          "ich9-intel-hda",
          "-device",
          "hda-output,audiodev=xmp",
        ]),
    "-audiodev",
    `wav,id=xmp,path=${audio},out.frequency=48000,out.channels=2,out.format=s16`,
  ];
  if (qemu.bios && !arm) args.push("-L", qemu.bios);
  const version = spawnSync(qemu.binary, ["--version"], { encoding: "utf8" });
  const number = /version (\d+)\.(\d+)/.exec(version.stdout ?? "");
  if (!number || Number(number[1]) < 8 || (Number(number[1]) === 8 && Number(number[2]) < 2))
    throw new Error("QEMU 8.2 or newer required");
  if (version.status !== 0) throw new Error("QEMU version probe failed");
  if (activeDisks.has(session.disk)) throw new Error("Owned VM disk is already running");
  const child = spawn(qemu.binary, args, { stdio: ["pipe", "pipe", "pipe"] }),
    pending = new Map(),
    checkpoints = new Map();
  activeSessions.add(session);
  activeDisks.add(session.disk);
  let buffer = "",
    log = "",
    next = 1,
    readyResolve,
    readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(() => {
    readyReject(
      new Error(
        `VM readiness exceeded frozen ${profile.bootReadyLimitSeconds}s profile; ${log.slice(-1600)}`,
      ),
    );
    child.kill("SIGKILL");
  }, profile.bootReadyLimitSeconds * 1000);
  const exit = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      activeSessions.delete(session);
      activeDisks.delete(session.disk);
      clearTimeout(timer);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("VM closed before response"));
      }
      pending.clear();
      for (const point of checkpoints.values()) {
        clearTimeout(point.timer);
        point.reject(new Error("VM closed before save checkpoint"));
      }
      checkpoints.clear();
      readyReject(new Error(`VM exited before readiness: ${code}/${signal}: ${log.slice(-2000)}`));
      resolve({ code, signal });
    }),
  );
  child.once("error", (e) => {
    clearTimeout(timer);
    readyReject(e);
  });
  const parse = (line) => {
    const index = line.indexOf("XMP!");
    if (index < 0) return;
    let message;
    try {
      message = JSON.parse(line.slice(index + 4));
    } catch {
      return;
    }
    if (message.ready) {
      if (message.buildId !== session.manifest.buildId || message.profile !== profile.id) {
        readyReject(new Error("Booted identity differs from candidate"));
        child.kill("SIGKILL");
        return;
      }
      clearTimeout(timer);
      readyResolve(message);
    }
    if (message.event === "save-checkpoint" && checkpoints.has(message.point)) {
      const point = checkpoints.get(message.point);
      clearTimeout(point.timer);
      checkpoints.delete(message.point);
      point.resolve(message);
    }
    if (message.id) {
      const p = pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(message.id);
        if (message.ok) p.resolve(message.result);
        else p.reject(new Error(message.error ?? "Guest rejected command"));
      }
    }
  };
  const serialDecoder = new StringDecoder("utf8");
  child.stdout.on("data", (b) => {
    const s = serialDecoder.write(b);
    log = (log + s).slice(-1024 * 1024);
    buffer += s;
    if (buffer.length > 2 * 1024 * 1024) {
      child.kill("SIGKILL");
      return;
    }
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      parse(buffer.slice(0, end).replace(/\r/g, ""));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (b) => {
    log = (log + b.toString()).slice(-1024 * 1024);
  });
  try {
    const boot = await ready;
    return {
      boot,
      child,
      audio,
      bootLog,
      args,
      emulator: version.stdout.split("\n")[0],
      waitCheckpoint(point) {
        if (
          !faultInjection ||
          !["pending-fsynced", "backup-fsynced", "primary-renamed", "directory-fsynced"].includes(
            point,
          ) ||
          checkpoints.has(point)
        )
          throw new Error("Named VM fixture checkpoint required");
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            checkpoints.delete(point);
            reject(new Error("Save checkpoint timeout"));
          }, profile.commandLimitSeconds * 1000);
          checkpoints.set(point, { resolve, reject, timer });
        });
      },
      request(command) {
        if (pending.size >= 16) throw new Error("VM request budget exceeded");
        const id = next++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Guest command timeout"));
          }, profile.commandLimitSeconds * 1000);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id, command })}\n`);
        });
      },
      async finish({ force = false } = {}) {
        if (child.exitCode === null && child.signalCode === null) {
          if (force) child.kill("SIGKILL");
          else {
            const id = next++;
            child.stdin.write(`${JSON.stringify({ id, command: { op: "shutdown" } })}\n`);
          }
        }
        let timeout;
        const result = await Promise.race([
          exit,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("VM shutdown timeout"));
            }, 15000);
          }),
        ]).finally(() => clearTimeout(timeout));
        await writeFile(bootLog, log, { mode: 0o600 });
        return { ...result, log, audio, boot };
      },
    };
  } catch (e) {
    child.kill("SIGKILL");
    await exit;
    await writeFile(bootLog, log, { mode: 0o600 });
    throw e;
  }
}
