import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRootfsObservation, validateHardwareObservation } from "../hardware-observation.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
async function regular(path, max) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max)
    throw Error("Regular private verification file required");
  return readFile(path);
}
export async function exportUnitProfile(stateDirectory) {
  try {
    const receipt = JSON.parse(
      (await regular(join(stateDirectory, "hardware-observation.json"), 16384)).toString(),
    );
    if (!/^[A-Za-z0-9._-]+\.txt$/.test(receipt.report?.file ?? ""))
      throw Error("Invalid private report path");
    const report = await regular(join(stateDirectory, receipt.report.file), 2 * 1024 ** 2);
    validateHardwareObservation(receipt, report);
    if (receipt.version === 2)
      return {
        "hardware-observation.json": Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
        [receipt.report.file]: report,
      };
    const facts = parseRootfsObservation(report.toString());
    const serial = report
      .toString()
      .match(/^Serial(?:\\t|[ \t])*:\s*([A-Za-z0-9._:-]{1,128})\s*$/m)[1];
    const minimal = Buffer.from(
      `===== compatible (verified stock observation)\ninmusic,acv8 inmusic,az01 rockchip,rk3288 \n\n===== product code\nACV8 \n\n===== cpuinfo\nSerial: ${serial}\n\n===== block devices\n179 6 ${facts.capacityBytes / 1024} mmcblk0p6\n\n===== dmesg\nVFS: Mounted root (ext4 filesystem) readonly on device 179:6.\n`,
    );
    const derived = {
      format: "xmp-live-mk1-hardware-observation",
      version: 1,
      bootloader: "0.4",
      report: { file: "stock-observation.txt", sha256: hash(minimal) },
      derivedFromReportSha256: hash(report),
      method: "Minimum identity/rootfs facts from the verified saved stock observation",
    };
    return {
      "hardware-observation.json": Buffer.from(JSON.stringify(derived, null, 2) + "\n"),
      "stock-observation.txt": minimal,
    };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function importUnitProfile(volume, stateDirectory) {
  const dir = join(volume, "xmp/.installer-profile");
  let receiptBytes;
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw Error("Symlink verification profile refused");
    receiptBytes = await regular(join(dir, "hardware-observation.json"), 16384);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  const receipt = JSON.parse(receiptBytes.toString());
  if (
    receipt.format !== "xmp-live-mk1-hardware-observation" ||
    !/^[A-Za-z0-9._-]+\.txt$/.test(receipt.report?.file ?? "")
  )
    throw Error("Invalid private MPC verification profile");
  const report = await regular(join(dir, receipt.report.file), 2 * 1024 ** 2);
  const facts = validateHardwareObservation(receipt, report);
  try {
    const pin = JSON.parse(
      (await regular(join(stateDirectory, "fastboot-identity.json"), 16384)).toString(),
    );
    if (pin.identity?.serial && !facts.serialHashes.includes(hash(pin.identity.serial)))
      throw Error("This USB verification profile belongs to a different MPC");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  for (const [name, b] of [
    [receipt.report.file, report],
    ["hardware-observation.json", receiptBytes],
  ]) {
    const temp = join(stateDirectory, `${name}.import-${Date.now()}`);
    await writeFile(temp, b, { flag: "wx", mode: 0o600 });
    await rename(temp, join(stateDirectory, name));
  }
  return true;
}
