import { z } from "zod";
export const VmProfile = z
  .object({
    id: z.literal("p10-qemu-x86_64-v1"),
    architecture: z.literal("x86_64"),
    machine: z.literal("pc-i440fx-8.2"),
    accelerator: z.literal("tcg"),
    cpu: z.literal("max"),
    vcpus: z.literal(2),
    memoryMiB: z.literal(1024),
    dataMiB: z.literal(128),
    sampleRate: z.literal(48000),
    audio: z.string().max(80),
    controls: z.string().max(80),
    bootReadyLimitSeconds: z.literal(60),
    commandLimitSeconds: z.literal(90),
    uiRestartBudget: z.literal(3),
    network: z.literal(false),
    hostShares: z.literal(false),
    usbPassthrough: z.literal(false),
    labAgentEnabled: z.literal(false),
    physicalAudioQualified: z.literal(false),
    mpcDriversQualified: z.literal(false),
  })
  .strict();
// Separate profile: the P10 timing/memory contract stays frozen.
export const DeviceVmProfile = VmProfile.extend({
  id: z.literal("device-qemu-x86_64-v1"),
  memoryMiB: z.literal(3072),
  dataMiB: z.literal(512),
  bootReadyLimitSeconds: z.literal(180),
}).strict();
// ARMv7 Device profile: the official az01 kernel on QEMU's generic virt board.
// Slower TCG emulation of ARM gets its own frozen limits.
export const ArmDeviceVmProfile = VmProfile.extend({
  id: z.literal("device-qemu-armv7-az01-v1"),
  architecture: z.literal("armv7"),
  machine: z.literal("virt"),
  cpu: z.literal("cortex-a15"),
  memoryMiB: z.literal(2048),
  dataMiB: z.literal(512),
  bootReadyLimitSeconds: z.literal(900),
  commandLimitSeconds: z.literal(300),
}).strict();
export const DevelopmentVmProfile = z.union([VmProfile, DeviceVmProfile, ArmDeviceVmProfile]);
export function releaseGate(components, { publicImage = false } = {}) {
  if (!Array.isArray(components) || components.length > 128)
    throw new Error("Invalid image component ledger");
  for (const c of components) {
    if (
      !c ||
      typeof c.id !== "string" ||
      typeof c.license !== "string" ||
      c.vendorPayload ||
      /proprietary|unknown/i.test(c.license)
    )
      throw new Error(`Unresolved redistribution dependency ${c?.id ?? "unknown"}; image blocked`);
    if (
      publicImage &&
      (!/^[a-f0-9]{64}$/.test(c.correspondingSourceSha256 ?? "") || c.redistribution !== "reviewed")
    )
      throw new Error(`Public image blocked: ${c.id} corresponding source/notices review pending`);
  }
  return {
    allowed: true,
    scope: publicImage ? "public" : "local-development-only",
    proprietaryPayloads: false,
  };
}
export function vmQualification({ passed = false, buildId, profile }) {
  if (!/^[a-f0-9]{64}$/.test(buildId) || profile !== "p10-qemu-x86_64-v1")
    throw new Error("Missing booted image identity");
  return {
    profile,
    buildId,
    genericVmSoftwarePassed: passed,
    physicalAudioQualified: false,
    mpcDriversQualified: false,
    phaseQualified: false,
    requiredPhysicalEvidence: [
      "Live Mk1 pads",
      "internal codec",
      "battery",
      "USB mode",
      "boot recovery",
    ],
    pending: [
      "graphical/touch workstation UI",
      "reviewed public redistribution/source bundle and independent source-builder qualification",
      "full native real-time engine parity",
      "physical audio and control timing",
      "booted package sandbox qualification",
    ],
  };
}
