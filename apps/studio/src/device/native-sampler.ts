import type { NativeTouchscreen } from "../../../../packages/core/src/device-ui.ts";
import {
  chopSampleToKit,
  installSample,
  manualSlices,
  ownKit,
  recordLoop,
  samplerInput,
} from "../../../../packages/core/src/edits.ts";
import type { DeviceController } from "./controller.ts";

/** Browser presentation and audio adapter for the actual C++ Sample touchscreen. */
export class NativeSampler {
  private initialized = false;
  private messageSeen = "";
  private projectRevision = -1;
  private projectTrack = "";
  private recordingRequest = false;
  private threshold = false;
  private source: DeviceController["workbench"]["sample"];
  private frame?: ImageData;
  private qValues = [0.5, 0.5, 0.5, 0.5];
  constructor(
    private readonly c: DeviceController,
    readonly ui: NativeTouchscreen,
  ) {}
  sync() {
    const s = this.c.workbench.sample;
    const sourceChanged = !this.initialized || this.source !== s;
    if (
      sourceChanged ||
      !this.initialized ||
      this.projectRevision !== this.c.session.revision ||
      this.projectTrack !== this.c.trackId
    ) {
      this.ui.setProject(
        this.c.project,
        this.c.project.tracks.findIndex((t) => t.id === this.c.trackId),
        sourceChanged || this.projectTrack !== this.c.trackId ? this.c.nav.pad : this.ui.state.pad,
      );
      this.projectRevision = this.c.session.revision;
      this.projectTrack = this.c.trackId;
    }
    if (sourceChanged) {
      this.initialized = true;
      this.source = s;
      // Native sample editing uses a 48 kHz take on every platform.
      if (s) {
        const ratio = s.rate / 48000;
        const pcm = new Float32Array(Math.round(s.pcm.length / ratio));
        if (pcm.length > 1536000) throw new Error("Take exceeds the 32-second sampler limit");
        for (let i = 0; i < pcm.length; ++i) {
          const at = i * ratio,
            lo = Math.floor(at),
            f = at - lo;
          pcm[i] =
            (s.pcm[lo] ?? 0) * (1 - f) + (s.pcm[Math.min(s.pcm.length - 1, lo + 1)] ?? 0) * f;
        }
        this.ui.setTake(pcm, s.name);
        this.ui.setEdit(
          Math.round(s.edit.start / ratio),
          Math.round(s.edit.end / ratio),
          s.edit.reverse,
        );
      } else this.ui.setTake([]);
    }
    if (this.c.message !== this.messageSeen) {
      this.messageSeen = this.c.message;
      this.ui.notice(this.c.message);
    }
    this.ui.saveState(this.c.session.error ? 3 : this.c.session.dirty ? 1 : 0);
    this.ui.transport(this.c.audio.position, this.c.audio.playing);
  }
  mount(root: HTMLElement) {
    this.sync();
    const canvas = root.querySelector<HTMLCanvasElement>("#native-sampler");
    if (!canvas) return;
    canvas.dataset.status = this.ui.state.message;
    this.frame ??= new ImageData(1280, 800);
    this.ui.paintRGBA(this.frame.data);
    canvas.getContext("2d")?.putImageData(this.frame, 0, 0);
    const overlays = root.querySelector<HTMLElement>("#native-sampler-controls");
    overlays?.replaceChildren();
    if (overlays)
      for (const control of this.ui.controls()) {
        const button = document.createElement(control.kind === "number" ? "input" : "button");
        if (button instanceof HTMLInputElement) {
          button.id = "native-value-input";
          button.type = "number";
          button.value = String(control.value);
          button.min = String(control.min);
          button.max = String(control.max);
          button.oninput = () => {
            this.ui.numberText(button.value);
            if (this.frame) {
              this.ui.paintRGBA(this.frame.data);
              canvas.getContext("2d")?.putImageData(this.frame, 0, 0);
            }
          };
        } else button.textContent = control.name;
        if (control.key) {
          button.dataset.valueKey = control.key;
          button.dataset.value = String(control.value);
        }
        button.setAttribute("aria-label", control.name);
        button.disabled = !control.enabled;
        Object.assign(button.style, {
          position: "absolute",
          left: `${control.x}px`,
          top: `${control.y}px`,
          width: `${control.width}px`,
          height: `${control.height}px`,
          opacity: "0.001",
          pointerEvents: "auto",
        });
        if (control.kind !== "number")
          button.onclick = (event) => {
            event.stopPropagation();
            this.touch("down", control.x + control.width / 2, control.y + control.height / 2);
          };
        overlays.append(button);
      }
    const point = (event: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return [
        ((event.clientX - r.left) * 1280) / r.width,
        ((event.clientY - r.top) * 800) / r.height,
      ] as const;
    };
    canvas.onpointerdown = (e) => {
      e.stopPropagation();
      canvas.setPointerCapture(e.pointerId);
      this.touch("down", ...point(e));
    };
    canvas.onpointermove = (e) => {
      if (e.buttons) this.touch("move", ...point(e));
    };
    canvas.onpointerup = (e) => this.touch("up", ...point(e));
  }
  observe() {
    this.sync();
    const state = this.ui.state;
    this.c.audio.setSamplerMonitor?.(
      state.monitor && (state.inputTrack || this.c.nav.page === "sample"),
    );
  }
  refresh() {
    const canvas = document.getElementById("native-sampler") as HTMLCanvasElement | null;
    if (!canvas || !this.frame) return;
    this.sync();
    this.ui.paintRGBA(this.frame.data);
    canvas.getContext("2d")?.putImageData(this.frame, 0, 0);
    canvas.dataset.status = this.ui.state.message;
  }
  private finish() {
    for (const action of this.ui.actions()) {
      const s = this.source;
      if (action.kind === "audition") {
        void this.c.audio
          .audition?.(48000, this.ui.preview(action.pad))
          .catch((e) => this.c.notify(String(e)));
        continue;
      }
      if (action.kind === "tempo" && action.value !== undefined) {
        const bpm = action.value;
        this.c.edit((p) => ({ ...p, bpm }));
        if (this.source) this.source.revision = this.c.session.revision;
        continue;
      }
      if (action.kind === "rename" && action.name !== undefined) {
        const name = action.name,
          kind = action.renameKind;
        this.c.edit((p) => {
          if (kind === 1) p.name = name;
          else if (kind === 2) {
            const track = p.tracks[action.track];
            if (track) track.name = name;
          }
          return p;
        });
        if (this.source) this.source.revision = this.c.session.revision;
        continue;
      }
      if (action.kind === "settings") {
        const settings = this.ui.state;
        this.c.edit((p) => samplerInput(p, this.c.trackId, settings.monitor, settings.bars));
        if (this.source) this.source.revision = this.c.session.revision;
        this.c.audio.setSamplerMonitor?.(settings.monitor);
        continue;
      }
      if (action.kind === "stop-record") {
        if (this.threshold) this.c.audio.finishSamplerTake?.();
        else {
          this.c.audio.cancelSampler?.();
          this.ui.recording(0, 0);
        }
        continue;
      }
      if (action.kind === "record") {
        void this.record();
        continue;
      }
      if (action.kind === "discard") {
        this.c.workbench.sample = undefined;
        this.c.show("sound");
        continue;
      }
      if (!s || (action.kind !== "keep" && action.kind !== "chop")) continue;
      if (s.revision !== this.c.session.revision)
        throw new Error("Project or destination changed; reopen the sample");
      const pcm = this.ui.preview(),
        points = this.ui.state.edit.boundaries;
      this.c.edit((p) => {
        const settings = this.ui.state;
        if (action.kind === "chop") {
          const kit = chopSampleToKit(p, this.c.trackId, settings.name, 48000, pcm, points);
          return s.fromInput
            ? samplerInput(kit, this.c.trackId, settings.monitor, settings.bars)
            : kit;
        }
        const next = installSample(
          ownKit(p, this.c.trackId),
          action.pad,
          s.name,
          48000,
          pcm,
          this.c.trackId,
        );
        const kept =
          points.length > 2
            ? manualSlices(
                next,
                action.pad,
                [...points.slice(0, 16 - action.pad), pcm.length],
                this.c.trackId,
              )
            : next;
        return s.fromInput
          ? samplerInput(kept, this.c.trackId, settings.monitor, settings.bars)
          : kept;
      });
      this.c.workbench.sample = undefined;
      this.c.show("sound");
      this.c.notify(
        action.kind === "chop"
          ? "Chopped to this track’s drum kit · Undo restores"
          : "Sample kept · Undo restores",
      );
    }
    const page = this.ui.state.view.toLowerCase();
    if (page === "sound") this.c.show("sound");
    else if (
      page === "clips" ||
      page === "play" ||
      page === "steps" ||
      page === "mix" ||
      page === "song"
    )
      this.c.show(page);
    else if (page === "browse") this.c.show("library");
    else {
      const root = document.getElementById("app");
      if (root) this.mount(root);
    }
  }
  private async record() {
    if (this.recordingRequest) return;
    const c = this.c,
      track = c.trackId,
      scene = c.sceneId,
      pad = this.ui.state.pad,
      id = c.project.id,
      bpm = c.project.bpm;
    const { monitor, bars } = this.ui.state;
    if (!c.audio.enableSamplerInput || !c.audio.recordSampler) {
      this.ui.recording(0, 0);
      c.notify("Input recording unavailable · import a WAV take");
      return;
    }
    this.recordingRequest = true;
    try {
      await c.audio.enableSamplerInput(monitor);
      if (c.project.id !== id || c.trackId !== track || c.sceneId !== scene)
        throw new Error("Recording destination changed; press Record again");
      if (!c.audio.playing && c.audio.recordSamplerTake) {
        this.threshold = true;
        c.audio.recordSamplerTake(
          (pcm) => {
            if (c.project.id !== id) {
              this.ui.recording(0, 0);
              return;
            }
            c.workbench.sample = {
              name: "Sample",
              fromInput: true,
              rate: 48000,
              pcm: Array.from(pcm),
              edit: {
                start: 0,
                end: pcm.length,
                tune: 0,
                level: 1,
                fadeIn: 0,
                fadeOut: 0,
                reverse: false,
                slices: 1,
              },
              track,
              pad,
              revision: c.session.revision,
            };
            this.ui.recording(0, pcm.length);
            c.notify("Take ready · Keep to pad commits it");
          },
          (state, frames) => {
            this.ui.recording(state === 1 || state === 2 ? state : 0, frames);
            c.notify(
              state === 1
                ? "Waiting for sound"
                : state === 2
                  ? "Recording · REC or Stop ends the take"
                  : state === 5
                    ? "Nothing recorded"
                    : "Take ready",
            );
          },
        );
        return;
      }
      this.threshold = false;
      c.audio.recordSampler(
        bars,
        track,
        (pcm, first) => {
          try {
            if (c.project.id !== id || c.project.bpm !== bpm || !c.audio.playing)
              throw new Error("Take cancelled because playback changed");
            c.edit((p) => recordLoop(p, track, scene, pad, "Live loop", pcm, bars));
            const clip = c.project.scenes.find((s) => s.id === scene)?.clips[track];
            if (!clip) throw new Error("Recorded clip unavailable");
            c.audio.finishSamplerLoop?.(track, clip, first, bars);
            c.workbench.sample = {
              name: "Live loop",
              fromInput: true,
              rate: 48000,
              pcm: Array.from(pcm),
              edit: {
                start: 0,
                end: pcm.length,
                tune: 0,
                level: 1,
                fadeIn: 0,
                fadeOut: 0,
                reverse: false,
                slices: 1,
              },
              track,
              pad,
              revision: c.session.revision,
            };
            this.ui.recording(0, pcm.length);
            c.notify("Live loop kept on selected pad · Undo restores");
          } catch (e) {
            c.audio.cancelSampler?.();
            this.ui.recording(0, 0);
            c.notify(String(e));
          }
        },
        (state, frames) => {
          if (state === 1 || state === 2) {
            this.ui.recording(state, frames);
            c.notify(state === 1 ? "Queued for next bar" : `Recording ${bars} bars`);
          } else if (state === 5 || state === 6) {
            this.ui.recording(0, 0);
            c.notify(state === 6 ? "Input interrupted; previous sample kept" : "Take cancelled");
          }
        },
        pad,
      );
    } catch (e) {
      this.ui.recording(0, 0);
      c.notify(String(e));
    } finally {
      this.recordingRequest = false;
    }
  }
  touch(phase: "down" | "move" | "up", x: number, y: number) {
    this.sync();
    this.ui.touch(phase, x, y);
    this.finish();
  }
  pad(pad: number) {
    this.sync();
    this.ui.pad(pad);
    this.finish();
  }
  button(name: string, shift = false) {
    this.sync();
    if (shift) this.ui.button("shift", true);
    this.ui.button(name, true);
    this.ui.button(name, false);
    if (shift) this.ui.button("shift", false);
    this.c.nav.shift = false;
    this.finish();
  }
  qValue(index: number) {
    return this.qValues[index] ?? 0.5;
  }
  qlink(index: number, value: number) {
    this.sync();
    const delta = Math.round((value - (this.qValues[index] ?? 0.5)) * 100);
    this.qValues[index] = value;
    const shifted = this.c.nav.shift;
    if (shifted) this.ui.button("shift", true);
    this.ui.knob(index, delta);
    if (shifted) this.ui.button("shift", false);
    this.c.nav.shift = false;
    this.finish();
  }
}
