// Loads XMP's C++ performance controls (native/include/xmp/controls.hpp),
// compiled to WebAssembly by `npm run engine:wasm`, and lays a project's
// controls out for it. One shared instance per realm: each load replaces the
// previous one, so callers load, then query, without interleaving.
import { decodeBase64 } from "./engine.ts";
import { CONTROLS_WASM_BASE64 } from "./generated/xmp-controls-wasm.ts";
import type { Project } from "./index.ts";
import { midiDestination } from "./midi-routing.ts";
import { parameterRegistry } from "./parameters.ts";

export interface ControlsExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  ctl_begin(bpm: number): void;
  ctl_track(uid: number, muted: number, destination: number): number;
  ctl_tracks_done(): number;
  ctl_mute(uid: number, value: number): number;
  ctl_solo(uid: number): number;
  ctl_macro(uid: number, value: number): number;
  ctl_assignment(parameter: number, amount: number, valid: number): number;
  ctl_event(kind: number, target: number, value: number, at: number): number;
  ctl_override(kind: number, target: number, value: number): number;
  ctl_clear_overrides(): void;
  ctl_tempo(step: number, bpm: number): number;
  ctl_evaluate(position: number, withOffsets: number): void;
  ctl_is_blocked(track: number, position: number): number;
  ctl_mute_count(): number;
  ctl_mute_key(i: number): number;
  ctl_mute_value(i: number): number;
  ctl_solo_count(): number;
  ctl_solo_key(i: number): number;
  ctl_macro_count(): number;
  ctl_macro_key(i: number): number;
  ctl_macro_value(i: number): number;
  ctl_offset_count(): number;
  ctl_offset_key(i: number): number;
  ctl_offset_value(i: number): number;
  ctl_unavailable_count(): number;
  ctl_unavailable(i: number): number;
  ctl_blocked_count(): number;
  ctl_blocked(i: number): number;
  ctl_tempo_at(step: number): number;
  ctl_seconds(position: number, origin: number): number;
  ctl_frame(position: number, swing: number, rate: number, origin: number): number;
  ctl_duration(
    position: number,
    duration: number,
    swing: number,
    rate: number,
    origin: number,
  ): number;
  ctl_error(): number;
}

const KINDS: Record<string, number> = { mute: 0, solo: 1, macro: 2 };
let shared: ControlsExports | undefined;
function engine(): ControlsExports {
  if (shared) return shared;
  const module = new WebAssembly.Module(decodeBase64(CONTROLS_WASM_BASE64));
  const exports = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: { random_get: () => 0 },
  }).exports as unknown as ControlsExports;
  exports._initialize?.();
  shared = exports;
  return exports;
}

export interface LoadedControls {
  engine: ControlsExports;
  /** The ID a uid stands for. */
  name(uid: number): string;
}

/** Lays out the project's mutes, solos, macros, events, overrides and tempo
 *  map. `registry` also marks which macro assignments name a parameter that
 *  exists (needed for offsets, not for the blocked tracks): true builds the
 *  project's registry, or pass its IDs. */
export function loadControls(
  project: Project,
  overrides: ReadonlyMap<string, boolean | number>,
  registry: boolean | ReadonlySet<string>,
): LoadedControls {
  const e = engine(),
    ids = new Map<string, number>(),
    names: string[] = [];
  const uid = (id: string) => {
    let n = ids.get(id);
    if (n === undefined) {
      n = names.length;
      ids.set(id, n);
      names.push(id);
    }
    return n;
  };
  const fail = () => {
    throw new Error("Performance controls budget exceeded");
  };
  const p = project.performance;
  e.ctl_begin(project.bpm);
  const index = new Map(project.tracks.map((t, i) => [t.id, i]));
  for (const t of project.tracks) {
    const target = midiDestination(project.tracks, t);
    if (!e.ctl_track(uid(t.id), t.muted ? 1 : 0, target ? (index.get(target.id) ?? -1) : -1))
      fail();
  }
  if (!e.ctl_tracks_done()) fail();
  if (p) {
    for (const [id, value] of Object.entries(p.mutes))
      if (!e.ctl_mute(uid(id), value ? 1 : 0)) fail();
    for (const id of p.solos) if (!e.ctl_solo(uid(id))) fail();
    const valid =
      registry === true
        ? new Set(parameterRegistry(project).map((r) => r.id))
        : registry || undefined;
    for (const m of p.macros) {
      if (!e.ctl_macro(uid(m.id), m.value)) fail();
      for (const a of m.assignments)
        if (!e.ctl_assignment(uid(a.parameter), a.amount, !valid || valid.has(a.parameter) ? 1 : 0))
          fail();
    }
    for (const ev of p.events)
      if (
        !e.ctl_event(
          KINDS[ev.kind] ?? 0,
          uid(ev.kind === "macro" ? ev.macroId : ev.trackId),
          Number(ev.value),
          ev.at,
        )
      )
        fail();
  }
  for (const [key, value] of overrides) {
    const at = key.indexOf(":"),
      kind = KINDS[key.slice(0, at)];
    if (kind === undefined) continue;
    if (!e.ctl_override(kind, uid(key.slice(at + 1)), Number(value))) fail();
  }
  for (const t of project.mix?.tempos ?? []) if (!e.ctl_tempo(t.step, t.bpm)) fail();
  return { engine: e, name: (n) => names[n] ?? "" };
}

/** Throws the TypeScript error for the last timing call's error, if any. */
export function timingChecked(e: ControlsExports, value: number) {
  const error = e.ctl_error();
  if (error === 1) throw new Error("Invalid groove");
  if (error === 2) throw new Error("Invalid musical position");
  return value;
}
