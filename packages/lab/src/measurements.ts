import { z } from "zod";
import { digest } from "./contracts.ts";
export const measurementProfile = Object.freeze({
  id: "p11-evidence-analysis-v1",
  analogTrials: 1000,
  controlTrials: 1000,
  midiIntervals: 10000,
  analogP95Ms: 20,
  controlP95Ms: 10,
  midiJitterP95Ms: 2,
});
const Series = z
  .object({
    source: z.enum(["simulator", "physical-unreviewed"]),
    clock: z.enum(["independent-capture", "control-rtt"]),
    calibrationHash: digest.nullable(),
    valuesMs: z.array(z.number().finite().min(0).max(60000)).max(10000),
  })
  .strict();
export function analyzeHardwareEvidence(input: unknown) {
  const evidence = z
    .object({ analog: Series.optional(), control: Series.optional(), midi: Series.optional() })
    .strict()
    .parse(input);
  const results = Object.entries({ analog: [1000, 20], control: [1000, 10], midi: [10000, 2] }).map(
    ([metric, [count, limit]]) => {
      const series = evidence[metric as keyof typeof evidence];
      if (
        !series?.calibrationHash ||
        series.clock !== "independent-capture" ||
        series.valuesMs.length < (count ?? 0)
      )
        return {
          metric,
          outcome: "inconclusive",
          p95Ms: null,
          withinBudget: null,
          reason: "Missing independent calibrated capture or trial count",
        };
      const values = [...series.valuesMs].sort((a, b) => a - b),
        p95Ms = values[Math.ceil(values.length * 0.95) - 1] ?? null;
      return {
        metric,
        outcome: "analysis-only",
        p95Ms,
        withinBudget: p95Ms !== null && p95Ms <= (limit ?? 0),
        trials: values.length,
        source: series.source,
      };
    },
  );
  return {
    profile: measurementProfile.id,
    results,
    hardwareQualified: false,
    formalLoopbackQualified: false,
    pending: [
      "reviewed physical captures and fixture identity",
      "stock controls and battery observations",
      "thermal and soak evidence",
      "reviewed USB and boot recovery evidence",
    ],
  };
}
