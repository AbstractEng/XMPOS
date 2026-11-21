import { expect, it } from "vitest";
import { createDemoProject } from "../packages/core/src/index.ts";
import { MachineRegistry } from "../packages/core/src/machines.ts";
import {
  CommunityManifest,
  ExpressionTake,
  macDevelopmentProfile,
  negotiateExpression,
  negotiateModule,
} from "../packages/sdk/src/community/contract.ts";
import {
  buildPackage,
  canonical,
  parsePackage,
  validatePackage,
} from "../packages/sdk/src/community/package.ts";
import {
  CommunityProcessor,
  communityMachine,
  renderCommunity,
} from "../packages/sdk/src/community/program.ts";
import { bindCommunity, validateCommunityProject } from "../packages/sdk/src/community/project.ts";
// @ts-expect-error Node CLI template source is executable ESM.
import { template } from "../tools/sdk/template.mjs";

it("negotiates API, architecture, units and only declared capabilities before code can run", async () => {
  const t = await template();
  const m = CommunityManifest.parse(t.manifest);
  expect(negotiateModule(m).capabilities).toEqual(m.capabilities);
  for (const patch of [
    { apiVersion: 9 },
    { dspAbi: 99 },
    { architecture: "linux-x64" },
    { adapter: "vst3" },
    { capabilities: ["device-write"] },
  ])
    expect(() => negotiateModule({ ...m, ...patch })).toThrow();
  expect(() => negotiateModule(m, { ...macDevelopmentProfile, capabilities: ["notes"] })).toThrow(
    "capability",
  );
  expect(m.parameters.map((p) => [p.id, p.unit, p.min, p.max, p.default])).toEqual([
    ["level", "linear", 0, 1, 0.25],
    ["cutoff", "Hz", 20, 20000, 8000],
  ]);
});
it("routes per-note pressure/pitch/timbre to one real DSP voice with stable ownership", async () => {
  const t = await template(),
    m = CommunityManifest.parse(t.manifest),
    state = { level: 0.25, cutoff: 8000 },
    a = new CommunityProcessor(m, t.program, state),
    b = new CommunityProcessor(m, t.program, state);
  for (const p of [a, b]) {
    p.noteOn({ id: 101, note: 60, velocity: 1, durationFrames: 0 });
    p.noteOn({ id: 102, note: 64, velocity: 1, durationFrames: 0 });
  }
  a.expression(101, "pressure", 0.2);
  a.expression(101, "pitch", 12);
  a.expression(101, "timbre", 0.4);
  expect(a.snapshot()[1]).toEqual(b.snapshot()[1]);
  expect(a.snapshot()[0]).toMatchObject({ id: 101, pressure: 0.2, pitch: 12, timbre: 0.4 });
  const left = new Float32Array(256),
    right = new Float32Array(256);
  a.process(left, 256);
  b.process(right, 256);
  expect(left).not.toEqual(right);
  const first = new CommunityProcessor(m, t.program, state),
    second = new CommunityProcessor(m, t.program, state);
  first.noteOn({ id: 101, note: 60, velocity: 1, durationFrames: 0 });
  second.noteOn({ id: 102, note: 64, velocity: 1, durationFrames: 0 });
  first.expression(101, "pressure", 0.2);
  first.expression(101, "pitch", 12);
  first.expression(101, "timbre", 0.4);
  const one = new Float32Array(256),
    two = new Float32Array(256);
  first.process(one, 256);
  second.process(two, 256);
  for (let i = 0; i < 256; i++)
    expect(Math.abs((left[i] ?? 0) - (one[i] ?? 0) - (two[i] ?? 0))).toBeLessThan(1e-7);
  expect(() => a.expression(999, "pitch", 1)).toThrow("identity");
  expect(() => a.expression(101, "pressure", NaN)).toThrow();
  a.panic();
  a.process(left, 240);
  expect(a.snapshot().length).toBe(0);
});
it("rejects unavailable expression before altering the take or existing notes", async () => {
  const t = await template();
  t.manifest.capabilities = ["notes", "velocity", "audio-output"];
  const m = CommunityManifest.parse(t.manifest),
    take = new ExpressionTake(["notes", "velocity"], m.capabilities);
  take.append({ kind: "on", id: 1, timestamp: 0, note: 60, velocity: 1 });
  const before = take.snapshot();
  expect(() =>
    take.append({ kind: "expression", id: 1, timestamp: 0.1, dimension: "pressure", value: 0.1 }),
  ).toThrow("unavailable");
  expect(take.snapshot()).toEqual(before);
  expect(negotiateExpression(["pitch"], m.capabilities, ["pitch", "pressure"])).toEqual({
    available: [],
    unavailable: ["pitch", "pressure"],
  });
  const p = new CommunityProcessor(m, t.program, { level: 0.25, cutoff: 8000 });
  p.noteOn({ id: 1, note: 60, velocity: 1, durationFrames: 0 });
  const snapshot = p.snapshot();
  expect(() => p.expression(1, "pitch", 1)).toThrow();
  expect(p.snapshot()).toEqual(snapshot);
});
it("builds deterministic data packages, rejects corruption/paths/dependencies and runs the shared machine contract", async () => {
  const t = await template(),
    a = await buildPackage(t.manifest, t.program, t.license),
    b = await buildPackage(t.manifest, t.program, t.license);
  expect(canonical(a)).toBe(canonical(b));
  const p = await parsePackage(JSON.stringify(a)),
    registry = new MachineRegistry();
  registry.register(communityMachine(p.manifest, p.program));
  const definition = registry.list()[0];
  expect(definition?.capabilities).toContain("pitch");
  const corrupt = structuredClone(a);
  if (corrupt.files[0]) corrupt.files[0].content += " ";
  await expect(validatePackage(corrupt)).rejects.toThrow("Integrity");
  await expect(
    validatePackage({
      ...a,
      files: a.files.map((f, i) => (i === 0 ? { ...f, path: "../escape" } : f)),
    }),
  ).rejects.toThrow();
  await expect(
    buildPackage(
      t.manifest,
      { ...t.program, requires: [{ id: "missing-dsp", version: "3.2.1" }] },
      t.license,
    ),
  ).rejects.toThrow("missing-dsp@3.2.1");
  const pcm = renderCommunity(
    p.manifest,
    p.program,
    { level: 0.25, cutoff: 8000 },
    [
      { kind: "on", id: 1, timestamp: 0, note: 69, velocity: 1 },
      { kind: "off", id: 1, timestamp: 0.1 },
    ],
    0.25,
  );
  expect(pcm.some((v) => v !== 0)).toBe(true);
  expect(pcm.slice(6000).every((v) => v === 0)).toBe(true);
});
it("saves the actual XMP project with package hash, parameters and an expression take intact", async () => {
  const t = await template(),
    pkg = await buildPackage(t.manifest, t.program, t.license),
    project = await bindCommunity(createDemoProject(), "drums", pkg),
    take = new ExpressionTake(t.manifest.capabilities, t.manifest.capabilities);
  for (const e of [
    { kind: "on", id: 1, timestamp: 0, note: 60, velocity: 0.8 },
    { kind: "on", id: 2, timestamp: 0, note: 64, velocity: 0.7 },
    { kind: "expression", id: 1, timestamp: 0.125, dimension: "pitch", value: 7 },
  ])
    take.append(e);
  project.takes = [{ trackId: "drums", source: t.manifest.capabilities, events: take.snapshot() }];
  const opened = await validateCommunityProject(JSON.parse(JSON.stringify(project)), [pkg]);
  expect(opened).toEqual(project);
  expect(opened.takes[0]?.events[2]).toMatchObject({
    id: 1,
    timestamp: 0.125,
    dimension: "pitch",
    value: 7,
  });
});
it("delivers negotiated expression through VoiceRack's shared extension interface", async () => {
  const { machines } = await import("../packages/core/src/machines.ts"),
    { prepareInstruments, VoiceRack } = await import("../packages/core/src/instruments.ts");
  const t = await template("instrument", "rack-tone"),
    pkg = await buildPackage(t.manifest, t.program, t.license),
    validated = await validatePackage(pkg);
  machines.register(communityMachine(validated.manifest, validated.program));
  const p = createDemoProject();
  p.samples = [{ id: "s", name: "Fixture", sampleRate: 48000, pcm: [0.5, 0] }];
  for (const pad of p.pads) pad.sampleId = "s";
  const project = await bindCommunity(p, "drums", pkg),
    rack = new VoiceRack(prepareInstruments(project.project));
  expect(rack.noteOn(101, 0, 0, 60, 1)).toBe(true);
  expect(rack.noteOn(102, 0, 0, 64, 1)).toBe(true);
  rack.expression("drums", 101, "pressure", 0.25);
  rack.expression("drums", 101, "pitch", 12);
  expect(() => rack.expression("drums", 999, "pitch", 1)).toThrow("identity");
  const pcm = new Float32Array(256);
  rack.process(pcm, new Float32Array(256));
  expect(pcm.some((v) => v !== 0)).toBe(true);
});
it("enforces DSP, note identity and take budgets and rejects code-bearing program fields", async () => {
  const t = await template(),
    m = CommunityManifest.parse(t.manifest),
    p = new CommunityProcessor(m, t.program, { level: 0.25, cutoff: 8000 });
  for (let i = 1; i <= 32; i++)
    expect(p.noteOn({ id: i, note: 60, velocity: 1, durationFrames: 0 })).toBe(true);
  expect(p.noteOn({ id: 33, note: 60, velocity: 1, durationFrames: 0 })).toBe(false);
  expect(p.noteOn({ id: 1, note: 60, velocity: 1, durationFrames: 0 })).toBe(false);
  expect(() => p.process(new Float32Array(4097), 4097)).toThrow("block");
  await expect(
    buildPackage(m, { ...t.program, script: "throw new Error('must not run')" }, t.license),
  ).rejects.toThrow();
  const take = new ExpressionTake(m.capabilities, m.capabilities);
  take.append({ kind: "on", id: 1, timestamp: 0, note: 60, velocity: 1 });
  for (let i = 1; i < 256; i++)
    take.append({
      kind: "expression",
      id: 1,
      timestamp: i / 1000,
      dimension: "pressure",
      value: 0.5,
    });
  const before = take.snapshot();
  expect(() =>
    take.append({ kind: "expression", id: 1, timestamp: 0.3, dimension: "pitch", value: 1 }),
  ).toThrow();
  expect(take.snapshot()).toEqual(before);
});
