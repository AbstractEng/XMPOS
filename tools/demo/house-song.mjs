// "Night Shift": an original XMP demo song (house, F minor, 124 BPM), built
// with XMP's own core so it is always a valid project. Every note and sound is
// original: the drums are XMP's synthesized 909-style kit, the rest XMP's
// subtractive synth presets.
//
//   node tools/demo/house-song.mjs [out-dir]
//
// writes night-shift.xmpsong (open it in the browser studio, or put it on the
// Live's stick as xmp/project.xmpsong) and night-shift.wav (a preview render).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportSong } from "../../packages/core/src/assets.ts";
import { applyDrumKit } from "../../packages/core/src/drum-kits.ts";
import { drumMachineKit } from "../../packages/core/src/drum-machines.ts";
import { createDemoProject, ProjectSchema } from "../../packages/core/src/index.ts";
import { synthPresets } from "../../packages/core/src/instrument-schema.ts";
import { machines } from "../../packages/core/src/machines.ts";
import { createEffect, emptyMix } from "../../packages/core/src/mix-schema.ts";

const BAR = 16; // steps per bar
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
// 909-style pads (drum-machines.ts DRUM_MACHINE_PADS["909"]).
const KICK = 0,
  CLOSED = 2,
  OPEN = 3,
  CLAP = 4,
  RIM = 5,
  LOW_TOM = 6,
  RIDE = 8,
  CRASH = 9,
  MID_TOM = 10,
  SHAKER = 14;

// i–VI–VII–v in F minor, one chord a bar.
const CHORDS = [
  { name: "Fm9", root: 41, stab: [56, 60, 63, 67], pad: [53, 56, 60] }, // F  | Ab C Eb G
  { name: "Dbmaj7", root: 37, stab: [56, 60, 61, 65], pad: [49, 53, 56] }, // Db | Ab C Db F
  { name: "Eb", root: 39, stab: [55, 58, 63, 67], pad: [51, 55, 58] }, // Eb | G Bb Eb G
  { name: "Cm7", root: 36, stab: [55, 58, 60, 63], pad: [48, 51, 55] }, // C  | G Bb C Eb
];
// The lead: four bars over the progression ([step, note, length] per bar).
const MELODY = [
  [
    [0, 72, 2],
    [4, 75, 2],
    [8, 77, 4],
    [14, 75, 2],
  ],
  [
    [0, 80, 4],
    [6, 77, 2],
    [10, 75, 4],
  ],
  [
    [0, 79, 2],
    [4, 75, 2],
    [8, 72, 6],
  ],
  [
    [0, 70, 4],
    [6, 72, 2],
    [10, 75, 6],
  ],
];

const preset = (name) => {
  const p = synthPresets.find((x) => x.name === name);
  if (!p) throw new Error(`No preset ${name}`);
  return { ...p };
};
const synth = (name) => ({ ...machines.instantiate("xmp.subtractive"), state: preset(name) });
const step = (s, pad, velocity = 0.8) => ({ step: s, pad, velocity, probability: 1 });
const note = (id, position, pitch, duration, velocity = 0.75) => ({
  id,
  pad: 0,
  note: pitch,
  position,
  duration,
  velocity,
  probability: 1,
  microtiming: 0,
  condition: "always",
});
const sequence = (notes) => ({ version: 1, notes, locks: [], lanes: [], modulations: [] });

// ---- drums: one-bar clips ----
function drums(name, parts) {
  const steps = [];
  for (let s = 0; s < BAR; s++) {
    if (parts.kick && s % 4 === 0) steps.push(step(s, KICK, 0.95));
    if (parts.clap && (s === 4 || s === 12)) steps.push(step(s, CLAP, 0.8));
    if (parts.hats && s % 4 === 2) steps.push(step(s, s === 14 && parts.open ? OPEN : CLOSED, 0.6));
    if (parts.shaker && s % 2 === 1) steps.push(step(s, SHAKER, s % 4 === 3 ? 0.45 : 0.3));
    if (parts.rim && (s === 7 || s === 15)) steps.push(step(s, RIM, 0.5));
  }
  return { id: `drums-${slug(name)}`, name, length: 16, steps };
}
// ---- perc: rides and toms for the drop; a crash to open it ----
function perc(name, crash) {
  const steps = [];
  for (let s = 0; s < BAR; s++) if (s % 4 === 2) steps.push(step(s, RIDE, 0.4));
  if (crash) steps.push(step(0, CRASH, 0.5));
  steps.push(step(13, MID_TOM, 0.45), step(15, LOW_TOM, 0.5));
  return { id: `perc-${slug(name)}`, name, length: 16, steps };
}
// ---- the synths: four-bar clips over the progression ----
function bass(name, busy) {
  const notes = [];
  CHORDS.forEach((c, bar) => {
    for (const [s, up] of busy
      ? [
          [2, 0],
          [6, 12],
          [10, 0],
          [13, 0],
          [14, 12],
        ]
      : [
          [2, 0],
          [6, 0],
          [10, 0],
          [14, 0],
        ])
      notes.push(note(`b${bar}-${s}`, bar * BAR + s, c.root + up, 1.5, up ? 0.7 : 0.85));
  });
  return { id: `bass-${slug(name)}`, name, length: 64, steps: [], sequence: sequence(notes) };
}
function chords(name) {
  const notes = [];
  for (const [bar, c] of CHORDS.entries())
    for (const s of [3, 6, 11, 14])
      for (const [k, pitch] of c.stab.entries())
        notes.push(note(`c${bar}-${s}-${k}`, bar * BAR + s, pitch, 1, 0.55));
  return { id: `chords-${slug(name)}`, name, length: 64, steps: [], sequence: sequence(notes) };
}
function pad(name) {
  const notes = [];
  for (const [bar, c] of CHORDS.entries())
    for (const [k, pitch] of c.pad.entries())
      notes.push(note(`p${bar}-${k}`, bar * BAR, pitch, 16, 0.5));
  return { id: `pad-${slug(name)}`, name, length: 64, steps: [], sequence: sequence(notes) };
}
function lead(name) {
  const notes = [];
  MELODY.forEach((bar, b) => {
    for (const [s, pitch, length] of bar)
      notes.push(note(`l${b}-${s}`, b * BAR + s, pitch, length, 0.7));
  });
  return { id: `lead-${slug(name)}`, name, length: 64, steps: [], sequence: sequence(notes) };
}

export function nightShift() {
  // The 909-style kit on the pads (at 24 kHz: sixteen sounds fit the project's sample budget).
  let p = createDemoProject();
  p = applyDrumKit(p, drumMachineKit("909", 24000));
  p.id = "night-shift";
  p.name = "Night Shift";
  p.bpm = 124;
  p.swing = 0.06;
  p.master = 0.22; // the Live hard-limits at −12 dBFS: the mix peaks under it
  p.parameters = [];
  p.tracks = [
    {
      id: "drums",
      name: "Drums",
      muted: false,
      volume: 0.72,
      clips: [
        drums("Kick and hats", { kick: true, hats: true }),
        drums("Full", { kick: true, clap: true, hats: true, open: true, rim: true }),
        drums("Drive", { kick: true, clap: true, hats: true, open: true, shaker: true, rim: true }),
      ],
    },
    {
      id: "bass",
      name: "Bass",
      muted: false,
      volume: 0.95,
      machine: synth("Warm bass"),
      clips: [bass("Roots", false), bass("Octaves", true)],
    },
    {
      id: "chords",
      name: "Chords",
      muted: false,
      volume: 0.5,
      machine: synth("Pluck"),
      clips: [chords("Stabs")],
    },
    {
      id: "pad",
      name: "Pad",
      muted: false,
      volume: 0.5,
      machine: synth("Soft pad"),
      clips: [pad("Wash")],
    },
    {
      id: "lead",
      name: "Lead",
      muted: false,
      volume: 0.55,
      machine: synth("Bright lead"),
      clips: [lead("Hook")],
    },
    {
      id: "perc",
      name: "Perc",
      muted: false,
      volume: 0.5,
      clips: [perc("Ride", false), perc("Ride and crash", true)],
    },
  ];
  // The lead's synth a little softer and darker than the preset.
  p.tracks[4].machine.state.cutoff = 3200;
  p.scenes = [
    { id: "intro", name: "Intro", clips: { drums: "drums-kick-and-hats", pad: "pad-wash" } },
    { id: "groove", name: "Groove", clips: { drums: "drums-full", bass: "bass-roots" } },
    {
      id: "build",
      name: "Build",
      clips: { drums: "drums-full", bass: "bass-roots", chords: "chords-stabs", pad: "pad-wash" },
    },
    {
      id: "drop",
      name: "Drop",
      clips: {
        drums: "drums-drive",
        bass: "bass-octaves",
        chords: "chords-stabs",
        lead: "lead-hook",
        perc: "perc-ride-and-crash",
      },
    },
    {
      id: "break",
      name: "Break",
      clips: { pad: "pad-wash", chords: "chords-stabs", lead: "lead-hook" },
    },
  ];
  // Reverb on return 1, a synced delay on return 2; the pad and chords wet, the lead echoed.
  const mix = emptyMix();
  const strip = (pan, reverb, delay) => ({ pan, sends: [reverb, delay], inserts: [] });
  mix.tracks = {
    drums: strip(0.5, 0.04, 0),
    bass: strip(0.5, 0, 0),
    chords: strip(0.4, 0.25, 0.1),
    pad: strip(0.6, 0.45, 0),
    lead: strip(0.55, 0.2, 0.3),
    perc: strip(0.65, 0.12, 0),
  };
  const echo = createEffect("delay", "echo");
  echo.params = { time: 0.25, feedback: 0.35, wet: 1 };
  echo.sync = { division: 3, sequence: [1], phase: "transport", loss: "hold-last-tempo" };
  const room = createEffect("reverb", "room");
  room.params = { decay: 0.6, wet: 1 };
  mix.returns = [[room], [echo]];
  p.mix = mix;
  // The song: four bars a block. Intro, Groove twice, Build, Drop twice, Break, Drop twice, then stop.
  const chain = [
    ["intro", 1],
    ["groove", 2],
    ["build", 1],
    ["drop", 2],
    ["break", 1],
    ["drop", 2],
  ].map(([sceneId, repeats], i) => ({ id: `part-${i + 1}`, sceneId, repeats }));
  p.performance = {
    version: 1,
    chain,
    end: "stop",
    macros: [],
    mutes: {},
    solos: [],
    events: [],
    delay: { steps: 1, feedback: 0.35, wet: 0, sends: {} },
  };
  return ProjectSchema.parse(p);
}

const peakDb = (pcm) => {
  let peak = 0;
  for (const x of pcm) peak = Math.max(peak, Math.abs(x));
  return peak > 0 ? Number((20 * Math.log10(peak)).toFixed(1)) : -Infinity;
};

if (process.argv[1] === import.meta.filename) {
  const out = process.argv[2] ?? "artifacts/demo";
  mkdirSync(out, { recursive: true });
  const project = nightShift();
  writeFileSync(join(out, "night-shift.xmpsong"), await exportSong(project));
  const { loadCore, renderPerformance } = await import("../../packages/core/src/edits.ts");
  await loadCore();
  // The offline renderer stops at about 44 s, so the preview runs to the end of the first drop.
  const preview = renderPerformance(project, { mode: "song", steps: 320, tailSeconds: 2 });
  writeFileSync(join(out, "night-shift-preview.wav"), Buffer.from(preview.wav));
  // Every track on its own, in a scene that uses it: it has to make sound.
  const solo = {};
  for (const track of project.tracks) {
    const scene = project.scenes.find((s) => s.clips[track.id]);
    const alone = structuredClone(project);
    for (const t of alone.tracks) t.muted = t.id !== track.id;
    const r = renderPerformance(alone, {
      mode: "scene",
      scene: scene.id,
      steps: 64,
      tailSeconds: 1,
    });
    solo[track.name] = { scene: scene.name, notes: r.trace.length, peakDb: peakDb(r.pcm) };
  }
  const steps = project.performance.chain.reduce((n, part) => n + 64 * part.repeats, 0);
  console.log(
    JSON.stringify(
      {
        out,
        songSeconds: Number(((steps / 4) * (60 / project.bpm)).toFixed(1)),
        previewSeconds: Number((preview.pcm.length / 48000).toFixed(1)),
        previewPeakDb: peakDb(preview.pcm),
        solo,
      },
      null,
      1,
    ),
  );
}
