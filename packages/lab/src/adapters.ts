import { z } from "zod";
export const requiredServices = [
  "internal-audio",
  "pads",
  "touch",
  "encoders",
  "transport",
  "midi",
  "battery",
  "storage",
] as const;
export const ServiceReport = z
  .object({
    id: z.enum(requiredServices),
    version: z.string().min(1).max(32),
    state: z.enum(["missing", "simulated", "measured-unreviewed"]),
  })
  .strict();
export function adapterReadiness(input: unknown) {
  const reports = z.array(ServiceReport).max(8).parse(input);
  if (new Set(reports.map((r) => r.id)).size !== reports.length)
    throw new Error("Duplicate adapter report");
  const missing = requiredServices.filter(
    (id) => !reports.some((r) => r.id === id && r.state !== "missing"),
  );
  return {
    mode: missing.length ? "safe-recovery" : "host-development",
    missing,
    physicalQualified: false,
    pressureQualified: false,
    gestureQualified: false,
    evidence: reports,
  };
}
const stamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ControlInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pad"),
      pad: z.number().int().min(0).max(15),
      velocity: z.number().int().min(0).max(127),
      atUs: stamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("touch"),
      contact: z.number().int().min(0).max(9),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(16).max(8192),
      height: z.number().int().min(16).max(8192),
      atUs: stamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("encoder"),
      encoder: z.number().int().min(0).max(3),
      delta: z.number().int().min(-127).max(127),
      atUs: stamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("transport"),
      action: z.enum(["start", "stop", "record"]),
      atUs: stamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("battery"),
      percent: z.number().finite().min(0).max(100),
      charging: z.boolean(),
      atUs: stamp,
    })
    .strict(),
]);
export function normalizeControl(input: unknown) {
  const event = ControlInput.parse(input);
  if (event.kind === "touch") {
    if (event.x >= event.width || event.y >= event.height)
      throw new Error("Touch coordinate outside adapter surface");
    return {
      ...event,
      x: event.x / (event.width - 1),
      y: event.y / (event.height - 1),
      source: "host-fixture",
      physicalQualified: false,
    };
  }
  if (event.kind === "pad")
    return {
      ...event,
      velocity: event.velocity / 127,
      pressed: event.velocity !== 0,
      source: "host-fixture",
      physicalQualified: false,
    };
  return { ...event, source: "host-fixture", physicalQualified: false };
}
