// Chop points for the Sampler machine: where each slice of a long sample starts.
// Mirrors native/include/xmp/chop.hpp step for step (same constants, same
// arithmetic order), so the browser and the Live cut a sample identically.
// Points always begin with 0, are strictly increasing, and number 1..16.
export const MAX_SLICES = 16;
const hop = 256,
  windowSize = 512,
  silence = 1e-6;

// `count` equal slices (1..16).
export function evenChop(frames: number, count: number): number[] {
  if (!Number.isInteger(frames) || frames < 1) throw new Error("Nothing to chop");
  const n = Math.max(1, Math.min(MAX_SLICES, Math.round(count), frames));
  return Array.from({ length: n }, (_, i) => Math.floor((frames * i) / n));
}

// A slice at each hit: rises in the log energy (256-frame hops, 512-frame
// windows) that are local peaks above (1 - sensitivity) of the strongest rise,
// at least 50 ms apart, strongest first, at most 16 slices with the start.
export function transientChop(pcm: ArrayLike<number>, rate: number, sensitivity: number): number[] {
  const frames = pcm.length;
  if (frames < 1) throw new Error("Nothing to chop");
  const s = Math.max(0, Math.min(1, sensitivity));
  const count = Math.floor(frames / hop);
  const energy: number[] = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * hop; j < Math.min(frames, i * hop + windowSize); j++)
      sum += (pcm[j] ?? 0) * (pcm[j] ?? 0);
    energy.push(sum);
  }
  const flux: number[] = energy.map((e, i) =>
    i === 0 ? 0 : Math.max(0, Math.log10(e + 1e-9) - Math.log10((energy[i - 1] ?? 0) + 1e-9)),
  );
  let strongest = 0;
  for (const f of flux) strongest = Math.max(strongest, f);
  if (strongest <= 0) return [0];
  const threshold = (1 - s) * strongest;
  const candidates: { at: number; flux: number }[] = [];
  for (let i = 1; i < count; i++) {
    const f = flux[i] ?? 0;
    if (
      f > 0 &&
      f >= threshold &&
      f >= (flux[i - 1] ?? 0) &&
      f > (flux[i + 1] ?? 0) &&
      (energy[i] ?? 0) > silence * windowSize
    )
      candidates.push({ at: i * hop, flux: f });
  }
  candidates.sort((a, b) => b.flux - a.flux || a.at - b.at);
  const gap = Math.round(0.05 * rate);
  const points = [0];
  for (const c of candidates) {
    if (points.length >= MAX_SLICES) break;
    if (points.every((p) => Math.abs(p - c.at) >= gap)) points.push(c.at);
  }
  return points.sort((a, b) => a - b);
}

// Points from any method, made valid: sorted, unique, within the sample, at
// least one frame apart, starting at 0, at most 16.
export function cleanChop(points: readonly number[], frames: number): number[] {
  const out = [0];
  for (const p of [...points].map((v) => Math.round(v)).sort((a, b) => a - b))
    if (p > (out.at(-1) ?? 0) && p < frames && out.length < MAX_SLICES) out.push(p);
  return out;
}

// The slice boundaries manualSlices takes: every start, then the end.
export const chopBoundaries = (points: readonly number[], frames: number) => [
  ...cleanChop(points, frames),
  frames,
];
