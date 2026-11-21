import { expect, it } from "vitest";
import {
  DSP_BUDGET_MS,
  soakFaults,
  soakHours,
  stoppingSoakFaults,
} from "../tools/live-mk1/live-soak.mjs";

const expected = {
  sessionSha256: "a".repeat(64),
  bridgeSha256: "b".repeat(64),
  libcSha256: "c".repeat(64),
};
const session = {
  playing: true,
  recording: false,
  audio: true,
  controller: true,
  screen: true,
  touch: true,
  project: true,
  blocks: 100,
  xruns: 0,
  peak: 0.23,
  audioLoad: 0.3,
  audioWorstMs: 2,
  lateNotes: 0,
  lateWorstMs: 0,
  stepWorstMs: 1,
};
const good = { ok: true, session, image: expected };
it("keeps qualification strict and retains every other stop during explicit non-qualifying diagnostics", () => {
  const faults = ["New late scheduled note", "New driver xrun", "Output exceeds -12 dBFS"];
  expect(stoppingSoakFaults(faults)).toEqual(faults);
  expect(stoppingSoakFaults(faults, true)).toEqual(faults.slice(1));
  expect(stoppingSoakFaults(["Unknown new fault"], true)).toEqual(["Unknown new fault"]);
});
it("accepts a healthy advancing verified session and a bounded overnight duration", () => {
  expect(soakFaults(good, session, expected, 90)).toEqual([]);
  expect(soakHours(8)).toBe(8);
  for (const value of [0, -1, 13, "bad", Number.NaN]) expect(() => soakHours(value)).toThrow();
});
it("stops for underruns, late notes, excessive peak/DSP time, stalled counters and unexpected input recording", () => {
  for (const patch of [
    { xruns: 1 },
    { lateNotes: 1 },
    { peak: 0.4 },
    { audioWorstMs: DSP_BUDGET_MS + 0.1 },
    { recording: true },
    { playing: false },
    { blocks: 80 },
    { audio: false },
    { audioLoad: Number.NaN },
  ])
    expect(
      soakFaults({ ...good, session: { ...session, ...patch } }, session, expected, 90).length,
    ).toBeGreaterThan(0);
  expect(
    soakFaults(
      { ...good, image: { ...expected, bridgeSha256: "d".repeat(64) } },
      session,
      expected,
      90,
    ),
  ).toContain("Candidate fingerprint changed: bridgeSha256");
});
it("does not report a missing or stopped session as a successful soak", () => {
  expect(soakFaults({}, session, expected, 90)).toEqual(["Session status unavailable"]);
  expect(
    soakFaults(
      { ...good, session: { ...session, playing: false } },
      session,
      expected,
      null,
      false,
    ),
  ).toEqual([]);
});
