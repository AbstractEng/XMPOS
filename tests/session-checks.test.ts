import { describe, expect, it } from "vitest";
// @ts-expect-error Source-build evidence policy is plain JavaScript.
import { evaluateSessionResult, SESSION_CHECKS } from "../tools/live-mk1/session-checks.mjs";

interface Fixture {
  format: string;
  version: number;
  audio: { peakDbfs: number };
  project: Record<string, unknown>;
  bridge?: Record<string, unknown>;
}
function fixture(): Fixture {
  return {
    format: "xmp-session-vm-test",
    version: 2,
    audio: { peakDbfs: -12.6 },
    ...Object.fromEntries(
      Object.entries(SESSION_CHECKS).map(([group, keys]) => [
        group,
        Object.fromEntries((keys as string[]).map((key) => [key, true])),
      ]),
    ),
  } as Fixture;
}
describe("emulator acceptance result", () => {
  it("fails on semantic errors and omitted results despite a successful process", () => {
    const report = fixture();
    expect(evaluateSessionResult(report).passed).toBe(true);
    report.project.noXruns = false;
    expect(evaluateSessionResult(report).failures).toContain("project.noXruns");
    delete report.project.noXruns;
    expect(evaluateSessionResult(report).passed).toBe(false);
  });
  it("never counts unexecuted sessions as passing or complete", () => {
    const report = fixture();
    delete report.bridge;
    const partial = evaluateSessionResult(report, ["project"]);
    expect(partial.passed).toBe(true);
    expect(partial.complete).toBe(false);
    expect(partial.notRun).toContain("bridge");
    expect(evaluateSessionResult(report).passed).toBe(false);
  });
  it("rejects missing or nonfinite audio evidence, bridge errors and unknown sessions", () => {
    const report = fixture();
    report.audio.peakDbfs = Number.NaN;
    if (report.bridge) report.bridge.error = "capture failed";
    expect(evaluateSessionResult(report).failures).toEqual(
      expect.arrayContaining(["audio.peakDbfs", "bridge.error"]),
    );
    expect(() => evaluateSessionResult(report, ["hardware"])).toThrow("known emulator sessions");
  });
});
