import {
  createDemoProject,
  encodeWav,
  expandSong,
  ProjectSchema,
} from "../../packages/core/src/index.ts";
import { editChain } from "../../packages/core/src/performance.ts";
import { decodeSampleWav } from "../../packages/core/src/recording.ts";

export function songFixture() {
  const wav = Buffer.from(
    encodeWav(
      [Float32Array.from({ length: 720 }, (_, i) => 0.4 * Math.exp(-i / 150) * Math.sin(i * 0.13))],
      48000,
    ),
  );
  const audio = decodeSampleWav(wav);
  const project = editChain(expandSong(createDemoProject()), [
    { id: "intro", sceneId: "scene-0", repeats: 2 },
    { id: "verse", sceneId: "scene-1", repeats: 1 },
  ]);
  project.id = "travel-song";
  project.name = "Travel song · café 日本語";
  project.bpm = 120;
  project.samples = [
    { id: "kick", name: "Kick café", sampleRate: audio.sampleRate, pcm: Array.from(audio.pcm) },
    { id: "alias", name: "Same sound", sampleRate: audio.sampleRate, pcm: Array.from(audio.pcm) },
  ];
  project.pads.forEach((pad, i) => {
    pad.sampleId = i === 1 ? "alias" : "kick";
    pad.name = i === 1 ? "Alias" : `Sound ${i + 1}`;
    delete pad.slice;
  });
  project.pads[0].slice = { start: 1, end: 700 };
  for (const t of project.tracks)
    for (const c of t.clips) {
      c.steps = [];
      delete c.sequence;
    }
  project.tracks[0].clips[0].steps = [
    { step: 0, pad: 0, velocity: 0.8, probability: 1 },
    { step: 8, pad: 1, velocity: 0.6, probability: 1 },
  ];
  project.tracks[1].machine = {
    id: "xmp.midi",
    base: "midi",
    version: 1,
    state: { channel: 3, destination: "drums" },
  };
  project.tracks[1].clips[0].steps = [
    { step: 4, pad: 0, note: 60, velocity: 0.7, probability: 1, duration: 1 },
  ];
  project.tracks[2].machine = {
    id: "community.future-machine",
    base: "audio",
    version: 7,
    state: { patch: "日本語", matrix: [0.25, 0.5], sampleId: "alias" },
  };
  return { project: ProjectSchema.parse(project), wav };
}
