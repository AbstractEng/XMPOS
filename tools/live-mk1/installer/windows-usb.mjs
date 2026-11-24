import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateHardwareObservation } from "../hardware-observation.mjs";

export const FASTBOOT_INTERFACE = "{f72fe0d4-cbcb-407d-8814-9ed673d0dd6b}";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const guid = /^\{[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\}$/i;
async function bounded(path, max = 16384) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > max)
    throw Error("Regular bounded USB verification file required");
  return readFile(path);
}

export function validateUsbRepairPlan(plan) {
  const before = plan?.before;
  if (
    typeof plan?.needsRepair !== "boolean" ||
    !hex.test(plan.fingerprint ?? "") ||
    !hex.test(before?.deviceKey ?? "") ||
    Object.keys(before).sort().join() !== "deviceKey,plural,singular"
  )
    throw Error("Invalid Windows USB repair preview");
  for (const value of [before.plural, before.singular]) {
    if (
      !["absent", "String", "MultiString"].includes(value?.kind) ||
      !Array.isArray(value.values) ||
      value.values.length > 32 ||
      value.values.some((v) => typeof v !== "string" || !guid.test(v)) ||
      (value.kind === "absent" && value.values.length !== 0) ||
      (value.kind === "String" && value.values.length !== 1) ||
      Object.keys(value).sort().join() !== "kind,values"
    )
      throw Error("Unsupported existing Windows USB registration");
  }
  if (hash(JSON.stringify(before)) !== plan.fingerprint)
    throw Error("Windows USB repair preview fingerprint mismatch");
  return plan;
}

// Host registry only: no USB handles, fastboot commands, or driver installation.
// The native helper independently rechecks the exact unit and snapshot after UAC.
export async function repairWindowsUsb({
  stateDirectory,
  invoke,
  ownerConfirmed = false,
  previewOnly = false,
  platform = process.platform,
  log = () => {},
}) {
  if (platform !== "win32") throw Error("This connection repair is for Windows only");
  if (!previewOnly && ownerConfirmed !== true)
    throw Error("Confirm the Windows USB registration repair first");
  const receipt = JSON.parse(await bounded(join(stateDirectory, "hardware-observation.json")));
  if (!/^[A-Za-z0-9._-]+\.txt$/.test(receipt.report?.file ?? ""))
    throw Error("Verified stock Live profile required before Windows USB repair");
  const observation = validateHardwareObservation(
    receipt,
    await bounded(join(stateDirectory, receipt.report.file), 2 * 1024 * 1024),
  );
  const pin = JSON.parse(await bounded(join(stateDirectory, "stock-device-identity.json")));
  if (
    pin.version !== 1 ||
    !Array.isArray(pin.serialHashes) ||
    pin.serialHashes.length < 1 ||
    pin.serialHashes.length > 2 ||
    pin.serialHashes.some((p) => !hex.test(p) || !observation.serialHashes.includes(p)) ||
    observation.board !== "inmusic,acv8"
  )
    throw Error("Stock unit pin does not match the verified Live profile");
  const pins = pin.serialHashes.join(",");
  const plan = validateUsbRepairPlan(await invoke(["winusb-plan", pins]));
  if (previewOnly) return plan;
  if (!plan.needsRepair) return { changed: false, reconnectRequired: false };
  const backups = join(stateDirectory, "windows-usb-backups");
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const st = await lstat(backups);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Private backup directory required");
  const backup = join(backups, `${plan.fingerprint}.json`);
  const bytes = `${JSON.stringify({ format: "xmp-winusb-registration-backup", version: 1, addedInterface: FASTBOOT_INTERFACE, ...plan }, null, 2)}\n`;
  try {
    await writeFile(backup, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || (await bounded(backup)).toString() !== bytes) throw error;
  }
  log("Previous Windows USB registration backed up. Requesting administrator approval…");
  const after = validateUsbRepairPlan(await invoke(["winusb-repair", pins, plan.fingerprint]));
  const expected = {
    ...plan.before,
    plural: {
      kind: "MultiString",
      values: [...plan.before.plural.values, FASTBOOT_INTERFACE],
    },
  };
  if (after.needsRepair || JSON.stringify(after.before) !== JSON.stringify(expected))
    throw Error("Windows USB repair did not verify; review the private backup before retrying");
  log(
    "Fastboot interface registered for the verified Live only. Disconnect and reconnect its USB-B cable, then check the Live again.",
  );
  return { changed: true, reconnectRequired: true, backup };
}
