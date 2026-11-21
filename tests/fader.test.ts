import { expect, it } from "vitest";
import { faderToGain, gainToFader } from "../packages/core/src/fader.ts";

it("gives the lower half of the fader useful attenuation while preserving stored gains", () => {
  expect(faderToGain(0)).toBe(0);
  expect(faderToGain(1)).toBe(1);
  expect(20 * Math.log10(faderToGain(0.5))).toBeCloseTo(-18.0618, 3);
  expect(20 * Math.log10(faderToGain(0.25))).toBeCloseTo(-36.1236, 3);
  for (const gain of [0, 0.0001, 0.125, 0.6, 0.8, 1])
    expect(faderToGain(gainToFader(gain))).toBeCloseTo(gain, 12);
});
