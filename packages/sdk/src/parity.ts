import { z } from "zod";
import { groovePosition } from "../../core/src/sequencer.ts";
import type { CommunityManifest, MusicalEvent } from "./community/contract.ts";
import { digest, validatePackage } from "./community/package.ts";
import { CommunityProcessor } from "./community/program.ts";

const id = z.number().int().min(1).max(0x7fffffff);
const base = { frame: z.number().int().min(0).max(47999) };
export const ParityPlanSchema = z
  .object({
    format: z.literal("xmp-dsp-parity"),
    version: z.literal(1),
    sampleRate: z.literal(48000),
    frames: z.number().int().min(480).max(48000),
    source: z.enum(["sine", "triangle", "virtual-input"]),
    gain: z.number().min(0).max(1),
    cutoff: z.number().min(20).max(20000),
    events: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...base,
              kind: z.literal("on"),
              id,
              note: z.number().int().min(0).max(127),
              value: z.number().min(0).max(1),
            })
            .strict(),
          z.object({ ...base, kind: z.literal("off"), id }).strict(),
          z
            .object({
              ...base,
              kind: z.literal("expression"),
              id,
              dimension: z.enum(["pressure", "pitch", "timbre"]),
              value: z.number().finite(),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("parameter"),
              parameter: z.enum(["gain", "cutoff"]),
              value: z.number().finite(),
            })
            .strict(),
          z.object({ ...base, kind: z.literal("panic") }).strict(),
        ]),
      )
      .max(256),
  })
  .strict()
  .superRefine((p, ctx) => {
    let last = -1;
    for (const e of p.events) {
      if (e.frame < last || e.frame >= p.frames)
        ctx.addIssue({ code: "custom", message: "Event order or frame outside render" });
      last = e.frame;
      if (
        e.kind === "expression" &&
        (e.dimension === "pitch" ? Math.abs(e.value) > 48 : e.value < 0 || e.value > 1)
      )
        ctx.addIssue({ code: "custom", message: "Expression outside range" });
      if (
        e.kind === "parameter" &&
        (e.parameter === "gain" ? e.value < 0 || e.value > 1 : e.value < 20 || e.value > 20000)
      )
        ctx.addIssue({ code: "custom", message: "Parameter outside range" });
      if (p.source === "virtual-input" && ["on", "off", "expression"].includes(e.kind))
        ctx.addIssue({ code: "custom", message: "Effect cannot receive note events" });
    }
  });
export type ParityPlan = z.infer<typeof ParityPlanSchema>;
export interface ParityTrace {
  frame: number;
  op: number;
  id: number;
  arg: number;
  value: number;
  accepted: boolean;
}
export interface ParityResult {
  sampleRate: number;
  pcm: Float32Array;
  trace: ParityTrace[];
  activeVoices: number;
}
export const parityScope = Object.freeze({
  profile: "declarative-v1-offline-48000-v1",
  preparedEventDelivery: true,
  nativeMusicalSequencerQualified: false,
  realtimeQualified: false,
  hardwareQualified: false,
  maximumAbsoluteError: 0.000002,
  maximumRmsError: 0.0000002,
});
export function eventRecord(e: ParityPlan["events"][number]): Omit<ParityTrace, "accepted"> {
  return {
    frame: e.frame,
    op: { on: 1, off: 2, expression: 3, parameter: 4, panic: 5 }[e.kind],
    id: "id" in e ? e.id : 0,
    arg:
      e.kind === "on"
        ? e.note
        : e.kind === "expression"
          ? { pressure: 1, pitch: 2, timbre: 3 }[e.dimension]
          : e.kind === "parameter"
            ? e.parameter === "gain"
              ? 1
              : 2
            : 0,
    value: "value" in e ? e.value : 0,
  };
}
export async function packagePlan(input: unknown): Promise<ParityPlan> {
  const { manifest: m, program: p } = await validatePackage(input);
  const state = Object.fromEntries(m.parameters.map((p) => [p.id, p.default]));
  const value = (b: typeof p.gain) => (typeof b === "number" ? b : (state[b.parameter] ?? 0));
  return ParityPlanSchema.parse({
    format: "xmp-dsp-parity",
    version: 1,
    sampleRate: 48000,
    frames: 24000,
    source: p.source,
    gain: value(p.gain),
    cutoff: value(p.cutoff),
    events:
      m.kind === "effect"
        ? []
        : [
            { kind: "on", frame: 0, id: 1, note: 69, value: 1 },
            { kind: "off", frame: 12000, id: 1 },
          ],
  });
}
export function referenceParity(input: unknown): ParityResult {
  const p = ParityPlanSchema.parse(input);
  const manifest: CommunityManifest = {
    format: "xmp-module",
    apiVersion: 2,
    dspAbi: 1,
    id: "parity",
    name: "Original parity fixture",
    version: "1.0.0",
    stateVersion: 1,
    kind: p.source === "virtual-input" ? "effect" : "instrument",
    architecture: "portable",
    adapter: "declarative-v1",
    license: "Apache-2.0",
    capabilities:
      p.source === "virtual-input"
        ? ["virtual-audio-input", "audio-output"]
        : ["notes", "velocity", "audio-output", "pressure", "pitch", "timbre"],
    parameters: [
      { id: "gain", name: "Gain", unit: "linear", min: 0, max: 1, default: p.gain },
      { id: "cutoff", name: "Cutoff", unit: "Hz", min: 20, max: 20000, default: p.cutoff },
    ],
    dependencies: [],
  };
  // Metadata is owned by the SDK. Imported executable code is never accepted.
  const processor = new CommunityProcessor(
    {
      ...manifest,
      capabilities: [...manifest.capabilities],
      parameters: [...manifest.parameters],
      dependencies: [],
    },
    {
      format: "xmp-dsp-graph",
      version: 1,
      source: p.source,
      gain: { parameter: "gain" },
      cutoff: { parameter: "cutoff" },
      requires: [],
      migrations: [],
    },
    { gain: p.gain, cutoff: p.cutoff },
  );
  const pcm = new Float32Array(p.frames),
    sample = new Float32Array(1),
    trace: ParityTrace[] = [];
  let next = 0;
  for (let frame = 0; frame < p.frames; frame++) {
    while (p.events[next]?.frame === frame) {
      const e = p.events[next++];
      if (!e) break;
      let accepted = true;
      if (e.kind === "on")
        accepted = processor.noteOn({
          id: e.id,
          note: e.note,
          velocity: e.value,
          durationFrames: 0,
        });
      if (e.kind === "off" || e.kind === "expression") {
        accepted = processor.snapshot().some((v) => v.id === e.id);
        if (accepted && e.kind === "off") processor.noteOff(e.id);
        if (accepted && e.kind === "expression") processor.expression(e.id, e.dimension, e.value);
      }
      if (e.kind === "parameter") processor.setParameter(e.parameter, e.value);
      if (e.kind === "panic") processor.panic();
      trace.push({ ...eventRecord(e), frame, accepted });
    }
    if (p.source === "virtual-input") {
      sample[0] = frame === 0 ? 0.5 : 0;
      processor.processInput(sample, sample, 1);
    } else processor.process(sample, 1);
    pcm[frame] = sample[0] ?? 0;
  }
  return { sampleRate: 48000, pcm, trace, activeVoices: processor.snapshot().length };
}
const TraceSchema = z
  .object({
    frame: z.number().int().min(0).max(47999),
    op: z.number().int().min(1).max(5),
    id: z.number().int().min(0).max(0x7fffffff),
    arg: z.number().int().min(0).max(127),
    value: z.number().finite(),
    accepted: z.boolean(),
  })
  .strict();
function validateCapture(r: ParityResult) {
  if (
    r.sampleRate !== 48000 ||
    !(r.pcm instanceof Float32Array) ||
    r.pcm.length < 480 ||
    r.pcm.length > 48000 ||
    !Array.isArray(r.trace) ||
    r.trace.length > 256 ||
    !Number.isInteger(r.activeVoices) ||
    r.activeVoices < 0 ||
    r.activeVoices > 32
  )
    throw new Error("Invalid parity capture shape");
  for (const e of r.trace) {
    TraceSchema.parse(e);
    if (e.frame >= r.pcm.length) throw new Error("Invalid capture event frame");
  }
}
export async function parityIdentity(result: ParityResult) {
  validateCapture(result);
  const bytes = new Uint8Array(result.pcm.length * 4),
    view = new DataView(bytes.buffer);
  result.pcm.forEach((v, i) => {
    if (!Number.isFinite(v) || Math.abs(v) > 1) throw new Error("Invalid parity PCM");
    view.setFloat32(i * 4, v, true);
  });
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    sampleRate: result.sampleRate,
    frames: result.pcm.length,
    activeVoices: result.activeVoices,
    pcmSha256: Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join(""),
    traceSha256: await digest(JSON.stringify(result.trace)),
  };
}
export function compareParity(reference: ParityResult, candidate: ParityResult) {
  validateCapture(reference);
  validateCapture(candidate);
  if (
    reference.sampleRate !== 48000 ||
    candidate.sampleRate !== 48000 ||
    reference.pcm.length !== candidate.pcm.length ||
    !reference.pcm.length
  )
    throw new Error("Parity capture shape mismatch");
  let maximum = 0,
    sum = 0;
  for (let i = 0; i < reference.pcm.length; i++) {
    const a = reference.pcm[i] ?? NaN,
      b = candidate.pcm[i] ?? NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 1 || Math.abs(b) > 1)
      throw new Error("Invalid parity PCM");
    const d = Math.abs(a - b);
    maximum = Math.max(maximum, d);
    sum += d * d;
  }
  const rms = Math.sqrt(sum / reference.pcm.length),
    eventsMatch = JSON.stringify(reference.trace) === JSON.stringify(candidate.trace),
    voicesMatch = reference.activeVoices === candidate.activeVoices;
  return {
    ...parityScope,
    passed:
      eventsMatch &&
      voicesMatch &&
      maximum <= parityScope.maximumAbsoluteError &&
      rms <= parityScope.maximumRmsError,
    eventsMatch,
    voicesMatch,
    maximumAbsoluteError: maximum,
    rmsError: rms,
    frames: reference.pcm.length,
  };
}
export function parityFixtures(): { id: string; plan: ParityPlan; expectedFrames: number[] }[] {
  const make = (
    id: string,
    source: ParityPlan["source"],
    events: ParityPlan["events"],
    expectedFrames = events.map((e) => e.frame),
  ) => ({
    id,
    plan: ParityPlanSchema.parse({
      format: "xmp-dsp-parity",
      version: 1,
      sampleRate: 48000,
      frames: 24000,
      source,
      gain: 0.25,
      cutoff: 8000,
      events,
    }),
    expectedFrames,
  });
  const eventsFromTake = (take: MusicalEvent[]): ParityPlan["events"] =>
    take.map((e) =>
      e.kind === "on"
        ? {
            kind: "on",
            frame: Math.round(e.timestamp * 48000),
            id: e.id,
            note: e.note,
            value: e.velocity,
          }
        : e.kind === "off"
          ? { kind: "off", frame: Math.round(e.timestamp * 48000), id: e.id }
          : {
              kind: "expression",
              frame: Math.round(e.timestamp * 48000),
              id: e.id,
              dimension: e.dimension,
              value: e.value,
            },
    );
  // Independent oracle: at 120 BPM, swing 62%, the second sixteenth starts at 7440.
  const swung = Math.round(groovePosition(1, 0.24) * 6000);
  return [
    make(
      "sine-note-release",
      "sine",
      eventsFromTake([
        { kind: "on", id: 1, timestamp: 0, note: 69, velocity: 0.8 },
        { kind: "off", id: 1, timestamp: 0.25 },
      ]),
    ),
    make("triangle-expression-parameters", "triangle", [
      { kind: "on", frame: 0, id: 1, note: 48, value: 0.7 },
      { kind: "on", frame: 1200, id: 2, note: 60, value: 0.5 },
      { kind: "expression", frame: 2400, id: 1, dimension: "pitch", value: 12 },
      { kind: "expression", frame: 3600, id: 2, dimension: "pressure", value: 0.3 },
      { kind: "expression", frame: 4800, id: 1, dimension: "timbre", value: 0.4 },
      { kind: "parameter", frame: 6000, parameter: "gain", value: 0.1 },
      { kind: "parameter", frame: 7200, parameter: "cutoff", value: 900 },
      { kind: "panic", frame: 12000 },
    ]),
    make("effect-impulse", "virtual-input", [
      { kind: "parameter", frame: 2, parameter: "cutoff", value: 300 },
      { kind: "panic", frame: 1200 },
    ]),
    make("voice-exhaustion", "sine", [
      ...Array.from({ length: 33 }, (_, i) => ({
        kind: "on" as const,
        frame: 0,
        id: i + 1,
        note: 48 + (i % 12),
        value: 0.01,
      })),
      { kind: "panic", frame: 12000 },
    ]),
    make(
      "swung-note-boundaries",
      "sine",
      [
        { kind: "on", frame: swung, id: 1, note: 69, value: 0.5 },
        { kind: "off", frame: 12000, id: 1 },
      ],
      [7440, 12000],
    ),
  ];
}
export function verifyParityOracle(id: string, result: ParityResult) {
  const fixture = parityFixtures().find((c) => c.id === id);
  if (!fixture) throw new Error("Unknown conformance oracle");
  if (
    JSON.stringify(result.trace.map((e) => e.frame)) !== JSON.stringify(fixture.expectedFrames) ||
    result.activeVoices !== 0
  )
    throw new Error("Independent timing or note-release oracle failed");
  if (
    id === "voice-exhaustion" &&
    (result.trace.slice(0, 32).some((e) => !e.accepted) || result.trace[32]?.accepted !== false)
  )
    throw new Error("Independent 32-voice admission oracle failed");
  if (id === "swung-note-boundaries" && result.pcm.findIndex((v) => Math.abs(v) > 1e-9) !== 7441)
    throw new Error("Independent swung onset oracle failed");
  if (
    id === "effect-impulse" &&
    Math.abs((result.pcm[0] ?? NaN) - (1 - Math.exp((-2 * Math.PI * 8000) / 48000)) * 0.125) >
      0.000002
  )
    throw new Error("Independent impulse gain oracle failed");
}
