import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { DEVICE_UI_WASM_BASE64 } from "../../packages/core/src/generated/xmp-device-ui-wasm.ts";

it("replays naming, pad entry and effect knobs in native and Wasm with identical controls, pixels and saved project", () => {
  const dir = mkdtempSync(join(tmpdir(), "xmp-house-parity-"));
  try {
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
        "native/tests/live_project_workflow_test.cpp",
        "-o",
        bin,
      ],
      { timeout: 120000 },
    );
    const fixture = "acceptance/fixtures/house-workflow-pages.json";
    execFileSync(bin, [fixture, dir]);
    let device: Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };
    const module = new WebAssembly.Module(Buffer.from(DEVICE_UI_WASM_BASE64, "base64"));
    const instance = new WebAssembly.Instance(module, {
      xmp: { read_file: () => 0 },
      wasi_snapshot_preview1: {
        clock_time_get: (_clock: number, _precision: bigint, at: number) => {
          new DataView(device.memory.buffer).setBigUint64(at, 1000000000n, true);
          return 0;
        },
      },
    });
    device = instance.exports as unknown as typeof device;
    device._initialize!();
    const initial = readFileSync(join(dir, "initial.xmpsong"));
    let address = device.input_buffer!(initial.length);
    new Uint8Array(device.memory.buffer, address, initial.length).set(initial);
    expect(device.initialize!(initial.length)).toBe(1);
    let menu = false;
    let saved = "";
    let lastPixels = 0;
    const steps = JSON.parse(readFileSync(fixture, "utf8")) as [string, ...(string | number)[]][];
    for (const [kind, a, b] of steps) {
      if (kind === "menu") {
        menu = true;
        device.button!(0x7b, 1);
      }
      if (kind === "pad") {
        device.pad!(Number(a) - 1, 100);
        device.pad!(Number(a) - 1, 0);
      }
      if (kind === "key") {
        device.button!(Number(a), 1);
        device.button!(Number(a), 0);
      }
      if (kind === "knob") device.knob!(Number(a), Number(b));
      if (kind === "touch") {
        device.touch!(0, Number(a), Number(b));
        device.touch!(2, Number(a), Number(b));
      }
      if (kind === "text") {
        const bytes = new TextEncoder().encode(String(a));
        address = device.input_buffer!(bytes.length);
        new Uint8Array(device.memory.buffer, address, bytes.length).set(bytes);
        device.text_input!(bytes.length, Number(b));
      }
      if (menu && !device.menu_pending!()) {
        device.button!(0x7b, 0);
        menu = false;
      }
      // Each shared action advances the same silent software audio block.
      device.audio_block!(512);
      if (kind === "image") {
        lastPixels = device.render!() || lastPixels;
        const native = readFileSync(join(dir, `${a}.ppm`));
        const start = native.indexOf(Buffer.from("255\n")) + 4;
        const wasm = new Uint8Array(device.memory.buffer, lastPixels, 1280 * 800 * 4);
        const actual = Buffer.alloc(1140 * 670 * 3),
          expected = Buffer.alloc(actual.length);
        for (let y = 72, j = 0; y < 742; y++)
          for (let x = 0; x < 1140; x++)
            for (let ch = 0; ch < 3; ch++, j++) {
              actual[j] = wasm[(y * 1280 + x) * 4 + ch]!;
              expected[j] = native[start + (y * 1280 + x) * 3 + ch]!;
            }
        expect(actual.equals(expected), `${a}: identical native/Wasm screen`).toBe(true);
      }
      if (device.save_size!()) {
        saved = new TextDecoder().decode(
          new Uint8Array(device.memory.buffer, device.save_bytes!(), device.save_size!()),
        );
        device.save_complete!(1);
      }
    }
    expect(JSON.parse(saved).project).toEqual(
      JSON.parse(readFileSync(join(dir, "project.xmpsong"), "utf8")).project,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 150000);
