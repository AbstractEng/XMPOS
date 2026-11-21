import { z } from "zod";
import { digest, opaqueId } from "./contracts.ts";

const model = z.enum(["Akai MPC Live Mk1", "Akai Force", "unknown"]);
const kinds = [
  "stock-observation",
  "boot",
  "recovery",
  "usb-topology",
  "owner-authorization",
] as const;
export const TargetDossier = z
  .object({
    format: z.literal("xmp-target-dossier"),
    version: z.literal(1),
    alias: opaqueId,
    model,
    firmware: z.string().min(1).max(32).nullable(),
    board: z.string().min(1).max(64).nullable(),
    buildHash: digest.nullable(),
    bootTier: z.enum(["unknown", "stock-linux-xmp-app", "independent-xmp-image"]),
    evidence: z
      .array(
        z
          .object({
            id: opaqueId,
            kind: z.enum(kinds),
            model,
            firmware: z.string().min(1).max(32),
            alias: opaqueId,
            status: z.enum(["research-only", "observed-unreviewed", "reviewed"]),
            sha256: digest,
            board: z.string().min(1).max(64),
            buildHash: digest,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export function reviewTarget(input: unknown) {
  const dossier = TargetDossier.parse(input);
  const protectedTarget = dossier.model === "Akai Force";
  const missing: string[] = [];
  if (dossier.model !== "Akai MPC Live Mk1") missing.push("exact Live Mk1 model");
  if (!dossier.firmware) missing.push("stock firmware observation");
  if (!dossier.board) missing.push("unit-specific board evidence");
  if (!dossier.buildHash) missing.push("reviewed target build");
  if (dossier.bootTier !== "independent-xmp-image") missing.push("independent OS boot evidence");
  for (const kind of kinds)
    if (
      !dossier.evidence.some(
        (e) =>
          e.kind === kind &&
          e.status === "reviewed" &&
          e.alias === dossier.alias &&
          e.model === dossier.model &&
          e.firmware === dossier.firmware &&
          e.board === dossier.board &&
          e.buildHash === dossier.buildHash,
      )
    )
      missing.push(kind);
  return {
    format: "xmp-bring-up-review",
    alias: dossier.alias,
    model: dossier.model,
    protectedTarget,
    missing,
    readyForDeviceSpecificReview: !protectedTarget && !missing.length,
    activeAdapterAvailable: false,
    deviceAccessAuthorized: false,
    hardwareQualified: false,
    proposedOperations: ["status", "stage", "load", "action", "render", "results"],
    prohibitedOperations: [
      "shell",
      "flash",
      "reboot",
      "mount",
      "driver-install",
      "arbitrary-file-write",
    ],
    nextStep: protectedTarget
      ? "Passive host inventory only"
      : "Attach exact-unit evidence and obtain separate device-specific authorization; no connection is made by this review",
  };
}
