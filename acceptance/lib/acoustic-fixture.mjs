import { acousticProfile } from "../../packages/core/src/acoustic.ts";
import { createDemoProject, encodeWav } from "../../packages/core/src/index.ts";
export function acousticProject() {
  const project = createDemoProject();
  project.id = "acoustic-check-v1";
  project.name = "Original acoustic check";
  project.bpm = 120;
  project.master = 0.25;
  project.swing = 0;
  project.parameters = [];
  project.tracks[0].volume = 1;
  project.samples = acousticProfile.frequencies.map((frequency, index) => ({
    id: `acoustic-${index}`,
    name: `Original test tone ${index + 1}`,
    sampleRate: 48000,
    pcm: Array.from(
      { length: 5760 },
      (_, i) =>
        0.8 * Math.sin((Math.PI * i) / 5759) ** 2 * Math.sin((2 * Math.PI * frequency * i) / 48000),
    ),
  }));
  project.pads.forEach((pad, i) => {
    pad.sampleId = `acoustic-${i % 8}`;
  });
  project.tracks[0].clips[0].length = 32;
  project.tracks[0].clips[0].steps = acousticProfile.steps.map((step, pad) => ({
    step,
    pad,
    velocity: 1,
    probability: 1,
  }));
  return project;
}
// Synthetic fixtures are analysis tests only: never evidence of a microphone recording.
export function syntheticAcoustic({
  rate = 48000,
  missing = -1,
  delayed = -1,
  silence = false,
  noise = false,
  clipped = false,
  wrongOrder = false,
} = {}) {
  const pcm = new Float32Array(rate * acousticProfile.captureSeconds);
  let seed = 991;
  for (let i = 0; i < pcm.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    pcm[i] = silence ? 0 : (seed / 4294967296 - 0.5) * (noise ? 0.08 : 0.0001);
  }
  if (!silence && !noise)
    acousticProfile.steps.forEach((step, note) => {
      if (note === missing) return;
      const frequency = acousticProfile.frequencies[wrongOrder ? 7 - note : note];
      const onset = Math.round((0.65 + step * 0.125 + (note === delayed ? 0.12 : 0)) * rate);
      const length = Math.round(rate * 0.12);
      for (let i = 0; i < length; i++)
        if (onset + i < pcm.length)
          pcm[onset + i] +=
            0.06 *
            Math.sin((Math.PI * i) / (length - 1)) ** 2 *
            Math.sin((2 * Math.PI * frequency * i) / rate);
    });
  if (clipped) pcm.fill(1, rate, rate + 1000);
  return pcm;
}
export function monoWav(pcm, rate) {
  const stereo = new DataView(encodeWav([pcm, pcm], rate));
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  Buffer.from(stereo.buffer, 0, 44).copy(bytes);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++)
    bytes.writeInt16LE(stereo.getInt16(44 + i * 4, true), 44 + i * 2);
  return bytes;
}
export const mockBuiltins = () => ({
  output: {
    id: 1,
    uid: "BuiltInSpeakerDevice",
    name: "MacBook Pro Speakers",
    builtIn: true,
    alive: true,
    sampleRate: 44100,
    inputChannels: 0,
    outputChannels: 2,
  },
  input: {
    id: 2,
    uid: "BuiltInMicrophoneDevice",
    name: "MacBook Pro Microphone",
    builtIn: true,
    alive: true,
    sampleRate: 44100,
    inputChannels: 1,
    outputChannels: 0,
  },
  microphonePermission: "authorized",
});
