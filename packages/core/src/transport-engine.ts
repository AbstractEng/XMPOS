// Loads XMP's C++ performance transport (native/include/xmp/transport.hpp),
// compiled to WebAssembly by `npm run engine:wasm`. One instance per transport.
import { decodeBase64 } from "./engine.ts";
import { TRANSPORT_WASM_BASE64 } from "./generated/xmp-transport-wasm.ts";

export interface TransportExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  tx_init(): void;
  tx_scratch(): number;
  tx_project_begin(
    tracks: number,
    scenes: number,
    loop: number,
    hasPosition: number,
    occurrence: number,
    offset: number,
    hasSelection: number,
    selectionScene: number,
  ): void;
  tx_track(i: number, uid: number, count: number, selectionClip: number): number;
  tx_scene(i: number, uid: number, length: number): number;
  tx_chain(id: number, scene: number, repeats: number): number;
  tx_project_commit(first: number): void;
  tx_launch_grid(grid: number): void;
  tx_start(scene: number, song: number, resume: number): number;
  tx_queue_scene(scene: number): void;
  tx_queue_clip_at(track: number, clip: number, at: number): number;
  tx_queue_clip(track: number, clip: number): void;
  tx_cancel(): number;
  tx_stop(): void;
  tx_advance(step: number): number;
  tx_running(): number;
  tx_song(): number;
  tx_step(): number;
  tx_song_offset(): number;
  tx_clock_origin(): number;
  tx_scene_uid(): number;
  tx_queued_scene(): number;
  tx_queued_scene_at(): number;
  tx_queued_count(): number;
  tx_queued_track(i: number): number;
  tx_queued_clip(i: number): number;
  tx_queued_at(i: number): number;
  tx_slot_count(): number;
  tx_slot_track(i: number): number;
  tx_slot_clip(i: number): number;
  tx_slot_anchor(i: number): number;
  tx_release_count(): number;
  tx_release(i: number): number;
  tx_clear_releases(): void;
  tx_has_occurrence(): number;
  tx_occurrence_id(): number;
  tx_occurrence_start(): number;
  tx_occurrence_span(): number;
}

let compiled: WebAssembly.Module | undefined;
export function createTransport(): TransportExports {
  compiled ??= new WebAssembly.Module(decodeBase64(TRANSPORT_WASM_BASE64));
  const exports = new WebAssembly.Instance(compiled, {
    wasi_snapshot_preview1: { random_get: () => 0 },
  }).exports as unknown as TransportExports;
  exports._initialize?.();
  exports.tx_init();
  return exports;
}
