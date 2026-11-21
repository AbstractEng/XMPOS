import { samplerMode } from "@xmp/core";
import { cleanChop, evenChop, transientChop } from "../../../../packages/core/src/chop.ts";
import {
  editChain,
  editMix,
  editPerformance,
  editSequence,
  ownKit,
  parameterValue,
  setParameter,
  shareKit,
} from "../../../../packages/core/src/edits.ts";
import {
  PRESETS_PER_PAGE,
  synthPresetPages,
  synthPresets,
} from "../../../../packages/core/src/instrument-schema.ts";
import { machines } from "../../../../packages/core/src/machines.ts";
import { createEffect, type EffectKind } from "../../../../packages/core/src/mix-schema.ts";
import {
  padNote,
  padScales,
  rootPitch,
  scaleName,
} from "../../../../packages/core/src/pad-scale.ts";
import { trackPads } from "../../../../packages/core/src/pads.ts";
import type { PerformanceSnapshot } from "../../../../packages/core/src/performance.ts";
import {
  renderSampleEdit,
  type SampleEdit,
  sampleEdit,
} from "../../../../packages/core/src/sample-edit.ts";
import {
  conditions,
  expressionEdit,
  moveBlock,
  selectedHit,
} from "../../../../packages/core/src/workflow.ts";
import { clearErrorLog, errorReport } from "../error-log.ts";
import type { DeviceController } from "./controller.ts";

export const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
export const button = (action: string, text: string, attrs = "") =>
  `<button data-action="${escapeHtml(action)}" ${attrs}>${text}</button>`;
export function valueButton(
  key: string,
  name: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit = "",
  reset = value,
) {
  return `<button class="value-field" data-value-key="${escapeHtml(key)}" data-value="${value}" data-min="${min}" data-max="${max}" data-increment="${step}" data-reset="${reset}" data-unit="${escapeHtml(unit)}" aria-label="Edit ${escapeHtml(name)}"><span>${escapeHtml(name)}</span><strong>${Number(value.toFixed(3))}${escapeHtml(unit)}</strong></button>`;
}
export type ChopMethod = "keys" | "even" | "transients" | "hand" | "lazy";
export const chopNames: Record<ChopMethod, string> = {
  keys: "Keys",
  even: "Even",
  transients: "Transients",
  hand: "By hand",
  lazy: "Lazy chop",
};
export const launchTimings = [
  [0, "Immediate"],
  [4, "Beat"],
  [16, "Bar"],
  [32, "2 bars"],
  [64, "4 bars"],
] as const;
export const padMachines = [
  "xmp.sampler",
  "melodic-sampler",
  "xmp.subtractive",
  "xmp.midi",
] as const;

export class Workbench {
  tool: "select" | "draw" = "select";
  note: number | undefined;
  rollLow = 43;
  locksOpen = false;
  effectsOpen = false;
  machinePicker = false;
  // A Sampler's Sample page: how its take becomes the pads (the Live's Ui::Chop).
  chop = {
    method: "transients" as ChopMethod,
    count: 8,
    sensitivity: 0.5,
    points: [0] as number[],
    selected: 0,
    lazy: false,
    lazyStart: 0,
  };
  get samplerTrack() {
    return samplerMode(this.c.track) !== undefined;
  }
  // The slice points for the chosen method, in the edited take (frames).
  computeChop() {
    const s = this.sample;
    if (!s || !this.samplerTrack) return;
    const pcm = renderSampleEdit(s.pcm, s.rate, s.edit),
      ch = this.chop;
    if (ch.method === "keys") ch.points = [0];
    else if (ch.method === "even") ch.points = evenChop(pcm.length, ch.count);
    else if (ch.method === "transients") ch.points = transientChop(pcm, s.rate, ch.sensitivity);
    else if (ch.method === "hand")
      ch.points = cleanChop(
        ch.points.length > 1 ? ch.points : transientChop(pcm, s.rate, ch.sensitivity),
        pcm.length,
      );
    else if (!ch.lazy && !ch.points.length) ch.points = [0];
    ch.selected = Math.max(0, Math.min(ch.selected, ch.points.length - 1));
  }
  // Lazy chop: a pad tap starts a slice where the take is playing now.
  markLazy(now = performance.now()) {
    const s = this.sample,
      ch = this.chop;
    if (!s || !ch.lazy) return;
    const frames = renderSampleEdit(s.pcm, s.rate, s.edit).length,
      at = Math.round(((now - ch.lazyStart) / 1000) * s.rate);
    if (at >= frames) {
      ch.lazy = false;
      return this.c.notify(`The take ended: ${ch.points.length} slices`);
    }
    ch.points = cleanChop([...ch.points, at], frames);
    ch.selected = ch.points.length - 1;
    if (ch.points.length >= 16) ch.lazy = false;
    this.c.notify(`Slice ${ch.points.length}`);
  }
  // A synth's Sound page: its presets or every control (the Live's Ui::sound_controls).
  soundTab: "presets" | "controls" = "presets";
  // The dial's place on a synth's Sound page: a control (Controls) or a preset (Presets).
  soundFocus = 0;
  /** Sound page, synth tracks: the page of eight presets the top pads choose from. */
  presetPage = 0;
  // Tracks in Clips: 4 (the A-D banks) or all 8; a per-browser preference.
  overview = (() => {
    try {
      return localStorage.getItem("xmp-device-clip-grid") === "8";
    } catch {
      return false;
    }
  })();
  help = false;
  shiftHelp = false;
  readonly heardSlots = new Map<string, string>();
  private heardScene = "";
  queuedScene: { id: string; at: number } | undefined;
  readonly queuedSlots = new Map<string, { scene: string; clip: string | null; at: number }>();

  get launchTiming() {
    return (
      launchTimings.find(
        ([steps]) => steps === (this.c.project.performance?.launchQuantize ?? 16),
      )?.[1] ?? "Bar"
    );
  }

  get launchMessage() {
    return this.launchTiming === "Immediate" ? "launching now" : `queued · ${this.launchTiming}`;
  }

  resetLaunches() {
    this.heardScene = "";
    this.heardSlots.clear();
    this.queuedScene = undefined;
    this.queuedSlots.clear();
  }

  queueScene(scene: string) {
    const audio = this.c.audio;
    audio.queueScene(scene);
    this.queuedSlots.clear();
    this.queuedScene = audio.launchQueue?.scene;
  }

  queueSlot(track: string, clip: string | null, scene: string) {
    const audio = this.c.audio;
    audio.queueClip(track, clip);
    this.queuedScene = undefined;
    const queued = audio.launchQueue?.clips?.get(track);
    if (queued) this.queuedSlots.set(track, { scene, clip, at: queued.at });
  }
  browseKind = "samples";
  browseReturn = "sound" as "sound" | "sample" | "clips";
  block = 0;
  quantize = 1;
  capturing = false;
  captureReplace = false;
  private captureParts: {
    scene: string;
    clips: Record<string, string>;
    start: number;
    end: number;
  }[] = [];
  velocity = 0.8;
  chance = 1;
  length = 1;
  fxLocation = "track";
  sample:
    | {
        name: string;
        rate: number;
        pcm: number[];
        edit: SampleEdit;
        track: string;
        pad: number;
        revision: number;
        fromInput?: boolean;
      }
    | undefined;
  editor:
    | {
        key: string;
        name: string;
        value: number;
        min: number;
        max: number;
        step: number;
        reset: number;
        unit: string;
      }
    | undefined;
  rename: "project" | "track" | "clip" | undefined;
  readonly c: DeviceController;
  constructor(c: DeviceController) {
    this.c = c;
  }
  get pitched() {
    return (
      (this.c.track.machine?.id !== "xmp.sampler" && !!this.c.track.machine) ||
      samplerMode(this.c.track) === "keys"
    );
  }
  get pitch() {
    return (
      this.note ?? padNote(this.c.nav.pad, this.c.octave, this.c.scale, rootPitch(this.c.root))
    );
  }
  get hit() {
    return selectedHit(
      this.c.project,
      this.c.trackId,
      this.c.clip?.id,
      this.c.nav.pad,
      this.c.step,
      this.pitched ? this.pitch : undefined,
    );
  }
  openValue(el: HTMLElement) {
    const d = el.dataset;
    const value = Number(d.value),
      min = Number(d.min),
      max = Number(d.max),
      step = Number(d.increment);
    if (![value, min, max, step].every(Number.isFinite) || min > max || step <= 0 || !d.valueKey)
      return;
    this.editor = {
      key: d.valueKey,
      name: el.getAttribute("aria-label")?.replace(/^Edit /, "") ?? "Value",
      value,
      min,
      max,
      step,
      reset: Number(d.reset ?? value),
      unit: d.unit ?? "",
    };
    this.c.notify();
  }
  setValue(key: string, value: number) {
    if (!Number.isFinite(value)) throw new Error("Enter a finite number");
    const c = this.c;
    if (key === "tempo") return c.edit((p) => ({ ...p, bpm: value }));
    if (key === "octave") {
      c.octave = Math.round(value);
      this.note = undefined;
      return c.notify();
    }
    if (key === "quantize") {
      this.quantize = value / 100;
      return c.notify();
    }
    if (key.startsWith("new:")) {
      const name = key.slice(4);
      if (name === "velocity") this.velocity = value / 100;
      else if (name === "chance") this.chance = value / 100;
      else if (name === "length") this.length = value;
      return c.notify();
    }
    if (key.startsWith("expression:")) {
      const name = key.slice(11),
        patch =
          name === "velocity"
            ? { velocity: value / 100 }
            : name === "chance"
              ? { probability: value / 100 }
              : { duration: value };
      return c.edit((p) =>
        expressionEdit(
          p,
          c.trackId,
          c.clip?.id ?? "",
          c.nav.pad,
          c.step,
          this.pitched ? this.pitch : undefined,
          patch,
        ),
      );
    }
    if (key.startsWith("machine:")) {
      const id = key.slice(8),
        definition = machines.get(c.track.machine),
        parameter = definition?.parameters.find((p) => p.id === id);
      if (!definition || !parameter) throw new Error("Parameter unavailable");
      const native =
        parameter.unit === "seconds"
          ? value / 1000
          : parameter.unit === "normalized"
            ? value / 100
            : value;
      if (native < parameter.min || native > parameter.max) throw new Error("Value outside bounds");
      return c.edit((p) =>
        setParameter(
          p,
          `track.${c.track.id}.machine.${definition.id}.v${definition.version}.${id}`,
          (native - parameter.min) / (parameter.max - parameter.min),
        ),
      );
    }
    if (key.startsWith("part:")) {
      const id = key.slice(5);
      return c.edit((p) =>
        editChain(
          p,
          (p.performance?.chain ?? []).map((e) => (e.id === id ? { ...e, repeats: value } : e)),
        ),
      );
    }
    if (key.startsWith("param:"))
      return c.edit((p) => {
        const id = key.slice(6),
          match = /^track\.([a-zA-Z0-9_-]+)\.(pan|send\.[01])$/.exec(id);
        if (match)
          p = editMix(p, (mix) => {
            const track = match[1];
            if (track) mix.tracks[track] ??= { pan: 0.5, sends: [0, 0], inserts: [] };
          });
        return setParameter(p, id, value / 100);
      });
    throw new Error("Unknown parameter");
  }
  action(id: string): boolean | Promise<boolean> {
    const c = this.c;
    if (id === "value-cancel") {
      this.editor = undefined;
      c.notify();
      return true;
    }
    if (id === "value-reset" && this.editor) {
      this.editor.value = this.editor.reset;
      c.notify();
      return true;
    }
    if (id === "value-apply" && this.editor) {
      const value = Number((document.getElementById("value-input") as HTMLInputElement)?.value),
        e = this.editor;
      if (!Number.isFinite(value) || value < e.min || value > e.max)
        throw new Error(`Enter ${e.min}–${e.max} ${e.unit}`);
      this.setValue(e.key, value);
      this.editor = undefined;
      c.notify();
      return true;
    }
    if (id === "toggle-layout") {
      document.body.classList.toggle("show-hardware");
      c.notify();
      return true;
    }
    if (id === "help") {
      this.help = !this.help;
      c.notify();
      return true;
    }
    if (id === "effects-open" || id === "effects-close") {
      this.effectsOpen = id === "effects-open";
      c.notify();
      return true;
    }
    if (id === "lock-dialog") {
      this.locksOpen = !this.locksOpen;
      c.notify();
      return true;
    }
    if (id === "capture-mode") {
      this.captureReplace = !this.captureReplace;
      c.notify();
      return true;
    }
    if (id === "capture") {
      this.toggleCapture();
      return true;
    }
    if (id.startsWith("rename:")) {
      this.rename = id.slice(7) as typeof this.rename;
      c.notify();
      return true;
    }
    if (id === "rename-cancel") {
      this.rename = undefined;
      c.notify();
      return true;
    }
    if (id === "rename-apply" && this.rename) {
      const name = (document.getElementById("rename-input") as HTMLInputElement)?.value.trim(),
        target = this.rename;
      if (!name || name.length > (target === "project" ? 80 : 40))
        throw new Error("Enter a shorter nonempty name");
      c.edit((p) => {
        if (target === "project") p.name = name;
        else if (target === "track") {
          const t = p.tracks.find((t) => t.id === c.trackId);
          if (t) t.name = name;
        } else c.ensureClip(p).name = name;
        return p;
      });
      this.rename = undefined;
      c.notify();
      return true;
    }
    if (id === "sound-tab:presets" || id === "sound-tab:controls") {
      this.soundTab = id === "sound-tab:controls" ? "controls" : "presets";
      // The dial starts on the first control, or on the preset now playing.
      this.soundFocus =
        this.soundTab === "controls"
          ? 0
          : Math.max(
              0,
              synthPresets.findIndex((p) => p.name === c.track.machine?.state.name),
            );
      if (this.soundTab === "presets")
        this.presetPage = Math.floor(this.soundFocus / PRESETS_PER_PAGE);
      c.notify();
      return true;
    }
    if (id === "open-kits") {
      this.browseReturn = "sound";
      this.browseKind = "kits";
      c.show("library");
      return true;
    }
    if (id === "machine-picker") {
      this.machinePicker = !this.machinePicker;
      c.notify();
      return true;
    }
    if (id.startsWith("machine:")) {
      if (id === "machine:melodic-sampler") {
        c.edit((p) => {
          const next = ownKit(p, c.trackId),
            t = next.tracks.find((t) => t.id === c.trackId);
          if (t?.pads) {
            t.machine = { id: "xmp.sampler", base: "audio", version: 1, state: { mode: "keys" } };
            const source = t.pads[c.nav.pad] ?? t.pads[0];
            if (source)
              t.pads = t.pads.map((pad) => ({
                ...source,
                id: pad.id,
                playback: { mode: "chromatic", rootNote: 48, chokeGroup: 0 },
              }));
          }
          return next;
        });
      } else if (id === "machine:xmp.sampler")
        c.edit((p) => {
          const trackId = c.trackId;
          const next = ownKit(samplerMode(c.track) ? shareKit(p, trackId) : p, trackId);
          const t = next.tracks.find((t) => t.id === trackId);
          if (t) {
            t.machine = machines.instantiate("xmp.sampler");
            for (const pad of t.pads ?? [])
              if (pad.playback?.mode === "chromatic")
                pad.playback = { mode: "one-shot", rootNote: 48, chokeGroup: 0 };
          }
          return next;
        });
      else c.setMachine(id.slice(8));
      this.machinePicker = false;
      c.show("sound");
      return true;
    }
    if (id.startsWith("preset-page:")) {
      const page = Number(id.slice(12));
      if (Number.isInteger(page) && page >= 0 && page < synthPresetPages.length) {
        this.presetPage = page;
        c.notify(`Presets: ${synthPresetPages[page]}`);
      }
      return true;
    }
    if (id.startsWith("preset:")) {
      const preset = synthPresets[Number(id.slice(7))];
      if (preset)
        c.edit((p) => {
          const t = p.tracks.find((t) => t.id === c.trackId);
          if (t?.machine) t.machine.state = { ...preset };
          return p;
        });
      return true;
    }
    if (id.startsWith("tool:")) {
      this.tool = id.slice(5) === "draw" ? "draw" : "select";
      c.notify();
      return true;
    }
    if (id === "delete-hit") {
      this.toggleStep(c.step, true);
      return true;
    }
    if (id === "clear-locks") {
      if (c.clip)
        c.edit((p) =>
          editSequence(p, c.trackId, c.clip?.id ?? "", (seq) => {
            seq.locks = seq.locks.filter((l) => l.position !== c.step);
          }),
        );
      return true;
    }
    if (id === "add-lock") {
      const parameter = (document.getElementById("lock-parameter") as HTMLSelectElement)?.value;
      if (c.clip && parameter)
        c.edit((p) =>
          editSequence(p, c.trackId, c.clip?.id ?? "", (seq) => {
            seq.locks = seq.locks.filter((l) => l.position !== c.step || l.parameter !== parameter);
            seq.locks.push({ position: c.step, parameter, value: parameterValue(p, parameter) });
          }),
        );
      return true;
    }
    if (id === "error-log-clear") {
      clearErrorLog();
      c.notify("Error log cleared");
      return true;
    }
    if (id === "error-log-copy") {
      const report = errorReport();
      void navigator.clipboard
        ?.writeText(report)
        .then(() => c.notify("Error log copied"))
        .catch(() => c.notify("Copy blocked; the log is also in the browser console"));
      return true;
    }
    if (id === "overview" || id.startsWith("clip-grid:")) {
      this.overview = id === "overview" ? !this.overview : id === "clip-grid:8";
      try {
        localStorage.setItem("xmp-device-clip-grid", this.overview ? "8" : "4");
      } catch {}
      c.notify();
      return true;
    }
    if (id === "stop-all") {
      for (const t of c.project.tracks) this.queueSlot(t.id, null, c.sceneId);
      c.notify(`All track stops ${this.launchMessage}`);
      return true;
    }
    if (id.startsWith("stop-track:")) {
      this.queueSlot(id.slice(11), null, "");
      c.notify(`Track stop ${this.launchMessage}`);
      return true;
    }
    if (id === "relaunch") {
      this.queueScene(c.sceneId);
      c.notify(`${c.scene.name} ${this.launchMessage}`);
      return true;
    }
    if (id === "fill") {
      const audio = c.audio as typeof c.audio & { fill?: boolean };
      audio.fill = !audio.fill;
      c.notify(audio.fill ? "Fill on" : "Fill off");
      return true;
    }
    if (id.startsWith("solo:")) {
      const track = id.slice(5);
      c.edit((p) =>
        editPerformance(p, (perf) => {
          perf.solos = perf.solos.includes(track)
            ? perf.solos.filter((t) => t !== track)
            : [...perf.solos, track];
        }),
      );
      return true;
    }
    if (id === "edit-sample") {
      this.openSample();
      return true;
    }
    if (id === "replace-sample") {
      this.browseReturn = "sound";
      this.browseKind = "samples";
      c.show("library");
      return true;
    }
    if (id.startsWith("block:")) {
      this.block = Number(id.slice(6));
      c.notify();
      return true;
    }
    if (id.startsWith("move-block:")) {
      const [from, to] = id.slice(11).split(":").map(Number);
      if (from !== undefined && to !== undefined)
        c.edit((p) => editChain(p, moveBlock(p.performance?.chain ?? [], from, to)));
      return true;
    }
    if (id === "fx-install") {
      const kind = (document.getElementById("wb-fx-kind") as HTMLSelectElement).value as EffectKind;
      c.edit((p) =>
        editMix(p, (mix) => {
          if (this.fxLocation === "track")
            mix.tracks[c.trackId] ??= { pan: 0.5, sends: [0, 0], inserts: [] };
          const inserts =
            this.fxLocation === "track"
              ? mix.tracks[c.trackId]?.inserts
              : mix.returns[Number(this.fxLocation) as 0 | 1];
          if (!inserts) throw new Error("Channel unavailable");
          if (inserts.length === 2) throw new Error("Two inserts per channel; remove one first");
          inserts.push(createEffect(kind, `fx-${c.session.revision}`));
        }),
      );
      return true;
    }
    if (id.startsWith("fx-remove:")) {
      const fx = id.slice(10);
      c.edit((p) =>
        editMix(p, (mix) => {
          if (this.fxLocation === "track") {
            const strip = mix.tracks[c.trackId];
            if (strip) strip.inserts = strip.inserts.filter((e) => e.id !== fx);
          } else {
            const i = Number(this.fxLocation) as 0 | 1;
            mix.returns[i] = mix.returns[i].filter((e) => e.id !== fx);
          }
        }),
      );
      return true;
    }
    if (id.startsWith("fx-bypass:")) {
      const fx = id.slice(10);
      c.edit((p) =>
        editMix(p, (mix) => {
          const effect = [
            ...Object.values(mix.tracks).flatMap((t) => t.inserts),
            ...mix.returns.flat(),
          ].find((e) => e.id === fx);
          if (effect) effect.bypass = !effect.bypass;
        }),
      );
      return true;
    }
    return false;
  }
  observe(snapshot: PerformanceSnapshot | undefined = this.c.audio.performanceSnapshot) {
    if (snapshot?.running) {
      const sceneLaunched = this.queuedScene && snapshot.step >= this.queuedScene.at;
      if (sceneLaunched || snapshot.sceneId !== this.heardScene) {
        this.heardSlots.clear();
        this.heardScene = snapshot.sceneId;
      }
      if (sceneLaunched) this.queuedScene = undefined;
      for (const [track, queued] of this.queuedSlots) {
        if (snapshot.step < queued.at) continue;
        if (queued.clip && snapshot.clips[track] === queued.clip)
          this.heardSlots.set(track, queued.scene);
        else this.heardSlots.delete(track);
        this.queuedSlots.delete(track);
      }
    }
    if (!this.capturing || !snapshot?.running) return;
    const at = Math.max(0, this.c.audio.performancePosition ?? snapshot.step),
      last = this.captureParts.at(-1),
      clips = snapshot.clips;
    if (last && JSON.stringify(last.clips) === JSON.stringify(clips)) {
      last.end = at;
      return;
    }
    if (last) last.end = at;
    if (this.captureParts.length >= 64) {
      this.c.notify("Capture reached 64 blocks; finish the capture");
      return;
    }
    this.captureParts.push({ scene: snapshot.sceneId, clips: { ...clips }, start: at, end: at });
  }
  toggleCapture() {
    if (!this.capturing) {
      this.captureParts = [];
      this.capturing = true;
      this.observe();
      this.c.notify("Capture armed · launch clips or scenes; Stop finishes");
      return;
    }
    this.finishCapture();
  }
  finishCapture() {
    if (!this.capturing) return;
    this.observe();
    this.capturing = false;
    const runs = this.captureParts;
    this.captureParts = [];
    if (!runs.length) {
      this.c.notify("Capture ended; no launches recorded");
      return;
    }
    const c = this.c;
    c.edit((p) => {
      const chain = this.captureReplace ? [] : [...(p.performance?.chain ?? [])];
      let at = this.captureReplace ? 0 : Math.min(chain.length, this.block + 1);
      for (const run of runs) {
        let scene = p.scenes.find((s) => p.tracks.every((t) => s.clips[t.id] === run.clips[t.id]));
        if (!scene) {
          if (p.scenes.length >= 16)
            throw new Error("No free scene for this jam; capture was not applied");
          let index = 0;
          while (p.scenes.some((s) => s.id === `jam-${index}`)) index++;
          scene = { id: `jam-${index}`, name: `Jam ${index + 1}`, clips: { ...run.clips } };
          p.scenes.push(scene);
        }
        const length = Math.max(
          16,
          ...p.tracks.map(
            (t) => t.clips.find((clip) => clip.id === scene?.clips[t.id])?.length ?? 16,
          ),
        );
        let repeats = Math.max(1, Math.round((run.end - run.start) / length));
        while (repeats > 0) {
          if (chain.length >= 64)
            throw new Error("Song reached 64 blocks; capture was not applied");
          let index = 0;
          while (chain.some((e) => e.id === `jam-part-${index}`)) index++;
          chain.splice(at++, 0, {
            id: `jam-part-${index}`,
            sceneId: scene.id,
            repeats: Math.min(16, repeats),
          });
          repeats -= 16;
        }
      }
      return editChain(p, chain);
    });
    c.notify("Jam captured · one Undo restores the song");
  }
  toggleStep(step: number, erase = false) {
    const c = this.c;
    c.step = step;
    if (this.hit && !erase && this.tool === "select") return c.notify();
    const pitch = this.pitched ? this.pitch : undefined;
    c.edit((p) => {
      const clip = c.ensureClip(p);
      const matching = (s: { pad: number; note?: number }) =>
        pitch === undefined ? s.pad === c.nav.pad : (s.note ?? 48 + s.pad) === pitch;
      const old = clip.steps.find((s) => s.step === step && matching(s));
      const seq = clip.sequence?.notes.find((n) => Math.floor(n.position) === step && matching(n));
      if (old || seq) {
        clip.steps = clip.steps.filter((s) => s !== old);
        if (clip.sequence) clip.sequence.notes = clip.sequence.notes.filter((n) => n !== seq);
      } else if (!erase) {
        if (pitch === undefined)
          clip.steps.push({
            step,
            pad: c.nav.pad,
            velocity: this.velocity,
            probability: this.chance,
          });
        else {
          const used = new Set(clip.steps.filter((s) => s.step === step).map((s) => s.pad));
          let pad = c.nav.pad;
          while (used.has(pad) && pad < 16) pad++;
          if (pad === 16) throw new Error("This step already has sixteen voices");
          clip.steps.push({
            step,
            pad,
            note: pitch,
            duration: this.length,
            velocity: this.velocity,
            probability: this.chance,
          });
        }
      }
      return p;
    });
  }
  openSample() {
    const c = this.c,
      pad = trackPads(c.project, c.trackId)[c.nav.pad],
      asset = c.project.samples.find((s) => s.id === pad?.sampleId);
    if (!asset || !pad) throw new Error("Sample unavailable");
    const edit = sampleEdit(asset.pcm.length);
    // A Sampler opens its whole sample, to chop again; a kit pad, its own part.
    const sampler = this.samplerTrack;
    edit.start = sampler ? 0 : (pad.slice?.start ?? 0);
    edit.end = sampler ? asset.pcm.length : (pad.slice?.end ?? asset.pcm.length);
    edit.reverse = pad.edit?.reverse ?? false;
    this.sample = {
      name: asset.name,
      rate: asset.sampleRate,
      pcm: pad.edit?.normalize
        ? (() => {
            let peak = 0;
            for (let i = edit.start; i < edit.end; i++)
              peak = Math.max(peak, Math.abs(asset.pcm[i] ?? 0));
            return peak ? asset.pcm.map((v) => Math.max(-1, Math.min(1, v / peak))) : asset.pcm;
          })()
        : asset.pcm,
      edit,
      track: c.trackId,
      pad: c.nav.pad,
      revision: c.session.revision,
    };
    if (sampler) {
      const starts = trackPads(c.project, c.trackId)
        .filter((p) => p.sampleId === asset.id && p.slice)
        .map((p) => p.slice?.start ?? 0);
      this.chop.points = cleanChop(starts, asset.pcm.length);
      this.chop.method = this.chop.points.length > 1 ? "hand" : "keys";
      this.chop.selected = 0;
      this.chop.lazy = false;
    }
    c.show("sample");
  }
  change(input: HTMLInputElement | HTMLSelectElement) {
    const c = this.c;
    if (input.dataset.commitKey) {
      this.setValue(input.dataset.commitKey, Number(input.value));
      return true;
    }
    if (input.id === "wb-root") {
      const root = Number(input.value);
      if (Number.isInteger(root) && root >= 0 && root < 12) c.root = root;
      this.note = undefined;
      c.notify(`Playing scale: ${scaleName(c.scale, c.root)}`);
      return true;
    }
    if (input.id === "wb-scale") {
      const scale = padScales.find((s) => s.id === input.value);
      if (scale) c.scale = scale.id;
      this.note = undefined;
      c.notify(`Playing scale: ${scaleName(c.scale, c.root)}`);
      return true;
    }
    if (input.id === "wb-condition") {
      const condition = conditions.find((s) => s === input.value);
      if (condition && c.clip)
        c.edit((p) =>
          expressionEdit(
            p,
            c.trackId,
            c.clip?.id ?? "",
            c.nav.pad,
            c.step,
            this.pitched ? this.pitch : undefined,
            { condition },
          ),
        );
      return true;
    }
    if (input.id === "wb-launch") {
      const value = Number(input.value);
      if (![0, 4, 16, 32, 64].includes(value)) throw new Error("Invalid launch grid");
      c.edit((p) =>
        editPerformance(p, (perf) => {
          perf.launchQuantize = value as 0 | 4 | 16 | 32 | 64;
        }),
      );
      return true;
    }
    if (input.id === "wb-record-quantize") {
      this.quantize = Number(input.value) / 100;
      c.notify();
      return true;
    }
    if (input.id === "wb-oscillator") {
      if (!["sine", "saw", "square"].includes(input.value)) throw new Error("Invalid oscillator");
      c.edit((p) => {
        const m = p.tracks.find((t) => t.id === c.trackId)?.machine;
        if (m) m.state.oscillator = input.value;
        return p;
      });
      return true;
    }
    if (input.id === "wb-fx-location") {
      this.fxLocation = input.value;
      c.notify();
      return true;
    }
    if (input.dataset.partScene) {
      const id = input.dataset.partScene;
      c.edit((p) =>
        editChain(
          p,
          (p.performance?.chain ?? []).map((e) =>
            e.id === id ? { ...e, sceneId: input.value } : e,
          ),
        ),
      );
      return true;
    }
    if (input.id === "wb-song-end") {
      c.edit((p) =>
        editPerformance(p, (perf) => {
          perf.end = input.value === "loop" ? "loop" : "stop";
        }),
      );
      return true;
    }
    return false;
  }
}
