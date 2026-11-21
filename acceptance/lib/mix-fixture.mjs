import { createDemoProject, expandSong } from "../../packages/core/src/index.ts";
import { editMix } from "../../packages/core/src/mix.ts";
import { createEffect } from "../../packages/core/src/mix-schema.ts";
import { editPerformance } from "../../packages/core/src/performance.ts";
export const mixOracle = {
  version: 1,
  panLaw: "equal-power -3.0103 dB center",
  rate: 48000,
  delayFrames: 192,
  reverbFrames: 6576,
  maxInserts: 2,
  maxReturns: 2,
  ppq: 960,
  clockFrames: [0, 1000, 96000, 98000],
  physicalMidiQualified: false,
  formalLoopbackQualified: false,
};
export function mixFixture() {
  let p = expandSong(createDemoProject());
  p.bpm = 300;
  p.master = 0.25;
  p.parameters = [];
  p.samples = [
    { id: "original-impulse", name: "Original impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] },
  ];
  for (const pad of p.pads) pad.sampleId = "original-impulse";
  for (const [i, t] of p.tracks.entries()) {
    t.volume = 0.1;
    for (const c of t.clips) {
      c.length = 16;
      c.steps = [{ step: i, pad: i, note: 48 + i, duration: 0.5, velocity: 1, probability: 1 }];
    }
  }
  p = editMix(p, (m) => {
    for (const [i, t] of p.tracks.entries()) {
      const eq = createEffect("eq", `eq-${i}`),
        filter = createEffect("filter", `filter-${i}`);
      m.tracks[t.id] = { pan: i / 7, sends: [0.2, 0.15], inserts: [eq, filter] };
    }
    const delay = createEffect("delay", "delay");
    delay.params = { time: 0.001, feedback: 0.3, wet: 1 };
    const reverb = createEffect("reverb", "reverb");
    reverb.params.wet = 1;
    m.returns = [[delay], [reverb]];
    m.tempos = [{ step: 16, bpm: 240 }];
  });
  return editPerformance(p, (x) => {
    x.chain = [{ id: "first", sceneId: "scene-0", repeats: 2 }];
  });
}
