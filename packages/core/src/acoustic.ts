// Acoustic smoke-test profile. These budgets do not qualify analog latency or fidelity.
export const acousticProfile = {
  id: "macbook-acoustic-v1",
  sampleRate: 48000,
  captureSeconds: 6,
  toneSeconds: 0.12,
  steps: [0, 3, 8, 10, 16, 21, 24, 28],
  frequencies: [540, 910, 1330, 720, 1090, 1690, 820, 1490],
  minimumRms: 0.0005,
  minimumCoherence: 0.3,
  maximumRelativeTimingErrorMs: 40,
} as const;

export interface AcousticDevice {
  id: number;
  uid: string;
  name: string;
  builtIn: boolean;
  alive: boolean;
  sampleRate: number;
  inputChannels: number;
  outputChannels: number;
}
export function requireMacBookDevice(device: AcousticDevice, input: boolean): void {
  const name = device?.name?.toLowerCase() ?? "";
  const channels = input ? device?.inputChannels : device?.outputChannels;
  if (
    !Number.isInteger(device?.id) ||
    device.id <= 0 ||
    device.builtIn !== true ||
    device.alive !== true ||
    device.uid !== (input ? "BuiltInMicrophoneDevice" : "BuiltInSpeakerDevice") ||
    !name.includes("macbook") ||
    !name.includes(input ? "microphone" : "speaker") ||
    /akai|force|mpc|inmusic/.test(name) ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 8 ||
    !Number.isInteger(device.sampleRate) ||
    device.sampleRate < 32000 ||
    device.sampleRate > 96000
  )
    throw new Error(
      "Only the live MacBook built-in speaker/microphone pair is allowed; no default-device fallback",
    );
}
export function preflightAcoustic(
  inventory: { output: AcousticDevice; input: AcousticDevice; microphonePermission: string },
  options: { platform: string; ci: boolean; capture: boolean },
) {
  if (options.platform !== "darwin" || options.ci)
    throw new Error("Physical acoustic capture is Mac-only and disabled in CI");
  requireMacBookDevice(inventory.output, false);
  requireMacBookDevice(inventory.input, true);
  if (options.capture && inventory.microphonePermission !== "authorized")
    throw new Error("Microphone permission must be granted before opening either stream");
  return {
    input: inventory.input,
    output: inventory.output,
    defaultFallback: false,
    formalLoopbackQualified: false,
  };
}

export function decodeAcousticWav(bytes: Uint8Array) {
  if (bytes.byteLength < 44 || bytes.byteLength > 2_000_000)
    throw new Error("Bounded acoustic WAV required");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, count: number) =>
    String.fromCharCode(...bytes.subarray(at, at + count));
  const rate = view.getUint32(24, true);
  if (
    text(0, 4) !== "RIFF" ||
    view.getUint32(4, true) !== bytes.byteLength - 8 ||
    text(8, 8) !== "WAVEfmt " ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    !Number.isInteger(rate) ||
    rate < 32000 ||
    rate > 96000 ||
    view.getUint32(28, true) !== rate * 2 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    text(36, 4) !== "data" ||
    view.getUint32(40, true) !== bytes.byteLength - 44 ||
    (bytes.byteLength - 44) / 2 !== rate * acousticProfile.captureSeconds
  )
    throw new Error("Expected a complete six-second mono PCM16 acoustic capture");
  const samples = new Float32Array(rate * acousticProfile.captureSeconds);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
  return { samples, sampleRate: rate };
}
export function analyzeAcoustic(samples: Float32Array, sampleRate: number) {
  const base = {
    profile: acousticProfile.id,
    formalLoopbackQualified: false,
    physicalAudioQualified: false,
    latencyMs: null,
    jitterMs: null,
    expectedNotes: acousticProfile.steps.length,
  };
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 32000 ||
    sampleRate > 96000 ||
    samples.length !== sampleRate * acousticProfile.captureSeconds ||
    samples.some((value) => !Number.isFinite(value))
  )
    return {
      ...base,
      outcome: "inconclusive",
      reason: "Incomplete or invalid capture",
      detectedNotes: 0,
    };
  let peak = 0,
    clipped = 0;
  for (const value of samples) {
    peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) >= 0.98) clipped++;
  }
  if (clipped / samples.length > 0.0001)
    return {
      ...base,
      outcome: "inconclusive",
      reason: "Microphone capture clipped",
      detectedNotes: 0,
      peak,
    };
  const width = Math.round(sampleRate * 0.04),
    hop = Math.round(sampleRate * 0.005);
  const count = Math.floor((samples.length - width) / hop) + 1;
  const weight = Float64Array.from(
    { length: width },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (width - 1)),
  );
  const weightEnergy = weight.reduce((sum, value) => sum + value * value, 0);
  const energies = new Float64Array(count);
  for (let block = 0; block < count; block++) {
    let energy = 0;
    for (let i = 0; i < width; i++) energy += (samples[block * hop + i] ?? 0) ** 2;
    energies[block] = energy;
  }
  const detections = acousticProfile.frequencies.map((frequency, note) => {
    const sine = Float64Array.from(
      weight,
      (value, i) => value * Math.sin((2 * Math.PI * frequency * i) / sampleRate),
    );
    const cosine = Float64Array.from(
      weight,
      (value, i) => value * Math.cos((2 * Math.PI * frequency * i) / sampleRate),
    );
    const powers = new Float64Array(count),
      coherence = new Float64Array(count);
    for (let block = 0; block < count; block++) {
      let re = 0,
        im = 0;
      for (let i = 0; i < width; i++) {
        const value = samples[block * hop + i] ?? 0;
        re += value * (cosine[i] ?? 0);
        im += value * (sine[i] ?? 0);
      }
      const spectral = (2 * (re * re + im * im)) / weightEnergy;
      powers[block] = spectral / width;
      coherence[block] = Math.min(1, spectral / Math.max(energies[block] ?? 0, 1e-20));
    }
    // Capture starts half a second before output; use the first quarter-second as ambient baseline.
    const backgroundCount = Math.floor((sampleRate * 0.25) / hop);
    const background =
      powers.slice(0, backgroundCount).reduce((sum, value) => sum + value, 0) / backgroundCount;
    const maximum = powers.reduce((value, next) => Math.max(value, next), 0);
    const threshold = Math.max(acousticProfile.minimumRms ** 2, background * 10, maximum * 0.15);
    const groups: { sum: number; weightedTime: number; frames: number }[] = [];
    let group: (typeof groups)[number] | undefined;
    for (let block = 0; block < count; block++) {
      if (
        (powers[block] ?? 0) >= threshold &&
        (coherence[block] ?? 0) >= acousticProfile.minimumCoherence
      ) {
        group ??= { sum: 0, weightedTime: 0, frames: 0 };
        const power = powers[block] ?? 0;
        group.sum += power;
        group.weightedTime += power * ((block * hop + width / 2) / sampleRate);
        group.frames++;
      } else if (group) {
        groups.push(group);
        group = undefined;
      }
    }
    if (group) groups.push(group);
    const best = groups
      .filter((item) => (item.frames * hop) / sampleRate >= 0.04)
      .sort((a, b) => b.sum - a.sum)[0];
    return {
      note,
      frequency,
      expectedSeconds: (acousticProfile.steps[note] ?? 0) * 0.125,
      observedSeconds: best ? best.weightedTime / best.sum : null,
      backgroundPower: background,
      peakPower: maximum,
    };
  });
  const matched = detections.filter((item) => item.observedSeconds !== null);
  if (matched.length !== detections.length)
    return {
      ...base,
      outcome: peak < acousticProfile.minimumRms ? "inconclusive" : "failed",
      reason: "Expected tone pattern was not fully detected",
      detectedNotes: matched.length,
      peak,
      detections,
    };
  const offsets = matched
    .map((item) => (item.observedSeconds ?? 0) - item.expectedSeconds)
    .sort((a, b) => a - b);
  const offset = ((offsets[3] ?? 0) + (offsets[4] ?? 0)) / 2;
  const residuals = matched.map(
    (item) => ((item.observedSeconds ?? 0) - item.expectedSeconds - offset) * 1000,
  );
  const maximumErrorMs = Math.max(...residuals.map(Math.abs));
  const intervalErrorMs = Math.max(
    ...residuals.slice(1).map((value, i) => Math.abs(value - (residuals[i] ?? 0))),
  );
  const passed =
    maximumErrorMs <= acousticProfile.maximumRelativeTimingErrorMs &&
    intervalErrorMs <= acousticProfile.maximumRelativeTimingErrorMs;
  return {
    ...base,
    outcome: passed ? "passed" : "failed",
    reason: passed
      ? "All eight tones and relative musical timing detected"
      : "Tone order or relative timing mismatch",
    detectedNotes: matched.length,
    peak,
    maximumErrorMs,
    intervalErrorMs,
    detections,
    alignmentOffsetSeconds: offset,
    alignmentIsLatencyMeasurement: false,
  };
}
