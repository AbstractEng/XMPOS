import { type Project, ProjectSchema } from "./index.ts";
import { MAX_SAMPLE_FRAMES } from "./input.ts";
import { installSample } from "./instruments.ts";
import { musicalSeconds } from "./mix.ts";
import { trackPads } from "./pads.ts";
export function decodeSampleWav(bytes: Uint8Array) {
  if (bytes.length < 44 || bytes.length > 16 * 1024 * 1024)
    throw new Error("WAV must be between 44 bytes and 16 MiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    text = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  if (
    text(0, 4) !== "RIFF" ||
    text(8, 4) !== "WAVE" ||
    view.getUint32(4, true) !== bytes.length - 8
  )
    throw new Error("Invalid RIFF WAV");
  let format = 0,
    channels = 0,
    rate = 0,
    bits = 0,
    align = 0,
    dataAt = 0,
    dataSize = 0,
    chunks = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    if (++chunks > 64) throw new Error("WAV chunk budget exceeded");
    const size = view.getUint32(at + 4, true),
      end = at + 8 + size;
    if (end > bytes.length) throw new Error("Truncated WAV chunk");
    if (text(at, 4) === "fmt ") {
      if (format || size < 16) throw new Error("Invalid WAV format chunk");
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      align = view.getUint16(at + 20, true);
      bits = view.getUint16(at + 22, true);
    }
    if (text(at, 4) === "data") {
      if (dataAt) throw new Error("Duplicate WAV data");
      dataAt = at + 8;
      dataSize = size;
    }
    at = end + (size % 2);
  }
  if (
    ![1, 3].includes(format) ||
    ![1, 2].includes(channels) ||
    rate < 8000 ||
    rate > 96000 ||
    ![16, 24, 32].includes(bits) ||
    (format === 3 && bits !== 32) ||
    align !== (channels * bits) / 8 ||
    !dataAt ||
    !dataSize ||
    dataSize % align
  )
    throw new Error("Use mono/stereo PCM16/24/32 or float32 WAV");
  const frames = dataSize / align;
  if (frames > 1536000 || frames / rate > 32)
    throw new Error("Sample exceeds 32 seconds or 1536000 frames");
  const pcm = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const at = dataAt + frame * align + (channel * bits) / 8;
      let value =
        format === 3
          ? view.getFloat32(at, true)
          : bits === 16
            ? view.getInt16(at, true) / 32768
            : bits === 32
              ? view.getInt32(at, true) / 2147483648
              : (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) /
                8388608;
      if (!Number.isFinite(value)) throw new Error("Non-finite WAV amplitude");
      value = Math.max(-1, Math.min(1, value));
      pcm[frame] = (pcm[frame] ?? 0) + value / channels;
    }
  return { pcm, sampleRate: rate };
}
export function recordingPlan(
  project: Project,
  sampleRate: number,
  padIndex: number,
  trackId?: string,
) {
  ProjectSchema.parse(project);
  const pads = trackPads(project, trackId);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || !pads[padIndex])
    throw new Error("Invalid recording source or pad");
  const frames = Math.round(musicalSeconds(project, 32) * sampleRate);
  const oldId = pads[padIndex]?.sampleId;
  // The take replaces this pad's sample; one that other pads still play stays.
  const elsewhere = (id: string) =>
    [project.pads, ...project.tracks.map((t) => t.pads ?? [])].some((bank) =>
      bank.some((p, i) => p.sampleId === id && (bank !== pads || i !== padIndex)),
    );
  const retained = project.samples
    .filter((s) => s.id !== oldId || elsewhere(s.id))
    .reduce((n, s) => n + s.pcm.length, 0);
  const budget = Math.min(480000, MAX_SAMPLE_FRAMES - retained);
  if (frames > budget || frames / sampleRate > 10)
    throw new Error("Two-bar take exceeds available sample budget; shorten assets or raise tempo");
  return { frames, sampleRate, budget, seconds: frames / sampleRate };
}
export class TakeRecorder {
  state: "idle" | "armed" | "recording" | "complete" | "interrupted" = "idle";
  private pcm = new Float32Array(0);
  frames = 0;
  sampleRate = 48000;
  reason: string | undefined;
  peak = 0;
  arm(plan: { frames: number; sampleRate: number; budget: number }) {
    if (this.state === "recording") throw new Error("Recording is already active");
    if (
      !Number.isInteger(plan.frames) ||
      plan.frames < 1 ||
      plan.frames > Math.min(480000, plan.budget) ||
      !Number.isInteger(plan.sampleRate) ||
      plan.sampleRate < 8000 ||
      plan.sampleRate > 96000
    )
      throw new Error("Invalid recording budget");
    this.pcm = new Float32Array(plan.frames);
    this.frames = 0;
    this.sampleRate = plan.sampleRate;
    this.state = "armed";
    this.reason = undefined;
  }
  start() {
    if (this.state !== "armed") throw new Error("Arm before recording");
    this.state = "recording";
  }
  push(input: Float32Array) {
    this.peak = 0;
    for (const value of input) {
      if (!Number.isFinite(value) || Math.abs(value) > 1)
        throw new Error("Invalid input amplitude");
      this.peak = Math.max(this.peak, Math.abs(value));
    }
    if (this.state !== "recording") return;
    const n = Math.min(input.length, this.pcm.length - this.frames);
    this.pcm.set(input.subarray(0, n), this.frames);
    this.frames += n;
    if (this.frames === this.pcm.length) {
      this.state = "complete";
      if (input.length > n) this.reason = "Input continued beyond the bounded take";
    }
  }
  interrupt(reason: string) {
    if (this.state === "recording") {
      this.state = "interrupted";
      this.reason = reason;
    }
  }
  get take() {
    if (!["complete", "interrupted"].includes(this.state) || !this.frames)
      throw new Error("No recoverable take");
    return this.pcm.slice(0, this.frames);
  }
  commit(project: Project, pad: number, name = "Recorded take") {
    return installSample(project, pad, name, this.sampleRate, this.take);
  }
}
