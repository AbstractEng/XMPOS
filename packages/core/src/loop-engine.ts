import { decodeBase64 } from "./engine.ts";
export interface LoopCore {
  memory: WebAssembly.Memory;
  _initialize(): void;
  lp_input(): number;
  lp_left(): number;
  lp_right(): number;
  lp_queue(first: number, frames: number): number;
  lp_process(frame: number, valid: number, monitor: number, gain: number): void;
  lp_arm_threshold(): void;
  lp_stop_threshold(): void;
  lp_prepare_take(): void;
  lp_cancel(): void;
  lp_handoff(frame: number): void;
  lp_state(): number;
  lp_frames(): number;
  lp_pcm(): number;
  lp_length(): number;
}
let compiled: Promise<WebAssembly.Module> | undefined;
export function loopModule() {
  compiled ??= import("./generated/xmp-loop-wasm.ts").then(({ LOOP_WASM_BASE64 }) =>
    WebAssembly.compile(decodeBase64(LOOP_WASM_BASE64)),
  );
  return compiled;
}
