import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adapterReadiness,
  normalizeControl,
  requiredServices,
} from "../packages/lab/src/adapters.ts";
import { LabCommand, validateGrant } from "../packages/lab/src/contracts.ts";
import { analyzeHardwareEvidence } from "../packages/lab/src/measurements.ts";
import { reviewTarget } from "../packages/lab/src/readiness.ts";
// @ts-expect-error Executable Node protocol tooling.
import { encodeFrame, FrameDecoder } from "../tools/lab/wire.mjs";

const sha = "a".repeat(64);

describe("P11 prerequisite evidence", () => {
  it("reports missing exact-unit evidence and cannot turn a dossier into device authorization", () => {
    const dossier = JSON.parse(readFileSync("hardware/target.example.json", "utf8"));
    const review = reviewTarget(dossier);
    expect(review.missing).toContain("recovery");
    expect(review.missing).toContain("usb-topology");
    expect(review.deviceAccessAuthorized).toBe(false);
    expect(reviewTarget({ ...dossier, model: "Akai Force" }).protectedTarget).toBe(true);
    const kinds = ["stock-observation", "boot", "recovery", "usb-topology", "owner-authorization"];
    const complete = {
      ...dossier,
      model: "Akai MPC Live Mk1",
      firmware: "fixture-version",
      board: "fixture-board",
      buildHash: sha,
      bootTier: "independent-xmp-image",
      evidence: kinds.map((kind, i) => ({
        id: `evidence-${i}`,
        kind,
        model: "Akai MPC Live Mk1",
        firmware: "fixture-version",
        alias: dossier.alias,
        status: "reviewed",
        sha256: sha,
        board: "fixture-board",
        buildHash: sha,
      })),
    };
    expect(reviewTarget(complete).readyForDeviceSpecificReview).toBe(true);
    expect(reviewTarget(complete).deviceAccessAuthorized).toBe(false);
    complete.evidence[1].firmware = "other-firmware";
    expect(reviewTarget(complete).missing).toContain("boot");
  });
});
describe("adapter boundaries", () => {
  it("normalizes every pad and touch corners without inferring pressure", () => {
    for (let pad = 0; pad < 16; pad++)
      for (const velocity of [0, 1, 64, 127]) {
        const event = normalizeControl({ kind: "pad", pad, velocity, atUs: pad });
        expect(event).toMatchObject({ velocity: velocity / 127, physicalQualified: false });
        expect(event).not.toHaveProperty("pressure");
      }
    expect(
      normalizeControl({
        kind: "touch",
        contact: 0,
        x: 799,
        y: 479,
        width: 800,
        height: 480,
        atUs: 1,
      }),
    ).toMatchObject({ x: 1, y: 1 });
    expect(() =>
      normalizeControl({
        kind: "touch",
        contact: 0,
        x: 800,
        y: 0,
        width: 800,
        height: 480,
        atUs: 1,
      }),
    ).toThrow();
    expect(() => normalizeControl({ kind: "pad", pad: 16, velocity: 127, atUs: 1 })).toThrow();
  });
  it("preserves missing battery/codec readings and refuses simulator qualification", () => {
    const reports = requiredServices.map((id) => ({
      id,
      version: "fixture-1",
      state: "simulated",
    }));
    expect(adapterReadiness(reports)).toMatchObject({
      mode: "host-development",
      physicalQualified: false,
      pressureQualified: false,
    });
    const state = adapterReadiness(
      reports.filter((r) => r.id !== "battery" && r.id !== "internal-audio"),
    );
    expect(state.mode).toBe("safe-recovery");
    expect(state.missing).toEqual(["internal-audio", "battery"]);
    expect(() => adapterReadiness([...reports, reports[0]])).toThrow();
  });
});
describe("bounded authenticated lab contract", () => {
  it("requires a fresh, exact, simulator-only grant with no duplicate capabilities", () => {
    const grant = {
      profile: "host-lab-development-v1",
      model: "XMP host simulator",
      alias: "bench",
      buildHash: sha,
      bootTier: "host-simulator",
      protocol: 1,
      hostPin: sha,
      agentPin: sha,
      fixtureHash: sha,
      issuedAt: 1000,
      expiresAt: 2000,
      operations: ["status"],
    };
    expect(validateGrant(grant, 1500).alias).toBe("bench");
    for (const input of [
      { ...grant, model: "Akai Force" },
      { ...grant, bootTier: "independent-xmp-image" },
      { ...grant, operations: ["status", "status"] },
      { ...grant, expiresAt: 999 },
    ])
      expect(() => validateGrant(input, 1500)).toThrow();
    for (const input of [
      { op: "shell", command: "anything" },
      { op: "stage", fixtureId: "../project", sha256: sha, text: "x" },
      { op: "action", action: "reboot" },
      { op: "status", path: "/dev/disk0" },
    ])
      expect(LabCommand.safeParse(input).success).toBe(false);
  });
  it("decodes fragmented and coalesced frames and rejects a hostile length before allocation", () => {
    const messages: unknown[] = [];
    const decoder = new FrameDecoder((m: unknown) => messages.push(m));
    const first = encodeFrame({ op: "stage", text: "x".repeat(12000) }),
      second = encodeFrame({ op: "status" });
    for (let i = 0; i < first.length; i += 7) decoder.push(first.subarray(i, i + 7));
    decoder.push(Buffer.concat([second, second]));
    expect(messages).toHaveLength(3);
    const bad = new FrameDecoder(() => {});
    expect(() => bad.push(Buffer.from([255, 255, 255, 255]))).toThrow(/bounded/);
    expect(() => bad.push(second)).toThrow(/Closed/);
    expect(() => encodeFrame({ text: "x".repeat(524289) })).toThrow();
  });
});
describe("hardware evidence analysis", () => {
  it("evaluates dimensions independently and leaves missing measurements inconclusive", () => {
    const series = {
      source: "simulator",
      clock: "independent-capture",
      calibrationHash: sha,
      valuesMs: Array(1000).fill(12),
    };
    const report = analyzeHardwareEvidence({
      analog: series,
      control: { ...series, valuesMs: Array(1000).fill(12) },
    });
    expect(report.results[0]).toMatchObject({ p95Ms: 12, withinBudget: true });
    expect(report.results[1]).toMatchObject({ withinBudget: false });
    expect(report.results[2]).toMatchObject({ outcome: "inconclusive", p95Ms: null });
    expect(report.hardwareQualified).toBe(false);
    expect(report.formalLoopbackQualified).toBe(false);
    expect(
      analyzeHardwareEvidence({ analog: { ...series, clock: "control-rtt" } }).results[0],
    ).toMatchObject({ outcome: "inconclusive", p95Ms: null });
    expect(
      analyzeHardwareEvidence({ analog: { ...series, calibrationHash: null } }).results[0],
    ).toMatchObject({ outcome: "inconclusive" });
  });
});
