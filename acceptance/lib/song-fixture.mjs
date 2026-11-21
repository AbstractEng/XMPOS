import { createDemoProject, ProjectSchema } from "../../packages/core/src/index.ts";
import { setParameter } from "../../packages/core/src/parameters.ts";
export function eightTrackFixture() {
  let project = createDemoProject();
  project.id = "portable-song";
  project.name = "Portable fixture";
  project.seed = 73019;
  project.bpm = 120;
  project.master = 1;
  project.samples = [
    { id: "shared-impulse", name: "Original impulse", sampleRate: 48000, pcm: [0.5, 0, 0, 0] },
  ];
  project.pads = Array.from({ length: 16 }, (_, pad) => ({
    id: `pad-${pad}`,
    name: `Pad ${pad + 1}`,
    sampleId: "shared-impulse",
  }));
  project.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `t${index}`,
    name: `Track ${index + 1}`,
    muted: false,
    volume: 1,
    clips: Array.from({ length: 16 }, (_, scene) => ({
      id: `c${index}-${scene}`,
      name: `Clip ${index + 1}/${scene + 1}`,
      length: 16,
      steps: [
        { pad: index, step: index, velocity: 0.5, probability: 1 },
        ...(index === 0 ? [{ pad: 15, step: 12, velocity: 0.25, probability: 0.5 }] : []),
      ],
    })),
  }));
  project.scenes = Array.from({ length: 16 }, (_, scene) => ({
    id: `scene-${scene}`,
    name: `Scene ${scene + 1}`,
    clips: Object.fromEntries(
      project.tracks.map((track, index) => [track.id, `c${index}-${scene}`]),
    ),
  }));
  project = setParameter(project, "track.t0.effect.gain", 0.6);
  return ProjectSchema.parse(project);
}
