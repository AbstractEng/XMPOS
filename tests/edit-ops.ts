import { applyDrumKit } from "../packages/core/src/drum-kits.ts";
import { expandSong, type Project, toggleStep } from "../packages/core/src/index.ts";
import { installSample, manualSlices, ownKit, shareKit } from "../packages/core/src/instruments.ts";
import { setMidiDestination } from "../packages/core/src/midi-routing.ts";
import { editMix } from "../packages/core/src/mix.ts";
import { deleteTrack, editChain, editPerformance } from "../packages/core/src/performance.ts";
import {
  appendNotes,
  duplicateClip,
  editSequence,
  quantizeNotes,
  resizeClip,
} from "../packages/core/src/sequencer.ts";

// Random project edits for the edit tests: tests/parity/project-edit-parity.test.ts
// (the C++ driver) and tests/edits.test.ts (the C++ core in WebAssembly) apply
// them alongside the TypeScript.

export type Op = { op: string; args: unknown[] };
export interface EditFunctions {
  toggleStep: typeof toggleStep;
  expandSong: typeof expandSong;
  appendNotes: typeof appendNotes;
  quantizeNotes: typeof quantizeNotes;
  resizeClip: typeof resizeClip;
  duplicateClip: typeof duplicateClip;
  editChain: typeof editChain;
  deleteTrack: typeof deleteTrack;
  setMidiDestination: typeof setMidiDestination;
  manualSlices: typeof manualSlices;
  installSample: typeof installSample;
  applyDrumKit: typeof applyDrumKit;
  ownKit: typeof ownKit;
  shareKit: typeof shareKit;
  editMix: typeof editMix;
  editPerformance: typeof editPerformance;
  editSequence: typeof editSequence;
}
export const typescriptEdits: EditFunctions = {
  toggleStep,
  expandSong,
  appendNotes,
  quantizeNotes,
  resizeClip,
  duplicateClip,
  editChain,
  deleteTrack,
  setMidiDestination,
  manualSlices,
  installSample,
  applyDrumKit,
  ownKit,
  shareKit,
  editMix,
  editPerformance,
  editSequence,
};
export const assign = (target: object, from: unknown) => Object.assign(target, from);
export function applyOp(e: EditFunctions, project: Project, { op, args }: Op): Project {
  const a = (k: number) => args[k] as never;
  switch (op) {
    case "toggleStep":
      return e.toggleStep(project, a(0), a(1), a(2), a(3));
    case "expandSong":
      return e.expandSong(project);
    case "appendNotes":
      return e.appendNotes(project, a(0), a(1), a(2));
    case "quantizeNotes":
      return e.quantizeNotes(project, a(0), a(1), a(2), a(3), a(4));
    case "resizeClip":
      return e.resizeClip(project, a(0), a(1), a(2));
    case "duplicateClip":
      return e.duplicateClip(project, a(0), a(1));
    case "editChain":
      return e.editChain(project, a(0));
    case "deleteTrack":
      return e.deleteTrack(project, a(0));
    case "setMidiDestination":
      return e.setMidiDestination(project, a(0), (args[1] ?? undefined) as never);
    case "manualSlices":
      return e.manualSlices(project, a(0), a(1), a(2));
    case "installSample":
      return e.installSample(project, a(0), a(1), a(2), Float32Array.from(a(3) as number[]), a(4));
    case "applyDrumKit":
      return e.applyDrumKit(project, a(0), a(1));
    case "ownKit":
      return e.ownKit(project, a(0));
    case "shareKit":
      return e.shareKit(project, a(0));
    case "assignMix":
      return e.editMix(project, (m) => assign(m, a(0)));
    case "assignPerformance":
      return e.editPerformance(project, (p) => assign(p, a(0)));
    case "assignSequence":
      return e.editSequence(project, a(0), a(1), (s) => assign(s, a(2)));
  }
  throw new Error(`unknown op ${op}`);
}

// A random edit, mostly well-formed, sometimes aimed at missing or invalid targets.
export function randomOp(p: Project, r: () => number): Op {
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  const track = r() < 0.92 ? pick(p.tracks) : undefined,
    trackId = track?.id ?? pick(["nowhere", "drums", ""]),
    clip = track && track.clips.length ? pick(track.clips) : undefined,
    clipId = r() < 0.92 ? (clip?.id ?? "missing") : "missing";
  const value = () => pick([0, 0.25, 0.5, 1, 1.5, -1, 16, 64, 2.5]);
  const note = (i: number) => ({
    id: r() < 0.9 ? `x${i}-${Math.floor(r() * 1e6)}` : "n0",
    pad: Math.floor(r() * 16),
    note: 60,
    position: Math.floor(r() * ((clip?.length ?? 16) - 1) * 960) / 960,
    duration: r() < 0.9 ? pick([0.25, 0.5, 1]) : 70,
    velocity: 0.7,
    probability: 1,
    microtiming: r() < 0.95 ? pick([0, 0.1]) : 0.6,
    condition: r() < 0.95 ? pick(["always", "fill"]) : "sometimes",
  });
  // A track's kit (format 7) for the sample edits, sometimes.
  const kit = r() < 0.4 ? [trackId] : [];
  const roll = Math.floor(r() * 17);
  switch (roll) {
    case 0:
      return {
        op: "toggleStep",
        args: [trackId, clipId, pick([0, 3, 15, 16, 1.5, -1]), pick([0, 5, 15, 16, 31, 63, 64])],
      };
    case 1:
      return { op: "expandSong", args: [] };
    case 2:
      return {
        op: "appendNotes",
        args: [trackId, clipId, Array.from({ length: Math.floor(r() * 3) + 1 }, (_, i) => note(i))],
      };
    case 3:
      return {
        op: "quantizeNotes",
        args: [
          trackId,
          clipId,
          (clip?.sequence?.notes ?? []).filter(() => r() < 0.6).map((n) => n.id),
          pick([0.25, 0.5, 1, 2, 4, 3]),
          r() < 0.3,
        ],
      };
    case 4:
      return { op: "resizeClip", args: [trackId, clipId, pick([16, 32, 64, 48])] };
    case 5:
      return { op: "duplicateClip", args: [trackId, clipId] };
    case 6: {
      const chain = (p.performance?.chain ?? []).filter(() => r() < 0.7);
      if (r() < 0.5)
        chain.push({
          id: `occ-${Math.floor(r() * 100)}`,
          sceneId: r() < 0.9 ? pick(p.scenes).id : "missing",
          repeats: pick([1, 2, 17]),
        });
      return { op: "editChain", args: [chain] };
    }
    case 7:
      return { op: "deleteTrack", args: [trackId] };
    case 8:
      return {
        op: "setMidiDestination",
        args: [trackId, r() < 0.3 ? null : (pick(p.tracks)?.id ?? "x")],
      };
    case 9: {
      const n = 2 + Math.floor(r() * 4);
      let at = 0;
      return {
        op: "manualSlices",
        args: [
          pick([0, 4, 12, 15, 16, -1]),
          Array.from({ length: n }, () => {
            at += 1 + Math.floor(r() * 10);
            return at;
          }).map((b, i) => (r() < 0.05 && i ? b - 20 : b)),
          ...kit,
        ],
      };
    }
    case 10:
      return {
        op: "installSample",
        args: [
          pick([0, 7, 15, 16]),
          pick(["Take", "", "x".repeat(130), "Voice 😀 take"]),
          pick([48000, 44100, 7999]),
          Array.from({ length: pick([1, 20, 0]) }, () => Math.fround(r() * 2 - 1)).concat(
            r() < 0.05 ? [2] : [],
          ),
          ...kit,
        ],
      };
    case 11:
      return {
        op: "applyDrumKit",
        args: [
          r() < 0.1
            ? pick([null, [], { name: "K" }, { name: "K", samples: [] }])
            : {
                name: pick(["  My kit ", "Kit", "   ", "x".repeat(81)]),
                samples: Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => ({
                  name: pick([`Kick ${i}`, "Closed hat", "x".repeat(50)]),
                  sampleRate: pick([44100, 48000]),
                  pcm: [0, 0.5, -0.25],
                  ...(r() < 0.4 ? { choke: pick([0, 1, 9]) } : {}),
                  // Format 8's multi-sampled sounds: velocity layers of takes; a
                  // take equal to the sound's pcm shares its sample.
                  ...(r() < 0.35
                    ? {
                        layers: pick([
                          [{ upTo: 1, takes: [{ sampleRate: 48000, pcm: [0.1, -0.1] }] }],
                          [
                            { upTo: 0.5, takes: [{ sampleRate: 24000, pcm: [0.2] }] },
                            {
                              upTo: 1,
                              takes: [
                                { sampleRate: 48000, pcm: [0, 0.5, -0.25] },
                                { sampleRate: 48000, pcm: [0.3, 0.1] },
                              ],
                            },
                          ],
                          [
                            { upTo: 1, takes: [{ sampleRate: 48000, pcm: [0.2] }] },
                            { upTo: 0.5, takes: [{ sampleRate: 48000, pcm: [0.2] }] },
                          ],
                          [{ upTo: 0.8, takes: [{ sampleRate: 48000, pcm: [0.2] }] }],
                          [{ upTo: 1, takes: [] }],
                          [{ upTo: 1, takes: [{ sampleRate: 48000, pcm: [2] }] }],
                          "loud",
                        ]),
                      }
                    : {}),
                })),
              },
          ...kit,
        ],
      };
    case 12:
      return {
        op: "assignMix",
        args: [
          pick([
            { tempos: [{ step: 32, bpm: 130 }] },
            { tempos: [{ step: 33, bpm: 130 }] },
            { tracks: { [trackId]: { pan: value(), sends: [0, 0.5], inserts: [] } } },
            { returns: [[], []] },
            { extra: 1 },
          ]),
        ],
      };
    case 13:
      return {
        op: "assignPerformance",
        args: [
          pick([
            { end: "loop" },
            { solos: [trackId] },
            { mutes: { [trackId]: true } },
            { delay: { steps: 2, feedback: 0.2, wet: value(), sends: {} } },
            { end: "maybe" },
          ]),
        ],
      };
    case 14:
      return { op: "ownKit", args: [trackId] };
    case 15:
      return { op: "shareKit", args: [trackId] };
    default:
      return {
        op: "assignSequence",
        args: [
          trackId,
          clipId,
          pick([
            { notes: [note(0)] },
            { locks: [{ position: 2, parameter: `track.${trackId}.gain`, value: value() }] },
            { lanes: [] },
            { modulations: [] },
            { version: 2 },
          ]),
        ],
      };
  }
}
