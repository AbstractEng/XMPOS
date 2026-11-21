import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeMidi,
  encodeMidi,
  exchangePlan,
  importMidiClip,
  loadCore,
} from "../../packages/core/src/edits.ts";
import { encodeWav } from "../../packages/core/src/index.ts";
import { decodeSampleWav } from "../../packages/core/src/recording.ts";
import { wavBytes } from "../media-fixtures.ts";
import { performedProject, richProject, rng } from "../project-fixtures.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

// XMP's C++ file formats (native/include/xmp/files.hpp) against the
// TypeScript: WAV encoding and decoding in every supported format (and
// corrupted ones), MIDI files encoded from export plans and decoded back (and
// with random byte damage), the export plans themselves, and MIDI clip import.
// Bytes, documents, projects and messages must be identical.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-files-")),
    binary = join(dir, "files");
  execFileSync("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/files_tool.cpp"),
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
type Answer = { ok: true; text: string } | { ok: false; message: string };
const attempt = (f: () => unknown): Answer => {
  try {
    const v = f();
    return { ok: true, text: JSON.stringify(v instanceof Uint8Array ? [...v] : v) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};

// A WAV file in any supported layout, with optional extra chunks and damage.
describe.skipIf(!haveCompiler)("the C++ file formats match the TypeScript", () => {
  const run = driver();
  const compare = (commands: unknown[], expected: Answer[]) => {
    const got = run(commands);
    let ok = 0,
      failed = 0;
    expected.forEach((e, i) => {
      const cpp = got[i] ?? "",
        nl = cpp.indexOf("\n"),
        head = cpp.slice(0, nl),
        body = cpp.slice(nl + 1),
        context = `command ${i} ${(commands[i] as { op: string }).op}`;
      if (e.ok) {
        expect(head, `${context}\nC++: ${body.slice(0, 300)}`).toBe("ok");
        expect(body, context).toBe(e.text);
        ok++;
      } else {
        expect(head, `${context}\nTypeScript: ${e.message}`).toBe("error");
        if (!e.message.startsWith("[")) expect(body, context).toBe(e.message);
        failed++;
      }
    });
    return { ok, failed };
  };

  it("encodes and decodes WAV", () => {
    const r = rng(11),
      commands: unknown[] = [],
      expected: Answer[] = [];
    for (let i = 0; i < 400; i++) {
      const channels = Array.from({ length: [1, 2, 2, 3, 0][Math.floor(r() * 5)] ?? 1 }, () =>
        Float32Array.from({ length: Math.floor(r() * 64) }, () => Math.fround(r() * 2.4 - 1.2)),
      );
      if (r() < 0.05 && channels[1]) channels[1] = channels[1].subarray(1);
      const rate = r() < 0.5 ? 48000 : 44100;
      commands.push({ op: "encodeWav", args: [channels.map((c) => [...c]), rate] });
      expected.push(attempt(() => new Uint8Array(encodeWav(channels, rate))));
      const bytes = wavBytes(r);
      commands.push({ op: "decodeWav", args: [[...bytes]] });
      expected.push(
        attempt(() => {
          const d = decodeSampleWav(bytes);
          return { pcm: [...d.pcm], sampleRate: d.sampleRate };
        }),
      );
    }
    const { ok, failed } = compare(commands, expected);
    // Many random layouts are deliberately invalid (8-bit, three channels, low rates, damage).
    expect(ok).toBeGreaterThan(150);
    expect(failed).toBeGreaterThan(150);
  });

  it("decodes hand-made MIDI files", () => {
    // SMF 0 and 1 the encoder never writes: no tempo (120 BPM is assumed),
    // running status, note-on with velocity 0 as note-off, ignored events.
    const chunk = (id: string, body: number[]) => [
      ...Array.from(id, (c) => c.charCodeAt(0)),
      ...[24, 16, 8, 0].map((sh) => (body.length >> sh) & 255),
      ...body,
    ];
    const header = (format: number, tracks: number, ppq: number) =>
      chunk("MThd", [0, format, 0, tracks, ppq >> 8, ppq & 255]);
    const end = [0, 0xff, 0x2f, 0];
    const files = [
      // Format 0, no tempo, running status and a velocity-0 note-off.
      [
        ...header(0, 1, 96),
        ...chunk("MTrk", [0, 0x90, 60, 100, 48, 60, 0, 0, 64, 90, 24, 0x80, 64, 0, ...end]),
      ],
      // Format 1 with a tempo, a program change and a controller (ignored).
      [
        ...header(1, 2, 480),
        ...chunk("MTrk", [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, ...end]),
        ...chunk("MTrk", [
          0,
          0xc1,
          5,
          0,
          0xb1,
          7,
          100,
          0,
          0x91,
          36,
          127,
          120,
          0x81,
          36,
          64,
          ...end,
        ]),
      ],
      // Two tempos at once: the same is kept once; different ones conflict.
      [
        ...header(1, 1, 96),
        ...chunk("MTrk", [
          0,
          0xff,
          0x51,
          3,
          7,
          0xa1,
          0x20,
          0,
          0xff,
          0x51,
          3,
          7,
          0xa1,
          0x20,
          0,
          0x90,
          60,
          1,
          96,
          0x80,
          60,
          0,
          ...end,
        ]),
      ],
      [
        ...header(1, 1, 96),
        ...chunk("MTrk", [0, 0xff, 0x51, 3, 7, 0xa1, 0x20, 0, 0xff, 0x51, 3, 9, 0, 0, ...end]),
      ],
      // A text meta event, a held note, a missing end, trailing bytes, SysEx.
      [
        ...header(0, 1, 96),
        ...chunk("MTrk", [0, 0xff, 1, 2, 65, 66, 0, 0x90, 60, 1, 10, 0x80, 60, 0, ...end]),
      ],
      [...header(0, 1, 96), ...chunk("MTrk", [0, 0x90, 60, 1, ...end])],
      [...header(0, 1, 96), ...chunk("MTrk", [0, 0x90, 60, 1, 10, 0x80, 60, 0])],
      [...header(0, 1, 96), ...chunk("MTrk", end), 0],
      [...header(0, 1, 96), ...chunk("MTrk", [0, 0xf0, 1, 0xf7, ...end])],
      [...header(2, 1, 96), ...chunk("MTrk", end)],
    ];
    const commands: unknown[] = [],
      expected: Answer[] = [];
    for (const f of files) {
      commands.push({ op: "decodeMidi", args: [f] });
      expected.push(attempt(() => decodeMidi(Uint8Array.from(f))));
    }
    const { ok, failed } = compare(commands, expected);
    expect(ok).toBeGreaterThanOrEqual(4);
    expect(failed).toBeGreaterThanOrEqual(5);
  });

  it("plans, encodes, decodes and imports MIDI", () => {
    const commands: unknown[] = [],
      expected: Answer[] = [];
    let plans = 0;
    for (let seed = 1; seed <= 18; seed++) {
      const r = rng(seed * 7477),
        project = seed % 3 === 0 ? richProject(r) : performedProject(seed);
      for (const mode of ["scene", "song"] as const) {
        const scene = project.scenes[Math.floor(r() * project.scenes.length)]?.id ?? "";
        commands.push({ op: "exchangePlan", args: [project, mode, scene] });
        const plan = attempt(() => exchangePlan(project, mode, scene));
        expected.push(plan);
        if (!plan.ok) continue;
        plans++;
        const { document } = JSON.parse(plan.text) as {
          document: Parameters<typeof encodeMidi>[0];
        };
        commands.push({ op: "encodeMidi", args: [document] });
        const encoded = attempt(() => encodeMidi(document));
        expected.push(encoded);
        if (!encoded.ok) continue;
        const bytes = Uint8Array.from(JSON.parse(encoded.text) as number[]);
        commands.push({ op: "decodeMidi", args: [[...bytes]] });
        expected.push(attempt(() => decodeMidi(bytes)));
        // Damaged files.
        for (let k = 0; k < 6; k++) {
          const damaged = Uint8Array.from(bytes);
          const roll = r();
          const cut = roll < 0.3 ? damaged.subarray(0, Math.floor(r() * damaged.length)) : damaged;
          if (roll >= 0.3) cut[Math.floor(r() * cut.length)] = Math.floor(r() * 256);
          commands.push({ op: "decodeMidi", args: [[...cut]] });
          expected.push(attempt(() => decodeMidi(cut)));
        }
        // Import the file's first note track into a clip.
        const track = project.tracks[Math.floor(r() * project.tracks.length)],
          clip = track?.clips[0]?.id ?? "missing",
          fileTrack = Math.floor(r() * 3);
        commands.push({
          op: "importMidiClip",
          args: [project, [...bytes], fileTrack, track?.id ?? "", clip],
        });
        expected.push(
          attempt(() => importMidiClip(project, bytes, fileTrack, track?.id ?? "", clip)),
        );
      }
    }
    const { ok, failed } = compare(commands, expected);
    expect(plans).toBeGreaterThan(15);
    expect(ok).toBeGreaterThan(60);
    expect(failed).toBeGreaterThan(40);
  }, 300000);
});
