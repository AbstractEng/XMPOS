import { createDemoProject, ProjectSchema } from "../../packages/core/src/index.ts";
export const osFixtureOracle = Object.freeze({
  version: 1,
  rate: 48000,
  frames: 96000,
  peakFrame: 24000,
  pcm16: 16384,
  bootProfile: "p10-qemu-x86_64-v1",
  physical: false,
});
export function osFixtureProject() {
  const p = createDemoProject();
  p.id = "os-contract";
  p.name = "Original OS fixture";
  p.bpm = 120;
  p.master = 1;
  p.seed = 73019;
  p.parameters = [];
  p.samples = [
    { id: "impulse", name: "Original half-scale impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] },
  ];
  for (const pad of p.pads) pad.sampleId = "impulse";
  const t = p.tracks[0],
    c = t?.clips[0];
  if (!t || !c) throw new Error("Missing original fixture");
  t.volume = 1;
  c.steps = [{ step: 4, pad: 0, velocity: 1, probability: 1 }];
  return ProjectSchema.parse(p);
}
