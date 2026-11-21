import { expect, it } from "vitest";
import { DEVICE_UI_WASM_BASE64 } from "../packages/core/src/generated/xmp-device-ui-wasm.ts";

interface DeviceAudio {
  memory: WebAssembly.Memory;
  _initialize(): void;
  initialize(bytes: number): number;
  button(code: number, down: number): void;
  pad(index: number, velocity: number): void;
  audio_block(frames: number): number;
  render(): number;
  panel_lights(): number;
  touch(phase: number, x: number, y: number): void;
  save_size(): number;
  save_bytes(): number;
  save_complete(ok: number): void;
  input_buffer(bytes: number): number;
  wheel(clicks: number): void;
  text_editing(): number;
  text_input(bytes: number, key: number): void;
}

async function instrument(clock = { nanoseconds: 1_000_000_000n }, song?: string) {
  let device: DeviceAudio;
  const { instance } = await WebAssembly.instantiate(Buffer.from(DEVICE_UI_WASM_BASE64, "base64"), {
    wasi_snapshot_preview1: {
      clock_time_get(_clock: number, _precision: bigint, output: number) {
        new DataView(device.memory.buffer).setBigUint64(output, clock.nanoseconds, true);
        return 0;
      },
    },
    xmp: { read_file: () => 0 },
  });
  device = instance.exports as unknown as DeviceAudio;
  device._initialize();
  const bytes = song ? new TextEncoder().encode(song) : new Uint8Array();
  if (bytes.length) {
    const address = device.input_buffer(bytes.length);
    new Uint8Array(device.memory.buffer, address, bytes.length).set(bytes);
  }
  expect(device.initialize(bytes.length)).toBe(1);
  // Open Play and strike the original built-in kick. This is a silent,
  // in-process test of the exact browser Wasm, with no audio device opened.
  device.button(0x7b, 1);
  device.pad(12, 100);
  device.pad(12, 0);
  device.button(0x7b, 0);
  device.pad(0, 100);
  return device;
}

function block(device: DeviceAudio, frames: number) {
  const address = device.audio_block(frames);
  return [
    new Float32Array(device.memory.buffer, address, frames).slice(),
    new Float32Array(device.memory.buffer, address + 512 * 4, frames).slice(),
  ] as const;
}
const peak = (channels: readonly Float32Array[]) =>
  Math.max(...channels.flatMap((channel) => [...channel].map(Math.abs)));

it("silences browser output after panic instead of replaying the previous audio block", async () => {
  const device = await instrument();
  expect(peak(block(device, 512))).toBeGreaterThan(0.001);
  device.pad(0, 0);
  device.button(0x51, 1); // STOP while stopped is panic.
  device.button(0x51, 0);
  // Panic intentionally fades voices over 5 ms to avoid a click. The rest
  // of that block, and all subsequent blocks, must be silent.
  const fading = block(device, 512);
  expect(peak(fading.map((channel) => channel.subarray(240)))).toBeLessThan(1e-8);
  for (let i = 0; i < 8; i++) expect(peak(block(device, 512))).toBeLessThan(1e-8);
});

const key = (device: DeviceAudio, code: number) => {
  device.button(code, 1);
  device.button(code, 0);
  device.render();
};
const pad = (device: DeviceAudio, index: number) => {
  device.pad(index, 100);
  device.pad(index, 0);
  device.render();
};
const menu = (device: DeviceAudio, index: number) => {
  device.button(0x7b, 1);
  pad(device, index);
  device.button(0x7b, 0);
  device.render();
};
function drumLoop(device: DeviceAudio) {
  device.pad(0, 0);
  key(device, 0x28);
  key(device, 0x6f);
  pad(device, 12);
  key(device, 0x53);
  for (let i = 0; i < 16; i++) {
    device.render();
    block(device, 512);
  }
}
function savedSong(device: DeviceAudio) {
  menu(device, 4);
  pad(device, 14);
  const bytes = new Uint8Array(device.memory.buffer, device.save_bytes(), device.save_size());
  const result = new TextDecoder().decode(bytes);
  device.save_complete(1);
  return result;
}
const savedProject = (device: DeviceAudio) => JSON.parse(savedSong(device)).project;

it("the shipped browser UI changes a second track to a pitched synth while the drum loop keeps running", async () => {
  const a = await instrument(),
    b = await instrument();
  for (const device of [a, b]) {
    drumLoop(device);
    key(device, 0x24);
    menu(device, 15);
    pad(device, 14);
    menu(device, 12);
  }
  a.pad(0, 100);
  b.pad(1, 100);
  let difference = 0;
  for (let i = 0; i < 8; i++) {
    const left = block(a, 512)[0],
      right = block(b, 512)[0];
    for (let j = 0; j < left.length; j++) difference += Math.abs((left[j] ?? 0) - (right[j] ?? 0));
  }
  expect(difference).toBeGreaterThan(1);
  key(a, 0x51);
  key(b, 0x51);
});

it("the browser TAP button measures quarter-note timing and saves the new tempo", async () => {
  const clock = { nanoseconds: 1_000_000_000n };
  const device = await instrument(clock);
  drumLoop(device);
  for (let i = 0; i < 5; i++) {
    clock.nanoseconds += 400_000_000n;
    key(device, 0x35);
  }
  key(device, 0x51);
  expect(savedProject(device).bpm).toBe(150);
});

it("the browser clip length keypad saves and reopens a partial final bar", async () => {
  const device = await instrument();
  device.pad(0, 0);
  key(device, 0x28);
  key(device, 0x6f);
  device.touch(0, 344, 678);
  device.touch(2, 344, 678); // Clip length
  pad(device, 14);
  pad(device, 10);
  pad(device, 2); // 3, 7, Apply
  const song = savedSong(device);
  const reopened = await instrument(undefined, song);
  expect(savedProject(reopened).tracks[0].clips[0].length).toBe(37);
});

it("edits step 128 from the hardware pad grid and retains it through a portable reopen", async () => {
  const device = await instrument();
  device.pad(0, 0);
  key(device, 0x28);
  key(device, 0x6f);
  device.touch(0, 344, 678);
  device.touch(2, 344, 678);
  pad(device, 12);
  pad(device, 13);
  pad(device, 11);
  pad(device, 2); // 128, Apply
  device.wheel(7);
  device.render();
  pad(device, 3); // last pad of bar eight
  const reopened = await instrument(undefined, savedSong(device));
  const clip = savedProject(reopened).tracks[0].clips[0];
  expect(clip.length).toBe(128);
  expect(clip.steps.some((step: { step: number }) => step.step === 127)).toBe(true);
});

it("renders the same signal across full and short browser output blocks", async () => {
  const full = await instrument();
  const short = await instrument();
  for (let iteration = 0; iteration < 4; iteration++) {
    const expected = block(full, 512);
    const actual = [new Float32Array(512), new Float32Array(512)];
    for (let part = 0; part < 4; part++) {
      const rendered = block(short, 128);
      for (const channel of [0, 1] as const) actual[channel]?.set(rendered[channel], part * 128);
    }
    for (const channel of [0, 1] as const)
      for (let frame = 0; frame < 512; frame++)
        expect(actual[channel]?.[frame]).toBeCloseTo(expected[channel][frame] ?? 0, 6);
  }
});

function feedback(device: DeviceAudio) {
  const address = device.panel_lights();
  return new Uint8Array(device.memory.buffer, address, 65).slice();
}
it("the browser emulator displays native transport, overdub and flashing upper-bank lights", async () => {
  const clock = { nanoseconds: 1_000_000_000n };
  const device = await instrument(clock);
  expect(feedback(device)[0]).toBe(3);
  expect(feedback(device)[11]).toBe(0);
  drumLoop(device);
  expect(feedback(device)[11]).toBe(3);
  key(device, 0x50);
  expect(feedback(device)[9]).toBe(3);
  expect(feedback(device)[8]).toBe(0);
  key(device, 0x51);
  expect(feedback(device)[11]).toBe(0);
  expect(feedback(device)[9]).toBe(0);
  device.button(0x31, 1);
  key(device, 0x24);
  device.button(0x31, 0);
  expect(feedback(device)[1]).toBe(3);
  clock.nanoseconds += 300_000_000n;
  expect(feedback(device)[1]).toBe(0);
});
it("the browser emulator preserves velocity hue and maps the playing step to the physical pad grid", async () => {
  const clock = { nanoseconds: 1_000_000_000n };
  const device = await instrument(clock);
  device.pad(0, 0);
  device.pad(0, 20);
  const soft = feedback(device).slice(17, 20);
  device.pad(0, 0);
  device.pad(0, 127);
  const hard = feedback(device).slice(17, 20);
  expect(soft[2]).toBeGreaterThan(soft[0] ?? 0);
  expect(hard[0]).toBeGreaterThan(hard[2] ?? 0);
  device.pad(0, 0);
  clock.nanoseconds += 1_000_000_000n;
  expect([...feedback(device).slice(17, 20)]).toEqual([0, 0, 0]);
  drumLoop(device);
  expect([...feedback(device).slice(17 + 12 * 3, 20 + 12 * 3)]).toEqual([96, 127, 112]);
  key(device, 0x51);
  expect([...feedback(device).slice(17)]).toEqual(Array(48).fill(0));
});

it("browser naming uses the shared native keyboard actions and saves the edited name", async () => {
  const device = await instrument();
  device.pad(0, 0);
  device.touch(0, 230, 18);
  device.touch(2, 230, 18);
  expect(device.text_editing()).toBe(1);
  device.text_input(0, 1);
  const text = new TextEncoder().encode("House keyboard");
  const at = device.input_buffer(text.length);
  new Uint8Array(device.memory.buffer, at, text.length).set(text);
  device.text_input(text.length, 0);
  device.text_input(0, 3);
  expect(device.text_editing()).toBe(0);
  expect(savedProject(device).name).toBe("House keyboard");
});
