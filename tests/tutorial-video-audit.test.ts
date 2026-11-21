import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error Shared executable authoring source.
import { checkSliceAudio } from "../tools/tutorials/check-lesson-project.mjs";
import {
  narrationFingerprint,
  narrationRequest,
  spokenSegments,
  verifyNarration,
} from "../tools/tutorials/narration-plan.mjs";
// @ts-expect-error Shared executable authoring source.
import { padCourse } from "../tools/tutorials/pad-course.mjs";
// @ts-expect-error Shared executable authoring source.
import { screenForwardPanel } from "../tools/tutorials/screen-forward-panel.mjs";

it("refuses narration from an older script, including punctuation changes", () => {
  const lesson = { id: "demo", steps: [{ speech: "Hear this groove." }] };
  const metadata = { scriptSha256: narrationFingerprint(["Hear this groove."]) };
  expect(() => verifyNarration(lesson, metadata)).not.toThrow();
  expect(() =>
    verifyNarration({ ...lesson, steps: [{ speech: "Hear this groove!" }] }, metadata),
  ).toThrow("stale");
});
it("pronounces the hardware name with a long i while retaining the short-i verb and printed spelling", () => {
  const printed = [
    "MPC Live Mk1. Connect the Live's USB port. Check Live and image.",
    "The library is where your saved projects live.",
  ];
  expect(spokenSegments(printed)).toEqual([
    "MPC Lyve Mk1. Connect the Lyve's USB port. Check Lyve and image.",
    "The library is where your saved projects live.",
  ]);
  expect(printed[0]).toContain("MPC Live Mk1");
  expect(narrationRequest(printed).text).toContain("MPC Lyve Mk1");
});
it("invalidates a cached hardware-name voiceover even when its captions have not changed", () => {
  const lesson = { id: "hardware", steps: [{ speech: "Connect the Live." }] };
  const old = {
    scriptSha256: "57e79a82356d2c486ace82d74db1771d2624e96c9d70f5925633cbdae1878216",
  };
  // This is the request hash before adding the speech-only pronunciation rule.
  expect(() => verifyNarration(padCourse[1], old)).toThrow("stale");
  expect(() =>
    verifyNarration(lesson, { scriptSha256: narrationFingerprint(["Connect the Live."]) }),
  ).not.toThrow();
});
it("selects a machine before demonstrating the Sound Q-Link page on a fresh track", () => {
  const step = padCourse[0].steps[4];
  const choices = step.actions.map((a: { type: string; id?: string; n?: number }) => a.id ?? a.n);
  expect(choices).toEqual([16, 13, "q-link"]);
});
it("rejects silent slices even when every slice marker is valid", () => {
  const pcm = [...Array(100).fill(0.1), ...Array(100).fill(0)];
  const pads = [{ slice: { start: 0, end: 100 } }, { slice: { start: 100, end: 200 } }];
  expect(() => checkSliceAudio(pads, { pcm })).toThrow("Slice 2");
  pcm.fill(0.1);
  expect(() => checkSliceAudio(pads, { pcm })).not.toThrow();
});
it("supplies music in all four quarters of the original practice loop", () => {
  const bytes = readFileSync("apps/studio/public/manual-media/first-groove.wav");
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  const channels = bytes.readUInt16LE(22),
    frames = bytes.readUInt32LE(40) / (channels * 2),
    rate = bytes.readUInt32LE(24);
  expect(frames / rate).toBeGreaterThan(3);
  expect(frames / rate).toBeLessThan(10);
  for (let part = 0; part < 4; part++) {
    let power = 0,
      count = 0;
    for (let i = Math.floor((part * frames) / 4); i < Math.floor(((part + 1) * frames) / 4); i++) {
      const v = bytes.readInt16LE(44 + i * channels * 2) / 32768;
      power += v * v;
      count++;
    }
    expect(Math.sqrt(power / count), `slice ${part + 1}`).toBeGreaterThan(0.005);
  }
});
it("the teaching drawing exposes transport, track and pad feedback separately from input highlights", () => {
  const drawing = screenForwardPanel();
  for (const id of ["play", "rec", "overdub", "bank-a"])
    expect(drawing).toContain(`data-feedback-light="${id}"`);
  for (let pad = 1; pad <= 16; pad++) expect(drawing).toContain(`data-control="pad-${pad}"`);
});
