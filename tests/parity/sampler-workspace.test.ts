import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { expandSong } from "../../packages/core/src/edits.ts";
import { DEVICE_UI_WASM_BASE64 } from "../../packages/core/src/generated/xmp-device-ui-wasm.ts";
import { createDemoProject } from "../../packages/core/src/index.ts";
import { openProject, saveSong } from "../../packages/core/src/project-io.ts";

it.each([false, true])(
  "keeps audio levels and project state identical across native/browser loop handoff (delete=%s)",
  async (remove) => {
    const dir = mkdtempSync(join(tmpdir(), "xmp-sampler-parity-"));
    try {
      const p = expandSong(createDemoProject());
      p.bpm = 300;
      p.swing = 0;
      p.samples = [{ id: "signal", name: "Original", sampleRate: 48000, pcm: [0.25, -0.125, 0] }];
      for (const pad of p.pads) {
        pad.sampleId = "signal";
        delete pad.slice;
      }
      const fixture = await saveSong(p);
      writeFileSync(join(dir, "input.xmpsong"), fixture);
      const bin = join(dir, "native");
      execFileSync(
        "c++",
        [
          "-std=c++17",
          "-O0",
          "-I",
          resolve("native/include"),
          "-I",
          resolve("build/fonts"),
          "native/tests/live_sampling_workflow_test.cpp",
          "-o",
          bin,
        ],
        { timeout: 120000 },
      );
      execFileSync(
        bin,
        [join(dir, "input.xmpsong"), join(dir, "native.xmpsong"), ...(remove ? ["--delete"] : [])],
        {
          timeout: 120000,
        },
      );
      let d: Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(Buffer.from(DEVICE_UI_WASM_BASE64, "base64")),
        {
          xmp: { read_file: () => 0 },
          wasi_snapshot_preview1: {
            clock_time_get: (_clock: number, _precision: bigint, at: number) => {
              new DataView(d.memory.buffer).setBigUint64(at, 1000000000n, true);
              return 0;
            },
          },
        },
      );
      d = instance.exports as typeof d;
      d._initialize!();
      const bytes = new TextEncoder().encode(fixture);
      const initialAddress = d.input_buffer!(bytes.length);
      new Uint8Array(d.memory.buffer, initialAddress, bytes.length).set(bytes);
      expect(d.initialize!(bytes.length)).toBe(1);
      d.input_enable!(1);
      const key = (code: number) => {
        d.button!(code, 1);
        d.button!(code, 0);
        d.render!();
      };
      const pad = (p: number) => {
        d.pad!(p, 100);
        d.pad!(p, 0);
        d.render!();
      };
      const menu = (p: number) => {
        d.button!(0x7b, 1);
        pad(p);
        d.button!(0x7b, 0);
        d.render!();
      };
      menu(14);
      key(0x53);
      key(0x49);
      const pcm = new Float32Array(512).fill(0.25);
      const blocks = remove ? 450 : 900;
      const rendered = new Float32Array(blocks * 1024);
      for (let n = 0; n < blocks; ++n) {
        const address = d.input_buffer!(pcm.byteLength);
        new Float32Array(d.memory.buffer, address, 512).set(pcm);
        expect(d.input_push!(512)).toBe(1);
        d.render!();
        const output = d.audio_block!(512);
        const stereo = new Float32Array(d.memory.buffer, output, 1024);
        for (let i = 0; i < 512; ++i) {
          rendered[n * 1024 + i * 2] = stereo[i]!;
          rendered[n * 1024 + i * 2 + 1] = stereo[512 + i]!;
        }
      }
      const nativeAudio = readFileSync(join(dir, "native.xmpsong.audio"));
      expect(nativeAudio.byteLength).toBe(rendered.byteLength);
      let worst = 0;
      // The input adapters have different startup cushions; compare after both
      // are primed, including the entire first loop and its engine handoff.
      for (let i = 4096 * 2; i < rendered.length; ++i)
        worst = Math.max(worst, Math.abs(rendered[i]! - nativeAudio.readFloatLE(i * 4)));
      expect(worst).toBeLessThan(1e-6);
      if (!remove) {
        const rms = (first: number) => {
          let power = 0;
          for (let i = first * 2; i < (first + 4096) * 2; ++i) power += rendered[i]! ** 2;
          return Math.sqrt(power / 8192);
        };
        expect(rms(200192)).toBeGreaterThan(0.01);
        expect(Math.abs(rms(200192) - rms(353792))).toBeLessThan(1e-7);
      }
      if (remove) {
        menu(8);
        d.button!(0x31, 1);
        key(0x7a);
        d.button!(0x31, 0);
        d.audio_block!(512);
        d.render!();
      }
      key(0x51);
      menu(4);
      pad(14);
      const saved = new TextDecoder().decode(
        new Uint8Array(d.memory.buffer, d.save_bytes!(), d.save_size!()),
      );
      const native = readFileSync(join(dir, "native.xmpsong"), "utf8");
      expect(saved).toBe(native);
      const project = await openProject(saved);
      const track = project.tracks[0]!;
      const destination = track.pads?.[0];
      expect(project.samples.find((s) => s.id === destination?.sampleId)?.pcm).toEqual(
        Array(153600).fill(0.25),
      );
      if (remove) expect(project.scenes[0]?.clips[track.id]).toBeUndefined();
      else
        expect(track.clips.find((c) => c.id === project.scenes[0]?.clips[track.id])?.length).toBe(
          64,
        );
      expect(project.tracks.slice(1)).toEqual(p.tracks.slice(1));
      expect(project.extensions?.["xmp.sampler-input"]?.data).toEqual({
        tracks: { [track.id]: { monitor: true, bars: 4 } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  180000,
);
