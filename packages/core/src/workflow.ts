import { type Project, ProjectSchema } from "./index.ts";
import { trackPads } from "./pads.ts";
import { sceneLength } from "./performance.ts";
import { emptySequence, type SequenceNote } from "./sequence-schema.ts";

export const conditions = [
  "always",
  "first",
  "not-first",
  "fill",
  "not-fill",
  "every-2",
  "every-4",
] as const;
export function selectedHit(
  project: Project,
  trackId: string,
  clipId: string | undefined,
  pad: number,
  step: number,
  note?: number,
) {
  const clip = project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  return (
    clip?.sequence?.notes.find(
      (n) =>
        Math.floor(n.position) === step && (note === undefined ? n.pad === pad : n.note === note),
    ) ??
    clip?.steps.find(
      (s) =>
        s.step === step && (note === undefined ? s.pad === pad : (s.note ?? 48 + s.pad) === note),
    )
  );
}
export function expressionEdit(
  project: Project,
  trackId: string,
  clipId: string,
  pad: number,
  step: number,
  note: number | undefined,
  patch: Partial<Pick<SequenceNote, "velocity" | "probability" | "duration" | "condition">>,
) {
  const clip = project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error("Select a clip first");
  let sequenceNote = clip.sequence?.notes.find(
    (n) =>
      Math.floor(n.position) === step && (note === undefined ? n.pad === pad : n.note === note),
  );
  const entry = clip.steps.find(
    (s) =>
      s.step === step && (note === undefined ? s.pad === pad : (s.note ?? 48 + s.pad) === note),
  );
  if (!sequenceNote && !entry) throw new Error("Select an existing hit first");
  if (entry && patch.condition !== undefined) {
    clip.sequence ??= emptySequence();
    let id = `hit-${step}-${pad}`;
    while (clip.sequence.notes.some((n) => n.id === id)) id += "x";
    sequenceNote = {
      id,
      pad: entry.pad,
      note: entry.note ?? note ?? trackPads(project, trackId)[pad]?.playback?.rootNote ?? 60,
      position: step,
      duration: entry.duration ?? 1,
      velocity: entry.velocity,
      probability: entry.probability,
      microtiming: 0,
      condition: "always",
    };
    clip.sequence.notes.push(sequenceNote);
    clip.steps = clip.steps.filter((s) => s !== entry);
  }
  if (sequenceNote) Object.assign(sequenceNote, patch);
  else if (entry) {
    if (patch.velocity !== undefined) entry.velocity = patch.velocity;
    if (patch.probability !== undefined) entry.probability = patch.probability;
    if (patch.duration !== undefined) entry.duration = patch.duration;
  }
  return ProjectSchema.parse(project);
}
export function recordPosition(position: number, length: number, strength: number) {
  if (
    ![position, length, strength].every(Number.isFinite) ||
    length < 1 ||
    strength < 0 ||
    strength > 1
  )
    throw new Error("Invalid recording position");
  const at = ((position % length) + length) % length;
  const moved = at + (Math.round(at) - at) * strength;
  return moved >= length ? 0 : moved;
}
export function moveBlock<T>(blocks: readonly T[], from: number, to: number) {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= blocks.length ||
    to >= blocks.length
  )
    throw new Error("Invalid song block");
  const next = [...blocks];
  const block = next.splice(from, 1)[0];
  if (block !== undefined) next.splice(to, 0, block);
  return next;
}

export function chainBarRanges(project: Project) {
  let bar = 1;
  return (project.performance?.chain ?? []).map((part) => {
    const start = bar;
    bar += (sceneLength(project, part.sceneId) / 16) * part.repeats;
    return { start, end: bar - 1 };
  });
}

// A chromatic Sampler is one sound across its playable note pads.
export function syncSamplerSound(project: Project, trackId: string, pad: number) {
  const track = project.tracks.find((t) => t.id === trackId);
  if (track?.machine?.id !== "xmp.sampler" || track.pads?.[0]?.playback?.mode !== "chromatic")
    return project;
  const source = track.pads[pad];
  if (source) track.pads = track.pads.map((p) => ({ ...structuredClone(source), id: p.id }));
  return project;
}
