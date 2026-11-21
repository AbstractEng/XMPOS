// Playing layout only: existing project notes keep their saved pitches.
// The order is the Live's (native/include/xmp/pad_scale.hpp): keep it.
export type PadScale =
  | "major"
  | "chromatic"
  | "harmonic-minor"
  | "minor"
  | "melodic-minor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "locrian";
export const padScales: { id: PadScale; name: string; intervals: readonly number[] }[] = [
  { id: "major", name: "Major (Ionian)", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: "chromatic", name: "Chromatic", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: "harmonic-minor", name: "Harmonic minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: "minor", name: "Natural minor (Aeolian)", intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: "melodic-minor", name: "Melodic minor", intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: "dorian", name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: "phrygian", name: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: "lydian", name: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: "mixolydian", name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: "locrian", name: "Locrian", intervals: [0, 1, 3, 5, 6, 8, 10] },
];
// The root note of the playing scale: 0 = C … 11 = B. Pad 1 plays it in octave 3.
export const padRoots = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;
export const scaleName = (scale: PadScale, root = 0) =>
  scale === "chromatic"
    ? "Chromatic"
    : `${padRoots[((root % 12) + 12) % 12]} ${padScales.find((s) => s.id === scale)?.name ?? ""}`;
export const rootPitch = (root: number) => 48 + (((Math.round(root) % 12) + 12) % 12);
export function padNote(pad: number, octave = 0, scale: PadScale = "major", root = 48) {
  if (
    !Number.isInteger(pad) ||
    pad < 0 ||
    pad > 15 ||
    !Number.isInteger(octave) ||
    Math.abs(octave) > 8 ||
    !Number.isInteger(root) ||
    root < 0 ||
    root > 127
  )
    throw new Error("Invalid pad pitch");
  const intervals = padScales.find((s) => s.id === scale)?.intervals;
  if (!intervals) throw new Error("Unknown scale");
  return Math.max(
    0,
    Math.min(
      127,
      root +
        octave * 12 +
        Math.floor(pad / intervals.length) * 12 +
        (intervals[pad % intervals.length] ?? 0),
    ),
  );
}
export function noteName(note: number) {
  const n = Math.max(0, Math.min(127, Math.round(note)));
  return `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][n % 12]}${Math.floor(n / 12) - 1}`;
}
