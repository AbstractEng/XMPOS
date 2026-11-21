import { z } from "zod";

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const opaqueId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const labOperations = ["status", "stage", "load", "action", "render", "results"] as const;
export const LabGrant = z
  .object({
    profile: z.literal("host-lab-development-v1"),
    model: z.literal("XMP host simulator"),
    alias: opaqueId,
    buildHash: digest,
    bootTier: z.literal("host-simulator"),
    protocol: z.literal(1),
    hostPin: digest,
    agentPin: digest,
    fixtureHash: digest,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    operations: z.array(z.enum(labOperations)).min(1).max(6),
  })
  .strict();
export type LabGrant = z.infer<typeof LabGrant>;
export function validateGrant(input: unknown, now = Date.now()) {
  const grant = LabGrant.parse(input);
  if (
    grant.issuedAt > now ||
    grant.expiresAt <= now ||
    grant.expiresAt - grant.issuedAt > 300000 ||
    new Set(grant.operations).size !== grant.operations.length
  )
    throw new Error("Expired or invalid simulator grant");
  return grant;
}
export const LabCommand = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["status", "results"]) }).strict(),
  z
    .object({
      op: z.literal("stage"),
      fixtureId: opaqueId,
      sha256: digest,
      text: z.string().min(1).max(262144),
    })
    .strict(),
  z.object({ op: z.enum(["load", "render"]), fixtureId: opaqueId }).strict(),
  z.object({ op: z.literal("action"), action: z.enum(["start", "stop"]) }).strict(),
]);
export type LabCommand = z.infer<typeof LabCommand>;
export const Envelope = z
  .object({ session: digest, sequence: z.number().int().min(1).max(4096), command: z.unknown() })
  .strict();
export const Hello = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(1),
    nonce: digest,
    alias: opaqueId,
    buildHash: digest,
  })
  .strict();
export const Attestation = z
  .object({
    type: z.literal("attestation"),
    protocol: z.literal(1),
    nonce: digest,
    session: digest,
    alias: opaqueId,
    model: z.literal("XMP host simulator"),
    buildHash: digest,
    bootTier: z.literal("host-simulator"),
    expiresAt: z.number().int().nonnegative(),
    fixtureHash: digest,
    operations: z.array(z.enum(labOperations)).min(1).max(6),
    proof: digest,
  })
  .strict();
export const labLimits = Object.freeze({
  frameBytes: 524288,
  fixtureBytes: 262144,
  fixtureCount: 4,
  totalFixtureBytes: 1048576,
  pendingCommands: 8,
  commandsPerMinute: 64,
  sessionMs: 300000,
});
