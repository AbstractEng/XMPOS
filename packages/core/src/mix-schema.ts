import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  unit = z.number().finite().min(0).max(1);
export const effectDefaults = {
  eq: { tone: 0.5, gain: 0.5 },
  filter: { cutoff: 0.7 },
  delay: { time: 0.125, feedback: 0.4, wet: 0.35 },
  reverb: { decay: 0.5, wet: 0.25 },
  distortion: { drive: 0.25, wet: 0.5 },
  compressor: { threshold: 0.6, ratio: 0.3, makeup: 0 },
} as const;
export type EffectKind = keyof typeof effectDefaults;
export const EffectSchema = z
  .object({
    id,
    kind: z.enum(["eq", "filter", "delay", "reverb", "distortion", "compressor"]),
    bypass: z.boolean(),
    params: z.record(z.string().max(16), unit),
    sync: z
      .object({
        division: z.number().finite().min(0.25).max(8),
        sequence: z.array(unit).min(1).max(16),
        phase: z.literal("transport"),
        loss: z.literal("hold-last-tempo"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const keys = Object.keys(effectDefaults[e.kind]);
    if (Object.keys(e.params).length !== keys.length || keys.some((k) => e.params[k] === undefined))
      ctx.addIssue({ code: "custom", message: "Effect parameter set does not match its kind" });
    if (e.sync && e.kind !== "delay" && e.kind !== "filter")
      ctx.addIssue({ code: "custom", message: "Only filter and delay support clock sync" });
  });
export type Effect = z.infer<typeof EffectSchema>;
export function createEffect(kind: EffectKind, id: string): Effect {
  return EffectSchema.parse({ id, kind, bypass: false, params: { ...effectDefaults[kind] } });
}
export const MixSchema = z
  .object({
    version: z.literal(1),
    tracks: z
      .record(
        id,
        z
          .object({
            pan: unit,
            sends: z.tuple([unit, unit]),
            inserts: z.array(EffectSchema).max(2),
          })
          .strict(),
      )
      .refine((v) => Object.keys(v).length <= 8),
    returns: z.tuple([z.array(EffectSchema).max(2), z.array(EffectSchema).max(2)]),
    // Changes are acknowledged at bar boundaries; base BPM is the initial tempo.
    tempos: z
      .array(
        z
          .object({
            step: z.number().int().min(16).max(65520).multipleOf(16),
            bpm: z.number().finite().min(30).max(300),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .superRefine((m, ctx) => {
    const effects = [...Object.values(m.tracks).flatMap((t) => t.inserts), ...m.returns.flat()];
    if (new Set(effects.map((e) => e.id)).size !== effects.length)
      ctx.addIssue({ code: "custom", message: "Effect IDs must be unique" });
    if (m.tempos.some((t, i) => i > 0 && t.step <= (m.tempos[i - 1]?.step ?? 0)))
      ctx.addIssue({ code: "custom", message: "Tempo map must be strictly increasing" });
  });
export type Mix = z.infer<typeof MixSchema>;
export const emptyMix = (): Mix => ({ version: 1, tracks: {}, returns: [[], []], tempos: [] });
