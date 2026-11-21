import { expect, it } from "vitest";
import {
  compareParity,
  ParityPlanSchema,
  parityFixtures,
  parityIdentity,
  referenceParity,
  verifyParityOracle,
} from "../packages/sdk/src/parity.ts";
import { decodeResult, encodePlan } from "../tools/sdk/parity-host.mjs";

it("checks independent musical oracles and releases every fixture's notes", () => {
  for (const c of parityFixtures()) {
    const result = referenceParity(c.plan);
    expect(() => verifyParityOracle(c.id, result)).not.toThrow();
    expect(result.pcm.every(Number.isFinite)).toBe(true);
    expect(result.pcm.some((v) => Math.abs(v) > 0.000001)).toBe(true);
    expect(encodePlan(c.plan).length).toBe(40 + c.plan.events.length * 24);
  }
});
it("fails parity for a one-frame event shift even with identical PCM", () => {
  const c = parityFixtures()[0];
  if (!c) throw new Error("fixture");
  const a = referenceParity(c.plan),
    b = referenceParity(c.plan);
  if (b.trace[0]) b.trace[0].frame++;
  const result = compareParity(a, b);
  expect(result.passed).toBe(false);
  expect(result.eventsMatch).toBe(false);
  expect(result.maximumAbsoluteError).toBe(0);
});
it("fails audible drift, non-finite PCM, truncation and a wrong final voice count", () => {
  const c = parityFixtures()[0];
  if (!c) throw new Error("fixture");
  const a = referenceParity(c.plan),
    b = referenceParity(c.plan);
  b.pcm[100] = (b.pcm[100] ?? 0) + 0.01;
  expect(compareParity(a, b).passed).toBe(false);
  b.pcm[100] = NaN;
  expect(() => compareParity(a, b)).toThrow("PCM");
  expect(() => compareParity(a, { ...a, pcm: a.pcm.slice(1) })).toThrow("shape");
  expect(compareParity(a, { ...a, activeVoices: 1 }).passed).toBe(false);
});
it("rejects unsupported rates, unbounded work and invalid event values before rendering", () => {
  const c = parityFixtures()[0];
  if (!c) throw new Error("fixture");
  for (const input of [
    { ...c.plan, sampleRate: 44100 },
    { ...c.plan, frames: 48001 },
    { ...c.plan, events: [{ kind: "on", frame: 0, id: 1, note: 128, value: 1 }] },
    {
      ...c.plan,
      events: [{ kind: "expression", frame: 1, id: 1, dimension: "pressure", value: 2 }],
    },
    { ...c.plan, events: [{ kind: "panic", frame: 24000 }] },
    { ...c.plan, events: Array(257).fill({ kind: "panic", frame: 0 }) },
  ])
    expect(ParityPlanSchema.safeParse(input).success).toBe(false);
  expect(() => decodeResult(Buffer.from("XMPR"))).toThrow("header");
});

it("hashes actual little-endian PCM and event identities without transporting audio", async () => {
  const fixture = parityFixtures()[0];
  if (!fixture) throw new Error("fixture");
  const a = referenceParity(fixture.plan),
    b = referenceParity(fixture.plan);
  const first = await parityIdentity(a);
  expect(await parityIdentity(b)).toEqual(first);
  b.pcm[100] = (b.pcm[100] ?? 0) + 0.01;
  expect((await parityIdentity(b)).pcmSha256).not.toBe(first.pcmSha256);
  expect((await parityIdentity(b)).traceSha256).toBe(first.traceSha256);
});
