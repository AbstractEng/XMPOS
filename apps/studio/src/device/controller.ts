import { createDemoProject, machineChosen, type Project, ProjectSchema } from "@xmp/core";
import {
  type ControlAction,
  ControlActionSchema,
} from "../../../../packages/core/src/control-actions.ts";
import {
  appendNotes,
  applyDrumKit,
  editChain,
  editPerformance,
  expandSong,
  installSample,
  overdubSteps,
  ownKit,
  setMidiDestination,
  setParameter,
  shareKit,
  toggleStep,
} from "../../../../packages/core/src/edits.ts";
import {
  PRESETS_PER_PAGE,
  synthPresetPages,
  synthPresets,
} from "../../../../packages/core/src/instrument-schema.ts";
import { machines } from "../../../../packages/core/src/machines.ts";
import { type PadScale, padNote, rootPitch } from "../../../../packages/core/src/pad-scale.ts";
import type { PerformanceSnapshot } from "../../../../packages/core/src/performance.ts";
import type { SequenceNote } from "../../../../packages/core/src/sequence-schema.ts";
import { ProjectSession } from "../../../../packages/core/src/session.ts";
import { recordPosition, syncSamplerSound } from "../../../../packages/core/src/workflow.ts";
import { loadKitById } from "../bundled-drum-kits.ts";
import { logError } from "../error-log.ts";
import { SampleLibrary } from "./library.ts";
import { liveMk1 } from "./live-mk1.ts";
import type { NativeSampler } from "./native-sampler.ts";
import {
  type DevicePage,
  initialNavigation,
  menuPad,
  menuPages,
  type PanelButton,
  padOrder,
  slotCoordinates,
} from "./navigation.ts";
import { padMachines, Workbench } from "./workbench.ts";

export interface DeviceAudio {
  playing: boolean;
  position: number;
  readonly performanceSnapshot?: PerformanceSnapshot;
  readonly performancePosition?: number;
  readonly launchQueue?: {
    scene?: { id: string; at: number };
    clips?: ReadonlyMap<string, { id: string | null; at: number }>;
  };
  enable(): Promise<void>;
  start(scene: string, mode?: "scene" | "song", resume?: boolean): void;
  stop(): void;
  panic(): void;
  setProject(project: Project): void;
  trigger(
    pad: number,
    velocity?: number,
    at?: number,
    track?: string,
    note?: number,
    duration?: number,
  ): number | undefined;
  queueClip(track: string, clip: string | null): void;
  queueScene(scene: string): void;
  cancelLaunch(): unknown;
  audition?(rate: number, pcm: Float32Array): Promise<void>;
  stopAudition?(): void;
  enableSamplerInput?(monitor: boolean): Promise<void>;
  setSamplerMonitor?(enabled: boolean): void;
  recordSampler?(
    bars: number,
    track: string,
    take: (pcm: Float32Array, firstStep: number) => void,
    state: (phase: number, frames: number) => void,
    pad?: number,
  ): void;
  finishSamplerLoop?(track: string, clip: string, firstStep: number, bars: number): void;
  recordSamplerTake?(
    take: (pcm: Float32Array) => void,
    state: (phase: number, frames: number) => void,
  ): void;
  finishSamplerTake?(): void;
  cancelSampler?(): void;
}
export function deviceDemo(): Project {
  const p = expandSong(createDemoProject());
  for (const track of p.tracks.slice(1)) {
    track.clips = track.clips.slice(0, 1);
    for (const scene of p.scenes.slice(1)) delete scene.clips[track.id];
  }
  for (const scene of p.scenes.slice(4)) delete scene.clips[p.tracks[0]?.id ?? ""];
  const first = p.tracks[0];
  if (first) first.clips = first.clips.slice(0, 4);
  return ProjectSchema.parse(p);
}
export class DeviceController {
  sampler?: NativeSampler;
  readonly workbench = new Workbench(this);
  session: ProjectSession;
  nav = initialNavigation();
  library = new SampleLibrary();
  trackId: string;
  sceneId: string;
  message = "MAIN: Clips · MENU: pages · SHIFT + MENU: Library";
  saveStatus = "Saved locally";
  scale: PadScale = "major";
  // The playing scale's root: 0 = C … 11 = B.
  root = 0;
  octave = 0;
  fullLevel = false;
  projectOpenFailed = false;
  record = false;
  overdub = false;
  busy = false;
  step = 0;
  query = "";
  libraryCursor = 0;
  pending:
    | {
        kind: "delete" | "copy";
        track: string;
        scene: string;
        sourceTrack?: string;
        sourceClip?: string;
      }
    | undefined;
  copySource: { track: string; clip: string } | undefined;
  private taps: number[] = [];
  private previewGeneration = 0;
  private transportGeneration = 0;
  menuCursor = 0;
  private draft: Project["tracks"][number]["clips"][number]["steps"] = [];
  private looseDraft: SequenceNote[] = [];
  private recordTarget:
    | { track: string; clip: string; revision: number; length: number; anchor: number }
    | undefined;
  onChange = () => {};
  onEdit = () => {};
  readonly audio: DeviceAudio;
  constructor(project: Project, audio: DeviceAudio) {
    this.audio = audio;
    this.session = new ProjectSession(project, true);
    this.trackId = project.tracks[0]?.id ?? "";
    this.sceneId = project.scenes[0]?.id ?? "";
    audio.setProject(project);
  }
  get project() {
    return this.session.project;
  }
  get track() {
    const track = this.project.tracks.find((t) => t.id === this.trackId) ?? this.project.tracks[0];
    if (!track) throw new Error("Missing track");
    return track;
  }
  get scene() {
    const scene = this.project.scenes.find((s) => s.id === this.sceneId) ?? this.project.scenes[0];
    if (!scene) throw new Error("Missing scene");
    return scene;
  }
  get clip() {
    return this.track.clips.find((c) => c.id === this.scene.clips[this.track.id]);
  }
  get samples() {
    const q = this.query.toLowerCase();
    return this.library.items.filter((item) =>
      `${item.name} ${item.folder}`.toLowerCase().includes(q),
    );
  }
  // The Sample page records into a Kit's pad or a Sampler's sample; synths and
  // MIDI tracks have nothing to sample into (the Live's Ui::can_sample).
  get canSample() {
    const machine = this.track.machine?.id;
    return machineChosen(this.track) && (!machine || machine === "xmp.sampler");
  }
  notify(text?: string) {
    if (text) this.message = text;
    // Choosing a synth or MIDI track while on Sample moves to its Sound page.
    if (this.nav.page === "sample" && !this.canSample) this.nav.page = "sound";
    this.onChange();
  }
  edit(change: (p: Project) => Project) {
    if (this.recordTarget) this.finishRecording();
    this.session.edit(change);
    this.audio.setProject(this.project);
    this.onEdit();
    this.onChange();
  }
  // Defaults the user didn't ask for, without an undo step (see ProjectSession.amend).
  amend(change: (p: Project) => Project) {
    this.session.amend(change);
    this.audio.setProject(this.project);
    this.onEdit();
    this.onChange();
  }
  private syncClipFocus() {
    this.trackId = this.track.id;
    this.sceneId = this.scene.id;
    const track = this.project.tracks.findIndex((t) => t.id === this.trackId);
    const scene = this.project.scenes.findIndex((s) => s.id === this.sceneId);
    this.nav.bank = Math.floor(track / 4) * 4 + Math.floor(scene / 4);
    this.nav.cursor = (3 - (scene % 4)) * 4 + (track % 4);
  }
  show(page: DevicePage) {
    if (page === "sample" && !this.canSample)
      return this.notify(
        `Sample is for Kit and Sampler tracks; ${this.track.name} is ${machines.get(this.track.machine)?.name ?? "not set up yet"}`,
      );
    if (page !== "play" && this.recordTarget) this.finishRecording();
    if (page === "clips") this.syncClipFocus();
    if (page !== "library") {
      this.previewGeneration++;
      this.audio.stopAudition?.();
    }
    if (page !== this.nav.page) {
      this.nav.previous = this.nav.page;
      this.nav.page = page;
    }
    if (page === "steps" && this.workbench.pitched && this.workbench.note === undefined) {
      const first =
        this.clip?.sequence?.notes[0]?.note ??
        this.clip?.steps.find((s) => s.note !== undefined)?.note;
      if (first !== undefined) {
        this.workbench.note = first;
        this.workbench.rollLow = Math.max(0, Math.min(120, first - 2));
      }
    }
    this.notify();
  }
  select(pad: number) {
    const at = slotCoordinates(this.nav.bank, pad),
      t = this.project.tracks[at.track],
      s = this.project.scenes[at.scene];
    if (!t || !s) return;
    this.nav.cursor = pad;
    this.trackId = t.id;
    this.sceneId = s.id;
    this.notify();
  }
  ensureClip(p: Project, trackId = this.trackId, sceneId = this.sceneId) {
    const track = p.tracks.find((t) => t.id === trackId),
      scene = p.scenes.find((s) => s.id === sceneId);
    if (!track || !scene) throw new Error("Clip target unavailable");
    let clip = track.clips.find((c) => c.id === scene.clips[track.id]);
    if (!clip) {
      if (track.clips.length >= 16)
        throw new Error("Track has sixteen clips; reuse an existing clip in Advanced Studio");
      let n = 0;
      while (track.clips.some((c) => c.id === `device-${n}`)) n++;
      clip = { id: `device-${n}`, name: `${scene.name} loop`, length: 16, steps: [] };
      track.clips.push(clip);
      scene.clips[track.id] = clip.id;
    }
    return clip;
  }
  createClip() {
    this.edit((p) => {
      this.ensureClip(p);
      return p;
    });
    this.show("steps");
  }
  stepPress(step: number) {
    this.edit((p) => {
      const clip = this.ensureClip(p);
      const next = toggleStep(p, this.trackId, clip.id, this.nav.pad, step);
      if (this.track.machine?.id !== "xmp.sampler" && this.track.machine) {
        const hit = next.tracks
          .find((t) => t.id === this.trackId)
          ?.clips.find((c) => c.id === clip.id)
          ?.steps.find((s) => s.step === step && s.pad === this.nav.pad);
        if (hit) {
          hit.note = padNote(this.nav.pad, this.octave, this.scale, rootPitch(this.root));
          hit.duration = 1;
        }
      }
      return next;
    });
  }
  async launch(pad: number, shift = false) {
    this.select(pad);
    if (this.copySource) {
      this.pending = {
        kind: "copy",
        track: this.trackId,
        scene: this.sceneId,
        sourceTrack: this.copySource.track,
        sourceClip: this.copySource.clip,
      };
      this.copySource = undefined;
      this.confirm();
      return;
    }
    if (shift) {
      this.show("steps");
      return;
    }
    const clip = this.clip;
    if (!this.project.performance) this.amend((p) => editPerformance(p, () => {}));
    if (this.audio.playing) this.workbench.queueSlot(this.trackId, clip?.id ?? null, this.sceneId);
    else
      this.edit((p) =>
        editPerformance(p, (performance) => {
          performance.selection = {
            sceneId: this.sceneId,
            clips: {
              ...(performance.selection?.sceneId === this.sceneId
                ? performance.selection.clips
                : this.scene.clips),
            },
          };
          if (clip) performance.selection.clips[this.trackId] = clip.id;
          else delete performance.selection.clips[this.trackId];
        }),
      );
    this.notify(
      clip
        ? `${clip.name} ${this.audio.playing ? this.workbench.launchMessage : "prepared; press PLAY"}`
        : this.audio.playing
          ? `Track stop ${this.workbench.launchMessage}`
          : "Empty slot prepared · press PLAY",
    );
  }
  async pad(pad: number, shift = false) {
    if (!Number.isInteger(pad) || pad < 0 || pad > 15) return;
    if (this.pending) return this.notify("Confirm or cancel the clip change first");
    try {
      if (this.nav.page === "sample" && this.sampler) return this.sampler.pad(pad);
      if (
        this.workbench.machinePicker ||
        (this.nav.page === "sound" && !machineChosen(this.track))
      ) {
        const machine = padMachines[pad];
        if (machine) await this.workbench.action(`machine:${machine}`);
        return;
      }
      if (this.nav.page === "menu") {
        const item = menuPages[menuPad(pad)];
        if (item) this.show(item.page);
        return;
      }
      if (this.nav.page === "clips") return await this.launch(pad, shift);
      if (this.nav.page === "scenes") {
        const scene = this.project.scenes[pad];
        if (!scene) return;
        this.sceneId = scene.id;
        if (this.audio.playing) this.workbench.queueScene(scene.id);
        else
          this.edit((p) =>
            editPerformance(p, (performance) => {
              performance.selection = { sceneId: scene.id, clips: { ...scene.clips } };
            }),
          );
        this.notify(
          `${scene.name} ${this.audio.playing ? this.workbench.launchMessage : "selected"}`,
        );
        return;
      }
      if (this.nav.page === "track" || this.nav.page === "mute" || this.nav.page === "mix") {
        const track = this.project.tracks[pad];
        if (!track) return;
        this.trackId = track.id;
        if (this.nav.page === "mute")
          this.edit((p) => {
            const t = p.tracks.find((t) => t.id === track.id);
            if (t) t.muted = !t.muted;
            return p;
          });
        this.notify();
        return;
      }
      if (this.nav.page === "steps") {
        if (shift) {
          this.nav.pad = pad;
          this.workbench.note = padNote(pad, this.octave, this.scale, rootPitch(this.root));
          return this.notify();
        }
        const step = Math.floor(this.step / 16) * 16 + padOrder.indexOf(pad);
        if (step < (this.clip?.length ?? 16)) {
          const tool = this.workbench.tool;
          this.workbench.tool = "draw";
          this.workbench.toggleStep(step);
          this.workbench.tool = tool;
        }
        return;
      }
      // A Sampler's Sample page: during lazy chop a tap starts a slice; otherwise
      // a pad picks its slice.
      if (this.nav.page === "sample" && this.workbench.sample && this.workbench.samplerTrack) {
        const ch = this.workbench.chop;
        if (ch.lazy) return this.workbench.markLazy();
        if (pad < ch.points.length) ch.selected = pad;
        return this.notify(pad < ch.points.length ? `Slice ${pad + 1}` : `No slice ${pad + 1}`);
      }
      this.nav.pad = pad;
      if (this.nav.page === "library")
        return this.notify(
          `Load to pad ${pad + 1}. SHIFT + PLAY auditions the focused library sound.`,
        );
      if (
        this.nav.page === "sound" &&
        this.track.machine?.id === "xmp.subtractive" &&
        this.workbench.soundTab === "presets" &&
        pad >= 8
      )
        return void this.workbench.action(
          `preset:${this.workbench.presetPage * PRESETS_PER_PAGE + (3 - Math.floor(pad / 4)) * 4 + (pad % 4)}`,
        );
      if (this.nav.page !== "play" && this.nav.page !== "sound") return;
      const generation = this.transportGeneration,
        track = this.trackId;
      await this.audio.enable();
      if (
        generation !== this.transportGeneration ||
        track !== this.trackId ||
        !["play", "sound"].includes(this.nav.page)
      )
        return;
      const pitched = this.workbench.pitched;
      this.audio.trigger(
        pad,
        this.fullLevel ? 1 : 0.8,
        undefined,
        track,
        pitched ? padNote(pad, this.octave, this.scale, rootPitch(this.root)) : undefined,
        24000,
      );
      if (this.record && this.recordTarget && this.audio.playing) {
        const target = this.recordTarget;
        const snapshot = this.audio.performanceSnapshot;
        if (
          this.overdub &&
          (snapshot?.clips[target.track] !== target.clip ||
            snapshot.anchors[target.track] !== target.anchor)
        ) {
          this.finishRecording();
          return;
        }
        const position = (this.audio.performancePosition ?? this.audio.position) - target.anchor;
        if (this.workbench.quantize < 1) {
          const at = recordPosition(position, target.length, this.workbench.quantize);
          this.looseDraft.push({
            id: `take-${this.session.revision}-${this.looseDraft.length}`,
            pad,
            note: pitched ? padNote(pad, this.octave, this.scale, rootPitch(this.root)) : 60,
            position: at,
            duration: 1,
            velocity: this.fullLevel ? 1 : 0.8,
            probability: 1,
            microtiming: 0,
            condition: "always",
          });
          if (this.looseDraft.length >= 1024) this.finishRecording();
          this.notify();
          return;
        }
        const at = ((Math.floor(position) % target.length) + target.length) % target.length;
        this.draft.push({
          step: at,
          pad,
          velocity: this.fullLevel ? 1 : 0.8,
          probability: 1,
          ...(pitched
            ? { note: padNote(pad, this.octave, this.scale, rootPitch(this.root)), duration: 1 }
            : {}),
        });
        if (this.draft.length >= 1024) this.finishRecording();
      }
      this.notify();
    } catch (error) {
      this.notify(logError("Pad action failed", error));
    }
  }
  finishRecording() {
    const target = this.recordTarget;
    this.record = false;
    this.overdub = false;
    this.recordTarget = undefined;
    if (!target || (!this.draft.length && !this.looseDraft.length))
      return this.notify("Recording finished; no notes captured");
    const notes = this.draft;
    const loose = this.looseDraft;
    this.looseDraft = [];
    this.draft = [];
    if (this.session.revision !== target.revision)
      return this.notify("Song changed during recording; take was not applied");
    this.edit((p) =>
      loose.length
        ? appendNotes(p, target.track, target.clip, loose)
        : overdubSteps(p, target.track, target.clip, notes),
    );
    this.notify("Recorded pad hits committed as one undoable edit");
  }
  async play(fromStart = false, song = false) {
    if (this.audio.playing && !fromStart) return;
    if (this.recordTarget) this.finishRecording();
    const generation = ++this.transportGeneration;
    if (fromStart) this.audio.stop();
    await this.audio.enable();
    if (generation !== this.transportGeneration) return;
    if (!this.project.performance) this.amend((p) => editPerformance(p, () => {}));
    if (this.record) {
      if (!this.clip)
        this.edit((p) => {
          this.ensureClip(p);
          return p;
        });
      const clip = this.clip;
      if (clip) {
        this.recordTarget = {
          track: this.trackId,
          clip: clip.id,
          revision: this.session.revision,
          length: clip.length,
          anchor: this.audio.performanceSnapshot?.anchors[this.trackId] ?? 0,
        };
        this.draft = [];
      }
    }
    this.workbench.resetLaunches();
    this.audio.start(this.sceneId, song ? "song" : "scene", !fromStart);
    if (this.recordTarget)
      this.recordTarget.anchor =
        this.audio.performanceSnapshot?.anchors[this.recordTarget.track] ?? 0;
    this.notify(
      song ? "Playing song chain" : `Playing · launch timing: ${this.workbench.launchTiming}`,
    );
  }
  async assignSample(id: string) {
    const revision = this.session.revision,
      pad = this.nav.pad,
      libraryRevision = this.library.revision,
      track = this.trackId;
    this.busy = true;
    this.notify("Reading the selected library sample…");
    try {
      const sample = await this.library.decode(id);
      if (
        revision !== this.session.revision ||
        pad !== this.nav.pad ||
        track !== this.trackId ||
        libraryRevision !== this.library.revision
      )
        throw new Error("Project or load target changed; retry");
      this.edit((p) =>
        syncSamplerSound(
          installSample(ownKit(p, track), pad, sample.name, sample.sampleRate, sample.pcm, track),
          track,
          pad,
        ),
      );
      this.notify(
        `Loaded ${sample.name} to pad ${pad + 1} · ${this.track.pads ? `${this.track.name}'s own kit` : "shared kit"}`,
      );
    } catch (e) {
      this.notify(logError("Sample load failed", e));
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
  // Project format 7: the track gets its own copy of the pads it plays, or
  // returns to the shared kit.
  toggleKit() {
    const track = this.trackId,
      own = !!this.track.pads;
    this.edit((p) => (own ? shareKit(p, track) : ownKit(p, track)));
    this.notify(
      own
        ? `${this.track.name} plays the shared kit again · UNDO restores its own kit`
        : `${this.track.name} has its own kit, a copy of the shared kit; load sounds to change it`,
    );
  }
  async loadKit(id: string) {
    const revision = this.session.revision;
    this.busy = true;
    this.notify("Loading kit…");
    try {
      const kit = await loadKitById(id);
      if (revision !== this.session.revision)
        throw new Error("Project changed during loading; retry");
      const track = this.trackId;
      this.edit((p) => applyDrumKit(ownKit(p, track), kit, track));
      this.notify(
        `${kit.name} loaded · ${this.track.pads ? `${this.track.name}'s own kit` : "shared kit"}`,
      );
    } catch (e) {
      this.notify(logError("Kit load failed", e));
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
  async preview() {
    const item = this.samples[this.libraryCursor];
    if (!item) return;
    const generation = ++this.previewGeneration,
      libraryRevision = this.library.revision;
    try {
      const sample = await this.library.decode(item.id);
      if (
        generation !== this.previewGeneration ||
        libraryRevision !== this.library.revision ||
        this.nav.page !== "library"
      )
        return;
      await this.audio.audition?.(sample.sampleRate, sample.pcm);
      this.notify(`Auditioning ${sample.name}; project unchanged`);
    } catch (e) {
      this.notify(logError("Preview failed", e));
    }
  }
  setMachine(id: string) {
    this.edit((p) => {
      const t = p.tracks.find((t) => t.id === this.trackId);
      if (t) t.machine = machines.instantiate(id);
      return p;
    });
    this.notify("Track machine changed; other track machines retained");
  }
  setMidiDestination(id: string) {
    this.edit((p) => setMidiDestination(p, this.trackId, id || undefined));
    this.notify(
      id
        ? "Internal MIDI destination changed · UNDO restores it"
        : "MIDI destination cleared · event preview only",
    );
  }
  addScene() {
    this.edit((p) =>
      editChain(p, [
        ...(p.performance?.chain ?? []),
        {
          id: `part-${p.performance?.chain.length ?? 0}-${this.session.revision}`,
          sceneId: this.sceneId,
          repeats: 1,
        },
      ]),
    );
    this.notify(`${this.scene.name} added to song chain`);
  }
  confirm() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.edit((p) => {
      const track = p.tracks.find((t) => t.id === pending.track),
        scene = p.scenes.find((s) => s.id === pending.scene);
      if (!track || !scene) throw new Error("Target unavailable");
      if (pending.kind === "delete") delete scene.clips[track.id];
      else {
        const source = p.tracks
          .find((t) => t.id === pending.sourceTrack)
          ?.clips.find((c) => c.id === pending.sourceClip);
        if (!source) throw new Error("Copy source unavailable");
        if (track.clips.length >= 16)
          throw new Error("Track has sixteen clips; copy was not applied");
        let n = 0;
        while (p.tracks.some((t) => t.clips.some((c) => c.id === `device-copy-${n}`))) n++;
        const id = `device-copy-${n}`;
        track.clips.push({
          ...structuredClone(source),
          id,
          name: `${source.name.slice(0, 30)} copy`,
        });
        scene.clips[track.id] = id;
      }
      return p;
    });
    this.notify("Change applied · UNDO restores it");
  }
  turn(delta: number) {
    if (!Number.isInteger(delta) || Math.abs(delta) > 16) return;
    if (this.nav.page === "menu") {
      this.menuCursor = Math.max(0, Math.min(menuPages.length - 1, this.menuCursor + delta));
      this.notify();
    } else if (this.nav.page === "sound" && machineChosen(this.track)) {
      // The dial moves through the Sound page's items (the Live's Ui::wheel).
      const w = this.workbench,
        synth = this.track.machine?.id === "xmp.subtractive";
      if (synth && w.soundTab === "controls") {
        // The oscillator, then each control (soundControls).
        const count = (machines.get(this.track.machine)?.parameters.length ?? 0) + 1;
        w.soundFocus = Math.max(0, Math.min(count - 1, w.soundFocus + delta));
      } else if (synth) {
        w.soundFocus = Math.max(0, Math.min(synthPresets.length - 1, w.soundFocus + delta));
        w.presetPage = Math.floor(w.soundFocus / PRESETS_PER_PAGE);
      } else this.nav.pad = Math.max(0, Math.min(15, this.nav.pad + delta));
      this.notify();
    } else if (this.nav.page === "sample" && this.workbench.sample && this.workbench.samplerTrack) {
      const ch = this.workbench.chop;
      ch.selected = Math.max(0, Math.min(ch.points.length - 1, ch.selected + delta));
      this.notify(`Slice ${ch.selected + 1}`);
    } else if (["track", "mix", "mute", "play"].includes(this.nav.page)) {
      const index = this.project.tracks.findIndex((t) => t.id === this.trackId);
      this.trackId =
        this.project.tracks[Math.max(0, Math.min(this.project.tracks.length - 1, index + delta))]
          ?.id ?? this.trackId;
      this.notify();
    } else if (["scenes", "song"].includes(this.nav.page)) {
      const index = this.project.scenes.findIndex((s) => s.id === this.sceneId);
      this.sceneId =
        this.project.scenes[Math.max(0, Math.min(this.project.scenes.length - 1, index + delta))]
          ?.id ?? this.sceneId;
      this.notify();
    } else if (this.nav.page === "library") {
      this.libraryCursor = Math.max(
        0,
        Math.min(this.samples.length - 1, this.libraryCursor + delta),
      );
      this.notify();
    } else if (this.nav.page === "clips") {
      const order = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3],
        i = order.indexOf(this.nav.cursor);
      this.select(order[Math.max(0, Math.min(15, i + delta))] ?? 12);
    } else if (this.nav.page === "steps") {
      const offset = this.step % 16;
      this.step =
        Math.max(
          0,
          Math.min(
            Math.ceil((this.clip?.length ?? 16) / 16) - 1,
            Math.floor(this.step / 16) + delta,
          ),
        ) *
          16 +
        offset;
      this.notify();
    } else {
      this.step = Math.max(0, Math.min((this.clip?.length ?? 16) - 1, this.step + delta));
      this.notify();
    }
  }
  qlink(index: number, value: number) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 3 ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      return;
    if (this.nav.page === "sample" && this.sampler) return this.sampler.qlink(index, value);
    const key = this.workbenchQKey(index);
    if (key) {
      this.workbench.setValue(key, key.endsWith(":length") ? 0.25 + value * 15.75 : value * 100);
      return;
    }
    if (this.nav.qPage === 0) {
      if (index < 2)
        this.edit((p) =>
          setParameter(p, index === 0 ? `track.${this.trackId}.gain` : "master.gain", value),
        );
      else
        this.edit((p) => ({
          ...p,
          ...(index === 2 ? { swing: value / 2 } : { bpm: Math.round(30 + value * 270) }),
        }));
    } else {
      const meta = machines.get(this.track.machine)?.parameters[(this.nav.qPage - 1) * 4 + index];
      if (!meta) return;
      let native = meta.min + value * (meta.max - meta.min);
      if (meta.step) native = Math.round((native - meta.min) / meta.step) * meta.step + meta.min;
      this.edit((p) => {
        const machine = p.tracks.find((t) => t.id === this.trackId)?.machine;
        if (machine) machine.state[meta.id] = Math.max(meta.min, Math.min(meta.max, native));
        return p;
      });
    }
  }
  private workbenchQKey(index: number) {
    if (this.nav.page === "steps" && this.nav.qPage < 2)
      return index < 3
        ? `${this.nav.qPage === 1 ? "new" : "expression"}:${["velocity", "chance", "length"][index]}`
        : `param:track.${this.track.id}.gain`;
    if (this.nav.page === "steps" ? this.nav.qPage === 3 : this.nav.qPage % 2 === 1) {
      const d = machines.get(this.track.machine),
        order =
          d?.id === "xmp.subtractive"
            ? ["cutoff", "attack", "decay", "release"]
            : (d?.parameters.map((p) => p.id) ?? []);
      return d && order[index]
        ? `param:track.${this.track.id}.machine.${d.id}.v${d.version}.${order[index]}`
        : "";
    }
    return `param:track.${this.track.id}.${["gain", "pan", "send.0", "send.1"][index]}`;
  }
  async button(button: PanelButton, shift = this.nav.shift) {
    if (
      button === "rec" &&
      (this.nav.page === "clips" || this.nav.page === "sound") &&
      this.sampler?.ui.state.inputTrack
    ) {
      this.show("sample");
      return this.sampler.button(button, shift);
    }
    if (
      this.nav.page === "sample" &&
      this.sampler &&
      (["plus", "minus", "rec", "wheel"].includes(button) ||
        (button === "stop" && this.sampler.ui.state.sampling))
    )
      return this.sampler.button(button, shift);
    this.nav.shift = button === "shift" ? this.nav.shift : false;
    if (button === "plus" || button === "minus") {
      const delta = button === "plus" ? 1 : -1;
      if (this.nav.page === "play") {
        this.octave = Math.max(-3, Math.min(3, this.octave + delta));
        this.workbench.note = undefined;
        return this.notify();
      }
      if (this.nav.page === "steps" && this.workbench.pitched) {
        this.workbench.note = Math.max(
          0,
          Math.min(127, this.workbench.pitch + delta * (shift ? 12 : 1)),
        );
        return this.notify();
      }
      if (
        this.nav.page === "sound" &&
        this.track.machine?.id === "xmp.subtractive" &&
        this.workbench.soundTab === "presets"
      ) {
        const pages = synthPresetPages.length;
        return void this.workbench.action(
          `preset-page:${(((this.workbench.presetPage + delta) % pages) + pages) % pages}`,
        );
      }
      if (this.nav.page === "clips") {
        const group = Math.floor(this.nav.bank / 4) * 4;
        this.nav.bank = group + Math.max(0, Math.min(3, (this.nav.bank % 4) + delta));
        return this.select(this.nav.cursor);
      }
    }
    return this.dispatch(liveMk1.resolve(button, shift, this.nav.page));
  }
  async dispatch(input: ControlAction) {
    try {
      const action = ControlActionSchema.parse(input);
      if (this.pending && !["stop", "back", "activate", "shift"].includes(action.type))
        return this.notify("Confirm or cancel the clip change first");
      if (action.type === "shift") {
        this.nav.shift = !this.nav.shift;
        return this.notify();
      }
      if (action.type === "navigate") return this.show(action.page);
      if (action.type === "menu")
        return this.show(this.nav.page === "menu" ? this.nav.previous : "menu");
      if (action.type === "back") return this.enter(true);
      if (action.type === "activate") return this.enter();
      if (action.type === "pad") return await this.pad(action.index, action.edit);
      if (action.type === "parameter") return this.qlink(action.index, action.value);
      if (action.type === "bank") {
        const track = this.project.tracks[action.index];
        if (track) {
          this.trackId = track.id;
          this.nav.bank = Math.floor(action.index / 4) * 4 + (this.nav.bank % 4);
          this.workbench.note = undefined;
        }
        return this.onChange();
      }
      if (action.type === "parameter-page") {
        const pages = this.nav.page === "steps" ? 4 : 2;
        this.nav.qPage = (this.nav.qPage + action.delta + pages) % pages;
        return this.notify();
      }
      if (action.type === "history") {
        if (this.record) this.finishRecording();
        if (action.redo) this.session.redo();
        else this.session.undo();
        this.trackId = this.track.id;
        this.sceneId = this.scene.id;
        if (this.nav.page === "clips") this.syncClipFocus();
        this.audio.setProject(this.project);
        this.onEdit();
        return this.notify(action.redo ? "Redo" : "Undo");
      }
      if (action.type === "stop") {
        if (this.workbench.capturing) this.workbench.finishCapture();
        this.transportGeneration++;
        this.previewGeneration++;
        this.audio.stopAudition?.();
        if (!this.audio.playing) this.audio.panic();
        this.audio.stop();
        if (this.record) this.finishRecording();
        this.audio.cancelLaunch();
        this.workbench.resetLaunches();
        return this.notify("Stopped · press STOP again for panic");
      }
      if (action.type === "audition") return await this.preview();
      if (action.type === "play") return await this.play(action.restart, this.nav.page === "song");
      if (action.type === "record") {
        if (this.nav.page === "song") {
          this.workbench.toggleCapture();
          return;
        }
        if (this.record) return this.finishRecording();
        if (this.audio.playing) {
          if (!action.overdub) return this.notify("Use OVER DUB to add notes to a playing clip");
          const snapshot = this.audio.performanceSnapshot;
          const clip = this.track.clips.find((c) => c.id === snapshot?.clips[this.trackId]);
          if (!clip) return this.notify("OVER DUB needs a playing clip on the selected track");
          this.recordTarget = {
            track: this.trackId,
            clip: clip.id,
            revision: this.session.revision,
            length: clip.length,
            anchor: snapshot?.anchors[this.trackId] ?? 0,
          };
          this.draft = [];
          this.record = this.overdub = true;
          this.show("play");
          return this.notify(
            "Overdub active · play pads · OVER DUB or REC finishes without stopping",
          );
        }
        this.record = true;
        this.overdub = !!action.overdub;
        this.show("play");
        return this.notify(
          this.record
            ? "Additive recording armed · PLAY START · play pads · STOP commits"
            : "Recording disarmed",
        );
      }
      if (action.type === "copy" || action.type === "delete") {
        if (action.type === "delete") {
          this.pending = { kind: "delete", track: this.trackId, scene: this.sceneId };
          this.confirm();
          return;
        }
        if (this.clip) {
          this.copySource = { track: this.trackId, clip: this.clip.id };
          this.show("clips");
          return this.notify("COPY: press a destination clip pad, then confirm");
        }
        return this.notify("Choose a nonempty source clip first");
      }
      if (action.type === "erase") {
        if (this.clip)
          this.edit((p) => {
            const clip = this.ensureClip(p);
            clip.steps = clip.steps.filter((s) => s.pad !== this.nav.pad);
            if (clip.sequence)
              clip.sequence.notes = clip.sequence.notes.filter((n) => n.pad !== this.nav.pad);
            return p;
          });
        return this.notify("Selected pad notes erased · UNDO restores them");
      }
      if (action.type === "full-level") {
        this.fullLevel = !this.fullLevel;
        return this.notify(
          this.fullLevel ? "Full level: fixed maximum velocity" : "Fixed browser velocity: 80%",
        );
      }
      if (action.type === "16-level") return this.show("steps");
      if (action.type === "note-repeat") return this.workbench.action("fill");
      if (action.type === "focus") return this.turn(action.delta);
      if (action.type === "tap") {
        const now = performance.now();
        this.taps = this.taps.filter((t) => now - t < 2000);
        this.taps.push(now);
        if (this.taps.length >= 3) {
          const bpm = Math.max(
            30,
            Math.min(300, (60000 * (this.taps.length - 1)) / (now - (this.taps[0] ?? now))),
          );
          this.edit((p) => ({ ...p, bpm: Math.round(bpm) }));
        }
        return this.notify("Tap three or more times to set tempo");
      }
    } catch (e) {
      this.notify(logError("Control action failed", e));
    }
  }
  enter(shift = false) {
    if (shift) {
      this.pending = undefined;
      this.copySource = undefined;
      return this.show(this.nav.previous === "menu" ? "clips" : this.nav.previous);
    }
    if (this.pending) return this.confirm();
    if (this.nav.page === "menu") {
      const page = menuPages[this.menuCursor];
      if (page) this.show(page.page);
    } else if (this.nav.page === "steps") this.stepPress(this.step);
    else if (this.nav.page === "scenes")
      void this.pad(this.project.scenes.findIndex((s) => s.id === this.sceneId));
    else if (this.nav.page === "library") {
      const item = this.samples[this.libraryCursor];
      if (item) return this.assignSample(item.id);
    } else if (this.nav.page === "clips") {
      if (!this.clip) this.createClip();
      else this.show("steps");
    } else if (this.nav.page === "song") this.addScene();
    else if (this.nav.page === "sound" && machineChosen(this.track)) {
      // ENTER acts on the dial's item: a preset is chosen, a pad's sample opened
      // (a control's editor opens in the view, which knows its field).
      const w = this.workbench;
      if (this.track.machine?.id === "xmp.subtractive") {
        if (w.soundTab === "presets") void w.action(`preset:${w.soundFocus}`);
      } else if (this.track.machine?.id !== "xmp.midi") void w.action("edit-sample");
    }
  }
}
