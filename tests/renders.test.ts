import { expect, it } from "vitest";
import * as core from "../packages/core/src/edits.ts";
import { createDemoProject, expandSong, ProjectSchema } from "../packages/core/src/index.ts";
import { GoldenLog } from "./golden.ts";
import { richProject, rng, sequencedProject } from "./project-fixtures.ts";

// The C++ core's scene plans, sequence renders and instrument scenes (all three
// renderers: mix, sequences, pads and synths) on random projects, refusals
// included, against fingerprints recorded while they matched the TypeScript
// renderers that phase 9 retired (tests/golden.ts).
const plain = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x instanceof Float32Array
      ? Array.from(x)
      : x instanceof ArrayBuffer
        ? Array.from(new Uint8Array(x))
        : x,
  );
const attempt = (f: () => unknown) => {
  try {
    return plain(f());
  } catch (e) {
    return `error ${(e as Error).message}`;
  }
};
it("the pad-sampler plan, sequences and instrument scenes", () => {
  const g = new GoldenLog("renders/the pad-sampler plan, sequences and instrument scenes");
  let plans = 0,
    sequences = 0;
  const kit = ProjectSchema.parse(expandSong(createDemoProject()));
  const projects = [
    kit,
    ...[1, 2, 3, 4, 5, 6].map((s) => (s % 2 ? sequencedProject(s) : richProject(rng(s * 11)))),
  ];
  for (const p of projects)
    for (const scene of [...p.scenes.slice(0, 3).map((s) => s.id), "nowhere"]) {
      if (!g.add(attempt(() => core.prepareScene(p, scene))).startsWith("error")) plans++;
      for (const exact of [undefined, 16])
        g.add(
          attempt(() => {
            const r = core.renderInstrumentScene(p, scene, exact) as Record<string, unknown>;
            delete r.commands;
            return r;
          }),
        );
      for (const [steps, fill, tail] of [
        [16, false, false],
        [8, true, true],
      ] as const)
        if (
          !g
            .add(attempt(() => core.renderSequence(p, scene, steps, fill, tail)))
            .startsWith("error")
        )
          sequences++;
    }
  expect(plans).toBeGreaterThan(2);
  expect(sequences).toBeGreaterThan(10);
  g.check();
}, 600000);
