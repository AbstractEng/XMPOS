// Musical swing is the first sixteenth's share of an eighth-note pair.
// The project format stores the odd-step delay in sixteenth-note units.
export const TRIPLET_SWING = 1 / 3;

export function swingPercent(delay: number): number {
  if (!Number.isFinite(delay) || delay < 0 || delay > 0.5)
    throw new RangeError("Swing delay must be between 0 and 0.5");
  return 50 + delay * 50;
}

export function swingFromPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 50 || percent > 75)
    throw new RangeError("Swing must be between 50% and 75%");
  return (percent - 50) / 50;
}

export function swingLabel(delay: number): string {
  const percent = swingPercent(delay);
  return `${Number(percent.toFixed(1))}%${delay === 0 ? " · Straight" : Math.abs(delay - TRIPLET_SWING) < 1e-12 ? " · Triplet" : ""}`;
}
