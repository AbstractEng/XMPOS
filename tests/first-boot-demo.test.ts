import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DEVICE_UI_WASM_BASE64 } from "../packages/core/src/generated/xmp-device-ui-wasm.ts";
import { openProject } from "../packages/core/src/project-io.ts";

it("the bundled first-start project opens in the shared Device and a single PLAY produces music", async () => {
  const bytes = readFileSync("tools/live-mk1/installer/demo/acid-circuit.xmpsong");
  const project = await openProject(bytes.toString());
  expect(project.name).toBe("Acid Circuit");
  expect(project.bpm).toBe(128);
  expect(project.tracks.filter((track) => track.clips.length)).toHaveLength(4);
  expect(project.performance?.chain.map((block) => block.repeats)).toEqual([2, 4, 2, 8, 4, 2]);
  expect(project.performance?.end).toBe("stop");
  let device: Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };
  const { instance } = await WebAssembly.instantiate(Buffer.from(DEVICE_UI_WASM_BASE64, "base64"), {
    wasi_snapshot_preview1: {
      clock_time_get: (_clock: number, _precision: bigint, address: number) => {
        new DataView(device.memory.buffer).setBigUint64(address, 1_000_000_000n, true);
        return 0;
      },
    },
    xmp: { read_file: () => 0 },
  });
  device = instance.exports as unknown as typeof device;
  device._initialize!();
  const input = device.input_buffer!(bytes.length);
  new Uint8Array(device.memory.buffer, input, bytes.length).set(bytes);
  expect(device.initialize!(bytes.length)).toBe(1);
  const silent = device.audio_block!(512);
  expect(new Float32Array(device.memory.buffer, silent, 512).every((value) => value === 0)).toBe(
    true,
  );
  // No page selection, clip launch or pad strike is needed at startup.
  device.button!(0x52, 1);
  device.button!(0x52, 0);
  expect(new Uint8Array(device.memory.buffer, device.panel_lights!(), 17)[11]).toBe(3);
  let peak = 0;
  let energy = 0;
  let finite = true;
  const blocks = Math.ceil((42 * 48000) / 512);
  for (let block = 0; block < blocks; block++) {
    const address = device.audio_block!(512);
    for (const value of new Float32Array(device.memory.buffer, address, 512)) {
      finite &&= Number.isFinite(value);
      peak = Math.max(peak, Math.abs(value));
      energy += value * value;
    }
  }
  expect(finite).toBe(true);
  expect(peak).toBeGreaterThan(0.01);
  expect(Math.sqrt(energy / (blocks * 512))).toBeGreaterThan(0.001);
  // The full 22-bar song finishes; a scene loop would still be playing.
  expect(new Uint8Array(device.memory.buffer, device.panel_lights!(), 17)[11]).toBe(0);
}, 60_000);
