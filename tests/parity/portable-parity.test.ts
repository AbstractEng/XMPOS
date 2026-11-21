import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportPortable, exportSong, importPortable } from "../../packages/core/src/assets.ts";
import { createDemoProject, type Project, ProjectSchema } from "../../packages/core/src/index.ts";
import { extensibleProject, invalidProjectExtensions } from "../project-extension-fixtures.ts";
import { performedProject, richProject, rng } from "../project-fixtures.ts";

// Opening the files the browser saves (native/include/xmp/portable.hpp)
// against the TypeScript's importPortable: plain projects, version 1 bundles
// (project.xmp.json) and version 2 songs (.xmpsong) with packaged or
// referenced samples, and damaged copies of each (altered audio, hashes,
// base64, versions, keys). The same projects, the same refusals, and the same
// messages where they are XMP's own.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-portable-")),
    binary = join(dir, "portable");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/portable_tool.cpp"),
    "-o",
    binary,
  ]);
  return (texts: string[], mode: string[] = []) => {
    const out = execFileSync(binary, mode, {
      input: Buffer.concat(texts.map((t) => Buffer.from(`${t}\0`, "utf8"))),
      maxBuffer: 2 ** 31,
    })
      .toString("utf8")
      .split("\0");
    out.pop();
    return out;
  };
}

// Smaller samples keep the test quick; some are float32-exact (packaged as f32), some not (f64).
function small(p: Project, r: () => number): Project {
  const next = structuredClone(p);
  next.samples = next.samples.map((s, i) => ({
    ...s,
    pcm: s.pcm
      .slice(0, 40 + Math.floor(r() * 200))
      .map((v) => (i % 2 ? Math.fround(v) : v + 1e-12 * (v > 0 ? -1 : 1))),
  }));
  for (const pad of next.pads) delete pad.slice;
  return ProjectSchema.parse(next);
}
// One random change to a file's text.
function damage(text: string, r: () => number): string {
  const roll = r();
  if (roll < 0.15) return text.replace(/"version":(\d)/, (_m, v) => `"version":${Number(v) + 2}`);
  if (roll < 0.3) {
    // A changed digit in a hash.
    const at = text.indexOf("sha256-");
    if (at >= 0) {
      const i = at + 7 + Math.floor(r() * 64);
      return text.slice(0, i) + (text[i] === "a" ? "b" : "a") + text.slice(i + 1);
    }
  }
  if (roll < 0.45) {
    // A changed audio value or base64 character.
    const at = text.indexOf('"pcm":[');
    if (at >= 0) return `${text.slice(0, at + 7)}0.123,${text.slice(at + 7)}`;
    const c = text.indexOf('"chunks":["');
    if (c >= 0) {
      const i = c + 11 + Math.floor(r() * 8);
      return text.slice(0, i) + (text[i] === "A" ? "B" : "A") + text.slice(i + 1);
    }
  }
  if (roll < 0.55) return text.replace('"format":"xmp-bundle"', '"format":"xmp-bundle","extra":1');
  if (roll < 0.65) return text.replace('"sampleMode":"embedded"', '"sampleMode":"referenced"');
  if (roll < 0.75) return text.replace(/"name":"[^"]*"/, '"name":"Renamed"');
  if (roll < 0.85)
    return text.replace(
      /"assets":\[/,
      '"assets":[{"hash":"sha256-0","sampleRate":48000,"pcm":[0]},',
    );
  return text.replace(/"bpm":\d+/, '"bpm":999');
}

describe.skipIf(!haveCompiler)("opening portable files in C++ matches the TypeScript", () => {
  const run = driver();
  it("preserves future extensions through a native save/reopen cycle and refuses the same incompatible descriptors", async () => {
    const project = extensibleProject();
    const song = await exportSong(project);
    const files = [JSON.stringify(project), await exportPortable(project), song];
    for (const result of run(files)) expect(result).toBe(`ok\n${JSON.stringify(project)}`);
    expect(run([JSON.stringify(project)], ["save"])).toEqual([`ok\n${song}`]);
    for (const result of run(
      invalidProjectExtensions().map((extensions) => JSON.stringify({ ...project, extensions })),
    ))
      expect(result).toMatch(/^error\n/);
  }, 120000);
  it("for bundles, songs and plain projects, intact and damaged", async () => {
    const texts: string[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed * 104723),
        p = small(
          seed % 3 === 0
            ? richProject(r)
            : seed % 3 === 1
              ? performedProject(seed)
              : createDemoProject(),
          r,
        );
      const files = [
        JSON.stringify(p),
        await exportPortable(p),
        await exportSong(p, { packageSamples: true }),
        await exportSong(p, { packageSamples: false }),
      ];
      for (const f of files) {
        texts.push(f);
        for (let k = 0; k < 4; k++) texts.push(damage(f, r));
      }
    }
    const expected = await Promise.all(
      texts.map(async (t) => {
        try {
          return { ok: true as const, text: JSON.stringify(await importPortable(t)) };
        } catch (error) {
          const e = error as Error;
          return {
            ok: false as const,
            message: e.message,
            // zod's issue lists and JSON.parse's wording are not reproduced.
            own:
              e.name !== "ZodError" &&
              e.name !== "SyntaxError" &&
              !/^(Could not open project: )?\[/.test(e.message),
          };
        }
      }),
    );
    const got = run(texts);
    let opened = 0,
      refused = 0,
      own = 0;
    expected.forEach((e, i) => {
      const cpp = got[i] ?? "",
        nl = cpp.indexOf("\n"),
        head = cpp.slice(0, nl),
        body = cpp.slice(nl + 1),
        context = `file ${i}: ${(texts[i] ?? "").slice(0, 120)}`;
      if (e.ok) {
        expect(head, `${context}\nC++: ${body.slice(0, 300)}`).toBe("ok");
        expect(body, context).toBe(e.text);
        opened++;
      } else {
        expect(head, `${context}\nTypeScript: ${e.message.slice(0, 300)}`).toBe("error");
        if (e.own) {
          expect(body, context).toBe(e.message);
          own++;
        }
        refused++;
      }
    });
    expect(opened).toBeGreaterThan(40);
    expect(refused).toBeGreaterThan(80);
    expect(own).toBeGreaterThan(40);
  }, 600000);
  it("saving a song writes the same file as exportSong", async () => {
    const projects: Project[] = [];
    for (let seed = 1; seed <= 9; seed++) {
      const r = rng(seed * 7919);
      projects.push(
        small(
          seed % 3 === 0
            ? richProject(r)
            : seed % 3 === 1
              ? performedProject(seed)
              : createDemoProject(),
          r,
        ),
      );
    }
    // Repeated audio is stored once; -0 is written as 0.
    const shared = structuredClone(projects[0] as Project);
    const [first, second] = shared.samples;
    if (first && second) {
      first.pcm[0] = -0;
      second.pcm = [...first.pcm];
      second.sampleRate = first.sampleRate;
    }
    projects.push(ProjectSchema.parse(shared));
    const got = run(
      projects.map((p) => JSON.stringify(p)),
      ["save"],
    );
    for (const [i, p] of projects.entries()) {
      const expected = await exportSong(p, { packageSamples: true });
      expect(got[i], `project ${i}`).toBe(`ok\n${expected}`);
      expect(JSON.stringify(await importPortable(expected))).toBe(JSON.stringify(p));
    }
    expect(got.join("")).toContain("pcm-f32le");
    expect(got.join("")).toContain("pcm-f64le");
  }, 600000);
});
