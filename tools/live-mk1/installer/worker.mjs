import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { MPC_RUNTIME, requireSupportedUpdater } from "../compatibility.mjs";
import { runFlash, verifiedSystemFastboot, verifiedXmpImage } from "../flash.mjs";
import { collectStockInstallProfile } from "../mpc-remote.mjs";
import { prepareStickToken } from "../stick-token.mjs";
import { stockImageFromUpdater } from "../stock-image.mjs";
import { verifyOwnerImage } from "../verify-owner-image.mjs";
import { inspectWithConnectionDiagnostics } from "./connection-diagnostics.mjs";
import { FIRST_PROJECT } from "./first-project.mjs";
import {
  ejectUsb,
  labelUsb,
  usbVolumes,
  windowsUpdateModeMetadata,
  windowsUsbRepairAction,
} from "./host.mjs";
import { prepareInstallation } from "./prepare-session.mjs";
import { exportUnitProfile, importUnitProfile } from "./profile.mjs";
import { stockInstallFixture } from "./stock-test-fixture.mjs";
import { writeUsbImage } from "./usb.mjs";
import { repairWindowsUsb } from "./windows-usb.mjs";

const { request, resources, workspace, simulation, simulationProfile } = workerData;
const log = (line) => parentPort.postMessage({ log: String(line) });
const digest = (b) => createHash("sha256").update(b).digest("hex");
const toolsDirectory = join(workspace, "platform-tools");
process.env.PATH = (
  process.platform === "win32"
    ? [
        join(resources, "image-tools/bin"),
        toolsDirectory,
        join(process.env.SystemRoot || "C:\\Windows", "System32"),
        process.env.SystemRoot || "C:\\Windows",
      ]
    : [
        join(resources, "bin"),
        join(resources, "image-tools"),
        toolsDirectory,
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]
).join(delimiter);
const lock = JSON.parse(readFileSync(join(resources, "inputs.lock.json"), "utf8"));

// The only real device runner lives in flash.mjs.
function fastboot(args) {
  const expected = JSON.parse(readFileSync(join(workspace, "platform-tools-receipt.json"), "utf8"));
  const binary = join(toolsDirectory, process.platform === "win32" ? "fastboot.exe" : "fastboot");
  if (
    digest(readFileSync(binary)) !== expected.fastbootSha256 ||
    expected.archiveSha256 !== lock.platformTools.sha256
  )
    throw new Error("USB support changed; install USB support again");
  return verifiedSystemFastboot(args, { executable: binary, sha256: expected.fastbootSha256 });
}
const fake = (args) => {
  if (args[0] === "devices") return { status: 0, output: "SIMULATED-LIVE\t fastboot" };
  if (args[0] !== "getvar") return { status: 0, output: "OKAY (simulation)" };
  if (simulationProfile === "legacy" && ["product", "partition-size:rootfs"].includes(args[1]))
    return {
      status: 0,
      output: `getvar:${args[1]} FAILED (remote: 'Variable not implemented')\nFinished.`,
    };
  return {
    status: 0,
    output: `${args[1]}: ${{ product: "az01", "version-bootloader": simulationProfile === "legacy" ? "0.4" : "2016.05-inmusic", "partition-type:rootfs": "ext4", "partition-size:rootfs": "0x1f400000" }[args[1]]}`,
  };
};
async function main() {
  if (request.task === "repair-windows-usb") {
    if (simulation) throw Error("Windows USB repair is unavailable in simulation");
    return repairWindowsUsb({
      stateDirectory: join(workspace, "reports/live-mk1"),
      ownerConfirmed: request.ownerConfirmed,
      invoke: (args) => windowsUsbRepairAction(resources, args),
      log,
    });
  }
  if (request.task === "verify-stock") {
    const fixture = simulation ? stockInstallFixture() : null;
    return collectStockInstallProfile(request.address, {
      ownerReadOnlyConfirmed: request.ownerReadOnlyConfirmed,
      stateDirectory: join(workspace, "reports/live-mk1"),
      askpass: join(
        resources,
        process.platform === "win32" ? "stock-askpass.exe" : "stock-askpass",
      ),
      transport: fixture ? () => fixture.report : null,
      record: log,
    });
  }
  if (request.task === "tools") {
    log("Downloading pinned Android Platform-Tools directly from Google…");
    const response = await fetch(lock.platformTools.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error("Could not download USB support");
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > lock.platformTools.bytes) throw new Error("USB download exceeds pinned size");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== lock.platformTools.bytes || digest(bytes) !== lock.platformTools.sha256)
      throw new Error("USB download hash does not match the reviewed release");
    const zip = join(workspace, "platform-tools.zip");
    await writeFile(zip, bytes, { mode: 0o600 });
    // Fixed, hash-pinned Google archive; no user-supplied ZIP input.
    if (process.platform === "win32")
      execFileSync("tar.exe", ["-xf", zip, "-C", workspace], {
        timeout: 120000,
        windowsHide: true,
      });
    else execFileSync("/usr/bin/unzip", ["-oq", zip, "-d", workspace], { timeout: 120000 });
    await chmod(
      join(toolsDirectory, process.platform === "win32" ? "fastboot.exe" : "fastboot"),
      0o755,
    );
    await writeFile(
      join(workspace, "platform-tools-receipt.json"),
      JSON.stringify({
        archiveSha256: lock.platformTools.sha256,
        fastbootSha256: digest(
          await readFile(
            join(toolsDirectory, process.platform === "win32" ? "fastboot.exe" : "fastboot"),
          ),
        ),
      }),
      { mode: 0o600 },
    );
    await rm(zip);
    log("Verified connection tools installed locally. Windows device drivers are separate.");
    return {};
  }
  if (request.task === "prepare") {
    log(
      "Authenticating the official 3.10.1 updater and preparing installation files on this computer…",
    );
    return prepareInstallation({
      updater: request.source,
      resources,
      workspace,
      log,
      phase: (phase) => parentPort.postMessage({ progress: { phase } }),
    });
  }
  const simulatedRoot = join(workspace, "build/simulated-usb");
  const simulatedVolume = () => ({
    mountPoint: simulatedRoot,
    filesystem: "fat32",
    external: true,
    removable: true,
    bus: "USB",
    model: "Simulation only",
    label: "XMP",
    deviceKey: "simulation-volume",
    usbVendorId: 0xdead,
    freeBytes: 1024 ** 3,
    capacityBytes: 8 * 1024 ** 3,
  });
  const inspectUsb = (path) =>
    simulation ? Promise.resolve(simulatedVolume()) : usbVolumes(resources, path);
  if (request.task === "list-usb") {
    if (simulation) {
      await mkdir(simulatedRoot, { recursive: true });
      return [simulatedVolume()];
    }
    return usbVolumes(resources);
  }
  if (request.task === "select-usb") {
    const volume = await inspectUsb(request.volume.mountPoint);
    if (volume.deviceKey !== request.volume.deviceKey) throw Error("USB key changed");
    const imported = await importUnitProfile(
      volume.mountPoint,
      join(workspace, "reports/live-mk1"),
    );
    return { volume, imported };
  }
  if (request.task === "prepare-usb") {
    const image = await verifyOwnerImage(request.source);
    let volume = await inspectUsb(request.volume.mountPoint);
    if (volume.deviceKey !== request.volume.deviceKey) throw Error("USB key changed");
    if (!simulation) volume = await labelUsb(volume, resources);
    parentPort.postMessage({ progress: { phase: "Copying XMP to the selected USB key" } });
    const profile = await exportUnitProfile(join(workspace, "reports/live-mk1"));
    const result = await writeUsbImage({
      volume,
      source: request.source,
      expectedSha256: image.sha256,
      inspect: inspectUsb,
      profile,
      firstProject: join(resources, FIRST_PROJECT.file),
      prepareToken: (path) =>
        prepareStickToken(path, join(workspace, "artifacts/live-mk1/bridge-token.json")),
      progress: (p) =>
        parentPort.postMessage({ progress: { phase: "Copying XMP to the USB key", ...p } }),
    });
    log(
      "USB system image copied, flushed and SHA-256 verified. Existing projects, samples, token and prior images preserved.",
    );
    log(
      result.firstProject?.status === "installed"
        ? "Acid Circuit demo loaded for first start. Press PLAY to hear the song."
        : "Existing startup project or recovery files preserved; no demo replaced your work.",
    );
    return { ...result, volume };
  }
  if (request.task === "eject-usb")
    return simulation ? { ejected: true } : ejectUsb(request.volume, resources);
  if (request.task === "verify-loader") {
    const manifest = JSON.parse(await readFile(join(request.source, "manifest.json"), "utf8"));
    if (manifest.format !== "xmp-live-mk1-loader-image")
      throw new Error("Choose a loader image, not a probe image");
    return verifiedXmpImage(request.source);
  }
  if (request.operation === "restore-stock") {
    const stock = await stockImageFromUpdater(request.source);
    requireSupportedUpdater(stock.receipt.updaterImageSha256);
    if (stock.sha256 !== MPC_RUNTIME.rootfsSha256) throw new Error("Wrong stock baseline");
  }
  if (!simulation && !existsSync(join(workspace, "platform-tools-receipt.json")))
    throw new Error("Install USB support first");
  const options = {
    operation: request.operation,
    source: request.source,
    fastboot: simulation ? fake : fastboot,
    stateDirectory: join(workspace, "reports/live-mk1"),
    log,
  };
  if (request.task === "inspect") {
    const status = await inspectWithConnectionDiagnostics(
      () => runFlash({ ...options, operation: "status" }),
      { readMetadata: () => windowsUpdateModeMetadata(resources), log },
    );
    const result = await runFlash({
      ...options,
      dryRun: true,
      expectedIdentity: status.identity,
      expectedHardwareObservationSha256: status.hardwareObservationSha256,
    });
    return { ...result, unitPinned: status.unitPinned };
  }
  if (request.task === "write") {
    return runFlash({
      ...options,
      dryRun: false,
      answers: request.answers,
      expectedIdentity: request.expectedIdentity,
      expectedImageSha256: request.expectedImageSha256,
      expectedHardwareObservationSha256: request.expectedHardwareObservationSha256,
    });
  }
  throw new Error("Unknown worker task");
}
main().then(
  (result) => parentPort.postMessage({ result }),
  (error) => parentPort.postMessage({ error: error.message }),
);
