import { z } from "zod";
import { MAX_SAMPLE_FRAMES, MAX_SAMPLES } from "./input.ts";
import { EditSchema, PlaybackSchema } from "./instrument-schema.ts";
import { machines, TrackMachineSchema } from "./machines.ts";
import { mixParameterBase } from "./mix.ts";
import { MixSchema } from "./mix-schema.ts";
import { parameterValue } from "./parameters.ts";
import { PerformanceSchema } from "./performance-schema.ts";
import { projectReadError } from "./project-errors.ts";
import { ProjectExtensionsSchema } from "./project-extensions.ts";
import { parameterId, SequenceSchema } from "./sequence-schema.ts";
import { stepEvents, stepSeconds } from "./sequencer-engine.ts";

export const API_VERSION = 1 as const;
export const PAD_COUNT = 16;
export { MAX_PROJECT_BYTES, MAX_SONG_BYTES } from "./input.ts";
export { UnsupportedSongError } from "./project-errors.ts";
export {
  type ExtensionJson,
  type ProjectExtension,
  type ProjectExtensions,
  preservedProjectExtensions,
  supportsProjectExtension,
} from "./project-extensions.ts";

import {
  extendedSampleProfile,
  MAX_LOOP_PROJECT_FRAMES,
  MAX_LOOP_SAMPLE_FRAMES,
  MAX_PROJECT_BYTES,
  preflightProjectText,
} from "./input.ts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const unit = z.number().finite().min(0).max(1);
export const StepSchema = z
  .object({
    step: z.number().int().min(0).max(63),
    pad: z.number().int().min(0).max(15),
    velocity: unit,
    probability: unit,
  })
  .strict();
const LegacyShape = z
  .object({
    format: z.literal("xmp-project"),
    version: z.literal(1),
    id,
    name: z.string().min(1).max(80),
    bpm: z.number().finite().min(30).max(300),
    swing: z.number().finite().min(0).max(0.5),
    master: unit,
    pads: z
      .array(z.object({ id, name: z.string().min(1).max(40), sampleId: id }).strict())
      .length(16),
    samples: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(120),
            sampleRate: z.number().int().min(8000).max(96000),
            pcm: z.array(z.number().finite().min(-1).max(1)).min(1).max(480000),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    tracks: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(40),
            muted: z.boolean(),
            volume: unit,
            clips: z
              .array(
                z
                  .object({
                    id,
                    name: z.string().min(1).max(40),
                    length: z.union([z.literal(16), z.literal(32), z.literal(64)]),
                    steps: z.array(StepSchema).max(1024),
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    scenes: z
      .array(z.object({ id, name: z.string().min(1).max(40), clips: z.record(id, id) }).strict())
      .min(1)
      .max(16),
  })
  .strict();
function validateReferences(
  project: Omit<z.infer<typeof LegacyShape>, "tracks"> & {
    tracks: {
      id: string;
      volume: number;
      clips: { id: string; length: number; steps: z.infer<typeof StepSchema>[] }[];
    }[];
  },
  ctx: z.RefinementCtx,
) {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const unique = (items: { id: string }[], label: string) => {
    if (new Set(items.map((x) => x.id)).size !== items.length) issue(`Duplicate ${label} id`);
  };
  unique(project.pads, "pad");
  unique(project.samples, "sample");
  unique(project.tracks, "track");
  unique(project.scenes, "scene");
  const samples = new Set(project.samples.map((sample) => sample.id));
  const extended = extendedSampleProfile(project);
  if (
    project.samples.reduce((n, sample) => n + sample.pcm.length, 0) >
    (extended ? MAX_LOOP_PROJECT_FRAMES : MAX_SAMPLE_FRAMES)
  )
    issue(
      extended
        ? "Sample budget exceeds extended profile"
        : "Project audio exceeds two million mono frames",
    );
  if (
    project.samples.some(
      (sample) => sample.pcm.length > (extended ? MAX_LOOP_SAMPLE_FRAMES : 480000),
    )
  )
    issue("Sample exceeds portable profile bounds");
  for (const pad of project.pads)
    if (!samples.has(pad.sampleId)) issue(`Missing sample ${pad.sampleId}`);
  for (const track of project.tracks) {
    unique(track.clips, "clip");
    for (const clip of track.clips) {
      const keys = new Set<string>();
      for (const step of clip.steps) {
        if (step.step >= clip.length) issue("Step exceeds clip length");
        const key = `${step.pad}:${step.step}`;
        if (keys.has(key)) issue("Duplicate pad event at step");
        keys.add(key);
      }
    }
  }
  for (const scene of project.scenes) {
    for (const [trackId, clipId] of Object.entries(scene.clips)) {
      const track = project.tracks.find((track) => track.id === trackId);
      if (!track?.clips.some((clip) => clip.id === clipId))
        issue("Scene references a missing track or clip");
    }
  }
}
export const LegacyProjectSchema = LegacyShape.superRefine(validateReferences);
const assignment = z
  .object({
    id: parameterId,
    base: unit,
    automation: unit.optional(),
    stepLock: unit.optional(),
    macro: z.number().finite().min(-1).max(1).optional(),
    lfo: z.number().finite().min(-1).max(1).optional(),
  })
  .strict();
const padV2 = z
  .object({
    id,
    name: z.string().min(1).max(40),
    sampleId: id,
    slice: z
      .object({ start: z.number().int().min(0), end: z.number().int().min(1) })
      .strict()
      .optional(),
  })
  .strict();
const ShapeV2 = LegacyShape.extend({
  version: z.literal(2),
  seed: z.number().int().min(0).max(0xffffffff),
  parameterVersion: z.literal(1),
  parameters: z.array(assignment).max(145),
  pads: z.array(padV2).length(16),
});
const validateV2 = (
  project: Omit<z.infer<typeof ShapeV2>, "tracks"> & {
    tracks: {
      id: string;
      volume: number;
      clips: { id: string; length: number; steps: z.infer<typeof StepSchema>[] }[];
    }[];
  },
  ctx: z.RefinementCtx,
) => {
  validateReferences({ ...project, version: 1 }, ctx);
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const ids = new Set<string>();
  for (const parameter of project.parameters) {
    if (ids.has(parameter.id)) issue("Duplicate parameter assignment");
    ids.add(parameter.id);
    const track = project.tracks.find(
      (t) => parameter.id === `track.${t.id}.gain` || parameter.id === `track.${t.id}.effect.gain`,
    );
    if (
      parameter.id !== "master.gain" &&
      !track &&
      !project.tracks.some((t) => parameter.id.startsWith(`track.${t.id}.machine.`)) &&
      mixParameterBase(project as unknown as Project, parameter.id) === undefined
    )
      issue(`Unknown parameter ${parameter.id}`);
    if (parameter.id === "master.gain" && parameter.base !== project.master)
      issue("Master parameter base differs from master gain");
    if (track && parameter.id === `track.${track.id}.gain` && parameter.base !== track.volume)
      issue("Track parameter base differs from volume");
  }
  if (
    project.tracks.reduce((sum, t) => sum + t.clips.reduce((n, c) => n + c.steps.length, 0), 0) >
    8192
  )
    issue("Project exceeds 131072 events");
  for (const pad of project.pads) {
    const sample = project.samples.find((s) => s.id === pad.sampleId);
    if (
      pad.slice &&
      (!sample || pad.slice.start >= pad.slice.end || pad.slice.end > sample.pcm.length)
    )
      issue("Sample slice lies outside its asset");
  }
};
const ProjectV2Schema = ShapeV2.superRefine(validateV2);
export const StepV3Schema = StepSchema.extend({
  step: z.number().int().min(0).max(1023),
  note: z.number().int().min(0).max(127).optional(),
  duration: z.number().finite().min(0.0625).max(64).optional(),
});
const ShapeV3 = ShapeV2.extend({
  version: z.literal(3),
  pads: z
    .array(padV2.extend({ playback: PlaybackSchema.optional(), edit: EditSchema.optional() }))
    .length(16),
  tracks: z
    .array(
      LegacyShape.shape.tracks.element.extend({
        machine: TrackMachineSchema.optional(),
        clips: z
          .array(
            LegacyShape.shape.tracks.element.shape.clips.element.extend({
              length: z.number().int().min(1).max(1024),
              steps: z.array(StepV3Schema).max(1024),
            }),
          )
          .min(0)
          .max(16),
      }),
    )
    .min(1)
    .max(8),
});
const validateV3 = (project: z.infer<typeof ShapeV3>, ctx: z.RefinementCtx) => {
  validateV2({ ...project, version: 2 }, ctx);
  for (const track of project.tracks) if (track.machine) machines.get(track.machine);
};
const ProjectV3Schema = ShapeV3.superRefine(validateV3);
const ShapeV4 = ShapeV3.extend({
  version: z.literal(4),
  tracks: z
    .array(
      ShapeV3.shape.tracks.element.extend({
        clips: z
          .array(
            ShapeV3.shape.tracks.element.shape.clips.element.extend({
              sequence: SequenceSchema.optional(),
            }),
          )
          .max(16),
      }),
    )
    .min(1)
    .max(8),
});
const validateV4 = (project: z.infer<typeof ShapeV4>, ctx: z.RefinementCtx) => {
  validateV3({ ...project, version: 3 }, ctx);
  let count = 0;
  for (const track of project.tracks)
    for (const clip of track.clips) {
      const seq = clip.sequence;
      if (!seq) continue;
      count += seq.notes.length;
      if (
        seq.notes.some(
          (n) => n.position >= clip.length || n.position + n.duration > clip.length + 1e-8,
        ) ||
        seq.locks.some((l) => l.position >= clip.length) ||
        seq.lanes.some((l) => l.points.some((p) => p.position > clip.length))
      )
        ctx.addIssue({ code: "custom", message: "Sequence event exceeds clip boundary" });
      for (const target of [...seq.locks, ...seq.lanes, ...seq.modulations])
        if (
          target.parameter !== "master.gain" &&
          !target.parameter.startsWith("return.") &&
          !target.parameter.startsWith(`track.${track.id}.`)
        )
          ctx.addIssue({ code: "custom", message: "Sequence parameter belongs to another track" });
    }
  if (count > 8192) ctx.addIssue({ code: "custom", message: "Sequence note budget exceeded" });
};
const ProjectV4Schema = ShapeV4.superRefine(validateV4);
const ShapeV5 = ShapeV4.extend({
  version: z.literal(5),
  performance: PerformanceSchema.optional(),
});
const validateV5 = (project: z.infer<typeof ShapeV5>, ctx: z.RefinementCtx) => {
  validateV4({ ...project, version: 4 }, ctx);
  const p = project.performance;
  if (!p) return;
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const tracks = new Set(project.tracks.map((t) => t.id)),
    scenes = new Set(project.scenes.map((s) => s.id));
  for (const e of p.chain)
    if (!scenes.has(e.sceneId)) issue("Song occurrence references a missing scene");
  if (
    [...Object.keys(p.mutes), ...p.solos, ...Object.keys(p.delay.sends)].some(
      (id) => !tracks.has(id),
    )
  )
    issue("Performance references a missing track");
  for (const m of p.macros)
    for (const a of m.assignments)
      if (
        a.parameter !== "master.gain" &&
        !a.parameter.startsWith("return.") &&
        !project.tracks.some((t) => a.parameter.startsWith(`track.${t.id}.`))
      )
        issue("Macro references a missing track");
  for (const e of p.events)
    if (e.kind === "macro" ? !p.macros.some((m) => m.id === e.macroId) : !tracks.has(e.trackId))
      issue("Performance event references a missing target");
  if (p.selection) {
    if (!scenes.has(p.selection.sceneId)) issue("Missing performance scene");
    for (const [id, clip] of Object.entries(p.selection.clips))
      if (!project.tracks.find((t) => t.id === id)?.clips.some((c) => c.id === clip))
        issue("Missing selected performance clip");
  }
  if (p.position) {
    const e = p.chain.find((e) => e.id === p.position?.occurrenceId);
    if (!e) issue("Missing song position occurrence");
    else {
      const scene = project.scenes.find((s) => s.id === e.sceneId);
      const length = Math.max(
        16,
        ...project.tracks.map(
          (t) => t.clips.find((c) => c.id === scene?.clips[t.id])?.length ?? 16,
        ),
      );
      if (p.position.offset >= length * e.repeats) issue("Song position exceeds occurrence");
    }
  }
};
const ProjectV5Schema = ShapeV5.superRefine(validateV5);
const ShapeV6 = ShapeV5.extend({
  version: z.literal(6),
  parameters: z.array(assignment).max(512),
  mix: MixSchema.optional(),
});
const validateV6 = (project: z.infer<typeof ShapeV6>, ctx: z.RefinementCtx) => {
  validateV5({ ...project, version: 5 }, ctx);
  if (project.mix) {
    for (const id of Object.keys(project.mix.tracks))
      if (!project.tracks.some((t) => t.id === id))
        ctx.addIssue({
          code: "custom",
          message: "Mix references missing track",
        });
  }
};
const ProjectV6Schema = ShapeV6.superRefine(validateV6);
export const PROJECT_VERSION = 8 as const;
// Version 7: a track may hold its own kit of 16 pads (a Kit or Sampler track's
// own sounds). Tracks without one play the project's pads, as every track did
// before, so older projects open unchanged and sound the same. The samples
// stay one shared pool, so a sound used by several kits is stored once.
const PadV3Schema = ShapeV3.shape.pads.element;
const ShapeV7 = ShapeV6.extend({
  version: z.literal(7),
  samples: z.array(LegacyShape.shape.samples.element).min(1).max(MAX_SAMPLES),
  tracks: z
    .array(
      ShapeV6.shape.tracks.element.extend({
        pads: z.array(PadV3Schema).length(16).optional(),
      }),
    )
    .min(1)
    .max(8),
});
const validateV7 = (project: z.infer<typeof ShapeV7>, ctx: z.RefinementCtx) => {
  validateV6({ ...project, version: 6 }, ctx);
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const track of project.tracks) {
    if (!track.pads) continue;
    if (new Set(track.pads.map((p) => p.id)).size !== track.pads.length) issue("Duplicate pad id");
    for (const pad of track.pads) {
      const sample = project.samples.find((s) => s.id === pad.sampleId);
      if (!sample) issue(`Missing sample ${pad.sampleId}`);
      else if (pad.slice && (pad.slice.start >= pad.slice.end || pad.slice.end > sample.pcm.length))
        issue("Sample slice lies outside its asset");
    }
  }
};
const ProjectV7Schema = ShapeV7.superRefine(validateV7);
// Version 8: a pad may be multi-sampled. Its velocity layers (softest first)
// each cover velocities up to `upTo`, the last reaching 1, and each holds 1-8
// round-robin takes from the sample pool that repeated hits rotate through.
// The pad's own `sampleId` stays the sound editors show; a layered pad plays
// its layers instead, whole (a layered pad has no slice). Pads without layers
// play as before, so version 7 projects open unchanged and sound the same.
export const PadLayerSchema = z.object({ upTo: unit, samples: z.array(id).min(1).max(8) }).strict();
export const PadSchema = PadV3Schema.extend({
  layers: z.array(PadLayerSchema).min(1).max(8).optional(),
});
export const ProjectSchema = ShapeV7.extend({
  version: z.literal(8),
  extensions: ProjectExtensionsSchema.optional(),
  samples: z
    .array(
      LegacyShape.shape.samples.element.extend({
        pcm: z.array(z.number().finite().min(-1).max(1)).min(1).max(MAX_LOOP_SAMPLE_FRAMES),
      }),
    )
    .min(1)
    .max(MAX_SAMPLES),
  pads: z.array(PadSchema).length(16),
  tracks: z
    .array(
      ShapeV7.shape.tracks.element.extend({
        pads: z.array(PadSchema).length(16).optional(),
      }),
    )
    .min(1)
    .max(8),
}).superRefine((project, ctx) => {
  validateV7({ ...project, version: 7 }, ctx);
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const samples = new Set(project.samples.map((s) => s.id));
  for (const pad of [...project.pads, ...project.tracks.flatMap((t) => t.pads ?? [])]) {
    if (!pad.layers) continue;
    if (pad.slice) issue("A layered pad has no slice");
    let top = 0;
    for (const layer of pad.layers) {
      if (!(layer.upTo > top)) issue("Pad layers must rise in velocity");
      top = layer.upTo;
      for (const id of layer.samples) if (!samples.has(id)) issue(`Missing sample ${id}`);
    }
    if (top !== 1) issue("A pad's last layer must reach full velocity");
  }
});
export type LegacyProject = z.infer<typeof LegacyProjectSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Step = z.infer<typeof StepV3Schema>;
export type Sample = Project["samples"][number];
export type Pad = Project["pads"][number];
export { sampleInUse, trackPads } from "./pads.ts";
export function checkProjectText(text: string): void {
  preflightProjectText(text);
}
export function migrateProject(input: unknown): Project {
  if (typeof input !== "object" || input === null)
    throw new Error("Expected an XMP project object");
  const version = (input as { version?: unknown }).version;
  const older = [
    undefined,
    LegacyProjectSchema,
    ProjectV2Schema,
    ProjectV3Schema,
    ProjectV4Schema,
    ProjectV5Schema,
    ProjectV6Schema,
    ProjectV7Schema,
  ] as const;
  if (typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= 7) {
    const parsed = (older[version] as z.ZodTypeAny).parse(input) as Record<string, unknown>;
    return ProjectSchema.parse(
      version === 1
        ? {
            ...parsed,
            version: PROJECT_VERSION,
            seed: 0,
            parameterVersion: 1,
            parameters: [],
          }
        : { ...parsed, version: PROJECT_VERSION },
    );
  }
  if (version !== PROJECT_VERSION)
    throw projectReadError(
      `Unsupported project version ${String(version)}; use a compatible XMP release. Current edits are unchanged.`,
    );
  return ProjectSchema.parse(input);
}
export function parseProject(text: string): Project {
  preflightProjectText(text, true);
  try {
    const value = JSON.parse(text);
    if (!extendedSampleProfile(value) && new TextEncoder().encode(text).length > MAX_PROJECT_BYTES)
      throw new Error("Project exceeds 24 MiB");
    return migrateProject(value);
  } catch (error) {
    throw projectReadError(
      `Could not open project: ${error instanceof Error ? error.message : "invalid data"}`,
    );
  }
}
export function openProject(text: string): {
  project: Project;
  originalText: string;
  migrated: boolean;
} {
  const project = parseProject(text);
  return {
    project,
    originalText: text,
    migrated: JSON.parse(text).version !== PROJECT_VERSION,
  };
}

export function stepTime(absoluteStep: number, bpm: number, swing: number): number {
  if (
    !Number.isInteger(absoluteStep) ||
    absoluteStep < 0 ||
    !Number.isFinite(bpm) ||
    bpm < 30 ||
    bpm > 300 ||
    !Number.isFinite(swing) ||
    swing < 0 ||
    swing > 0.5
  )
    throw new Error("Invalid transport time");
  return stepSeconds(absoluteStep, bpm, swing);
}
export function deterministicRandom(key: string): number {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}
// The step notes due on an absolute step, chosen by the C++ sequencer.
export function eventsAtStep(project: Project, sceneId: string, absoluteStep: number) {
  return stepEvents(project, sceneId, absoluteStep).map(({ track, step }) => ({
    ...step,
    velocity:
      step.velocity *
      parameterValue(project, `track.${track.id}.gain`) *
      parameterValue(project, `track.${track.id}.effect.gain`) *
      2,
    trackId: track.id,
  }));
}
export function toggleStep(
  project: Project,
  trackId: string,
  clipId: string,
  pad: number,
  step: number,
): Project {
  const next = structuredClone(project);
  const clip = next.tracks
    .find((track) => track.id === trackId)
    ?.clips.find((clip) => clip.id === clipId);
  if (
    !clip ||
    !Number.isInteger(pad) ||
    pad < 0 ||
    pad >= 16 ||
    !Number.isInteger(step) ||
    step < 0 ||
    step >= clip.length
  )
    throw new Error("Invalid step edit");
  const index = clip.steps.findIndex((event) => event.pad === pad && event.step === step);
  if (index >= 0) clip.steps.splice(index, 1);
  else clip.steps.push({ step, pad, velocity: 0.8, probability: 1 });
  return next;
}

// Original synthesized demo sounds, generated deterministically. No vendor assets.
export function makeSample(pad: number, sampleRate = 24000): Sample {
  const names = [
    "Kick",
    "Snare",
    "Closed hat",
    "Open hat",
    "Low tom",
    "Mid tom",
    "High tom",
    "Clap",
    "Rim",
    "Shaker",
    "Clave",
    "Cowbell",
    "Sub",
    "Pluck",
    "Chord",
    "Air",
  ];
  const length = Math.floor(sampleRate * (pad === 3 || pad >= 12 ? 0.6 : 0.3));
  let seed = pad + 1;
  let phase = 0;
  const pcm = Array.from({ length }, (_, i) => {
    const t = i / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    phase +=
      (2 * Math.PI * (pad === 0 ? 48 + 110 * Math.exp(-t * 35) : 80 + pad * 30)) / sampleRate;
    const attack = Math.min(1, i / 40);
    const release = Math.min(1, (length - i - 1) / 80);
    const tonal = Math.sin(phase);
    const value =
      pad === 0 || pad >= 12
        ? tonal * Math.exp(-t * (pad === 0 ? 14 : 7))
        : pad === 1 || pad === 7
          ? (noise * 0.7 + tonal * 0.3) * Math.exp(-t * 22)
          : pad === 2 || pad === 3 || pad === 9 || pad === 15
            ? noise * Math.exp(-t * (pad === 3 ? 9 : 50)) * 0.45
            : tonal * Math.exp(-t * 25);
    return value * attack * release * 0.7 || 0;
  });
  return { id: `sample-${pad}`, name: names[pad] ?? "Tone", sampleRate, pcm };
}
export function createLegacyDemoProject(): LegacyProject {
  const samples = Array.from({ length: 16 }, (_, i) => makeSample(i));
  const clipNames = ["Foundation", "Variation", "Break", "Full kit"];
  const clips = clipNames.map((name, scene) => ({
    id: `clip-${scene}`,
    name,
    length: 16 as const,
    steps: Array.from({ length: 16 }, (_, step) => [
      ...(step % 4 === 0 && scene !== 2 ? [{ step, pad: 0, velocity: 0.9, probability: 1 }] : []),
      ...(step % 8 === 4 ? [{ step, pad: 1, velocity: 0.8, probability: 1 }] : []),
      ...(step % 2 === 0
        ? [{ step, pad: 2, velocity: step % 4 === 0 ? 0.5 : 0.35, probability: 1 }]
        : []),
      ...(scene === 1 && step === 14 ? [{ step, pad: 7, velocity: 0.6, probability: 1 }] : []),
      ...(scene === 3 && step % 4 === 2 ? [{ step, pad: 13, velocity: 0.5, probability: 1 }] : []),
    ]).flat(),
  }));
  return LegacyProjectSchema.parse({
    format: "xmp-project",
    version: 1,
    id: "first-light",
    name: "First light",
    bpm: 112,
    swing: 0,
    master: 0.55,
    pads: samples.map((sample, i) => ({ id: `pad-${i}`, name: sample.name, sampleId: sample.id })),
    samples,
    tracks: [{ id: "drums", name: "Drum rack", muted: false, volume: 0.8, clips }],
    scenes: ["Intro", "Verse", "Break", "Drop"].map((name, i) => ({
      id: `scene-${i}`,
      name,
      clips: { drums: `clip-${i}` },
    })),
  });
}

export function createDemoProject(): Project {
  return migrateProject(createLegacyDemoProject());
}
// A track's machine counts as chosen once it has one, its own kit, or any notes.
// A track with none of them (a new song's empty tracks) still plays the project's
// kit, as before, but the Sound page asks which machine it should be. Old
// projects' drum tracks have notes, so they stay kits.
export function machineChosen(track: Project["tracks"][number]): boolean {
  return (
    !!track.machine ||
    !!track.pads ||
    track.clips.some((clip) => clip.steps.length > 0 || (clip.sequence?.notes.length ?? 0) > 0)
  );
}
// A pad-sampler track is a Kit (pads with their own sounds) or a Sampler (one
// sample, played as notes or chopped into slices). Older Samplers have no mode
// but play chromatically: they are keys.
export function samplerMode(track: Project["tracks"][number]): "keys" | "slices" | undefined {
  if (track.machine && track.machine.id !== "xmp.sampler") return undefined;
  const mode = track.machine?.state.mode;
  if (mode === "keys" || mode === "slices") return mode;
  return track.pads?.[0]?.playback?.mode === "chromatic" ? "keys" : undefined;
}
export function expandSong(project: Project): Project {
  const next = structuredClone(project);
  while (next.tracks.length < 8) {
    let index = 1;
    while (next.tracks.some((track) => track.id === `track-${index}`)) index++;
    next.tracks.push({
      id: `track-${index}`,
      name: `Track ${next.tracks.length + 1}`,
      muted: false,
      volume: 0.8,
      clips: [],
    });
  }
  while (next.scenes.length < 16) {
    let index = 0;
    while (next.scenes.some((scene) => scene.id === `scene-${index}`)) index++;
    next.scenes.push({ id: `scene-${index}`, name: `Scene ${next.scenes.length + 1}`, clips: {} });
  }
  for (const track of next.tracks)
    for (const [index, scene] of next.scenes.entries())
      if (!scene.clips[track.id]) {
        const unused = track.clips.find(
          (clip) => !next.scenes.some((scene) => scene.clips[track.id] === clip.id),
        );
        if (unused) {
          scene.clips[track.id] = unused.id;
          continue;
        }
        let id = `${track.id.slice(0, 40)}-clip-${index}`,
          suffix = 0;
        while (track.clips.some((clip) => clip.id === id))
          id = `${track.id.slice(0, 40)}-clip-${index}-${++suffix}`;
        const clip = { id, name: scene.name, length: 16 as const, steps: [] };
        track.clips.push(clip);
        scene.clips[track.id] = clip.id;
      }
  return ProjectSchema.parse(next);
}

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const length = channels[0]?.length ?? 0;
  if (
    !channels.length ||
    channels.length > 2 ||
    channels.some((channel) => channel.length !== length)
  )
    throw new Error("Invalid WAV channels");
  const buffer = new ArrayBuffer(44 + length * channels.length * 2);
  const view = new DataView(buffer);
  const string = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  string(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  string(8, "WAVE");
  string(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  string(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  for (let frame = 0; frame < length; frame++)
    for (let channel = 0; channel < channels.length; channel++) {
      const value = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
      view.setInt16(
        44 + (frame * channels.length + channel) * 2,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
    }
  return buffer;
}

export {
  type ControlAction,
  ControlActionSchema,
  type ControlPage,
  ControlPageSchema,
} from "./control-actions.ts";
