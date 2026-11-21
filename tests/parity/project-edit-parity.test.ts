import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Project, ProjectSchema } from "../../packages/core/src/index.ts";
import { applyOp, type Op, randomOp, typescriptEdits } from "../edit-ops.ts";
import { richProject, rng } from "../project-fixtures.ts";

// XMP's C++ project edits (native/include/xmp/project_edit.hpp) against the
// TypeScript: the same random sequences of edits applied to the same random
// projects. After every edit both must succeed or fail together, produce
// byte-identical projects, and give the same message when it is the
// TypeScript's own (not zod's).
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-edit-")),
    binary = join(dir, "edit");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/project_edit.cpp"),
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

describe.skipIf(!haveCompiler)("the C++ project edits match the TypeScript", () => {
  const run = driver();
  it("through random edit sequences", () => {
    const counts: Record<string, { ok: number; error: number }> = {};
    let ownMessages = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const r = rng(seed * 7919);
      let project = richProject(r);
      // Room for duplicates: fewer clips on some tracks (and no scene pointing at them).
      if (seed % 2 === 0) {
        const next = structuredClone(project);
        for (const t of next.tracks.slice(0, 4)) {
          const gone = t.clips.splice(12);
          for (const sc of next.scenes)
            if (gone.some((c) => c.id === sc.clips[t.id])) delete sc.clips[t.id];
        }
        project = ProjectSchema.parse(next);
      }
      // Long clip names, some with emoji: copies cut them at 30 UTF-16 units.
      if (seed % 3 !== 1) {
        const next = structuredClone(project);
        next.tracks.forEach((t, k) => {
          t.clips.forEach((c, j) => {
            c.name =
              (j + k) % 2
                ? `${"Long clip name ".repeat(3)}${j}`.slice(0, 40)
                : `${"🎛".repeat(14)}ab${j}`;
          });
        });
        project = ProjectSchema.parse(next);
      }
      const commands: unknown[] = [{ op: "set", project }],
        expected: ({ ok: true; text: string } | { ok: false; message: string; own: boolean })[] = [
          { ok: true, text: JSON.stringify(project) },
        ],
        ops: Op[] = [];
      for (let i = 0; i < 60; i++) {
        const op = randomOp(project, r);
        ops.push(op);
        commands.push(op);
        counts[op.op] ??= { ok: 0, error: 0 };
        const c = counts[op.op] as { ok: number; error: number };
        try {
          project = applyOp(typescriptEdits, project, op);
          expected.push({ ok: true, text: JSON.stringify(project) });
          c.ok++;
        } catch (error) {
          expected.push({
            ok: false,
            message: (error as Error).message,
            own: !(error instanceof z.ZodError),
          });
          c.error++;
        }
      }
      const got = run(commands);
      expected.forEach((e, i) => {
        const cpp = got[i] ?? "",
          nl = cpp.indexOf("\n");
        const head = cpp.slice(0, nl),
          body = cpp.slice(nl + 1);
        const context = `seed ${seed}, command ${i}: ${String(JSON.stringify(ops[i - 1])).slice(0, 400)}`;
        if (e.ok) {
          expect(head, `${context}\nC++: ${body.slice(0, 400)}`).toBe("ok");
          expect(body, context).toBe(e.text);
        } else {
          expect(head, `${context}\nTypeScript: ${e.message.slice(0, 400)}`).toBe("error");
          if (e.own) {
            expect(body, context).toBe(e.message);
            ownMessages++;
          }
        }
      });
    }
    // Every edit was exercised, both ways.
    for (const [op, c] of Object.entries(counts)) {
      expect(c.ok, `${op} succeeded`).toBeGreaterThan(0);
      // expandSong cannot fail on a valid project.
      if (op !== "expandSong") expect(c.error, `${op} failed`).toBeGreaterThan(0);
    }
    expect(Object.keys(counts).length).toBe(17);
    expect(ownMessages).toBeGreaterThan(50);
  }, 600000);
});
