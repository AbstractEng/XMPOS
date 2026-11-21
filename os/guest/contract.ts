import { z } from "zod";
import { ParityPlanSchema } from "../../packages/sdk/src/parity.ts";
export const GuestCommand = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("sdk-parity"),
      plan: ParityPlanSchema,
      backend: z.enum(["reference", "native"]),
    })
    .strict(),
  z
    .object({
      op: z.enum([
        "status",
        "record",
        "beat",
        "synth",
        "arrange",
        "save",
        "reopen",
        "export",
        "fixture",
        "diagnostics",
        "crash-ui",
        "exhaust-ui",
        "shutdown",
        "recovery-report",
        "recovery-export",
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("fault-save"),
      point: z.enum(["pending-fsynced", "backup-fsynced", "primary-renamed", "directory-fsynced"]),
    })
    .strict(),
  z.object({ op: z.literal("fault-corrupt"), all: z.boolean() }).strict(),
  z.object({ op: z.literal("load-project"), text: z.string().min(1).max(131072) }).strict(),
  z.object({ op: z.literal("rename"), name: z.string().min(1).max(80) }).strict(),
  z.object({ op: z.literal("pad"), pad: z.number().int().min(0).max(15) }).strict(),
  z
    .object({
      op: z.literal("step"),
      pad: z.number().int().min(0).max(15),
      step: z.number().int().min(0).max(15),
    })
    .strict(),
]);
export type GuestCommand = z.infer<typeof GuestCommand>;
const eventNames = [
  "storage-ready",
  "engine-ready",
  "ui-ready",
  "project-saved",
  "saves-flushed",
  "ui-crashed",
  "ui-recovery",
  "engine-stopped",
  "shutdown",
  "first-pad",
  "record-metronome",
] as const;
export const ServiceEvent = z
  .object({ event: z.enum(eventNames), at: z.number().finite().min(0).max(1000000) })
  .strict();
export function diagnosticBundle(
  build: { buildId: string; profile: string; kernel: string },
  events: unknown[],
  errors: string[],
) {
  const allowed = new Set([
    "UI_RESTART_BUDGET",
    "SAVE_FAILED",
    "COMMAND_REJECTED",
    "ENGINE_FAILED",
  ]);
  return {
    format: "xmp-os-diagnostics",
    version: 1,
    build: {
      buildId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(build.buildId),
      profile: z
        .string()
        .regex(/^p10-qemu-x86_64-v1$/)
        .parse(build.profile),
      kernel: z
        .string()
        .regex(/^[0-9a-zA-Z.+_-]{1,80}$/)
        .parse(build.kernel),
    },
    services: events.slice(-64).map((e) => ServiceEvent.parse(e)),
    errors: errors.filter((e) => allowed.has(e)).slice(-32),
    redaction: {
      personalAudioIncluded: false,
      projectContentsIncluded: false,
      credentialsIncluded: false,
      deviceIdentifiersIncluded: false,
    },
  };
}
export class ServiceLifecycle {
  readonly events: { event: (typeof eventNames)[number]; at: number }[] = [];
  readonly errors: string[] = [];
  storage = false;
  engine = false;
  ui = false;
  recovery = false;
  restarts = 0;
  event(event: (typeof eventNames)[number], at: number) {
    this.events.push(ServiceEvent.parse({ event, at }));
    if (this.events.length > 64) this.events.shift();
  }
  error(code: string) {
    this.errors.push(code);
    if (this.errors.length > 32) this.errors.shift();
  }
  storageReady(at: number) {
    if (this.storage) throw new Error("Storage already ready");
    this.storage = true;
    this.event("storage-ready", at);
  }
  engineReady(at: number) {
    if (!this.storage) throw new Error("Engine requires persistent storage");
    this.engine = true;
    this.event("engine-ready", at);
  }
  uiReady(at: number) {
    if (!this.engine || this.recovery)
      throw new Error("UI cannot claim playable before engine readiness");
    this.ui = true;
    this.event("ui-ready", at);
  }
  uiCrash(at: number) {
    this.ui = false;
    this.event("ui-crashed", at);
    if (++this.restarts > 3) {
      this.recovery = true;
      this.error("UI_RESTART_BUDGET");
      this.event("ui-recovery", at);
      return false;
    }
    return true;
  }
  stop(at: number) {
    if (!this.storage) throw new Error("Storage unavailable during shutdown");
    this.event("saves-flushed", at);
    this.ui = false;
    this.engine = false;
    this.event("engine-stopped", at);
    this.event("shutdown", at);
  }
}
