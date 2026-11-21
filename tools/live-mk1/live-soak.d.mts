export const DSP_BUDGET_MS: number;
export function soakHours(value: unknown): number;
export function stoppingSoakFaults(faults: string[], diagnosticOnly?: boolean): string[];
export function soakFaults(
  reply: unknown,
  baseline: { xruns: number; lateNotes: number },
  expected: Record<string, string>,
  previousBlocks: number | null,
  playing?: boolean,
): string[];
