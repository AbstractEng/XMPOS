import { createDemoProject } from "../../packages/core/src/index.ts";
import { machines } from "../../packages/core/src/machines.ts";
export function instrumentFixture() {
  const p = createDemoProject();
  p.id = "p05-fixture";
  p.bpm = 120;
  p.master = 0.5;
  p.tracks[0].volume = 1;
  p.parameters = [];
  p.samples = [
    {
      id: "tone",
      name: "Original sine",
      sampleRate: 48000,
      pcm: Array.from({ length: 2400 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000)),
    },
  ];
  p.pads.forEach((pad) => {
    pad.sampleId = "tone";
  });
  p.tracks[0].clips[0].length = 32;
  p.tracks[0].clips[0].steps = [
    { step: 0, pad: 0, velocity: 0.5, probability: 1 },
    { step: 8, pad: 1, velocity: 0.8, probability: 1 },
  ];
  return p;
}
export function songWithSynth() {
  const p = instrumentFixture();
  p.tracks.push({
    id: "bass",
    name: "Bass",
    muted: false,
    volume: 0.6,
    machine: machines.instantiate("xmp.subtractive"),
    clips: [
      {
        id: "bass-0",
        name: "Bass",
        length: 32,
        steps: [
          { step: 0, pad: 0, note: 36, duration: 4, velocity: 0.7, probability: 1 },
          { step: 8, pad: 1, note: 43, duration: 8, velocity: 0.5, probability: 1 },
        ],
      },
    ],
  });
  p.scenes[0].clips.bass = "bass-0";
  return p;
}
export function renderRack(rack, frames, actions = []) {
  const pcm = new Float32Array(frames),
    left = new Float32Array(128),
    right = new Float32Array(128);
  let action = 0;
  for (let frame = 0; frame < frames; ) {
    while (actions[action]?.frame === frame) {
      actions[action++].run();
    }
    const next = actions[action]?.frame ?? frames;
    const count = Math.min(128, frames - frame, next - frame);
    if (count <= 0) throw new Error("Bad fixture event order");
    rack.process(left, right, count);
    pcm.set(left.subarray(0, count), frame);
    frame += count;
  }
  return pcm;
}
export const instrumentOracle = {
  sampleRate: 48000,
  voices: 32,
  panicFrames: 240,
  twoBarsFrames: 192000,
  synthNotes: [48, 55],
  sampleFrequency: 440,
  octaveFrequency: 880,
};
