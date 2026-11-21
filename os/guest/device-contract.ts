import { z } from "zod";

export const DeviceCommand = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("device-file-start"),
      kind: z.enum(["song", "sample"]),
      bytes: z
        .number()
        .int()
        .min(1)
        .max(96 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      op: z.literal("device-file-write"),
      offset: z
        .number()
        .int()
        .min(0)
        .max(96 * 1024 * 1024),
      data: z
        .string()
        .min(4)
        .max(2732)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  z.object({ op: z.literal("device-file-open") }).strict(),
  z.object({ op: z.literal("device-file-save"), packageSamples: z.boolean() }).strict(),
  z
    .object({
      op: z.literal("device-file-read"),
      id: z.string().uuid(),
      offset: z
        .number()
        .int()
        .min(0)
        .max(96 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      op: z.enum([
        "device-status",
        "device-snapshot",
        "device-reload",
        "device-export",
        "arm-parity",
        "hardware-probe",
        "shutdown",
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("arm-test"),
      name: z.enum([
        "sampler",
        "render-short",
        "exhaustion",
        "tempo",
        "commands",
        "critical",
        "canary",
      ]),
    })
    .strict(),
  z
    .object({ op: z.literal("device-chunk"), offset: z.number().int().min(0).max(2_000_000) })
    .strict(),
  z
    .object({
      op: z.literal("device-click"),
      x: z.number().int().min(0).max(1599),
      y: z.number().int().min(0).max(999),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("device-key"),
      key: z.enum([
        "Tab",
        "Enter",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        " ",
      ]),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("device-control"),
      kind: z.enum(["panel", "pad", "step", "slot", "action", "page"]),
      id: z.string().regex(/^[a-z0-9-]{1,32}$/),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("device-select"),
      id: z.enum([
        "device-sound",
        "device-track",
        "device-machine",
        "device-scene",
        "device-length",
      ]),
      value: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
    })
    .strict(),
]);
export type DeviceCommand = z.infer<typeof DeviceCommand>;
