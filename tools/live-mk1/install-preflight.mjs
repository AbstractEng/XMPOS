import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { COMPATIBILITY } from "./compatibility.mjs";

const text = z.string().min(1).max(160);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Facts are explicit local observations, never instructions sent to a device.
const observations = z
  .object({
    version: z.literal(1),
    model: text,
    devices: z.array(z.object({ board: text, soc: text }).strict()).max(4),
    identityMatchesPinnedLive: z.boolean(),
    firstUseOwnerConfirmationPlanned: z.boolean().default(false),
    mpcOsVersion: text,
    bootloader: text.nullable(),
    rootfs: z
      .object({ filesystem: text, capacityBytes: bytes.nullable(), loaderBytes: bytes })
      .strict(),
    updater: z
      .object({ signatureVerified: z.boolean(), imageSha256: hash, rootfsSha256: hash })
      .strict(),
    loaderHashIndependentlyVerified: z.boolean(),
    stick: z
      .object({
        filesystem: text,
        label: text,
        capacityBytes: bytes,
        freeBytes: bytes,
        partitionTableReviewed: z.boolean(),
      })
      .strict(),
    powerAndDataCableReviewed: z.boolean(),
    recoveryImageVerified: z.boolean(),
    setupDoctorPassed: z.boolean(),
    workspaceFreeBytes: bytes,
  })
  .strict();

export function installPreflight(input, host) {
  const facts = observations.parse(input);
  const record = COMPATIBILITY;
  const stops = [];
  const stop = (condition, code, instruction) => {
    if (!condition) stops.push({ code, instruction });
  };
  const target = record.models.find((model) => model.id === facts.model);
  const live = record.models.find((model) => model.id === "live-mk1");
  stop(
    target?.ownerRehearsalTarget === true,
    "model",
    "This model has no enabled owner rehearsal route. Keep stock firmware; One ports need their own adapters and qualification.",
  );
  stop(
    !/force|ada2/i.test(JSON.stringify([facts.model, facts.devices])),
    "protected",
    "Force is protected. Do not contact or open it.",
  );
  stop(
    facts.devices.length === 1 &&
      facts.devices[0].board === live.board &&
      facts.devices[0].soc === live.testedSoc,
    "identity",
    "Exactly one observed ACV8 / plain RK3288 is required. Unknown boards and the untested RK3288-C revision stop here.",
  );
  stop(
    facts.identityMatchesPinnedLive || facts.firstUseOwnerConfirmationPlanned,
    "pinned-identity",
    "Require a matching stored unit serial, or plan the owner's typed first-use enrolment. The flash tool must still confirm the actual unit before writing.",
  );
  stop(
    facts.mpcOsVersion === record.baseline.mpcOsVersion,
    "firmware",
    "Only stock MPC OS 3.10.1 is in this candidate profile. The owner manages official updates.",
  );
  stop(
    facts.bootloader === live.bootloader,
    "bootloader",
    "Only bootloader 0.4 has saved observations. Do not change the bootloader.",
  );
  stop(
    facts.rootfs.filesystem === "ext4" &&
      facts.rootfs.capacityBytes !== null &&
      facts.rootfs.loaderBytes > 0 &&
      facts.rootfs.capacityBytes >= facts.rootfs.loaderBytes,
    "rootfs-capacity",
    "Require a readable ext4 rootfs capacity sufficient for the verified loader. Missing fastboot size is a stop, not permission to guess.",
  );
  stop(
    facts.updater.signatureVerified &&
      facts.updater.imageSha256 === record.baseline.updaterImageSha256 &&
      facts.updater.rootfsSha256 === record.baseline.rootfsSha256,
    "updater",
    "Verify the official signed, pinned Gen 1 3.10.1 updater and original rootfs locally.",
  );
  stop(
    facts.loaderHashIndependentlyVerified,
    "loader-receipt",
    "Record the exact verified candidate loader hash; historical owner attestation alone is incomplete.",
  );
  stop(
    host?.platform === record.host.platform &&
      host.arch === record.host.arch &&
      host.osVersion === record.host.osVersion &&
      host.nodeMajor === record.host.nodeMajor,
    "host",
    "Use the observed Intel macOS 13.4.1 / Node 24 profile for this rehearsal or qualify a new host profile first.",
  );
  stop(
    facts.stick.filesystem === record.storage.filesystem &&
      record.storage.labels.includes(facts.stick.label) &&
      facts.stick.capacityBytes >= record.storage.minimumCapacityBytes &&
      facts.stick.freeBytes >= record.storage.minimumFreeBytes &&
      facts.stick.freeBytes <= facts.stick.capacityBytes &&
      facts.stick.partitionTableReviewed,
    "stick",
    "Review the USB stick partition layout, FAT32/vfat, XMP or XMPPROBE label, capacity and free space against the provisional budget. Do not reformat automatically.",
  );
  stop(
    facts.workspaceFreeBytes >= record.storage.minimumWorkspaceFreeBytes,
    "workspace",
    "Free at least the provisional 8 GiB workspace budget before a clean preparation/build rehearsal.",
  );
  stop(
    facts.powerAndDataCableReviewed && facts.recoveryImageVerified && facts.setupDoctorPassed,
    "preparation",
    "Review mains power and data cable, verified offline recovery image and live:setup:doctor before the owner proceeds.",
  );
  return {
    format: "xmp-offline-install-preflight",
    version: 1,
    compatibilitySha256: createHash("sha256")
      .update(readFileSync(new URL("../../os/compatibility.json", import.meta.url)))
      .digest("hex"),
    observationsSatisfyProfile: stops.length === 0,
    publicInstallationAllowed: false,
    stops,
    remainingReleaseEvidence: record.openEvidence,
    plannedPortWork: record.plannedPortWork,
    scope:
      "Offline observation review only. Does not discover, open or authenticate hardware, verify supplied files, authorize flashing or clear release gates. Existing signature/hash/device checks and owner-only typed flash confirmation remain mandatory. Never invent facts to obtain a pass.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, ...extra] = process.argv.slice(2);
    if (!path || extra.length)
      throw new Error("Usage: npm run live:preflight -- <local-observations.json>");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
      throw new Error("Observations must be a regular JSON file of at most 16 KiB");
    const osVersion =
      process.platform === "darwin"
        ? spawnSync("sw_vers", ["-productVersion"], {
            encoding: "utf8",
            timeout: 3000,
          }).stdout?.trim()
        : "unqualified";
    const result = installPreflight(JSON.parse(readFileSync(path, "utf8")), {
      platform: process.platform,
      arch: process.arch,
      osVersion,
      nodeMajor: Number(process.versions.node.split(".")[0]),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.observationsSatisfyProfile ? 0 : 1;
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Invalid or incomplete bounded observation record; see docs/install-preflight.example.json"
        : error.message,
    );
    process.exitCode = 1;
  }
}
