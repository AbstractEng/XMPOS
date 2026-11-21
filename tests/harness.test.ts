import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAdapter, preflightAdapter } from "../acceptance/lib/adapters.mjs";
// @ts-expect-error Host harness modules run directly under Node 24.
import { evaluateGate, latencyResult, recordEvidence } from "../acceptance/lib/evidence.mjs";
// @ts-expect-error Host harness modules run directly under Node 24.
import { freshProject } from "../acceptance/lib/fixtures.mjs";
// @ts-expect-error Host harness modules run directly under Node 24.
import { scenarioWorkspace } from "../acceptance/lib/workspace.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "xmp-gate-test-"));
  directories.push(directory);
  const required = [{ scenarioId: "required", profile: "host-contract" }];
  const record = recordEvidence(
    directory,
    { ...required[0], buildHash: "candidate", fixtureHash: "fixture", outcome: "passed" },
    [{ kind: "trace", data: { event: "impulse", frame: 24000 } }],
  );
  return { directory, required, records: [record], buildHash: "candidate", fixtureHash: "fixture" };
}
describe("qualification rejects misleading evidence", () => {
  it("requires an intact capture from the same build and fixture", () => {
    const input = setup();
    expect(evaluateGate(input).complete).toBe(true);
    expect(evaluateGate({ ...input, buildHash: "other" }).complete).toBe(false);
    expect(evaluateGate({ ...input, fixtureHash: "other" }).complete).toBe(false);
    const artifact = input.records[0].artifacts[0];
    writeFileSync(resolve(input.directory, artifact.path), "tampered");
    expect(evaluateGate(input).failures.join()).toContain("corrupt artifact");
  });
  it("rejects missing, duplicate, synthetic and unsupported evidence", () => {
    const input = setup();
    expect(evaluateGate({ ...input, records: [] }).complete).toBe(false);
    expect(evaluateGate({ ...input, records: [...input.records, ...input.records] }).complete).toBe(
      false,
    );
    for (const outcome of [
      "undefined",
      "pending",
      "skipped",
      "unsupported",
      "inconclusive",
      "failed",
    ])
      expect(evaluateGate({ ...input, records: [{ ...input.records[0], outcome }] }).complete).toBe(
        false,
      );
    expect(
      evaluateGate({ ...input, records: [{ ...input.records[0], synthetic: true }] }).complete,
    ).toBe(false);
    expect(evaluateGate({ ...input, required: [] }).complete).toBe(false);
  });
  it("does not trust artifact path traversal or missing files", () => {
    const input = setup();
    input.records[0].artifacts[0].path = "../outside";
    expect(evaluateGate(input).failures.join()).toContain("outside report");
    input.records[0].artifacts[0].path = "absent";
    expect(evaluateGate(input).complete).toBe(false);
  });
  it("never converts absent or uncalibrated latency into zero", () => {
    for (const capture of [
      null,
      { calibrated: false, frames: 0, sampleRate: 48000 },
      { calibrated: true, frames: NaN, sampleRate: 48000 },
    ])
      expect(latencyResult(capture)).toMatchObject({ outcome: "inconclusive", latencyMs: null });
    expect(latencyResult({ calibrated: true, frames: 960, sampleRate: 48000 }).latencyMs).toBe(20);
  });
  it("publishes only the supported evidence schema", () => {
    const input = setup();
    const record = recordEvidence(
      input.directory,
      { ...input.records[0], serial: "secret", project: "personal" },
      [{ kind: "log", data: { event: "render", serial: "secret", project: "personal" } }],
    );
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(readFileSync(resolve(input.directory, record.artifacts[0].path), "utf8")).not.toContain(
      "personal",
    );
  });
});
describe("capability boundary", () => {
  it("requires explicit profiles and refuses every physical/OS target", () => {
    for (const profile of ["os-vm", "usb-lab"] as const)
      expect(() => preflightAdapter(profile, [])).toThrow("UNSUPPORTED");
    expect(() => preflightAdapter("desktop", ["physical-pad-sensor"])).toThrow("UNSUPPORTED");
  });
  it("exposes only requested methods and validates before writing", () => {
    const workspace = scenarioWorkspace();
    directories.push(workspace.directory);
    const adapter = openAdapter("native", ["project-persistence"], workspace);
    expect(adapter.render).toBeUndefined();
    expect(Object.isFrozen(adapter)).toBe(true);
    adapter.saveProject?.(freshProject());
    expect(adapter.loadProject?.()).toEqual(freshProject());
    const renderer = openAdapter("native", ["offline-render"], workspace);
    expect(() =>
      renderer.render?.({ sampleRate: 48000, frames: 48000, eventFrame: 48000, pcm: [0.5] }),
    ).toThrow("Invalid bounded");
  });
});
