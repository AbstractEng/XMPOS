export interface ClockCalibration {
  version: 1;
  sampleRate: number;
  bufferFrames: number;
  clockRatio: number;
  clockOffsetFrames: number;
  captureStartFrame: number;
  maximumResidualFrames: number;
  independentCalibration: boolean;
  physicalFixtureObserved: boolean;
  synthetic: boolean;
  emittedFrames: number[];
}
export interface LoopbackResult {
  outcome: "measured" | "inconclusive";
  reason?: string;
  physicalQualification: false;
  synthetic: boolean;
  latencyMs: number[];
  p50Ms: number | null;
  p95Ms: number | null;
  maximumMs: number | null;
  thresholdPassed: boolean;
}
const inconclusive = (reason: string, synthetic = false): LoopbackResult => ({
  outcome: "inconclusive",
  reason,
  physicalQualification: false,
  synthetic,
  latencyMs: [],
  p50Ms: null,
  p95Ms: null,
  maximumMs: null,
  thresholdPassed: false,
});
export function decodeCaptureWav(bytes: Uint8Array): { sampleRate: number; pcm: Float32Array } {
  if (bytes.byteLength < 44 || bytes.byteLength > 64 * 1024 * 1024)
    throw new Error("Capture size outside profile");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length));
  if (
    ascii(0, 4) !== "RIFF" ||
    ascii(8, 4) !== "WAVE" ||
    view.getUint32(4, true) + 8 !== bytes.byteLength
  )
    throw new Error("Invalid capture RIFF");
  let offset = 12,
    rate = 0,
    channels = 0,
    bits = 0,
    format = 0,
    align = 0,
    data: Uint8Array | undefined;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset, 4),
      size = view.getUint32(offset + 4, true);
    offset += 8;
    if (size > bytes.length - offset) throw new Error("Truncated capture chunk");
    if (id === "fmt ") {
      if (size < 16) throw new Error("Invalid capture format");
      format = view.getUint16(offset, true);
      channels = view.getUint16(offset + 2, true);
      rate = view.getUint32(offset + 4, true);
      align = view.getUint16(offset + 12, true);
      bits = view.getUint16(offset + 14, true);
    } else if (id === "data") {
      if (data) throw new Error("Duplicate capture data");
      data = bytes.subarray(offset, offset + size);
    }
    offset += size + (size & 1);
  }
  if (
    format !== 1 ||
    channels !== 1 ||
    bits !== 16 ||
    align !== 2 ||
    rate !== 48000 ||
    !data ||
    data.byteLength % 2
  )
    throw new Error("Expected mono PCM16 capture at 48 kHz");
  const samples = new Float32Array(data.byteLength / 2);
  const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
  return { sampleRate: rate, pcm: samples };
}
export function analyzeLoopback(
  capture: Uint8Array | undefined,
  calibration: ClockCalibration | undefined,
  maximumP95Ms = 20,
): LoopbackResult {
  if (!capture || !calibration)
    return inconclusive("Missing physical capture or clock calibration");
  const c = calibration;
  if (
    typeof c.synthetic !== "boolean" ||
    typeof c.physicalFixtureObserved !== "boolean" ||
    c.version !== 1 ||
    c.sampleRate !== 48000 ||
    c.bufferFrames !== 256 ||
    !c.independentCalibration ||
    !Number.isFinite(c.clockRatio) ||
    Math.abs(c.clockRatio - 1) > 0.0001 ||
    !Number.isFinite(c.clockOffsetFrames) ||
    !Number.isFinite(c.captureStartFrame) ||
    !Number.isFinite(c.maximumResidualFrames) ||
    c.maximumResidualFrames < 0 ||
    c.maximumResidualFrames > 1 ||
    (!c.synthetic && !c.physicalFixtureObserved) ||
    !Number.isFinite(maximumP95Ms) ||
    maximumP95Ms <= 0
  )
    return inconclusive(
      "Invalid calibration, fixture attestation or active audio profile",
      c.synthetic,
    );
  if (
    !Array.isArray(c.emittedFrames) ||
    c.emittedFrames.length < 1000 ||
    c.emittedFrames.length > 10000 ||
    c.emittedFrames.some(
      (frame, index) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        (index > 0 && frame - (c.emittedFrames[index - 1] ?? 0) < 6000),
    )
  )
    return inconclusive("Need 1000..10000 isolated hardware-clock impulse trials", c.synthetic);
  let decoded: ReturnType<typeof decodeCaptureWav>;
  try {
    decoded = decodeCaptureWav(capture);
  } catch (error) {
    return inconclusive(error instanceof Error ? error.message : "Invalid capture", c.synthetic);
  }
  const latencyMs: number[] = [];
  let previous = -1;
  for (const frame of c.emittedFrames) {
    const expected = frame * c.clockRatio + c.clockOffsetFrames - c.captureStartFrame;
    const first = Math.floor(expected),
      end = first + 4800;
    if (first < 0 || end >= decoded.pcm.length)
      return inconclusive("Capture does not cover every trial window", c.synthetic);
    let peak = -1;
    for (let index = first; index <= end; index++)
      if (Math.abs(decoded.pcm[index] ?? 0) >= 0.1) {
        peak = index;
        break;
      }
    if (peak < 0 || peak <= previous)
      return inconclusive("Missing or ambiguous impulse trial", c.synthetic);
    // Independent pre-trial noise and a narrow impulse are required; long tones are not timing evidence.
    for (let index = Math.max(0, first - 128); index < first; index++)
      if (Math.abs(decoded.pcm[index] ?? 0) > 0.02)
        return inconclusive("Capture has excessive pre-trial noise", c.synthetic);
    if (Math.abs(decoded.pcm[peak + 128] ?? 0) > 0.02)
      return inconclusive("Impulse tail is not isolated", c.synthetic);
    for (let index = peak + 129; index <= end; index++)
      if (Math.abs(decoded.pcm[index] ?? 0) >= 0.1)
        return inconclusive("Ambiguous multiple impulses in trial", c.synthetic);
    if (peak < expected) return inconclusive("Calibration produced negative latency", c.synthetic);
    previous = peak;
    latencyMs.push(((peak - expected) / decoded.sampleRate) * 1000);
  }
  const sorted = [...latencyMs].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  const p95 = percentile(0.95);
  return {
    outcome: "measured",
    physicalQualification: false,
    synthetic: c.synthetic,
    latencyMs,
    p50Ms: percentile(0.5),
    p95Ms: p95,
    maximumMs: sorted[sorted.length - 1] ?? null,
    thresholdPassed: p95 !== null && p95 <= maximumP95Ms,
  };
}
