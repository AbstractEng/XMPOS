import { describe, expect, it } from "vitest";
// The plan auditor is also a Node CLI; its pure analysis function performs no I/O.
// @ts-expect-error The CLI is maintained as executable ESM rather than a TS package.
import { analyzePlan } from "../tools/check-acceptance-plan.mjs";

const plan = {
  stages: [
    { id: "P01", dependsOn: [], feature: "features/test.feature", substeps: [{ id: "P01.1" }] },
  ],
};
const valid = `@P01 @host_only
Feature: Small acceptance plan
  @planned @stage_gate @positive
  Scenario: Complete a stage
    Given a fixture
    When a user acts
    Then the result is observed
  @planned @P01_1 @positive
  Scenario: Perform the substep
    Given a fixture
    When a user acts
    Then the result is observed
  @planned @P01_1 @negative
  Scenario: Reject invalid input
    Given an invalid fixture
    When a user acts
    Then the error is observed
`;
describe("acceptance plan traceability", () => {
  it("accepts a parsed plan with one gate and positive and failure coverage", () => {
    const report = analyzePlan(plan, { "features/test.feature": valid });
    expect(report.errors).toEqual([]);
    expect(report.plannedDefinitions).toBe(3);
  });
  it("fails if a substep loses its failure scenario", () => {
    const report = analyzePlan(plan, {
      "features/test.feature": valid.replace("@P01_1 @negative", "@negative"),
    });
    expect(
      report.errors.some((message: string) => message.includes("missing planned failure")),
    ).toBe(true);
  });
  it("fails on malformed Gherkin or ambiguous implementation status", () => {
    expect(
      analyzePlan(plan, { "features/test.feature": "Feature: Invalid\n Scenario Missing colon\n" })
        .errors.length,
    ).toBeGreaterThan(0);
    expect(
      analyzePlan(plan, {
        "features/test.feature": valid.replace(
          "@planned @stage_gate",
          "@implemented @planned @stage_gate",
        ),
      }).errors.some((message: string) => message.includes("exactly one")),
    ).toBe(true);
  });
  it("fails on cyclic stage dependencies", () => {
    const cyclic = { stages: [{ ...plan.stages[0], dependsOn: ["P01"] }] };
    expect(
      analyzePlan(cyclic, { "features/test.feature": valid }).errors.some((message: string) =>
        message.includes("cycle"),
      ),
    ).toBe(true);
  });
  it("rejects a host-only scenario mislabeled as a device run", () => {
    const report = analyzePlan(plan, {
      "features/test.feature": valid.replace("@P01 @host_only", "@P01 @host_only @usb_lab"),
    });
    expect(
      report.errors.some((message: string) => message.includes("cannot require device contact")),
    ).toBe(true);
  });
});
