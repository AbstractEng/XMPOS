// The manual's numbered instructions, read from the published manual source, and
// a registry that ties each one to the UI test that performs it.
//
// Every numbered step in apps/studio/manual/index.html must be performed by a test
// with the same wording. When an instruction is added, removed or reworded, the
// coverage checks fail and name the step, so the test changes with the manual.
// (The lesson steps are generated from tools/tutorials/lessons.mjs.)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

export type ManualStep = { list: string; title: string; text: string };

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};
const plain = (html: string) =>
  html
    .replace(/<\/?(?:strong|em|code|a|span|kbd|b|i|small|abbr)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) =>
      e.startsWith("#x")
        ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
        : e.startsWith("#") && e !== "#39"
          ? String.fromCodePoint(Number(e.slice(1)))
          : (entities[e] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();

export const manualFile = resolve(import.meta.dirname, "../../apps/studio/manual/index.html");

// Each ordered list of instructions, keyed "<section id> › <nearest heading>".
// The lesson index (a list of links) is not instructions.
export function manualSteps(source = readFileSync(manualFile, "utf8")): ManualStep[] {
  const steps: ManualStep[] = [];
  for (const list of source.matchAll(/<ol([^>]*)>([\s\S]*?)<\/ol>/g)) {
    if (/lesson-index/.test(list[1] ?? "")) continue;
    const before = source.slice(0, list.index);
    const section = [...before.matchAll(/<section[^>]*\bid="([^"]+)"/g)].at(-1)?.[1] ?? "manual";
    const heading = [...before.matchAll(/<h([234])[^>]*>([\s\S]*?)<\/h\1>/g)].at(-1)?.[2] ?? "";
    const key = `${section} › ${plain(heading)}`;
    let n = 0;
    for (const item of (list[2] ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      n++;
      const body = item[1] ?? "";
      const title = /<h[34][^>]*>([\s\S]*?)<\/h[34]>/.exec(body);
      steps.push({
        list: key,
        title: title ? plain(title[1] ?? "") : `Step ${n}`,
        text: plain(title ? body.replace(title[0], "") : body),
      });
    }
  }
  return steps;
}

export const lists = (steps: ManualStep[]) => [...new Set(steps.map((s) => s.list))];

// A test file's journey through some of the manual's lists. `step` registers one
// instruction as a test, in order (later steps build on earlier ones, as a reader's
// do); `coverage` checks that the file performs exactly the steps of its lists.
export function manualJourney(owned: readonly string[]) {
  const registered: ManualStep[] = [];
  let list = "";
  return {
    list(name: string) {
      if (!owned.includes(name)) throw new Error(`Not one of this file's lists: ${name}`);
      list = name;
    },
    step(title: string, text: string, run: () => Promise<void> | void, timeout = 20000) {
      registered.push({ list, title, text });
      it(`${list} › ${title}`, run, timeout);
    },
    coverage() {
      it("performs every step of its manual lists, worded as the manual words them", () => {
        const manual = manualSteps().filter((s) => owned.includes(s.list));
        const show = (s: ManualStep) => `${s.list} › ${s.title}: ${s.text}`;
        expect(
          registered.map(show),
          "A manual step changed: update the test that performs it (tests/manual/)",
        ).toEqual(manual.map(show));
      });
    },
  };
}
