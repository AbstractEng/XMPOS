import { createHash } from "node:crypto";

// Only mpc-remote.mjs may send this fixed read-only script to the owner-selected
// Live in stock MPC OS. No received or typed value is substituted into it.
export const STOCK_INSTALL_PROBE = [
  "set -e",
  "B=/sys/firmware/devicetree/base",
  "C=$(tr '\\000' ' ' < $B/compatible)",
  "P=$(tr -d '\\000' < $B/inmusic,product-code)",
  "M=$(tr '\\000' ' ' < $B/model)",
  "V=$(head -n 1 /tmp/com.akaipro.mpc.version)",
  'case " $C " in *" inmusic,acv8 "*) ;; *) exit 20;; esac',
  'case " $C " in *" rockchip,rk3288 "*) ;; *) exit 20;; esac',
  "N=$(printf '%s' \"$C $M\" | tr '[:upper:]' '[:lower:]')",
  'case "$N" in *force*|*ada2*|*rk3288-c*) exit 20;; esac',
  '[ "$P" = ACV8 ]',
  "VN=$(printf '%s\\n' \"$V\" | awk 'match($0, /[0-9]+\\.[0-9]+\\.[0-9]+/) {print substr($0,RSTART,RLENGTH);exit}')",
  '[ "$VN" = 3.10.1 ]',
  "printf 'XMP_STOCK_INSTALL_REPORT_V1\\n'",
  "printf '@@compatible\\n%s\\n' \"$C\"",
  "printf '@@model\\n%s\\n' \"$M\"",
  "printf '@@product\\n%s\\n' \"$P\"",
  "printf '@@serial\\n'; tr '\\000' ' ' < $B/serial-number; echo",
  "printf '@@cpu_serial\\n'; sed -n '/^Serial[[:space:]]*:/p' /proc/cpuinfo",
  "printf '@@version\\n%s\\n' \"$V\"",
  "printf '@@root_device\\n'; stat -c %d /",
  "printf '@@root_mount\\n'; awk '$3 == \"179:6\" && $5 == \"/\" { print; n++ } END { if(n != 1) exit 1 }' /proc/self/mountinfo",
  "printf '@@partitions\\n'; cat /proc/partitions",
  "printf '@@rootfs_sectors\\n'; cat /sys/dev/block/179:6/size",
  "printf '@@rootfs_path\\n'; readlink -f /sys/dev/block/179:6",
  "printf '@@end\\n'",
].join("\n");

const sha = (value) => createHash("sha256").update(value).digest("hex");
const serial = (value) =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^(?:0+|f+|unknown|none|null)$/i.test(value);

export function parseStockInstallReport(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536 || text.includes("\0"))
    throw new Error("Bounded stock verification report required");
  if (!text.startsWith("XMP_STOCK_INSTALL_REPORT_V1\n"))
    throw new Error("Stock verification report header missing");
  const names = [
    "compatible",
    "model",
    "product",
    "serial",
    "cpu_serial",
    "version",
    "root_device",
    "root_mount",
    "partitions",
    "rootfs_sectors",
    "rootfs_path",
    "end",
  ];
  const found = [...text.matchAll(/^@@([a-z_]+)\r?$/gm)];
  if (JSON.stringify(found.map((m) => m[1])) !== JSON.stringify(names))
    throw new Error("Incomplete, duplicate or reordered stock verification fields");
  const fields = {};
  for (let i = 0; i < found.length - 1; i++)
    fields[found[i][1]] = text
      .slice(found[i].index + found[i][0].length, found[i + 1].index)
      .trim();
  if (text.slice(found.at(-1).index + found.at(-1)[0].length).trim())
    throw new Error("Unexpected stock verification trailer");
  const compatibles = fields.compatible.split(/\s+/);
  if (/force|ada2/i.test(fields.compatible + " " + fields.product + " " + fields.model))
    throw new Error("Protected Force or unsupported stock device; refusing");
  if (
    fields.product !== "ACV8" ||
    !compatibles.includes("inmusic,acv8") ||
    !compatibles.includes("rockchip,rk3288") ||
    compatibles.includes("rockchip,rk3288-c")
  )
    throw new Error("Stock verification requires Live Mk1 ACV8 / plain RK3288");
  const version = fields.version.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== "3.10.1") throw new Error("Stock MPC OS must be exactly 3.10.1");
  const cpu = [
    ...fields.cpu_serial.matchAll(/^Serial[ \t]*:[ \t]*([A-Za-z0-9._:-]{1,128})[ \t]*$/gm),
  ];
  if (!serial(fields.serial) || cpu.length !== 1)
    throw new Error("Unambiguous stock device-tree and CPU serials required");
  if (fields.root_device !== "45830")
    throw new Error("Active root filesystem is not the measured internal rootfs device");
  const mountLines = fields.root_mount.split("\n");
  const pieces = mountLines[0].split(" - ");
  const left = pieces[0].split(/\s+/),
    right = pieces[1]?.split(/\s+/);
  if (
    mountLines.length !== 1 ||
    pieces.length !== 2 ||
    left[2] !== "179:6" ||
    left[4] !== "/" ||
    right?.[0] !== "ext4"
  )
    throw new Error("Stock root must be the measured ext4 rootfs on 179:6");
  if (
    !/^\/sys\/devices\/.+\/mmcblk0\/mmcblk0p6$/.test(fields.rootfs_path) ||
    !fields.rootfs_path.includes("ff0f0000") ||
    fields.rootfs_path.includes("ff0c0000")
  )
    throw new Error("Rootfs must resolve to the internal eMMC controller ff0f0000");
  const entries = [...fields.partitions.matchAll(/^\s*179\s+6\s+(\d+)\s+mmcblk0p6\s*$/gm)];
  if (entries.length !== 1 || !/^\d{1,12}$/.test(fields.rootfs_sectors))
    throw new Error("Unambiguous measured rootfs sectors and partition inventory required");
  const capacityBytes = Number(fields.rootfs_sectors) * 512;
  const tableBytes = Number(entries[0][1]) * 1024;
  if (
    !Number.isSafeInteger(capacityBytes) ||
    capacityBytes < 4096 ||
    capacityBytes > 2 ** 31 ||
    tableBytes !== Math.floor(capacityBytes / 1024) * 1024
  )
    throw new Error("Rootfs size and partition measurements conflict");
  return {
    compatible: compatibles.join(","),
    model: fields.model,
    board: "inmusic,acv8",
    soc: "rockchip,rk3288",
    mpcOsVersion: version,
    rootfsPartition: "mmcblk0p6",
    capacityBytes,
    serialSha256: sha(fields.serial),
    serialHashes: [...new Set([fields.serial, cpu[0][1]].filter(serial).map(sha))],
    deviceTreeSerial: fields.serial,
    filesystem: "ext4",
    rootDevice: "179:6",
    source: "stock-3.10.1-readonly-query",
  };
}

export function stockInstallReceipt(report, { collectedAt = new Date().toISOString() } = {}) {
  parseStockInstallReport(report);
  return {
    format: "xmp-live-mk1-hardware-observation",
    version: 2,
    method: "stock-3.10.1-readonly-query",
    expectedBootloader: "0.4",
    collectedAt,
    report: { file: "stock-install-verification.txt", sha256: sha(report) },
  };
}
