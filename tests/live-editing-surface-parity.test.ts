import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { DEVICE_UI_WASM_BASE64 } from "../packages/core/src/generated/xmp-device-ui-wasm.ts";

it("renders the same bar controls and saves the same project after identical native and browser inputs", async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "xmp-live-pages-"));
  try {
    const { ensureFonts } = await import("../tools/fonts.mjs");
    await ensureFonts();
    const binary = join(temp, "native-pages");
    const fixture = join(root, "acceptance/fixtures/live-editing-pages.json");
    execFileSync(
      "c++",
      [
        "-std=c++17",
        "-O1",
        `-I${join(root, "native/include")}`,
        `-I${join(root, "build/fonts")}`,
        join(root, "native/tests/live_project_workflow_test.cpp"),
        "-o",
        binary,
      ],
      { timeout: 120000 },
    );
    execFileSync(binary, [fixture, temp], { timeout: 30000 });
    let device: {
      memory: WebAssembly.Memory;
      _initialize(): void;
      input_buffer(n: number): number;
      initialize(n: number): number;
      button(code: number, down: number): void;
      pad(index: number, velocity: number): void;
      touch(phase: number, x: number, y: number): void;
      render(): number;
      panel_lights(): number;
      menu_pending(): number;
      save_size(): number;
      save_bytes(): number;
      save_complete(ok: number): void;
      audio_block(n: number): number;
    };
    const { instance } = await WebAssembly.instantiate(
      Buffer.from(DEVICE_UI_WASM_BASE64, "base64"),
      {
        wasi_snapshot_preview1: {
          clock_time_get(_clock: number, _precision: bigint, output: number) {
            new DataView(device.memory.buffer).setBigUint64(output, 1_000_000_000n, true);
            return 0;
          },
        },
        xmp: { read_file: () => 0 },
      },
    );
    device = instance.exports as typeof device;
    device._initialize();
    const bytes = readFileSync(join(temp, "initial.xmpsong"));
    const address = device.input_buffer(bytes.length);
    new Uint8Array(device.memory.buffer, address, bytes.length).set(bytes);
    expect(device.initialize(bytes.length)).toBe(1);
    let menu = false,
      saved = "";
    type Event =
      | ["menu"]
      | ["pad", number]
      | ["touch", number, number]
      | ["image", string]
      | ["saved-clip", number, number]
      | ["saved", string, string];
    const events = JSON.parse(readFileSync(fixture, "utf8")) as Event[];
    for (const [kind, a, b] of events) {
      if (kind === "menu") {
        menu = true;
        device.button(0x7b, 1);
      } else if (kind === "pad") {
        device.pad(a - 1, 100);
        device.pad(a - 1, 0);
      } else if (kind === "touch") {
        device.touch(0, a, b);
        device.touch(2, a, b);
      } else if (kind === "image") {
        // Force a paint without changing the project or the final modifier state.
        device.button(0x31, 1);
        device.button(0x31, 0);
        const pixels = device.render();
        const feedbackAddress = device.panel_lights();
        const feedback = Buffer.from(new Uint8Array(device.memory.buffer, feedbackAddress, 65));
        expect(feedback).toEqual(readFileSync(join(temp, `${a}.leds`)));
        const rgba = new Uint8Array(device.memory.buffer, pixels, 1280 * 800 * 4);
        const native = readFileSync(join(temp, `${a}.ppm`));
        const offset = native.indexOf(Buffer.from("\n255\n")) + 5;
        // Storage status/header and toast are platform presentation. The actual
        // screen controls, pad grid, bar selectors and Q-Link strip must match.
        const browserPixels = Buffer.alloc(1280 * 624 * 3);
        let next = 0;
        for (let y = 80; y < 704; y++)
          for (let x = 0; x < 1280; x++) {
            const index = (y * 1280 + x) * 4;
            browserPixels[next++] = rgba[index] ?? 0;
            browserPixels[next++] = rgba[index + 1] ?? 0;
            browserPixels[next++] = rgba[index + 2] ?? 0;
          }
        expect(
          browserPixels.equals(native.subarray(offset + 80 * 1280 * 3, offset + 704 * 1280 * 3)),
          String(a),
        ).toBe(true);
      }
      device.render();
      if (menu && !device.menu_pending()) {
        device.button(0x7b, 0);
        menu = false;
      }
      if (device.save_size()) {
        saved = new TextDecoder().decode(
          new Uint8Array(device.memory.buffer, device.save_bytes(), device.save_size()),
        );
        device.save_complete(1);
      }
      device.audio_block(512);
    }
    const native = JSON.parse(readFileSync(join(temp, "project.xmpsong"), "utf8"));
    expect(JSON.parse(saved)).toEqual(native);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 120000);
