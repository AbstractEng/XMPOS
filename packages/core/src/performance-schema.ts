import { z } from "zod";
import { parameterId } from "./sequence-schema.ts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  unit = z.number().finite().min(0).max(1);
export const PerformanceEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      at: z.number().finite().min(0).max(65535),
      kind: z.literal("mute"),
      trackId: id,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      id,
      at: z.number().finite().min(0).max(65535),
      kind: z.literal("solo"),
      trackId: id,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      id,
      at: z.number().finite().min(0).max(65535),
      kind: z.literal("macro"),
      macroId: id,
      value: unit,
    })
    .strict(),
]);
export const PerformanceSchema = z
  .object({
    version: z.literal(1),
    chain: z
      .array(z.object({ id, sceneId: id, repeats: z.number().int().min(1).max(16) }).strict())
      .max(64),
    end: z.enum(["stop", "loop"]),
    launchQuantize: z
      .union([z.literal(0), z.literal(4), z.literal(16), z.literal(32), z.literal(64)])
      .optional(),
    macros: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(40),
            value: unit,
            assignments: z
              .array(
                z
                  .object({ parameter: parameterId, amount: z.number().finite().min(-1).max(1) })
                  .strict(),
              )
              .max(16),
          })
          .strict(),
      )
      .max(8),
    mutes: z.record(id, z.boolean()),
    solos: z.array(id).max(8),
    events: z.array(PerformanceEventSchema).max(2048),
    selection: z
      .object({ sceneId: id, clips: z.record(id, id) })
      .strict()
      .optional(),
    position: z
      .object({ occurrenceId: id, offset: z.number().int().min(0).max(1023) })
      .strict()
      .optional(),
    delay: z
      .object({
        steps: z.number().finite().min(0.25).max(8),
        feedback: z.number().finite().min(0).max(0.75),
        wet: unit,
        sends: z.record(id, unit),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const unique = (a: string[], name: string) => {
      if (new Set(a).size !== a.length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${name}` });
    };
    unique(
      p.chain.map((c) => c.id),
      "song occurrence",
    );
    unique(
      p.macros.map((m) => m.id),
      "macro",
    );
    unique(
      p.events.map((e) => e.id),
      "performance event",
    );
    unique(p.solos, "solo track");
    for (const m of p.macros)
      unique(
        m.assignments.map((a) => a.parameter),
        "macro assignment",
      );
    if (Object.keys(p.mutes).length > 8 || Object.keys(p.delay.sends).length > 8)
      ctx.addIssue({ code: "custom", message: "Performance track budget exceeded" });
    if (p.events.some((e, i) => i > 0 && e.at < (p.events[i - 1]?.at ?? 0)))
      ctx.addIssue({ code: "custom", message: "Performance events must be ordered" });
  });
export type Performance = z.infer<typeof PerformanceSchema>;
export type PerformanceEvent = z.infer<typeof PerformanceEventSchema>;
export type ChainEntry = Performance["chain"][number];
export const emptyPerformance = (): Performance => ({
  version: 1,
  chain: [],
  end: "stop",
  macros: [],
  mutes: {},
  solos: [],
  events: [],
  delay: { steps: 1, feedback: 0.35, wet: 0, sends: {} },
});
