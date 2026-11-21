// Every numbered instruction list in the manual is performed by a UI test:
// native-course.test.ts (the shared C++ Device view) or studio.test.ts (Advanced Studio), or is
// recorded word for word by hardware.test.ts (steps on the MPC itself). A new
// list, such as a new lesson or chapter, fails here until a test performs it;
// each file checks the wording of its own steps.
import { expect, it } from "vitest";
import { deviceLists, hardwareLists, studioLists } from "./lists.ts";
import { lists, manualSteps } from "./steps.ts";

it("assigns every instruction list in the manual to a UI test", () => {
  const owned = [...deviceLists, ...studioLists, ...hardwareLists];
  expect(new Set(owned).size, "a list is claimed twice").toBe(owned.length);
  expect(
    [...owned].sort(),
    "The manual's numbered lists changed: add or remove them in tests/manual/lists.ts and perform their steps",
  ).toEqual(lists(manualSteps()).sort());
});
