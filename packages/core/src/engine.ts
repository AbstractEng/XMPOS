// Loads XMP's C++ instrument engine (native/include/xmp/rack.hpp), compiled to
// WebAssembly by `npm run engine:wasm`. The module is embedded as base64 so the
// page, the audio worklet and Node all load the same bytes with no fetch, and
// it is compiled once per realm. Each rack gets its own instance and memory.
import { ENGINE_WASM_BASE64 } from "./generated/xmp-engine-wasm.ts";

export interface EngineExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  xmp_create(rate: number): number;
  xmp_scratch_index(): number;
  xmp_scratch_value(): number;
  xmp_scratch_sequence(): number;
  xmp_custom_audio(): number;
  xmp_left(): number;
  xmp_right(): number;
  xmp_meter_out(): number;
  xmp_midi(): number;
  xmp_midi_count(): number;
  xmp_midi_overflow(): number;
  xmp_midi_clear(): void;
  xmp_midi_event_size(): number;
  xmp_stage_begin(tracks: number, pads: number): void;
  xmp_stage_pad_base(track: number, base: number): number;
  xmp_stage_track(
    i: number,
    uid: number,
    kind: number,
    key: number,
    route: number,
    flags: number,
    gain: number,
    channelState: number,
    delaySend: number,
    gainIndex: number,
    effectGainIndex: number,
    channelIndex: number,
  ): number;
  xmp_stage_patch(i: number, oscillator: number): number;
  xmp_stage_pad(
    i: number,
    length: number,
    rate: number,
    mode: number,
    root: number,
    choke: number,
  ): number;
  xmp_stage_pad_take(
    i: number,
    layer: number,
    take: number,
    length: number,
    rate: number,
    upTo: number,
  ): number;
  xmp_stage_delay(present: number, seconds: number, feedback: number, wet: number): void;
  xmp_stage_base(index: number, value: number): void;
  xmp_stage_master(master: number): void;
  xmp_stage_mixer(mode: number, bpm: number): number;
  xmp_stage_strip(
    i: number,
    pan: number,
    send0: number,
    send1: number,
    panIndex: number,
    send0Index: number,
    send1Index: number,
  ): number;
  xmp_stage_tempo(step: number, bpm: number): number;
  xmp_stage_effect(
    chain: number,
    kind: number,
    bypass: number,
    bypassIndex: number,
    cutoffRaw: number,
    sync: number,
    division: number,
    sequenceLength: number,
  ): number;
  xmp_commit(): void;
  xmp_set_master_index(index: number): void;
  xmp_set_bypass_flag(index: number, bypass: number): void;
  xmp_targets_begin(): void;
  xmp_targets_add(index: number, value: number): void;
  xmp_targets_commit(): void;
  xmp_reset_parameters(): void;
  xmp_has_value(index: number): number;
  xmp_value(index: number): number;
  xmp_blocked_begin(): void;
  xmp_blocked_add(uid: number): void;
  xmp_blocked_commit(): void;
  xmp_track_blocked(index: number): number;
  xmp_note_on(
    id: number,
    pad: number,
    track: number,
    note: number,
    velocity: number,
    duration: number,
  ): number;
  xmp_note_off(id: number): void;
  xmp_release_track(uid: number): void;
  xmp_remove_track(uid: number): void;
  xmp_panic(): void;
  xmp_clear_tail(): void;
  xmp_clock(step: number, bpm: number): void;
  xmp_active(): number;
  xmp_refused(): number;
  xmp_frame(): number;
  xmp_master_gain(): number;
  xmp_set_master_gain(gain: number): void;
  xmp_has_mixer(): number;
  xmp_meter(reset: number): number;
  xmp_track_gain(index: number): number;
  xmp_advanced(): number;
  xmp_process(frames: number): void;
  xmp_voices_block(frames: number): void;
  xmp_custom_add(track: number, frames: number): void;
  xmp_finish(frames: number): void;
  xmp_frame_voices(i: number): void;
  xmp_frame_custom(track: number, value: number): void;
  xmp_frame_mix(i: number): void;
}

// Audio worklets have no atob, so decode base64 here.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const lookup = new Uint8Array(128);
  for (let i = 0; i < ALPHABET.length; i++) lookup[ALPHABET.charCodeAt(i)] = i;
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(new ArrayBuffer(Math.floor((clean.length * 3) / 4)));
  let bits = 0,
    count = 0,
    at = 0;
  for (let i = 0; i < clean.length; i++) {
    bits = (bits << 6) | (lookup[clean.charCodeAt(i)] ?? 0);
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[at++] = (bits >> count) & 255;
    }
  }
  return out;
}

let compiled: WebAssembly.Module | undefined;
export function engineModule(): WebAssembly.Module {
  compiled ??= new WebAssembly.Module(decodeBase64(ENGINE_WASM_BASE64));
  return compiled;
}

// A fresh engine instance at `rate`. The module needs only one WASI import,
// random_get, which wasi-libc's start-up asks for; it gets no entropy and no
// other host access.
export function createEngine(rate: number): EngineExports {
  const instance = new WebAssembly.Instance(engineModule(), {
    wasi_snapshot_preview1: { random_get: () => 0 },
  });
  const exports = instance.exports as unknown as EngineExports;
  exports._initialize?.();
  if (!exports.xmp_create(rate)) throw new Error("Invalid processing rate");
  return exports;
}
