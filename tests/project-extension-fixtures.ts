import { createDemoProject, type Project, ProjectSchema } from "../packages/core/src/index.ts";

export function extensibleProject(): Project {
  const project = createDemoProject();
  project.samples = [
    { id: "sound", name: "Sound", sampleRate: 48000, pcm: [0.25, -0.125, 0] },
    { id: "future-asset", name: "Future machine asset", sampleRate: 48000, pcm: [0.5, 0] },
  ];
  for (const pad of project.pads) {
    pad.sampleId = "sound";
    delete pad.slice;
  }
  const track = project.tracks[0];
  if (!track) throw new Error("Missing fixture track");
  track.machine = {
    id: "com.example.future-machine",
    base: "audio",
    version: 42,
    state: { program: "A future sound", sampleId: "future-asset", matrix: [0.2, 0.8] },
  };
  project.parameters = [
    {
      id: `track.${track.id}.machine.com.example.future-machine.v42.depth`,
      base: 0.4,
    },
  ];
  project.extensions = {
    "com.example.motion": {
      version: 7,
      required: false,
      data: { tracks: { [track.id]: { curve: [0, 0.5, 1], sampleId: "future-asset" } } },
    },
    "xmp.workspace": {
      version: 2,
      data: { label: "café 日本語", view: { unknownFutureOption: true, value: null } },
    },
  };
  return ProjectSchema.parse(project);
}

/** The same hostile descriptors are passed to TypeScript, Wasm and native C++. */
export function invalidProjectExtensions(): unknown[] {
  const entry = (data: unknown = {}) => ({ version: 1, data });
  let deep: unknown = null;
  for (let i = 0; i < 11; i++) deep = { next: deep };
  return [
    null,
    [],
    1,
    { unnamespaced: entry() },
    { "com..example": entry() },
    { "com.1example": entry() },
    { "com.example": { version: 0, data: {} } },
    { "com.example": { version: 1.5, data: {} } },
    { "com.example": { version: 65536, data: {} } },
    { "com.example": { version: 1 } },
    { "com.example": { ...entry(), required: "yes" } },
    { "com.example": { ...entry(), unsupportedEnvelopeField: true } },
    { "com.example": entry({ text: "a".repeat(513) }) },
    { "com.example": entry({ values: Array(257).fill(0) }) },
    {
      "com.example": entry(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 0]))),
    },
    { "com.example": entry({ deep }) },
    { "com.example": entry({ rows: Array.from({ length: 64 }, () => Array(128).fill(0)) }) },
    JSON.parse('{"com.example":{"version":1,"data":{"__proto__":{"polluted":true}}}}'),
    { "com.example": entry({ constructor: "bad" }) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`com.feature${i}`, entry()])),
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `com.feature${i}`,
        entry(Object.fromEntries(Array.from({ length: 64 }, (_, j) => [`k${j}`, "x".repeat(512)]))),
      ]),
    ),
    { "com.example": { version: 1, required: true, data: {} } },
    { "xmp.extended-samples": entry({ unexpected: true }) },
    { "xmp.sampler-input": entry({ tracks: { drums: { monitor: "yes", bars: 4 } } }) },
    { "xmp.sampler-input": entry({ tracks: { drums: { monitor: true, bars: 3 } } }) },
    { "xmp.sampler-input": entry({ tracks: { "bad.id": { monitor: true, bars: 4 } } }) },
  ];
}
