import { z } from "zod";

const position = z.number().finite().min(0).max(1024);
const unit = z.number().finite().min(0).max(1);
export const parameterId = z
  .string()
  .regex(
    /^(master\.gain|return\.[01]\.insert\.[a-zA-Z0-9_-]{1,64}\.[a-z]{1,16}|track\.[a-zA-Z0-9_-]{1,64}\.(gain|pan|send\.[01]|insert\.[a-zA-Z0-9_-]{1,64}\.[a-z]{1,16}|effect\.gain|machine\.[a-z][a-z0-9.-]{1,63}\.v[1-9][0-9]{0,3}\.[a-z][a-z0-9-]{0,31}))$/,
  );
export const SequenceNoteSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    pad: z.number().int().min(0).max(15),
    note: z.number().int().min(0).max(127),
    position,
    duration: z
      .number()
      .finite()
      .min(1 / 960)
      .max(64),
    velocity: unit,
    probability: unit,
    microtiming: z.number().finite().min(-0.49).max(0.49),
    condition: z.enum(["always", "first", "not-first", "fill", "not-fill", "every-2", "every-4"]),
    original: z
      .object({
        position,
        duration: z
          .number()
          .finite()
          .min(1 / 960)
          .max(64),
        velocity: unit,
        timestamp: z.number().finite().min(0).max(86400),
      })
      .strict()
      .optional(),
  })
  .strict();
export const LaneSchema = z
  .object({
    parameter: parameterId,
    points: z.array(z.object({ position, value: unit }).strict()).max(256),
  })
  .strict();
export const SequenceSchema = z
  .object({
    version: z.literal(1),
    notes: z.array(SequenceNoteSchema).max(1024),
    locks: z
      .array(
        z
          .object({
            position: z.number().int().min(0).max(1023),
            parameter: parameterId,
            value: unit,
          })
          .strict(),
      )
      .max(256),
    lanes: z.array(LaneSchema).max(32),
    modulations: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
            parameter: parameterId,
            kind: z.enum(["macro", "lfo"]),
            amount: z.number().finite().min(-1).max(1),
            cycles: z.number().finite().min(0.0625).max(16),
            phase: unit,
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .superRefine((seq, ctx) => {
    const unique = (keys: string[], label: string) => {
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${label}` });
    };
    unique(
      seq.notes.map((n) => n.id),
      "note ID",
    );
    unique(
      seq.lanes.map((l) => l.parameter),
      "automation lane",
    );
    unique(
      seq.locks.map((l) => `${l.position}:${l.parameter}`),
      "lock",
    );
    unique(
      seq.modulations.map((m) => m.id),
      "modulation ID",
    );
    for (const lane of seq.lanes)
      if (lane.points.some((p, i) => i > 0 && p.position <= (lane.points[i - 1]?.position ?? 0)))
        ctx.addIssue({ code: "custom", message: "Automation points must be strictly ordered" });
  });
export type SequenceNote = z.infer<typeof SequenceNoteSchema>;
export type Sequence = z.infer<typeof SequenceSchema>;
export type AutomationLane = z.infer<typeof LaneSchema>;
export const emptySequence = (): Sequence => ({
  version: 1,
  notes: [],
  locks: [],
  lanes: [],
  modulations: [],
});
