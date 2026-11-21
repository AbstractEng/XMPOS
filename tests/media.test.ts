import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as wasm from "../packages/core/src/edits.ts";
import { encodeWav, type Project } from "../packages/core/src/index.ts";
import { decodeSampleWav } from "../packages/core/src/recording.ts";
import { GoldenLog } from "./golden.ts";
import { wavBytes } from "./media-fixtures.ts";
import { performedProject, richProject, rng } from "./project-fixtures.ts";

// The browser's files and renders through the C++ core in WebAssembly
// (packages/core/src/edits.ts) against the TypeScript: WAV and MIDI files
// read and written byte for byte, export plans, MIDI clip import, and
// scenes and songs rendered to the same audio.
type Outcome = { ok: true; value: unknown } | { ok: false; message: string };
const attempt = (f: () => unknown): Outcome => {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};
const plain = (v: unknown): unknown =>
  v instanceof Float32Array || v instanceof Uint8Array
    ? Array.from(v)
    : v instanceof ArrayBuffer
      ? Array.from(new Uint8Array(v))
      : v;
// The core's results, fingerprinted (tests/golden.ts): recorded while they
// matched the TypeScript renderer and file code, which phase 9 retired.
let golden: GoldenLog | undefined;
beforeEach(() => {
  golden = new GoldenLog(`media/${expect.getState().currentTestName ?? ""}`);
});
afterEach(() => {
  if (golden?.count) golden.check();
});
function log(b: Outcome) {
  golden?.add(b.ok ? JSON.stringify(b.value, (_k, v) => plain(v)) : `error ${b.message}`);
  return b;
}
function same(a: Outcome, b: Outcome, context: string) {
  golden?.add(b.ok ? JSON.stringify(b.value, (_k, v) => plain(v)) : `error ${b.message}`);
  expect(b.ok, `${context}\n${a.ok ? "" : a.message}\n${b.ok ? "" : b.message}`).toBe(a.ok);
  if (a.ok && b.ok)
    expect(
      JSON.stringify(b.value, (_k, v) => plain(v)),
      context,
    ).toBe(JSON.stringify(a.value, (_k, v) => plain(v)));
  else if (!a.ok && !b.ok && !a.message.startsWith("[")) expect(b.message, context).toBe(a.message);
}

describe("files and renders through the C++ core (WebAssembly)", () => {
  it("read and write WAV files as the TypeScript does", () => {
    const r = rng(11);
    let read = 0;
    for (let i = 0; i < 300; i++) {
      const bytes = wavBytes(r);
      const a = attempt(() => decodeSampleWav(bytes)),
        b = attempt(() => wasm.decodeSampleWav(bytes));
      same(a, b, `wav ${i}`);
      if (a.ok) read++;
    }
    expect(read).toBeGreaterThan(40);
    for (let i = 0; i < 40; i++) {
      const frames = [0, 1, 50, 300][i % 4] as number,
        count = [1, 2, 3][i % 3] as number;
      const channels = Array.from({ length: count }, () =>
        Float32Array.from({ length: frames }, () => r() * 2.4 - 1.2),
      );
      const rate = [48000, 44100, 1000][i % 3] as number;
      same(
        attempt(() => encodeWav(channels, rate)),
        attempt(() => wasm.encodeWav(channels, rate)),
        `encode ${i}`,
      );
    }
  });

  it("accepts long loop WAVs and refuses takes beyond the bounded 32-second profile", () => {
    const wav = encodeWav([new Float32Array(576000)], 48000);
    expect(decodeSampleWav(new Uint8Array(wav)).pcm.length).toBe(576000);
    expect(wasm.decodeSampleWav(new Uint8Array(wav)).pcm.length).toBe(576000);
    const tooLong = encodeWav([new Float32Array(1536001)], 48000);
    expect(() => decodeSampleWav(new Uint8Array(tooLong))).toThrow(/32 seconds/);
    expect(() => wasm.decodeSampleWav(new Uint8Array(tooLong))).toThrow(/32 seconds/);
  });

  it("plan, write, read and import MIDI", () => {
    let plans = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed * 4241),
        project = seed % 3 === 0 ? richProject(r) : performedProject(seed);
      for (const mode of ["scene", "song"] as const) {
        const scene = project.scenes[Math.floor(r() * project.scenes.length)]?.id ?? "";
        const plan = log(attempt(() => wasm.exchangePlan(project, mode, scene)));
        if (!plan.ok) continue;
        plans++;
        const { document } = plan.value as { document: Parameters<typeof wasm.encodeMidi>[0] };
        const encoded = log(attempt(() => wasm.encodeMidi(document)));
        if (!encoded.ok) continue;
        const bytes = encoded.value as Uint8Array;
        log(attempt(() => wasm.decodeMidi(bytes)));
        for (let k = 0; k < 4; k++) {
          const cut = bytes.slice(0, Math.floor(r() * bytes.length));
          log(attempt(() => wasm.decodeMidi(cut)));
        }
        const track = project.tracks[Math.floor(r() * project.tracks.length)],
          clip = track?.clips[0]?.id ?? "missing";
        log(attempt(() => wasm.importMidiClip(project, bytes, 0, track?.id ?? "", clip)));
      }
    }
    expect(plans).toBeGreaterThan(10);
  }, 300000);

  it("render scenes and songs", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const project: Project = seed % 2 ? performedProject(seed) : richProject(rng(seed * 17));
      const scene = project.scenes[0]?.id ?? "";
      const pick = (x: {
        wav: ArrayBuffer;
        pcm: Float32Array;
        rightPcm: Float32Array;
        trace: unknown;
        transitions: unknown;
        bodySteps: number;
        midi: unknown;
        snapshot: unknown;
      }) => ({
        wav: x.wav,
        pcm: x.pcm,
        rightPcm: x.rightPcm,
        trace: x.trace,
        transitions: x.transitions,
        bodySteps: x.bodySteps,
        midi: x.midi,
        snapshot: x.snapshot,
      });
      const audible = log(
        attempt(() =>
          pick(
            wasm.renderPerformance(project, { scene, mode: "song", steps: 64, tailSeconds: 0.5 }),
          ),
        ),
      );
      expect(audible.ok).toBe(true);
      log(attempt(() => wasm.renderProjectScene(project, scene)));
      log(attempt(() => wasm.renderInstrumentScene(project, scene, 16).pcm));
      log(
        attempt(() => {
          const x = wasm.renderExchange(project, "scene", scene, 0.5);
          return { ...pick(x), midiFile: x.midiFile, document: x.document };
        }),
      );
    }
  }, 600000);
});
