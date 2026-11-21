export interface DelaySettings {
  seconds: number;
  feedback: number;
  wet: number;
  sends: Record<string, number>;
}
// Original bounded mono send/return for the performance preview, not the P08 effects graph.
export class SharedDelay {
  private ring: Float32Array;
  private cursor = 0;
  feedback: number;
  wet: number;
  readonly frames: number;
  constructor(settings: DelaySettings, rate: number) {
    if (
      !Number.isInteger(rate) ||
      rate < 8000 ||
      rate > 96000 ||
      !Number.isFinite(settings.seconds) ||
      settings.seconds <= 0 ||
      settings.seconds > 4 ||
      !Number.isFinite(settings.feedback) ||
      settings.feedback < 0 ||
      settings.feedback > 0.75 ||
      !Number.isFinite(settings.wet) ||
      settings.wet < 0 ||
      settings.wet > 1
    )
      throw new Error("Invalid preview delay");
    this.frames = Math.max(1, Math.round(settings.seconds * rate));
    this.ring = new Float32Array(this.frames);
    this.feedback = settings.feedback;
    this.wet = settings.wet;
  }
  process(input: number) {
    const value = this.ring[this.cursor] ?? 0;
    this.ring[this.cursor] = Math.max(
      -1,
      Math.min(1, (Number.isFinite(input) ? input : 0) + value * this.feedback),
    );
    this.cursor = (this.cursor + 1) % this.frames;
    return value * this.wet;
  }
  clear() {
    this.ring.fill(0);
    this.cursor = 0;
  }
}
