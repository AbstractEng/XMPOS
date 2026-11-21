import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Project, ProjectSchema } from "../../packages/core/src/index.ts";
import { type MachineDefinition, machines } from "../../packages/core/src/machines.ts";
import {
  advanceParameter,
  clearParameterSource,
  machineParameter,
  parameterRegistry,
  parameterSources,
  parameterValue,
  setParameter,
  smoothParameter,
} from "../../packages/core/src/parameters.ts";
import { richProject, rng } from "../project-fixtures.ts";

// XMP's C++ machines and parameters (native/include/xmp/machines.hpp and
// parameters.hpp) against the TypeScript (machines.ts, parameters.ts): the
// registry, every parameter's sources and value, machine parameters,
// instantiate, smoothing, and random setParameter and clearParameterSource
// edits, on random projects that include an SDK-style machine. Everything is
// identical except smoothing, where the C library's exp may differ from
// JavaScript's in the last bit.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

// An SDK-style machine (its state check is JavaScript, as for real SDK machines).
const sdkMachine: MachineDefinition = {
  id: "community.test-synth",
  name: "Test synth",
  base: "audio",
  version: 2,
  automation: true,
  capabilities: ["notes", "audio-output"],
  parameters: [
    { id: "drive", name: "Drive", unit: "amount", min: 0, max: 10, defaultValue: 2 },
    { id: "steps", name: "Steps", unit: "steps", min: 0, max: 8, defaultValue: 4, step: 2 },
  ],
  defaults: { drive: 2, steps: 4 },
  validate: () => {},
};
machines.register(sdkMachine);

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-parameters-")),
    binary = join(dir, "parameters");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/parameters_tool.cpp"),
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

type Expected =
  | { ok: true; text: string; approximate?: boolean }
  | { ok: false; message: string; own: boolean };
function attempt(f: () => unknown, approximate = false): Expected {
  try {
    const v = f();
    return { ok: true, text: JSON.stringify(v === undefined ? null : v), approximate };
  } catch (error) {
    return { ok: false, message: (error as Error).message, own: !(error instanceof z.ZodError) };
  }
}

// Some tracks get the SDK machine; the project stays valid.
function withSdk(p: Project, r: () => number): Project {
  const next = structuredClone(p);
  for (const t of next.tracks.slice(4))
    if (r() < 0.5)
      t.machine = {
        id: sdkMachine.id,
        base: "audio",
        version: 2,
        state: r() < 0.5 ? { drive: Math.round(r() * 100) / 10, steps: 6 } : {},
      };
  return ProjectSchema.parse(next);
}

describe.skipIf(!haveCompiler)("the C++ machines and parameters match the TypeScript", () => {
  const run = driver();
  it("on random projects and edits", () => {
    const counts: Record<string, { ok: number; error: number }> = {};
    let own = 0,
      checked = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 104729),
        pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
      let project = withSdk(richProject(r), r);
      const commands: unknown[] = [
          { op: "machine", args: [{ ...sdkMachine, validate: undefined }] },
          { op: "set", project },
        ],
        expected: Expected[] = [
          { ok: true, text: "null" },
          { ok: true, text: JSON.stringify(project) },
        ],
        names: string[] = ["machine", "set"];
      const add = (op: string, args: unknown[], f: () => unknown, approximate = false) => {
        commands.push({ op, args });
        expected.push(attempt(f, approximate));
        names.push(op);
      };
      for (let round = 0; round < 12; round++) {
        const p = project,
          ids = parameterRegistry(p).map((d) => d.id),
          someId = () =>
            r() < 0.9
              ? pick(ids)
              : pick(["track.nowhere.gain", "master.gain", "return.0.insert.x.wet", "bogus"]);
        add("registry", [], () => parameterRegistry(p));
        for (const id of ids.filter(() => r() < 0.4).concat(["track.nowhere.gain", "bogus"])) {
          add("sources", [id], () => parameterSources(p, id));
          add("value", [id], () => parameterValue(p, id));
          add("machineParameter", [id], () => {
            const m = machineParameter(p, id);
            return m ? [p.tracks.indexOf(m.track), m.parameter.id] : null;
          });
        }
        const inst = pick(["xmp.sampler", "xmp.subtractive", "xmp.midi", sdkMachine.id, "nope"]);
        add("instantiate", [inst], () => machines.instantiate(inst));
        const s = [
          pick([0, 0.5, 1, -0.1, 1.2]),
          pick([0, 0.3, 1]),
          pick([48000, 44100, 7999, 192001]),
          pick([0, 10, 50]),
          pick([0, 1, 128, 480, 2100001, 1.5]),
        ];
        add(
          "smooth",
          s,
          () => smoothParameter(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0, s[4] ?? 0),
          true,
        );
        const adv = [
          someId(),
          pick([0, 0.25, 1, 2]),
          pick([0, 64, 4800]),
          pick([48000, 44100]),
        ] as const;
        add("advance", [...adv], () => advanceParameter(p, adv[0], adv[1], adv[2], adv[3]), true);
        // An edit, applied to both.
        const edit =
          r() < 0.7
            ? {
                op: "setParameter",
                args: [
                  // Often a machine parameter: the discrete ones (channel, steps) snap to their step.
                  r() < 0.4 && ids.some((id) => id.includes(".machine."))
                    ? pick(ids.filter((id) => id.includes(".machine.")))
                    : someId(),
                  pick([0, 0.2, 0.5, 0.77, 1, -0.5, 1.5, Number.NaN]),
                  pick(["base", "base", "automation", "stepLock", "macro", "lfo", "volume"]),
                ],
              }
            : {
                op: "clearParameterSource",
                args: [someId(), pick(["automation", "stepLock", "macro", "lfo", "base"])],
              };
        const [id, a1, a2] = edit.args as [string, never, never];
        commands.push(edit);
        names.push(edit.op);
        try {
          project =
            edit.op === "setParameter"
              ? setParameter(project, id, a1, a2)
              : clearParameterSource(project, id, a1);
          expected.push({ ok: true, text: JSON.stringify(project) });
        } catch (error) {
          expected.push({
            ok: false,
            message: (error as Error).message,
            own: !(error instanceof z.ZodError),
          });
        }
      }
      const got = run(commands);
      expected.forEach((e, i) => {
        const cpp = got[i] ?? "",
          nl = cpp.indexOf("\n"),
          head = cpp.slice(0, nl),
          body = cpp.slice(nl + 1),
          op = names[i] ?? "?";
        const context = `seed ${seed}, command ${i} ${op} ${String(JSON.stringify(commands[i])).slice(0, 300)}`;
        counts[op] ??= { ok: 0, error: 0 };
        const c = counts[op] as { ok: number; error: number };
        if (e.ok) {
          expect(head, `${context}\nC++: ${body.slice(0, 300)}`).toBe("ok");
          if (e.approximate)
            expect(Math.abs(Number(body) - Number(e.text)), context).toBeLessThan(1e-12);
          else expect(body, context).toBe(e.text);
          c.ok++;
        } else {
          expect(head, `${context}\nTypeScript: ${e.message.slice(0, 300)}`).toBe("error");
          if (e.own) {
            expect(body, context).toBe(e.message);
            own++;
          }
          c.error++;
        }
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(5000);
    expect(own).toBeGreaterThan(200);
    for (const op of [
      "sources",
      "value",
      "instantiate",
      "smooth",
      "advance",
      "setParameter",
      "clearParameterSource",
    ]) {
      expect(counts[op]?.ok, `${op} succeeded`).toBeGreaterThan(0);
      expect(counts[op]?.error, `${op} failed`).toBeGreaterThan(0);
    }
  }, 600000);
});
