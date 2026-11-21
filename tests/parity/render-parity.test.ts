import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCore,
  renderExchange,
  renderInstrumentScene,
  renderPerformance,
  renderProjectScene,
  renderScenePlan,
  renderSequence,
} from "../../packages/core/src/edits.ts";
import {
  createDemoProject,
  createLegacyDemoProject,
  expandSong,
  migrateProject,
  type Project,
  ProjectSchema,
} from "../../packages/core/src/index.ts";
import { machines } from "../../packages/core/src/machines.ts";
import { performedProject, richProject, rng, sequencedProject } from "../project-fixtures.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

// XMP's C++ renders (native/include/xmp/render.hpp, through voices.hpp and the
// engine) against the TypeScript renderers (which drive the same engine as
// WebAssembly): performances, sequences, instrument scenes, the original
// pad-sampler renderer, whole-scene WAVs and MIDI-with-audio exports. Audio may
// differ only within 1e-5 (the C libraries' sin and exp differ in the last
// bits); note traces, scene transitions, MIDI events and files, snapshots and
// WAV headers must be identical.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-render-")),
    binary = join(dir, "render");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/render_tool.cpp"),
    "-o",
    binary,
  ]);
  return (commands: unknown[]) => {
    const out = execFileSync(binary, {
      input: Buffer.concat(commands.map((c) => Buffer.from(`${JSON.stringify(c)}\0`, "utf8"))),
      maxBuffer: 2 ** 31,
    })
      .toString("utf8")
      .split("\0");
    out.pop();
    return out;
  };
}

type Answer = { ok: true; value: unknown } | { ok: false; message: string };
const plain = (v: unknown): unknown =>
  v instanceof Float32Array || v instanceof Uint8Array
    ? [...v]
    : v instanceof ArrayBuffer
      ? [...new Uint8Array(v)]
      : Array.isArray(v)
        ? v.map(plain)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([, x]) => x !== undefined)
                .map(([k, x]) => [k, plain(x)]),
            )
          : v;
const attempt = (f: () => unknown): Answer => {
  try {
    return { ok: true, value: plain(f()) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};
// Audio arrays within `audio`; WAV sample bytes within one LSB; everything else exact (numbers within 1e-12).
function close(a: unknown, b: unknown, path: string, audio = false): string | undefined {
  if (typeof a === "number" && typeof b === "number") {
    const tolerance = audio ? 1e-5 : 1e-12;
    return a === b || Math.abs(a - b) <= tolerance ? undefined : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = close(a[i], b[i], `${path}[${i}]`, audio);
      if (d) return d;
    }
    return undefined;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(),
      kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) {
      const d = close(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
        audio || k === "pcm" || k === "rightPcm" || k === "meter",
      );
      if (d) return d;
    }
    return undefined;
  }
  return a === b ? undefined : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
// WAV bytes: identical headers, 16-bit samples within one step.
function wavClose(a: number[], b: number[]) {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < 44; i++) if (a[i] !== b[i]) return `header byte ${i}`;
  for (let i = 44; i + 1 < a.length; i += 2) {
    const x = (((a[i + 1] ?? 0) << 24) >> 16) | (a[i] ?? 0),
      y = (((b[i + 1] ?? 0) << 24) >> 16) | (b[i] ?? 0);
    if (Math.abs(x - y) > 1) return `sample at ${i}: ${x} vs ${y}`;
  }
  return undefined;
}

describe.skipIf(!haveCompiler)("the C++ renders match the TypeScript", () => {
  const run = driver();
  it("on random projects", () => {
    const commands: unknown[] = [],
      expected: Answer[] = [],
      kinds: string[] = [];
    const add = (op: string, args: unknown[], f: () => unknown) => {
      commands.push({ op, args });
      expected.push(attempt(f));
      kinds.push(op);
    };
    // The original pad-sampler renderer: projects without instruments.
    for (const p of [createDemoProject(), migrateProject(createLegacyDemoProject())]) {
      for (const scene of [p.scenes[0]?.id ?? "", "missing"]) {
        add("plan", [p, scene], () => renderScenePlan(p, scene));
        add("projectScene", [p, scene], () => renderProjectScene(p, scene));
      }
    }
    // An instrument project with no sequences and no mix (renderInstrumentScene's
    // own path): a synth holding notes past the end, so the end releases them.
    {
      const p = expandSong(createDemoProject());
      const synth = p.tracks[1];
      if (synth?.clips[0]) {
        synth.machine = machines.instantiate("xmp.subtractive");
        synth.clips[0].steps = [
          { step: 2, pad: 3, velocity: 0.8, probability: 1, note: 48, duration: 8 },
          { step: 6, pad: 5, velocity: 0.6, probability: 1, duration: 16 },
        ];
      }
      const q = ProjectSchema.parse(p);
      // Exact lengths end at the last step; without one (0 here) the render has a tail,
      // where the notes still held at the end are released.
      for (const exact of [8, 16, 0])
        add("instrument", [q, "scene-0", exact], () =>
          renderInstrumentScene(q, "scene-0", exact || undefined),
        );
    }
    // Automation points between quarter steps: renderSequence adds them as change positions.
    {
      const p = structuredClone(sequencedProject(7));
      for (const t of p.tracks)
        for (const c of t.clips)
          for (const lane of c.sequence?.lanes ?? [])
            lane.points = lane.points.map((pt) => ({
              ...pt,
              position: Math.max(0, pt.position - 0.125),
            }));
      const q = ProjectSchema.parse(p);
      for (const scene of q.scenes.slice(0, 4).map((s) => s.id))
        add("sequence", [q, scene, 16, false, false], () =>
          renderSequence(q, scene, 16, false, false),
        );
    }
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed * 2741),
        pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
      const projects: Project[] = [performedProject(seed), sequencedProject(seed + 40)];
      if (seed % 2) projects.push(richProject(r));
      for (const p of projects) {
        const scene = pick(p.scenes).id,
          mode = r() < 0.5 && p.performance?.chain.length ? "song" : "scene",
          steps = pick([8, 16, 24]),
          tail = pick([0, 0.25]);
        add("performance", [p, scene, mode, steps, tail, false], () =>
          renderPerformance(p, { scene, mode, steps, tailSeconds: tail }),
        );
        const sequenceSteps = pick([4, 8, 16]),
          fill = r() < 0.3,
          exact = pick([4, 8]);
        add("sequence", [p, scene, sequenceSteps, fill, false], () =>
          renderSequence(p, scene, sequenceSteps, fill, false),
        );
        add("instrument", [p, scene, exact], () => renderInstrumentScene(p, scene, exact));
        if (p.performance?.chain.length && p.performance.end === "stop")
          add("exchange", [p, "song", scene, 0], () => renderExchange(p, "song", scene, 0));
        add("exchange", [p, "scene", scene, 0], () => renderExchange(p, "scene", scene, 0));
      }
    }
    const got = run(commands);
    let audio = 0;
    expected.forEach((e, i) => {
      const cpp = got[i] ?? "",
        nl = cpp.indexOf("\n"),
        head = cpp.slice(0, nl),
        body = cpp.slice(nl + 1),
        kind = kinds[i] ?? "?",
        context = `command ${i} ${kind}`;
      if (e.ok) {
        expect(head, `${context}\nC++: ${body.slice(0, 300)}`).toBe("ok");
        const value = JSON.parse(body) as unknown;
        if (kind === "projectScene" || kind === "plan")
          expect(wavClose(value as number[], e.value as number[]), context).toBeUndefined();
        else {
          const ts = e.value as Record<string, unknown>;
          // Only the fields both sides report.
          const picked = Object.fromEntries(Object.keys(value as object).map((k) => [k, ts[k]]));
          if (kind === "exchange") picked.midiFile = ts.midiFile;
          // The C++ driver reports how many commands the render ran.
          if (Array.isArray(picked.commands)) picked.commands = picked.commands.length;
          // No mixer: no meter (undefined there, null here).
          if ("meter" in picked) picked.meter ??= null;
          expect(close(value, picked, "", false), context).toBeUndefined();
        }
        audio++;
      } else {
        expect(head, `${context}\nTypeScript: ${e.message}`).toBe("error");
        if (!e.message.startsWith("[")) expect(body, context).toBe(e.message);
      }
    });
    expect(audio).toBeGreaterThan(60);
  }, 900000);
});
