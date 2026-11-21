// Random XMP projects shared by the C++ project parity tests.
import {
  createDemoProject,
  expandSong,
  type Project,
  ProjectSchema,
} from "../packages/core/src/index.ts";
import { synthPresets as allPresets } from "../packages/core/src/instrument-schema.ts";

import { machines } from "../packages/core/src/machines.ts";
import { setMidiDestination } from "../packages/core/src/midi-routing.ts";
import { createEffect, emptyMix } from "../packages/core/src/mix-schema.ts";
import { parameterRegistry as fullRegistry } from "../packages/core/src/parameters.ts";

// The recordings below were made with the original eight presets (the Classic page).
const synthPresets = allPresets.slice(0, 8);

// The synth's later controls (resonance, filter envelope, detune, glide) came
// after these fixtures' recordings (tests/golden.json): random choices leave
// them out, so the same seeds make the same projects.
const LATER = /\.xmp\.subtractive\.v1\.(resonance|env-amount|env-decay|detune|glide)$/;
const parameterRegistry = (p: Parameters<typeof fullRegistry>[0]) =>
  fullRegistry(p).filter((d) => !LATER.test(d.id));

export function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// A rich version 7 project: machines, MIDI routing, sequences, a mix, a performance.
export function richProject(r: () => number): Project {
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  let p = expandSong(createDemoProject());
  // Short samples keep the test fast; slices and pad instruments on some pads.
  p.samples = p.samples.map((s) => ({ ...s, pcm: s.pcm.slice(0, 32 + Math.floor(r() * 64)) }));
  p.pads.forEach((pad, i) => {
    if (r() < 0.3) pad.slice = { start: 0, end: 8 + (i % 8) };
    if (r() < 0.3)
      (pad as Record<string, unknown>).playback = {
        mode: pick(["one-shot", "gate", "loop", "chromatic"] as const),
        rootNote: 60,
        chokeGroup: Math.floor(r() * 9),
      };
    if (r() < 0.2) (pad as Record<string, unknown>).edit = { reverse: r() < 0.5, normalize: true };
  });
  const [a, b] = p.tracks;
  if (a && b && r() < 0.6) {
    a.machine = machines.instantiate("xmp.midi");
    b.machine = machines.instantiate("xmp.subtractive");
    b.machine.state = { ...pick(synthPresets) };
    p = setMidiDestination(p, a.id, b.id);
  }
  if (r() < 0.6) {
    const mix = emptyMix();
    for (const track of p.tracks)
      if (r() < 0.5)
        mix.tracks[track.id] = {
          pan: Math.round(r() * 100) / 100,
          sends: [0, Math.round(r() * 100) / 100],
          inserts:
            r() < 0.5
              ? [createEffect(pick(["eq", "filter", "delay"] as const), `fx-${track.id}`)]
              : [],
        };
    mix.returns = [[createEffect("reverb", "verb")], []];
    mix.tempos = r() < 0.5 ? [{ step: 64, bpm: 140 }] : [];
    p.mix = mix;
  }
  const registry = parameterRegistry(p).map((d) => d.id);
  p.parameters = registry
    .filter((id) => !id.endsWith(".gain") && r() < 0.2)
    .map((id) => ({ id, base: 0.5, ...(r() < 0.5 ? { automation: 0.25 } : {}) }));
  for (const track of p.tracks)
    for (const clip of track.clips) {
      if (r() < 0.6) continue;
      const own = registry.filter((id) => id.startsWith(`track.${track.id}.`));
      clip.sequence = {
        version: 1,
        notes: Array.from({ length: Math.floor(r() * 6) }, (_, i) => ({
          id: `n${i}`,
          pad: Math.floor(r() * 16),
          note: 60 + i,
          position: i * 2,
          duration: 1,
          velocity: 0.8,
          probability: 1,
          microtiming: 0,
          condition: pick(["always", "fill", "every-2"] as const),
          ...(r() < 0.3
            ? { original: { position: i * 2, duration: 1, velocity: 0.7, timestamp: 12.5 } }
            : {}),
        })),
        locks: r() < 0.5 && own[0] ? [{ position: 3, parameter: own[0], value: 0.4 }] : [],
        lanes:
          r() < 0.5 && own[0]
            ? [
                {
                  parameter: own[0],
                  points: [
                    { position: 0, value: 0.1 },
                    { position: 8, value: 0.9 },
                  ],
                },
              ]
            : [],
        modulations:
          r() < 0.3 && own[0]
            ? [{ id: "lfo", parameter: own[0], kind: "lfo", amount: 0.5, cycles: 2, phase: 0 }]
            : [],
      };
    }
  if (r() < 0.7) {
    const scene = p.scenes[0]?.id ?? "scene-0";
    p.performance = {
      version: 1,
      chain: [
        { id: "a", sceneId: scene, repeats: 2 },
        { id: "b", sceneId: p.scenes[1]?.id ?? scene, repeats: 1 },
      ],
      end: pick(["stop", "loop"] as const),
      macros: [
        {
          id: "m",
          name: "Tone",
          value: 0.5,
          assignments: registry[0] ? [{ parameter: registry[0], amount: 0.5 }] : [],
        },
      ],
      mutes: { [p.tracks[2]?.id ?? "drums"]: true },
      solos: [],
      events: [
        { id: "e1", at: 4, kind: "mute", trackId: p.tracks[0]?.id ?? "drums", value: true },
        { id: "e2", at: 8, kind: "macro", macroId: "m", value: 0.2 },
      ],
      ...(r() < 0.5 ? { position: { occurrenceId: "a", offset: 5 } } : {}),
      ...(r() < 0.5 ? { selection: { sceneId: scene, clips: {} } } : {}),
      delay: { steps: 1, feedback: 0.3, wet: 0.1, sends: {} },
    };
  }
  // Format 7: some tracks with their own kits, some sounds only theirs.
  for (const [t, track] of p.tracks.entries()) {
    if (r() >= 0.35) continue;
    const extra = {
      id: `own-${t}`,
      name: `Own ${t}`,
      sampleRate: 24000,
      pcm: Array.from({ length: 24 + t }, (_, i) => Math.sin(i * (t + 1)) * 0.5),
    };
    p.samples.push(extra);
    track.pads = p.pads.map((pad, i) => {
      const own = structuredClone(pad);
      own.id = `own-${t}-${i}`;
      if (r() < 0.4) {
        own.sampleId = extra.id;
        if (own.slice) own.slice = { start: 0, end: 12 };
      }
      if (r() < 0.3)
        own.playback = {
          mode: pick(["one-shot", "gate", "loop", "chromatic"] as const),
          rootNote: 48 + Math.floor(r() * 24),
          chokeGroup: Math.floor(r() * 9),
        };
      if (r() < 0.2) own.edit = { reverse: r() < 0.5, normalize: r() < 0.5 };
      return own;
    });
  }
  return ProjectSchema.parse(p);
}

export const CONDITIONS = [
  "always",
  "first",
  "not-first",
  "fill",
  "not-fill",
  "every-2",
  "every-4",
] as const;

// A project with rich clip sequences (conditions, probability, microtiming,
// automation lanes, locks and modulation) on random tracks and synths.
export function sequencedProject(seed: number): Project {
  const r = rng(seed),
    pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T,
    p = expandSong(createDemoProject());
  p.seed = r() < 0.3 ? 0 : Math.floor(r() * 0xffffffff);
  p.swing = r() < 0.4 ? 0 : Math.round(r() * 50) / 100;
  p.bpm = 60 + Math.floor(r() * 120);
  p.tracks.forEach((track, t) => {
    if (t > 0 && r() < 0.35)
      track.machine = {
        id: "xmp.subtractive",
        base: "audio",
        version: 1,
        state: { ...pick(synthPresets) },
      };
    track.muted = r() < 0.15;
  });
  const registry = parameterRegistry(p).map((d) => d.id);
  for (const track of p.tracks)
    for (const clip of track.clips) {
      const own = registry.filter(
        (id) => id === "master.gain" || id.startsWith(`track.${track.id}.`),
      );
      clip.length = pick([16, 32, 64] as const);
      clip.steps = [];
      const used = new Set<string>();
      for (let i = Math.floor(r() * 24); i > 0; i--) {
        const step = Math.floor(r() * clip.length),
          pad = Math.floor(r() * 16);
        if (used.has(`${step}:${pad}`)) continue;
        used.add(`${step}:${pad}`);
        clip.steps.push({
          step,
          pad,
          velocity: Math.round(r() * 100) / 100,
          probability: r() < 0.6 ? 1 : Math.round(r() * 100) / 100,
          ...(r() < 0.3 ? { duration: 1 + Math.floor(r() * 4) } : {}),
          ...(r() < 0.2 ? { note: 30 + Math.floor(r() * 60) } : {}),
        });
      }
      if (r() < 0.7) {
        const notes = Array.from({ length: Math.floor(r() * 40) }, (_, i) => {
          // Several notes on the same position exercise the ID tie-break.
          const position =
            r() < 0.3 ? Math.floor(r() * 4) * 4 : Math.floor(r() * clip.length * 960) / 960;
          return {
            id: `n${i}${r() < 0.2 ? "_x" : ""}`,
            pad: Math.floor(r() * 16),
            note: Math.floor(r() * 128),
            position,
            duration: Math.max(
              1 / 960,
              Math.min(clip.length - position, Math.floor(r() * 4 * 960) / 960),
            ),
            velocity: Math.round(r() * 100) / 100,
            probability: r() < 0.6 ? 1 : Math.round(r() * 100) / 100,
            microtiming: Math.round((r() * 0.98 - 0.49) * 100) / 100,
            condition: pick(CONDITIONS),
          };
        });
        const lanes = own
          .filter(() => r() < 0.3)
          .map((parameter) => {
            let at = 0;
            return {
              parameter,
              points: Array.from({ length: 1 + Math.floor(r() * 6) }, () => {
                at += Math.floor(r() * 8 * 4 + 1) / 4;
                return { position: Math.min(at, clip.length), value: Math.round(r() * 100) / 100 };
              }).filter((point, i, all) => i === 0 || point.position > (all[i - 1]?.position ?? 0)),
            };
          });
        const lockKeys = new Set<string>(),
          locks = [];
        for (let i = Math.floor(r() * 10); i > 0; i--) {
          const position = Math.floor(r() * clip.length),
            parameter = pick(own);
          if (lockKeys.has(`${position}:${parameter}`)) continue;
          lockKeys.add(`${position}:${parameter}`);
          locks.push({ position, parameter, value: Math.round(r() * 100) / 100 });
        }
        const modulations = Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({
          id: `m${i}`,
          parameter: pick(own),
          kind: pick(["macro", "lfo"] as const),
          amount: Math.round((r() * 2 - 1) * 100) / 100,
          cycles: pick([0.0625, 0.5, 1, 2, 3.5, 16]),
          phase: Math.round(r() * 100) / 100,
        }));
        clip.sequence = { version: 1, notes, locks, lanes, modulations };
      }
    }
  return ProjectSchema.parse(p);
}

// A sequenced project with a performance: chain, macros, events, mutes, solos, and sometimes a tempo map.
export function performedProject(seed: number): Project {
  const r = rng(seed * 92821),
    pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  let p = structuredClone(sequencedProject(seed));
  // A MIDI track playing an instrument: solos follow the route (performanceControls).
  const [a, b] = p.tracks;
  if (a && b && r() < 0.6) {
    a.machine = machines.instantiate("xmp.midi");
    if (b.machine?.id !== "xmp.subtractive") b.machine = machines.instantiate("xmp.subtractive");
    p = setMidiDestination(ProjectSchema.parse(p), a.id, b.id);
  }
  if (r() < 0.5)
    p.mix = {
      ...emptyMix(),
      tempos: r() < 0.7 ? [{ step: 32, bpm: 90 + Math.floor(r() * 60) }] : [],
    };
  const ids = parameterRegistry(p).map((d) => d.id);
  const chain = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, i) => ({
    id: `occ-${i}`,
    sceneId: pick(p.scenes).id,
    repeats: 1 + Math.floor(r() * 2),
  }));
  const macros = Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({
    id: `m${i}`,
    name: `Macro ${i}`,
    value: Math.round(r() * 100) / 100,
    assignments: [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(ids)))].map(
      (parameter) => ({
        parameter,
        amount: Math.round((r() * 2 - 1) * 100) / 100,
      }),
    ),
  }));
  let at = 0;
  const events = Array.from({ length: Math.floor(r() * 12) }, (_, i) => {
    at += Math.floor(r() * 12);
    const t = pick(p.tracks).id;
    return r() < 0.3 && macros.length
      ? {
          id: `e${i}`,
          at,
          kind: "macro" as const,
          macroId: pick(macros).id,
          value: Math.round(r() * 100) / 100,
        }
      : {
          id: `e${i}`,
          at,
          kind: r() < 0.7 ? ("mute" as const) : ("solo" as const),
          trackId: t,
          value: r() < 0.5,
        };
  });
  p.performance = {
    version: 1,
    chain,
    end: r() < 0.5 ? "loop" : "stop",
    macros,
    mutes: r() < 0.3 ? { [pick(p.tracks).id]: true } : {},
    solos: r() < 0.35 ? [pick(p.tracks.slice(0, 3)).id] : [],
    events,
    delay: { steps: 1, feedback: 0.3, wet: 0, sends: {} },
  };
  return ProjectSchema.parse(p);
}
