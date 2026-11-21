// The hardware setup chapter's steps, word for word (see hardwareLists). These run
// on the MPC and in the native installer, not in the browser; a reworded or new
// step fails here so the change is reviewed, and hardware-steps.json is updated.
import { expect, it } from "vitest";
import recorded from "./hardware-steps.json" with { type: "json" };
import { hardwareLists } from "./lists.ts";
import { manualSteps } from "./steps.ts";

it("records every hardware setup step exactly as the manual words it", () => {
  const manual = manualSteps().filter((s) => (hardwareLists as readonly string[]).includes(s.list));
  expect(
    manual,
    "A hardware setup step changed: review it and update tests/manual/hardware-steps.json",
  ).toEqual(recorded);
});
