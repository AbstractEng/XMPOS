// Capture only. The shared C++ workspace owns monitoring, timing and takes.
declare const AudioWorkletProcessor: { new (): { port: MessagePort } };
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
class DeviceInput extends AudioWorkletProcessor {
  private buffers = Array.from({ length: 8 }, () => new Float32Array(512));
  private current: Float32Array | undefined = this.buffers.pop();
  private offset = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<Float32Array<ArrayBuffer>>) => {
      if (data instanceof Float32Array && data.length === 512) this.buffers.push(data);
    };
  }
  process(inputs: Float32Array[][]) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const frames = channels[0]?.length ?? 0;
    for (let i = 0; i < frames; ++i) {
      this.current ??= this.buffers.pop();
      if (!this.current) continue;
      let value = 0;
      for (const channel of channels) value += channel[i] ?? 0;
      this.current[this.offset++] = Math.max(-1, Math.min(1, value));
      if (this.offset === 512) {
        this.port.postMessage(this.current, [this.current.buffer]);
        this.current = undefined;
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("xmp-device-input", DeviceInput);

export {};
