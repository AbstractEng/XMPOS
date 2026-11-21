import { createDemoProject, expandSong } from "../../packages/core/src/index.ts";
import { editPerformance } from "../../packages/core/src/performance.ts";
export const performanceOracle = Object.freeze({
  version: 1,
  sceneFrames: [0, 192000, 576000],
  sceneSteps: [0, 32, 96],
  endStep: 112,
  delayImpulseFrames: [12000, 24000],
  layout: { width: 1280, height: 800, minTarget: 44, physicalDisplayQualified: false },
});
export function performanceFixture() {
  const p = expandSong(createDemoProject());
  p.bpm = 120;
  p.master = 1;
  p.parameters = [];
  p.samples = [{ id: "impulse", name: "Original impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] }];
  for (const pad of p.pads) pad.sampleId = "impulse";
  for (const t of p.tracks) {
    t.volume = 1;
    for (const c of t.clips) c.steps = [];
  }
  for (let i = 0; i < 2; i++) {
    const t = p.tracks[i];
    for (const c of t.clips) c.steps = [{ step: 0, pad: i, velocity: 1, probability: 1 }];
  }
  p.tracks[0].clips[1].length = 64;
  p.tracks[0].clips[1].steps.push({ step: 48, pad: 0, velocity: 1, probability: 1 });
  return editPerformance(p, () => {});
}
export const chainFixture = () => [
  { id: "intro", sceneId: "scene-0", repeats: 2 },
  { id: "long", sceneId: "scene-1", repeats: 1 },
  { id: "outro", sceneId: "scene-2", repeats: 1 },
];
