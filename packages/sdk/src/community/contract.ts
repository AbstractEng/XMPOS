import { z } from "zod";
export const SDK_API_VERSION = 2 as const;
export const DSP_ABI_VERSION = 1 as const;
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const revision = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/);
export const Dimension = z.enum(["pressure", "pitch", "timbre"]);
export type Dimension = z.infer<typeof Dimension>;
export const ParameterSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .refine((v) => !["constructor", "prototype"].includes(v), "Reserved parameter identity"),
    name: z.string().min(1).max(40),
    unit: z.enum(["linear", "Hz", "semitones"]),
    min: z.number().finite().min(-20000).max(20000),
    max: z.number().finite().min(-20000).max(20000),
    default: z.number().finite(),
  })
  .strict()
  .refine(
    (p) => p.min < p.max && p.default >= p.min && p.default <= p.max,
    "Invalid parameter range",
  );
export const CommunityManifest = z
  .object({
    format: z.literal("xmp-module"),
    apiVersion: z.literal(2),
    dspAbi: z.literal(1),
    id: identifier,
    name: z.string().min(1).max(80),
    version: revision,
    stateVersion: z.number().int().min(1).max(1000),
    kind: z.enum(["instrument", "effect"]),
    architecture: z.enum(["portable", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]),
    adapter: z.enum(["declarative-v1", "trusted-native-v1", "vst3", "cv", "audio-input"]),
    license: z.enum(["MIT", "Apache-2.0", "BSD-3-Clause"]),
    capabilities: z
      .array(
        z.enum([
          "notes",
          "velocity",
          "audio-output",
          "virtual-audio-input",
          "simulated-controls",
          "pressure",
          "pitch",
          "timbre",
        ]),
      )
      .max(8),
    parameters: z.array(ParameterSchema).max(16),
    dependencies: z
      .array(
        z
          .object({ id: identifier, version: revision, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const items of [
      m.capabilities,
      m.parameters.map((p) => p.id),
      m.dependencies.map((d) => d.id),
    ])
      if (new Set(items).size !== items.length)
        ctx.addIssue({ code: "custom", message: "Duplicate manifest identity" });
    if (!m.capabilities.includes("audio-output"))
      ctx.addIssue({ code: "custom", message: "Audio module requires audio-output capability" });
    if (m.kind === "instrument" && !m.capabilities.includes("notes"))
      ctx.addIssue({ code: "custom", message: "Instrument requires notes capability" });
    if (m.kind === "effect" && !m.capabilities.includes("virtual-audio-input"))
      ctx.addIssue({ code: "custom", message: "Effect requires virtual-audio-input capability" });
  });
export type CommunityManifest = z.infer<typeof CommunityManifest>;
export interface HostProfile {
  apiVersion: 2;
  dspAbi: 1;
  architecture: string;
  adapters: readonly string[];
  capabilities: readonly string[];
}
export const macDevelopmentProfile: HostProfile = Object.freeze({
  apiVersion: 2,
  dspAbi: 1,
  architecture: "portable",
  adapters: ["declarative-v1"],
  capabilities: [
    "notes",
    "velocity",
    "audio-output",
    "virtual-audio-input",
    "simulated-controls",
    "pressure",
    "pitch",
    "timbre",
  ],
});
export const adapterPolicies = Object.freeze({
  "declarative-v1": {
    execution: "trusted interpreter; package data only",
    isolation: "bounded DSP graph",
    available: true,
    physicalAccess: false,
  },
  "trusted-native-v1": {
    execution: "trusted code inside native audio host",
    isolation: "host fault on DSP crash",
    available: false,
    physicalAccess: false,
  },
  vst3: {
    execution: "requires reviewed VST3 host, ABI and licence",
    isolation: "unqualified",
    available: false,
    physicalAccess: false,
  },
  cv: {
    execution: "requires reviewed device/calibration adapter",
    isolation: "unqualified",
    available: false,
    physicalAccess: false,
  },
  "audio-input": {
    execution: "requires explicitly approved source adapter",
    isolation: "unqualified",
    available: false,
    physicalAccess: false,
  },
});
export function negotiateModule(input: unknown, profile: HostProfile = macDevelopmentProfile) {
  const m = CommunityManifest.parse(input);
  if (
    m.apiVersion !== profile.apiVersion ||
    m.dspAbi !== profile.dspAbi ||
    (m.architecture !== "portable" && m.architecture !== profile.architecture)
  )
    throw new Error("Incompatible API, DSP ABI or architecture");
  if (!profile.adapters.includes(m.adapter) || !adapterPolicies[m.adapter].available)
    throw new Error(`Adapter ${m.adapter} unavailable; no native, VST or device code loaded`);
  if (m.architecture !== "portable")
    throw new Error("Declarative packages must declare portable architecture");
  for (const c of m.capabilities)
    if (!profile.capabilities.includes(c)) throw new Error(`Undeclared host capability: ${c}`);
  return {
    manifest: m,
    capabilities: [...m.capabilities],
    physicalAccess: false as const,
    adapter: m.adapter,
  };
}
export function negotiateExpression(
  source: readonly string[],
  instrument: readonly string[],
  requested: readonly Dimension[],
) {
  if (requested.length > 3 || new Set(requested).size !== requested.length)
    throw new Error("Invalid expression request");
  const available = requested.filter((d) => source.includes(d) && instrument.includes(d));
  return { available, unavailable: requested.filter((d) => !available.includes(d)) };
}
const unit = z.number().finite().min(0).max(1),
  time = z.number().finite().min(0).max(60),
  noteId = z.number().int().min(1).max(0x7fffffff);
export const MusicalEvent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("on"),
      id: noteId,
      timestamp: time,
      note: z.number().int().min(0).max(127),
      velocity: unit,
    })
    .strict(),
  z.object({ kind: z.literal("off"), id: noteId, timestamp: time }).strict(),
  z
    .object({
      kind: z.literal("expression"),
      id: noteId,
      timestamp: time,
      dimension: Dimension,
      value: z.number().finite().min(-48).max(48),
    })
    .strict()
    .refine(
      (e) => e.dimension === "pitch" || (e.value >= 0 && e.value <= 1),
      "Pressure/timbre must be normalized",
    ),
]);
export type MusicalEvent = z.infer<typeof MusicalEvent>;
export const TakeSchema = z
  .array(MusicalEvent)
  .max(256)
  .superRefine((events, ctx) => {
    const active = new Set<number>(),
      seen = new Set<number>();
    let previous = 0;
    for (const e of events) {
      if (e.timestamp < previous)
        ctx.addIssue({ code: "custom", message: "Take timestamps must be ordered" });
      previous = e.timestamp;
      if (e.kind === "on") {
        if (seen.has(e.id)) ctx.addIssue({ code: "custom", message: "Note identity reused" });
        seen.add(e.id);
        active.add(e.id);
      } else if (!active.has(e.id))
        ctx.addIssue({ code: "custom", message: "Unknown note ownership" });
      if (e.kind === "off") active.delete(e.id);
    }
  });
export function validateTake(
  events: unknown,
  source: readonly string[],
  instrument: readonly string[],
) {
  const parsed = TakeSchema.parse(events);
  for (const e of parsed) {
    if (e.kind === "on" && (!source.includes("notes") || !instrument.includes("notes")))
      throw new Error("Notes capability unavailable before delivery");
    if (
      e.kind === "expression" &&
      negotiateExpression(source, instrument, [e.dimension]).unavailable.length
    )
      throw new Error(`Expression ${e.dimension} unavailable before delivery`);
  }
  return parsed;
}
export class ExpressionTake {
  private events: MusicalEvent[] = [];
  private source: readonly string[];
  private instrument: readonly string[];
  constructor(source: readonly string[], instrument: readonly string[]) {
    this.source = [...source];
    this.instrument = [...instrument];
  }
  append(input: unknown) {
    const candidate = validateTake(
      [...this.events, MusicalEvent.parse(input)],
      this.source,
      this.instrument,
    );
    this.events = candidate;
  }
  snapshot() {
    return structuredClone(this.events);
  }
}
