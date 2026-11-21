import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventsAtStep, type Project } from "../../packages/core/src/index.ts";
import { parameterRegistry } from "../../packages/core/src/parameters.ts";
import { notesInWindow, parameterFrame, timeline } from "../../packages/core/src/sequencer.ts";
import { richProject, rng, sequencedProject } from "../project-fixtures.ts";

// The C++ sequencer reading the C++ project (native/include/xmp/play.hpp)
// against the TypeScript, which lays the project out for the same sequencer
// in WebAssembly: notesInWindow, timeline, eventsAtStep and parameterFrame on
// random projects. Answers must be byte-identical: the same notes, IDs, order,
// frames and parameter values.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-play-")),
    binary = join(dir, "play");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/play_tool.cpp"),
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
const attempt = (f: () => unknown) => {
  try {
    return { ok: true as const, text: JSON.stringify(f()) };
  } catch (error) {
    return { ok: false as const, message: (error as Error).message };
  }
};

describe.skipIf(!haveCompiler)(
  "the C++ sequencer on the C++ project matches the TypeScript",
  () => {
    const run = driver();
    it("on random projects and windows", () => {
      let notes = 0,
        events = 0,
        frames = 0,
        checked = 0;
      for (let seed = 1; seed <= 24; seed++) {
        const r = rng(seed * 6007),
          pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
        const project: Project = seed % 3 === 0 ? richProject(r) : sequencedProject(seed);
        const scenes = project.scenes.map((s) => s.id).concat(["missing"]),
          registry = parameterRegistry(project).map((d) => d.id);
        const commands: unknown[] = [{ op: "set", project }],
          expected = [{ ok: true as const, text: JSON.stringify(project) }] as ReturnType<
            typeof attempt
          >[];
        const add = (op: string, args: unknown[], f: () => unknown) => {
          commands.push({ op, args });
          expected.push(attempt(f));
        };
        for (let i = 0; i < 40; i++) {
          const scene = r() < 0.95 ? pick(scenes) : "missing",
            from =
              r() < 0.1
                ? pick([-1, Number.NaN, 2e6])
                : Math.floor(r() * 200) + pick([0, 0.25, 0.5]),
            to = from + (r() < 0.1 ? pick([0, 65]) : 1 + Math.floor(r() * 16)),
            fill = r() < 0.3;
          add("notesInWindow", [scene, from, to, fill], () =>
            notesInWindow(project, scene, from, to, fill),
          );
          const swing = r() < 0.1 ? 0.6 : pick([0, 0.1, project.swing, 0.5]),
            rate = pick([48000, 44100]);
          add("timeline", [scene, from, to, fill, swing, rate], () =>
            timeline(project, scene, from, to, fill, swing, rate),
          );
          const step = r() < 0.1 ? pick([-1, 1.5]) : Math.floor(r() * 256);
          add("eventsAtStep", [scene, step], () => eventsAtStep(project, scene, step));
          const position = r() < 0.05 ? -1 : r() * 128,
            offsets = Object.fromEntries(
              registry
                .filter(() => r() < 0.1)
                .map((id) => [id, Math.round((r() * 2 - 1) * 100) / 100]),
            );
          add("parameterFrame", [scene, position, offsets], () =>
            parameterFrame(project, scene, position, offsets),
          );
        }
        const got = run(commands);
        expected.forEach((e, i) => {
          const cpp = got[i] ?? "",
            nl = cpp.indexOf("\n"),
            head = cpp.slice(0, nl),
            body = cpp.slice(nl + 1);
          const context = `seed ${seed}, command ${i}: ${String(JSON.stringify(commands[i])).slice(0, 300)}`;
          if (e.ok) {
            expect(head, `${context}\nC++: ${body.slice(0, 300)}`).toBe("ok");
            const op = (commands[i] as { op: string }).op;
            if (op === "parameterFrame") {
              // LFOs use sin: the browser's C library (wasi-libc) and this build's
              // may differ in the last bit, as tests/sequencer-parity.test.ts allows.
              const a = JSON.parse(body) as Record<string, number>,
                b = JSON.parse(e.text) as Record<string, number>;
              expect(Object.keys(a), context).toEqual(Object.keys(b));
              for (const [k, v] of Object.entries(b))
                expect(Math.abs((a[k] ?? Number.NaN) - v), `${context} ${k}`).toBeLessThan(1e-12);
            } else expect(body, context).toBe(e.text);
            const n = op === "parameterFrame" ? 1 : (JSON.parse(body) as unknown[]).length;
            if (op === "notesInWindow" || op === "timeline") notes += n;
            if (op === "eventsAtStep") events += n;
            if (op === "parameterFrame") frames++;
          } else {
            expect(head, `${context}\nTypeScript: ${e.message}`).toBe("error");
            expect(body, context).toBe(e.message);
          }
          checked++;
        });
      }
      expect(checked).toBeGreaterThan(3500);
      expect(notes).toBeGreaterThan(5000);
      expect(events).toBeGreaterThan(300);
      expect(frames).toBeGreaterThan(800);
    }, 600000);
  },
);
