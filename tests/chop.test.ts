import { describe, expect, it } from "vitest";
import { chopBoundaries, cleanChop, evenChop, transientChop } from "../packages/core/src/chop.ts";

// The same signal as native/tests/live_ui_test.cpp ("chop:"), so the browser and
// the Live are held to the same points.
function signal() {
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const pcm = new Float32Array(96000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = rnd() * 0.001;
  for (const at of [12000, 33600, 52800, 76800])
    for (let i = 0; i < 6000; i++)
      pcm[at + i] = (pcm[at + i] ?? 0) + rnd() * 0.8 * Math.exp(-i / 1200);
  for (let i = 0; i < 4000; i++)
    pcm[64000 + i] = (pcm[64000 + i] ?? 0) + rnd() * 0.01 * Math.exp(-i / 800);
  return pcm;
}

describe("Sampler chop points", () => {
  it("cuts even slices", () => {
    expect(evenChop(96000, 5)).toEqual([0, 19200, 38400, 57600, 76800]);
    expect(evenChop(96000, 40)).toHaveLength(16);
    expect(evenChop(3, 16)).toEqual([0, 1, 2]);
  });
  it("finds each hit, and quieter ones as sensitivity rises", () => {
    const pcm = signal();
    expect(transientChop(pcm, 48000, 0.5)).toEqual([0, 11520, 33280, 52480, 76544]);
    expect(transientChop(pcm, 48000, 0.9)).toEqual([0, 11520, 33280, 52480, 63744, 76544]);
    expect(transientChop(new Float32Array(9600), 48000, 0.9)).toEqual([0]);
  });
  it("cleans hand and lazy points into valid slice boundaries", () => {
    expect(cleanChop([500, 100, 100, 99999, -4], 1000)).toEqual([0, 100, 500]);
    expect(
      cleanChop(
        Array.from({ length: 30 }, (_, i) => i * 10 + 1),
        1000,
      ),
    ).toHaveLength(16);
    expect(chopBoundaries([300, 100], 1000)).toEqual([0, 100, 300, 1000]);
  });
});
