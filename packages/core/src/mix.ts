import { type Project, ProjectSchema } from "./index.ts";
import { type Effect, emptyMix, type Mix } from "./mix-schema.ts";
export function editMix(project: Project, change: (mix: Mix) => void): Project {
  const next = structuredClone(project);
  next.mix ??= emptyMix();
  change(next.mix);
  return ProjectSchema.parse(next);
}
export function mixEffects(mix: Mix): { prefix: string; effect: Effect }[] {
  return [
    ...Object.entries(mix.tracks).flatMap(([id, t]) =>
      t.inserts.map((effect) => ({ prefix: `track.${id}.insert.${effect.id}`, effect })),
    ),
    ...mix.returns.flatMap((effects, i) =>
      effects.map((effect) => ({ prefix: `return.${i}.insert.${effect.id}`, effect })),
    ),
  ];
}
export function mixParameterBase(project: Project, id: string): number | undefined {
  if (!project.mix) return;
  for (const t of project.tracks) {
    const strip = project.mix.tracks[t.id];
    if (id === `track.${t.id}.pan`) return strip?.pan ?? 0.5;
    for (let i = 0; i < 2; i++) if (id === `track.${t.id}.send.${i}`) return strip?.sends[i] ?? 0;
  }
  for (const { prefix, effect } of mixEffects(project.mix)) {
    if (id === `${prefix}.bypass`) return Number(effect.bypass);
    for (const [key, value] of Object.entries(effect.params))
      if (id === `${prefix}.${key}`) return value;
  }
}
// This graph deliberately supports only post-fader sends and return-to-master routes.
export function validateRoute(from: string, to: string, project: Project) {
  const source = project.tracks.some((t) => t.id === from),
    send = /^return\.[01]$/.test(from);
  if (!((source && (to === "master" || /^return\.[01]$/.test(to))) || (send && to === "master")))
    throw new Error("Unsupported route: feedback and return cross-routing are disabled");
  return { from, to };
}
export function tempoAt(project: Project, step: number) {
  let bpm = project.bpm;
  for (const t of project.mix?.tempos ?? []) {
    if (step < t.step) break;
    bpm = t.bpm;
  }
  return bpm;
}
export function musicalSeconds(project: Project, step: number) {
  if (!Number.isFinite(step) || step < 0 || step > 1000100)
    throw new Error("Invalid musical position");
  let seconds = 0,
    previous = 0,
    bpm = project.bpm;
  for (const t of project.mix?.tempos ?? []) {
    if (t.step > step) break;
    seconds += ((t.step - previous) * 15) / bpm;
    previous = t.step;
    bpm = t.bpm;
  }
  return seconds + ((step - previous) * 15) / bpm;
}
export function musicalPosition(project: Project, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid elapsed time");
  let elapsed = 0,
    previous = 0,
    bpm = project.bpm;
  for (const t of project.mix?.tempos ?? []) {
    const span = ((t.step - previous) * 15) / bpm;
    if (elapsed + span > seconds) break;
    elapsed += span;
    previous = t.step;
    bpm = t.bpm;
  }
  return previous + ((seconds - elapsed) * bpm) / 15;
}
