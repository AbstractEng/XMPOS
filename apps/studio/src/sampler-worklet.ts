// Platform audio I/O for the same bounded C++ LoopTake used on the Live.
import type { LoopCore } from "../../../packages/core/src/loop-engine.ts";

declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;
class SamplerInput extends AudioWorkletProcessor {
  private readonly core: LoopCore;
  private input: Float32Array;
  private left: Float32Array;
  private right: Float32Array;
  private monitor = true;
  private gain = 0.125;
  constructor(options: { processorOptions: { module: WebAssembly.Module } }) {
    super();
    const instance = new WebAssembly.Instance(options.processorOptions.module, {
      wasi_snapshot_preview1: {
        clock_time_get: () => 8,
        fd_close: () => 8,
        fd_seek: () => 8,
        fd_write: () => 8,
      },
    });
    this.core = instance.exports as unknown as LoopCore;
    this.core._initialize();
    this.input = new Float32Array(this.core.memory.buffer, this.core.lp_input(), 128);
    this.left = new Float32Array(this.core.memory.buffer, this.core.lp_left(), 128);
    this.right = new Float32Array(this.core.memory.buffer, this.core.lp_right(), 128);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.op === "monitor") this.monitor = !!m.enabled;
      else if (m.op === "queue") {
        this.gain = m.gain;
        if (!this.core.lp_queue(m.first, m.frames)) this.port.postMessage({ state: 6, frames: 0 });
      } else if (m.op === "threshold") {
        this.core.lp_arm_threshold();
        this.rebind();
      } else if (m.op === "finish-take") this.core.lp_stop_threshold();
      else if (m.op === "cancel") this.core.lp_cancel();
      else if (m.op === "handoff") this.core.lp_handoff(m.frame);
      else if (m.op === "state")
        this.port.postMessage({ state: this.core.lp_state(), frames: this.core.lp_frames() });
      else if (m.op === "take" && this.core.lp_state() === 3) {
        // Copy only between process calls, in response to the main thread.
        this.core.lp_prepare_take();
        this.rebind();
        const pcm = new Float32Array(
          this.core.memory.buffer,
          this.core.lp_pcm(),
          this.core.lp_length(),
        ).slice();
        this.port.postMessage({ pcm }, [pcm.buffer]);
      }
    };
  }
  private rebind() {
    // Allocating preparation messages may grow Wasm memory; callbacks retain
    // views only after those messages have finished.
    this.input = new Float32Array(this.core.memory.buffer, this.core.lp_input(), 128);
    this.left = new Float32Array(this.core.memory.buffer, this.core.lp_left(), 128);
    this.right = new Float32Array(this.core.memory.buffer, this.core.lp_right(), 128);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const channels = inputs[0],
      output = outputs[0];
    for (let i = 0; i < 128; ++i)
      this.input[i] = Math.max(
        -1,
        Math.min(1, (channels?.[0]?.[i] ?? 0) + (channels?.[1]?.[i] ?? 0)),
      );
    this.core.lp_process(
      currentFrame,
      channels?.[0]?.length === 128 ? 1 : 0,
      this.monitor ? 1 : 0,
      this.gain,
    );
    output?.[0]?.set(this.left);
    output?.[1]?.set(this.right);
    return true;
  }
}
registerProcessor("xmp-sampler-input", SamplerInput as unknown as typeof AudioWorkletProcessor);
