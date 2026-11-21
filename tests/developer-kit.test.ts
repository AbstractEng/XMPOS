import { describe, expect, it } from "vitest";
import { BUILDER_LAYERS, builderPlan, inspectDocker } from "../tools/live-mk1/container.mjs";

describe("developer Docker dependency plan", () => {
  it("prepares every required parent from an empty image store", () => {
    expect(builderPlan("xmp-live-mk1-probe:1")).toEqual(BUILDER_LAYERS);
    expect(builderPlan("xmp-live-mk1-userspace:1").map((v) => v.tag)).toEqual([
      "xmp-live-mk1-builder:1",
      "xmp-live-mk1-userspace:1",
    ]);
    expect(builderPlan("xmp-live-mk1-builder:1")).toHaveLength(1);
  });
  it("refuses an unknown image rather than resolving external build instructions", () => {
    expect(() => builderPlan("unreviewed:latest")).toThrow("Unknown XMP builder");
  });
  it("bounds daemon readiness checks and rejects unavailable or non-Linux engines", () => {
    const info = inspectDocker((command, args, options) => {
      expect(command).toBe("docker");
      expect(args).toEqual(["info", "--format", "{{.OSType}}"]);
      expect(options.timeout).toBe(10000);
      return { status: null, error: { code: "ETIMEDOUT" } };
    });
    expect(info.ready).toBe(false);
    expect(info.reason).toContain("10 seconds");
    expect(inspectDocker(() => ({ status: 1 })).ready).toBe(false);
    expect(inspectDocker(() => ({ status: 0, stdout: "windows\n" })).ready).toBe(false);
    expect(inspectDocker(() => ({ status: 0, stdout: "linux\n" })).ready).toBe(true);
  });
});
