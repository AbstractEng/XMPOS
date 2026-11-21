import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStockInstallReport } from "./stock-install-report.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function regular(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum)
    throw new Error("Bounded regular hardware observation file required");
  return readFile(path);
}

// Saved output from an authorized earlier boot, not a universal partition-size
// default. It remains private and must identify this exact physical unit.
export function parseRootfsObservation(text) {
  if (/\binmusic,ada2\b|\binmusic,force\b/i.test(text))
    throw new Error("Protected Force hardware observation; refusing");
  const compatibles = text
    .match(/^===== compatible[^\n]*\n([^\n]+)/m)?.[1]
    .trim()
    .split(/\s+/);
  const serials = [...text.matchAll(/^Serial(?:\\t|[ \t])*:\s*([A-Za-z0-9._:-]{1,128})\s*$/gm)].map(
    (m) => m[1],
  );
  const product = text.match(/^===== product code\s*\n([^\n]+)/m)?.[1].trim();
  if (
    serials.length !== 1 ||
    product !== "ACV8" ||
    !compatibles?.includes("inmusic,acv8") ||
    !compatibles.includes("rockchip,rk3288") ||
    compatibles.includes("rockchip,rk3288-c")
  )
    throw new Error("Saved hardware report must identify one Live Mk1 ACV8 / RK3288 unit");
  const sections = text.split(/^===== block devices[ \t]*\r?$/m);
  if (sections.length !== 2) throw new Error("One saved block-device inventory is required");
  const section = sections[1].split(/^===== /m)[0];
  const partitions = [...section.matchAll(/^\s*179\s+6\s+(\d+)\s+mmcblk0p6\s*$/gm)];
  const rootMatches = [
    ...text.matchAll(
      /^VFS: Mounted root \(ext4 filesystem\) readonly on device (\d+):(\d+)\.\s*$/gm,
    ),
  ];
  if (
    partitions.length !== 1 ||
    rootMatches.length !== 1 ||
    rootMatches[0][1] !== "179" ||
    rootMatches[0][2] !== "6"
  )
    throw new Error(
      "Saved report does not unambiguously measure the mounted ext4 rootfs partition",
    );
  const capacityBytes = Number(partitions[0][1]) * 1024; // /proc/partitions reports KiB.
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 4096 || capacityBytes > 2 ** 31)
    throw new Error("Invalid saved rootfs capacity");
  return {
    serialSha256: sha(serials[0]),
    board: "inmusic,acv8",
    soc: "rockchip,rk3288",
    rootfsPartition: "mmcblk0p6",
    capacityBytes,
  };
}

export function validateHardwareObservation(receipt, report) {
  if (
    receipt?.format !== "xmp-live-mk1-hardware-observation" ||
    !/^[A-Za-z0-9._-]+\.txt$/.test(receipt.report?.file ?? "") ||
    !/^[a-f0-9]{64}$/.test(receipt.report?.sha256 ?? "") ||
    sha(report) !== receipt.report.sha256
  )
    throw new Error("Saved hardware observation hash changed or receipt invalid");
  if (receipt.version === 1 && receipt.bootloader === "0.4") {
    const facts = parseRootfsObservation(Buffer.from(report).toString("utf8"));
    return { ...facts, serialHashes: [facts.serialSha256], source: "saved-unit-report" };
  }
  if (
    receipt.version === 2 &&
    receipt.expectedBootloader === "0.4" &&
    receipt.method === "stock-3.10.1-readonly-query" &&
    typeof receipt.collectedAt === "string" &&
    Number.isFinite(Date.parse(receipt.collectedAt))
  )
    return parseStockInstallReport(Buffer.from(report).toString("utf8"));
  throw new Error("Unsupported saved hardware observation receipt");
}

export async function loadHardwareObservation(stateDirectory, identity) {
  try {
    const pin = JSON.parse(
      (await regular(join(stateDirectory, "stock-device-identity.json"), 16384)).toString("utf8"),
    );
    if (
      pin.version !== 1 ||
      !Array.isArray(pin.serialHashes) ||
      pin.serialHashes.length < 1 ||
      pin.serialHashes.length > 2 ||
      pin.serialHashes.some((h) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) ||
      !pin.serialHashes.includes(sha(identity.serial))
    )
      throw new Error("Fastboot unit differs from the Live verified in stock OS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let bytes;
  try {
    bytes = await regular(join(stateDirectory, "hardware-observation.json"), 16384);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (!/^[A-Za-z0-9._-]+\.txt$/.test(receipt.report?.file ?? ""))
    throw new Error("Invalid saved hardware observation receipt");
  const report = await regular(join(stateDirectory, receipt.report.file), 2 * 1024 * 1024);
  const observation = validateHardwareObservation(receipt, report);
  if (
    !observation.serialHashes.includes(sha(identity.serial)) ||
    identity["version-bootloader"] !== "0.4" ||
    identity["partition-type:rootfs"] !== "ext4"
  )
    throw new Error("Saved hardware observation does not match this Live and bootloader");
  return {
    ...observation,
    serialSha256: sha(identity.serial),
    reportSha256: receipt.report.sha256,
    receiptSha256: sha(bytes),
    source: observation.source,
  };
}
