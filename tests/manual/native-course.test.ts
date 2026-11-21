import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
// @ts-expect-error Executable ESM is the shared authoring source.
import { padCourse } from "../../tools/tutorials/pad-course.mjs";
import { deviceLists } from "./lists.ts";
import { manualSteps } from "./steps.ts";

it("matches every current lesson instruction to its recorded pad workflow", () => {
  const steps = manualSteps();
  for (const lesson of padCourse) {
    const written = steps.filter((s) => s.list === `learn › ${lesson.title}`);
    expect(written.map((s) => ({ title: s.title, text: s.text }))).toEqual(
      lesson.steps.map((s: { title: string; caption: string; speech: string }) => ({
        title: s.title,
        text: `${s.caption} ${s.speech}`,
      })),
    );
  }
  expect(
    steps.filter((s) => deviceLists.includes(s.list as (typeof deviceLists)[number])),
  ).toHaveLength(110);
});

it("replays all sixteen lessons through the production C++ browser interface and verifies the saved music", () => {
  const output = execFileSync(process.execPath, ["tools/tutorials/refresh.mjs", "--verify"], {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
    timeout: 420000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(output.match(/Validated \d\d-/g)).toHaveLength(16);
}, 430000);
