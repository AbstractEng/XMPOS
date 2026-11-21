import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Project, ProjectSchema } from "../../packages/core/src/index.ts";
import { machines } from "../../packages/core/src/machines.ts";
import { setMidiDestination } from "../../packages/core/src/midi-routing.ts";
import { emptyMix } from "../../packages/core/src/mix-schema.ts";
import { parameterRegistry } from "../../packages/core/src/parameters.ts";
import {
  PerformanceTransport,
  performanceControls,
  performanceValues,
  performanceWindow,
} from "../../packages/core/src/performance.ts";
import { performedProject, rng } from "../project-fixtures.ts";

// The C++ performance on the C++ project (native/include/xmp/performance.hpp)
// against the TypeScript PerformanceTransport, performanceControls,
// performanceValues and performanceWindow: the same random performances
// (scene and song mode, launches, clip changes, live mutes, solos and macros,
// project and chain edits while playing, and mostly window steps). Answers must
// match exactly, except numbers within 1e-12 (an LFO's sin may differ in the
// last bit between C libraries).
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-performance-")),
    binary = join(dir, "performance");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/performance_tool.cpp"),
    "-o",
    binary,
  ]);
  return (commands: unknown[]) => {
    const out = execFileSync(binary, {
      input: Buffer.concat(commands.map((c) => Buffer.from(`${JSON.stringify(c)}\0`, "utf8"))),
      maxBuffer: 1 << 30,
    })
      .toString("utf8")
      .split("\0");
    out.pop();
    return out;
  };
}

type Answer = { ok: true; value: unknown } | { ok: false; message: string };
const attempt = (f: () => unknown): Answer => {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(f() ?? null)) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};
function close(a: unknown, b: unknown, path: string): string | undefined {
  if (typeof a === "number" && typeof b === "number")
    return a === b || Math.abs(a - b) < 1e-12 ? undefined : `${path}: ${a} vs ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = close(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a),
      kb = Object.keys(b);
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) {
      const d = close(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
    return undefined;
  }
  return a === b ? undefined : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

describe.skipIf(!haveCompiler)(
  "the C++ performance on the C++ project matches the TypeScript",
  () => {
    const run = driver();
    it("through random performances", () => {
      let windows = 0,
        notes = 0,
        checked = 0;
      for (let seed = 1; seed <= 16; seed++) {
        const r = rng(seed * 15485863),
          pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
        let project = performedProject(seed);
        const t = new PerformanceTransport(project);
        const state = () => ({
          sceneId: t.sceneId,
          running: t.running,
          mode: t.mode,
          step: t.step,
          songOffset: t.songOffset,
          clockOrigin: t.clockOrigin,
          slots: [...t.slots].map(([id, s]) => [id, s.clipId ?? null, s.anchor]),
        });
        const commands: unknown[] = [{ op: "new", project }],
          expected: Answer[] = [attempt(state)];
        const add = (
          op: string,
          args: unknown[],
          f: () => unknown,
          extra: Record<string, unknown> = {},
        ) => {
          commands.push({ op, args, ...extra });
          expected.push(attempt(f));
        };
        let step = -1;
        for (let i = 0; i < 160; i++) {
          const roll = r();
          if (roll < 0.04 || (i === 0 && r() < 0.8)) {
            const mode = r() < 0.5 ? "song" : "scene",
              scene = r() < 0.1 ? null : pick(project.scenes).id,
              resume = r() < 0.3;
            add("start", [scene, mode, resume], () => {
              t.start(scene ?? undefined, mode, resume);
              return state();
            });
            step = -1;
          } else if (roll < 0.08) {
            const scene = r() < 0.9 ? pick(project.scenes).id : "nowhere";
            add("queueScene", [scene], () => {
              t.queueScene(scene);
              return state();
            });
          } else if (roll < 0.13) {
            const track = pick(project.tracks),
              clip = r() < 0.2 ? null : (pick(track.clips)?.id ?? null);
            add("queueClip", [track.id, clip], () => {
              t.queueClip(track.id, clip);
              return state();
            });
          } else if (roll < 0.15) add("cancel", [], () => t.cancelLaunch());
          else if (roll < 0.16) add("stop", [], () => (t.stop(), state()));
          else if (roll < 0.22) {
            const macro = project.performance?.macros[0];
            const event =
              r() < 0.4 && macro
                ? {
                    id: "live",
                    at: Math.max(0, step),
                    kind: "macro",
                    macroId: macro.id,
                    value: Math.round(r() * 100) / 100,
                  }
                : {
                    id: "live",
                    at: Math.max(0, step),
                    kind: pick(["mute", "solo"]),
                    trackId: r() < 0.9 ? pick(project.tracks).id : "nowhere",
                    value: r() < 0.5,
                  };
            add("control", [event], () => (t.control(event as never), state()));
          } else if (roll < 0.25) {
            // Edit the chain while playing.
            const next = structuredClone(project);
            if (next.performance) {
              next.performance.chain = next.performance.chain.filter(() => r() < 0.8);
              if (r() < 0.5)
                next.performance.chain.push({
                  id: `new-${i}`,
                  sceneId: pick(next.scenes).id,
                  repeats: 1,
                });
            }
            project = ProjectSchema.parse(next);
            const p = project;
            commands.push({ op: "setProject", project: p });
            expected.push(attempt(() => (t.setProject(p), state())));
          } else if (roll < 0.28) {
            const position = r() * 64;
            add("values", [position], () => performanceValues(t, position));
          } else if (roll < 0.3) {
            const position = r() < 0.1 ? -1 : r() * 128,
              overrides = [...t.overrides];
            add("controls", [project, position, overrides], () =>
              performanceControls(project, position, new Map(overrides)),
            );
          } else {
            // Mostly the next step; sometimes a jump (songs reach their end) or an invalid advance.
            const next =
              Math.max(0, t.step) +
              (r() < 0.05
                ? pick([-1, 5000, 0.5])
                : r() < 0.85
                  ? 1
                  : r() < 0.6
                    ? 2
                    : pick([16, 64, 200]));
            const fill = r() < 0.2,
              swing = r() < 0.9 ? project.swing : pick([0, 0.25, 0.5]),
              rate = r() < 0.9 ? 48000 : 44100;
            add("window", [next, fill, swing, rate], () =>
              performanceWindow(t, next, fill, swing, rate),
            );
            step = next;
          }
        }
        const got = run(commands);
        expected.forEach((e, i) => {
          const cpp = got[i] ?? "",
            nl = cpp.indexOf("\n"),
            head = cpp.slice(0, nl),
            body = cpp.slice(nl + 1);
          const op = (commands[i] as { op: string }).op,
            context = `seed ${seed}, command ${i} ${op} ${String(JSON.stringify((commands[i] as { args?: unknown }).args)).slice(0, 200)}`;
          if (e.ok) {
            expect(head, `${context}\nC++: ${body.slice(0, 300)}`).toBe("ok");
            const diff = close(JSON.parse(body), e.value, "");
            expect(diff, context).toBeUndefined();
            if (op === "window") {
              windows++;
              notes += (e.value as { notes: unknown[] }).notes.length;
            }
          } else {
            expect(head, `${context}\nTypeScript: ${e.message}`).toBe("error");
            if (!e.message.startsWith("[")) expect(body, context).toBe(e.message);
          }
          checked++;
        });
      }
      expect(checked).toBeGreaterThan(2400);
      expect(windows).toBeGreaterThan(1500);
      expect(notes).toBeGreaterThan(1000);
    }, 900000);
  },
);
