import { type Project, ProjectSchema } from "./index.ts";
import { machines } from "./machines.ts";
import { mixEffects, mixParameterBase } from "./mix.ts";
export type ParameterSource = "base" | "automation" | "stepLock" | "macro" | "lfo";
export interface ParameterSources {
  base: number;
  automation?: number;
  stepLock?: number;
  macro?: number;
  lfo?: number;
}
export interface ParameterDefinition {
  id: string;
  name: string;
  min: 0;
  max: 1;
  unit: "normalized";
  defaultValue: number;
  step?: number;
  smoothing: { readonly type: "one-pole"; readonly timeMs: 10 };
}
const smoothing = Object.freeze({ type: "one-pole" as const, timeMs: 10 as const });
export function parameterRegistry(project: Project): readonly ParameterDefinition[] {
  return [
    {
      id: "master.gain",
      name: "Master gain",
      min: 0,
      max: 1,
      unit: "normalized",
      defaultValue: 0.55,
      smoothing,
    },
    ...(project.mix
      ? [
          ...project.tracks.flatMap((t) =>
            ["pan", "send.0", "send.1"].map((key) => ({
              id: `track.${t.id}.${key}`,
              name: `${t.name} ${key}`,
              min: 0 as const,
              max: 1 as const,
              unit: "normalized" as const,
              defaultValue: key === "pan" ? 0.5 : 0,
              smoothing,
            })),
          ),
          ...mixEffects(project.mix)
            .filter(
              ({ prefix }) =>
                prefix.startsWith("return.") ||
                project.tracks.some((t) => prefix.startsWith(`track.${t.id}.`)),
            )
            .flatMap(({ prefix, effect }) =>
              [...Object.keys(effect.params), "bypass"].map((key) => ({
                id: `${prefix}.${key}`,
                name: `${effect.kind} ${key}`,
                min: 0 as const,
                max: 1 as const,
                unit: "normalized" as const,
                defaultValue: key === "bypass" ? Number(effect.bypass) : (effect.params[key] ?? 0),
                smoothing,
              })),
            ),
        ]
      : []),
    ...project.tracks.flatMap((track) => [
      {
        id: `track.${track.id}.gain`,
        name: `${track.name} gain`,
        min: 0 as const,
        max: 1 as const,
        unit: "normalized" as const,
        defaultValue: 0.8,
        smoothing,
      },
      {
        id: `track.${track.id}.effect.gain`,
        name: `${track.name} effect gain`,
        min: 0 as const,
        max: 1 as const,
        unit: "normalized" as const,
        defaultValue: 0.5,
        smoothing,
      },
      ...machineParameters(track),
    ]),
  ];
}
export function machineParameters(track: Project["tracks"][number]): ParameterDefinition[] {
  const definition = machines.get(track.machine);
  return (definition?.automation ? definition.parameters : []).map((p) => ({
    id: `track.${track.id}.machine.${definition?.id}.v${definition?.version}.${p.id}`,
    name: `${track.name} ${p.name} (${p.unit})`,
    min: 0,
    max: 1,
    unit: "normalized",
    defaultValue: (p.defaultValue - p.min) / (p.max - p.min),
    ...(p.step ? { step: p.step / (p.max - p.min) } : {}),
    smoothing,
  }));
}
export function machineParameter(project: Project, id: string) {
  for (const track of project.tracks) {
    const definition = machines.get(track.machine);
    const parameter = definition?.parameters.find(
      (p) => id === `track.${track.id}.machine.${definition.id}.v${definition.version}.${p.id}`,
    );
    if (parameter) return { track, parameter };
  }
  return undefined;
}
export function resolveParameter(sources: ParameterSources): number {
  for (const source of ["base", "automation", "stepLock", "macro", "lfo"] as const) {
    const value = sources[source];
    if (value === undefined && source !== "base") continue;
    if (
      !Number.isFinite(value) ||
      value === undefined ||
      value < (source === "macro" || source === "lfo" ? -1 : 0) ||
      value > 1
    )
      throw new Error(`Invalid ${source} parameter value`);
  }
  const replacement = sources.stepLock ?? sources.automation ?? sources.base;
  return Math.max(0, Math.min(1, replacement + (sources.macro ?? 0) + (sources.lfo ?? 0)));
}
export function parameterSources(
  project: Project,
  id: string,
  knownDefinition?: ParameterDefinition,
): ParameterSources {
  const definition =
    knownDefinition ?? parameterRegistry(project).find((parameter) => parameter.id === id);
  if (!definition) throw new Error(`Unknown parameter ${id}`);
  const assigned = project.parameters.find((parameter) => parameter.id === id);
  if (assigned) return assigned;
  const track = project.tracks.find((track) => id === `track.${track.id}.gain`);
  const m = id.includes(".machine.") ? machineParameter(project, id) : undefined;
  return {
    base:
      id === "master.gain"
        ? project.master
        : m
          ? (Number(m.track.machine?.state[m.parameter.id] ?? m.parameter.defaultValue) -
              m.parameter.min) /
            (m.parameter.max - m.parameter.min)
          : (mixParameterBase(project, id) ?? track?.volume ?? definition.defaultValue),
  };
}
export function parameterValue(project: Project, id: string): number {
  return resolveParameter(parameterSources(project, id));
}
export function setParameter(
  project: Project,
  id: string,
  value: number,
  source: ParameterSource = "base",
): Project {
  const sources = parameterSources(project, id);
  if (!["base", "automation", "stepLock", "macro", "lfo"].includes(source))
    throw new Error("Unknown parameter source");
  const discrete = source === "base" ? machineParameter(project, id) : undefined;
  if (discrete?.parameter.step && Number.isFinite(value) && value >= 0 && value <= 1) {
    const p = discrete.parameter;
    const native = Math.max(
      p.min,
      Math.min(
        p.max,
        p.min + Math.round((value * (p.max - p.min)) / (p.step ?? 1)) * (p.step ?? 1),
      ),
    );
    value = (native - p.min) / (p.max - p.min);
  }
  const updated = { ...sources, [source]: value };
  resolveParameter(updated);
  const next = structuredClone(project);
  next.parameters = next.parameters.filter((parameter) => parameter.id !== id);
  next.parameters.push({ id, ...updated });
  if (source === "base") {
    if (id === "master.gain") next.master = value;
    const track = next.tracks.find((track) => id === `track.${track.id}.gain`);
    if (track) track.volume = value;
    const m = machineParameter(next, id);
    if (m?.track.machine)
      m.track.machine.state[m.parameter.id] =
        m.parameter.min + value * (m.parameter.max - m.parameter.min);
  }
  return ProjectSchema.parse(next);
}
export function clearParameterSource(
  project: Project,
  id: string,
  source: Exclude<ParameterSource, "base">,
): Project {
  parameterSources(project, id);
  const next = structuredClone(project);
  const assigned = next.parameters.find((parameter) => parameter.id === id);
  if (assigned) delete assigned[source];
  return ProjectSchema.parse(next);
}

export function smoothParameter(
  current: number,
  target: number,
  sampleRate: number,
  timeMs: number,
  frames: number,
): number {
  if (
    ![current, target, sampleRate, timeMs, frames].every(Number.isFinite) ||
    current < 0 ||
    current > 1 ||
    target < 0 ||
    target > 1 ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    timeMs < 0 ||
    timeMs > 10000 ||
    !Number.isInteger(frames) ||
    frames < 0 ||
    frames > 2100000
  )
    throw new Error("Invalid parameter smoothing input");
  if (frames === 0) return current;
  return timeMs === 0
    ? target
    : target + (current - target) * Math.exp(-frames / ((sampleRate * timeMs) / 1000));
}
export function parameterSmoothingMs(project: Project, id: string): number {
  const definition = parameterRegistry(project).find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown parameter ${id}`);
  return definition.smoothing.timeMs;
}
export function advanceParameter(
  project: Project,
  id: string,
  current: number,
  frames: number,
  sampleRate = 48000,
): number {
  return smoothParameter(
    current,
    parameterValue(project, id),
    sampleRate,
    parameterSmoothingMs(project, id),
    frames,
  );
}
