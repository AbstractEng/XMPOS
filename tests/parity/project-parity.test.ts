import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDemoProject,
  createLegacyDemoProject,
  openProject,
  type Project,
} from "../../packages/core/src/index.ts";
import { richProject, rng } from "../project-fixtures.ts";

// XMP's C++ project model (native/include/xmp/project.hpp) against the
// TypeScript's parseProject/openProject: random projects of every version
// (1 to 6) and thousands of random mutations of them. Both must accept and
// refuse the same files, produce byte-identical canonical JSON, agree on
// whether a file was migrated, and, for XMP's own checks, name the same problem.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

// Messages the C++ shares with the TypeScript (its own checks, the preflight,
// the version); other C++ messages describe zod's structural problems in their own words.
const OWN = [
  /^Duplicate /,
  /^Missing /,
  /^Sample /,
  /^Step exceeds/,
  /^Scene references/,
  /^Unknown parameter/,
  /^Master parameter/,
  /^Track parameter/,
  /^Project exceeds 131072/,
  /^Sequence /,
  /^Song /,
  /^Performance /,
  /^Macro references/,
  /^Mix references/,
  /^Machine state exceeds/,
  /^Automation points/,
  /^Effect /,
  /^Only filter/,
  /^Tempo map/,
  /^Expected an XMP/,
  /^Unsupported project version/,
];

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-project-")),
    binary = join(dir, "project");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/project_open.cpp"),
    "-o",
    binary,
  ]);
  return (texts: string[]) => {
    const out = execFileSync(binary, {
      input: Buffer.concat(texts.map((t) => Buffer.from(`${t}\0`, "utf8"))),
      maxBuffer: 1 << 30,
    })
      .toString("utf8")
      .split("\0");
    out.pop();
    return out;
  };
}
// The same project written as an older version (dropping what that version lacks).
function asVersion(p: Project, version: number): Record<string, unknown> {
  const o = structuredClone(p) as Record<string, unknown> & Project;
  o.version = version as 8;
  if (version <= 7)
    for (const pad of [...o.pads, ...o.tracks.flatMap((t) => t.pads ?? [])]) delete pad.layers;
  if (version <= 6) {
    // No track kits before version 7, nor their own samples.
    for (const t of o.tracks) delete t.pads;
    o.samples = o.samples.filter((s) => o.pads.some((p) => p.sampleId === s.id));
  }
  if (version <= 5) {
    delete o.mix;
    o.parameters = o.parameters
      .filter((x) => !x.id.includes(".pan") && !x.id.includes("send") && !x.id.includes("insert"))
      .slice(0, 145);
  }
  if (version <= 4) delete o.performance;
  if (version <= 3) for (const t of o.tracks) for (const c of t.clips) delete c.sequence;
  if (version <= 2) {
    for (const t of o.tracks) {
      delete t.machine;
      for (const c of t.clips) for (const s of c.steps) delete s.note, delete s.duration;
    }
    for (const pad of o.pads)
      delete (pad as Record<string, unknown>).playback,
        delete (pad as Record<string, unknown>).edit;
    o.parameters = o.parameters.filter((x) => !x.id.includes(".machine."));
    // Versions 1 and 2 need at least one clip per track.
    o.tracks = o.tracks.filter((t) => t.clips.length > 0);
    const ids = new Set(o.tracks.map((t) => t.id));
    for (const s of o.scenes)
      for (const k of Object.keys(s.clips)) if (!ids.has(k)) delete s.clips[k];
    o.parameters = o.parameters.filter(
      (x) => [...ids].some((id) => x.id.startsWith(`track.${id}.`)) || x.id === "master.gain",
    );
  }
  if (version <= 1) {
    const legacy = o as Record<string, unknown>;
    delete legacy.seed, delete legacy.parameterVersion, delete legacy.parameters;
    for (const pad of o.pads) delete (pad as Record<string, unknown>).slice;
  }
  return o;
}

// One random change somewhere in the document.
function mutate(doc: unknown, r: () => number): unknown {
  const copy = structuredClone(doc);
  const paths: { parent: Record<string, unknown> | unknown[]; key: string | number }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      // Long arrays (PCM) contribute a few elements only.
      const n = Math.min(v.length, 6);
      for (let i = 0; i < n; i++) {
        paths.push({ parent: v, key: i });
        walk(v[i]);
      }
    } else if (v && typeof v === "object")
      for (const k of Object.keys(v)) {
        paths.push({ parent: v as Record<string, unknown>, key: k });
        walk((v as Record<string, unknown>)[k]);
      }
  };
  walk(copy);
  const at = paths[Math.floor(r() * paths.length)];
  if (!at) return copy;
  const parent = at.parent as Record<string | number, unknown>,
    value = parent[at.key],
    roll = r();
  const replace = (v: unknown) => {
    parent[at.key] = v;
  };
  if (roll < 0.12) {
    if (Array.isArray(parent)) parent.splice(at.key as number, 1);
    else delete parent[at.key];
  } else if (roll < 0.22 && typeof value === "number")
    replace(
      // Nearby values, and the limits the schemas and checks use.
      [
        value + 1,
        value - 1,
        value * 1000,
        -value,
        value + 0.5,
        0,
        65536,
        1e308,
        ...[1, 8, 15, 16, 17, 31, 32, 63, 64, 65, 127, 128, 145, 300, 301, 1023, 1024],
      ][Math.floor(r() * 25)],
    );
  else if (roll < 0.3 && typeof value === "string")
    replace(
      [
        `${value}x`,
        "",
        "a b",
        ...[16, 17, 32, 33, 40, 41, 64, 65, 80, 81, 120, 121, 256, 257].map((n) => "x".repeat(n)),
        "track.drums.gain",
        "scene-1",
        "clip-1",
        "drums",
        "master.gain",
        "😀".repeat(20),
        "😀".repeat(21),
        "😀".repeat(41),
      ][Math.floor(r() * 25)],
    );
  else if (roll < 0.36) replace([null, true, "1", 1, [], {}][Math.floor(r() * 6)]);
  else if (roll < 0.44 && value && typeof value === "object" && !Array.isArray(value))
    (value as Record<string, unknown>)[
      ["extra", "__proto__", "1", "constructor"][Math.floor(r() * 4)] as string
    ] = r() < 0.5 ? 1 : { a: 1 };
  else if (roll < 0.48 && value && typeof value === "object" && !Array.isArray(value)) {
    // A real "__proto__" key holding a copy of a sibling's value (zod drops it from records).
    const first = Object.values(value)[0];
    if (first !== undefined)
      Object.defineProperty(value, "__proto__", {
        value: structuredClone(first),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  } else if (roll < 0.52 && Array.isArray(value) && value.length)
    value.push(structuredClone(value[0]));
  else if (roll < 0.56 && Array.isArray(value)) value.length = 0;
  else if (roll < 0.62 && Array.isArray(parent) && parent.length > 1)
    parent[at.key as number] = structuredClone(parent[0]);
  else if (roll < 0.66 && at.key === "version")
    replace([1, 2, 3, 4, 5, 6, 7, 8, 0, "6", null, 2.5][Math.floor(r() * 12)]);
  else if (typeof value === "boolean") replace(!value);
  else if (typeof value === "number") replace(Math.round(value * 3.7 * 100) / 100);
  return copy;
}

function typescript(text: string) {
  try {
    const { project, migrated } = openProject(text);
    return { ok: true as const, text: JSON.stringify(project), migrated };
  } catch (error) {
    return { ok: false as const, message: (error as Error).message };
  }
}

describe.skipIf(!haveCompiler)("the C++ project model matches the TypeScript", () => {
  const run = driver();
  const compare = (texts: string[]) => {
    const got = run(texts);
    let accepted = 0,
      refused = 0,
      own = 0;
    texts.forEach((text, i) => {
      const ts = typescript(text),
        cpp = got[i] ?? "";
      const nl = cpp.indexOf("\n"),
        head = cpp.slice(0, nl),
        body = cpp.slice(nl + 1);
      if (ts.ok) {
        expect(head, `${body}\n${text.slice(0, 2000)}`).toBe(`ok ${ts.migrated ? 1 : 0}`);
        expect(body).toBe(ts.text);
        accepted++;
      } else {
        expect(head, `${ts.message}\n${text.slice(0, 3000)}`).toBe("error");
        refused++;
        // Same opening, and XMP's own messages appear in the TypeScript's.
        const message = body.replace(/^Could not open project: /, "");
        expect(body.startsWith("Could not open project: ")).toBe(
          ts.message.startsWith("Could not open project: "),
        );
        if (OWN.some((re) => re.test(message))) {
          expect(ts.message, message).toContain(message);
          own++;
        }
      }
    });
    return { accepted, refused, own };
  };

  it("opens projects of every version identically", () => {
    const r = rng(3),
      texts: string[] = [
        JSON.stringify(createLegacyDemoProject()),
        JSON.stringify(createDemoProject()),
      ];
    for (let i = 0; i < 40; i++) {
      const p = richProject(r);
      for (const v of [1, 2, 3, 4, 5, 6, 7])
        texts.push(JSON.stringify(asVersion(p, v), null, r() < 0.3 ? 2 : 0));
    }
    const { accepted } = compare(texts);
    expect(accepted).toBe(texts.length);
  }, 300000);

  it("accepts and refuses the same mutated projects", () => {
    const r = rng(17),
      texts: string[] = [];
    for (let i = 0; i < 60; i++) {
      const p = richProject(r);
      const v = 1 + Math.floor(r() * 7);
      const base = asVersion(p, v);
      for (let k = 0; k < 50; k++) {
        let doc: unknown = base;
        for (let m = 1 + Math.floor(r() * 2); m > 0; m--) doc = mutate(doc, r);
        texts.push(JSON.stringify(doc));
      }
    }
    const { accepted, refused, own } = compare(texts);
    expect(accepted).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(1000);
    expect(own).toBeGreaterThan(100);
  }, 600000);

  it("applies the same preflight and version rules", () => {
    const demo = JSON.stringify(createDemoProject());
    const texts = [
      "",
      "[]",
      "null",
      "3",
      '"x"',
      "{}",
      '{"version":9}',
      '{"version":"6"}',
      '{"version":[1,[2,null]]}',
      '{"version":{}}',
      `{"a":"${"x".repeat(1025)}"}`,
      `${"[".repeat(33)}${"]".repeat(33)}`,
      `[${"1".repeat(129)}]`,
      `{"a":"${"😀".repeat(512)}x"}`,
      `{"a":"${"😀".repeat(513)}"}`,
      demo.replace('"version":8', '"version":8.0'),
      `[${"1e400,".repeat(3)}1]`,
      demo.replace('"bpm":112', '"bpm":1.12e2'),
      demo.replace('"swing":0', '"swing":-0'),
      demo.replace('{"format"', '{"format":"x","format"'),
    ];
    compare(texts);
  }, 120000);
});
