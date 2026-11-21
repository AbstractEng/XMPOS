import type { Project } from "@xmp/core";
import {
  hasInstruments,
  prepareInstruments,
  sameSounds,
  soundsKey,
} from "../../../packages/core/src/instruments.ts";
import { loopModule } from "../../../packages/core/src/loop-engine.ts";
import { musicalPosition, musicalSeconds } from "../../../packages/core/src/mix.ts";
import { trackPads } from "../../../packages/core/src/pads.ts";
import { groovePosition, hasSequence } from "../../../packages/core/src/sequencer.ts";
import workletUrl from "./instrument-worklet.ts?worker&url";
import samplerWorkletUrl from "./sampler-worklet.ts?worker&url";
import "./track-machines.ts";
import {
  eventsAtStep,
  PerformanceTransport,
  parameterFrame,
  parameterSmoothingMs,
  parameterValue,
  performanceCommands,
  performanceControls,
  performanceValues,
  performanceWindow,
  renderPerformance,
  renderProjectScene,
  samplerPlan,
  timeline,
} from "../../../packages/core/src/edits.ts";

import type { PerformanceSnapshot } from "../../../packages/core/src/performance.ts";

import type { PerformanceEvent } from "../../../packages/core/src/performance-schema.ts";

export class StudioAudio {
  private previewSource?: AudioBufferSourceNode;
  private previewGeneration = 0;
  stopAudition() {
    this.previewGeneration++;
    this.previewSource?.stop();
    this.previewSource = undefined;
  }
  async audition(sampleRate: number, pcm: Float32Array) {
    if (
      !Number.isFinite(sampleRate) ||
      !pcm.length ||
      pcm.length > 1536000 ||
      sampleRate < 8000 ||
      sampleRate > 96000 ||
      pcm.some((v) => !Number.isFinite(v) || Math.abs(v) > 1)
    )
      throw new Error("Invalid preview sound");
    this.stopAudition();
    const generation = this.previewGeneration;
    await this.enable();
    if (generation !== this.previewGeneration) return;
    if (!this.context || !this.limiter) return;
    const source = this.context.createBufferSource(),
      gain = this.context.createGain();
    const buffer = this.context.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(new Float32Array(pcm), 0);
    source.buffer = buffer;
    gain.gain.value = 0.2;
    source.connect(gain).connect(this.limiter);
    this.previewSource = source;
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      if (this.previewSource === source) this.previewSource = undefined;
    };
    source.start();
  }
  private sampler?: AudioWorkletNode;
  private samplerStream?: MediaStream;
  private samplerOpening?: Promise<void>;
  private samplerPoll?: ReturnType<typeof setInterval>;
  private samplerTake?: (pcm: Float32Array) => void;
  private samplerState?: (state: number, frames: number) => void;
  private samplerTakeRequested = false;
  private samplerBusy = false;
  private samplerThreshold = false;
  private samplerTarget?: {
    project: string;
    track: string;
    pad: number;
    sample: string;
    previous: string | null;
  };
  private samplerPad = 0;
  private samplerPhase = -1;
  private samplerFrames = -1;
  private samplerRestore?: { track: string; clip: string | null };
  async enableSamplerInput(monitor: boolean) {
    await this.enable();
    if (!this.sampler && !this.samplerOpening)
      this.samplerOpening = (async () => {
        const context = this.context;
        if (context?.sampleRate !== 48000)
          throw new Error("Sampler input requires a 48 kHz audio context");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false,
        });
        try {
          await context.audioWorklet.addModule(samplerWorkletUrl);
          const node = new AudioWorkletNode(context, "xmp-sampler-input", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { module: await loopModule() },
          });
          context.createMediaStreamSource(stream).connect(node);
          node.connect(this.limiter ?? context.destination);
          this.sampler = node;
          this.samplerStream = stream;
          node.port.onmessage = (e) => {
            if (e.data.pcm) {
              if (this.samplerThreshold) this.samplerBusy = false;
              this.samplerTake?.(e.data.pcm);
            } else {
              if (this.samplerPhase === e.data.state && this.samplerFrames === e.data.frames)
                return;
              this.samplerPhase = e.data.state;
              this.samplerFrames = e.data.frames;
              if ([4, 5, 6].includes(e.data.state)) {
                this.samplerBusy = false;
                if (e.data.state === 4) this.samplerTarget = undefined;
                if (e.data.state === 6) this.cancelSampler();
              }
              this.samplerState?.(e.data.state, e.data.frames);
              if (e.data.state === 3 && !this.samplerTakeRequested) {
                this.samplerTakeRequested = true;
                node.port.postMessage({ op: "take" });
              }
            }
          };
          this.samplerPoll = setInterval(() => node.port.postMessage({ op: "state" }), 50);
        } catch (e) {
          stream.getTracks().forEach((t) => {
            t.stop();
          });
          throw e;
        }
      })().finally(() => {
        this.samplerOpening = undefined;
      });
    await this.samplerOpening;
    this.setSamplerMonitor(monitor);
  }
  setSamplerMonitor(enabled: boolean) {
    this.sampler?.port.postMessage({ op: "monitor", enabled });
  }
  recordSampler(
    bars: number,
    track: string,
    take: (pcm: Float32Array, firstStep: number) => void,
    state: (phase: number, frames: number) => void,
    pad = 0,
  ) {
    this.samplerPad = pad;
    if (!this.sampler || !this.project || !this.playing)
      throw new Error("Start playback before recording a synced loop");
    if (this.samplerBusy)
      throw new Error("The previous loop is entering its clip; wait for its next boundary");
    const { frames } = samplerPlan(this.project, bars);
    this.samplerThreshold = false;
    this.samplerBusy = true;
    this.samplerPhase = -1;
    this.samplerFrames = -1;
    const firstStep = (Math.floor(Math.max(this.position, this.step) / 16) + 1) * 16;
    const first = Math.round((this.anchor + this.secondsFor(firstStep)) * 48000);
    this.samplerRestore = { track, clip: this.performance?.slots.get(track)?.clipId ?? null };
    this.performance?.queueClipAt(track, null, firstStep);
    this.samplerTakeRequested = false;
    this.samplerTake = (pcm) => take(pcm, firstStep);
    this.samplerState = state;
    const volume = this.project.tracks.find((t) => t.id === track)?.volume ?? 0;
    this.sampler.port.postMessage({
      op: "queue",
      first,
      frames,
      gain: volume * this.project.master * 0.25,
    });
  }
  recordSamplerTake(
    take: (pcm: Float32Array) => void,
    state: (phase: number, frames: number) => void,
  ) {
    if (!this.sampler || this.samplerBusy) throw new Error("Input is not ready for another take");
    this.samplerThreshold = true;
    this.samplerBusy = true;
    this.samplerTakeRequested = false;
    this.samplerPhase = -1;
    this.samplerFrames = -1;
    this.samplerTake = take;
    this.samplerState = state;
    this.sampler.port.postMessage({ op: "threshold" });
  }
  finishSamplerTake() {
    this.sampler?.port.postMessage({ op: "finish-take" });
  }
  finishSamplerLoop(track: string, clip: string, firstStep: number, bars: number) {
    const target = this.project?.tracks.find((t) => t.id === track);
    const sample =
      target && this.project
        ? trackPads(this.project, track)[this.samplerPad]?.sampleId
        : undefined;
    if (sample && this.project)
      this.samplerTarget = {
        project: this.project.id,
        track,
        pad: this.samplerPad,
        sample,
        previous: this.samplerRestore?.clip ?? null,
      };
    this.samplerRestore = undefined;
    const span = bars * 16;
    const at =
      firstStep +
      Math.max(1, Math.ceil((Math.max(this.position, this.step) + 16 - firstStep) / span)) * span;
    this.performance?.queueClipAt(track, clip, at);
    this.sampler?.port.postMessage({
      op: "handoff",
      frame: Math.round((this.anchor + this.secondsFor(at)) * 48000),
    });
  }
  cancelSampler() {
    this.sampler?.port.postMessage({ op: "cancel" });
    if (this.samplerRestore && this.playing)
      this.performance?.queueClip(this.samplerRestore.track, this.samplerRestore.clip);
    this.samplerRestore = undefined;
    this.samplerTarget = undefined;
  }
  closeSamplerInput() {
    this.cancelSampler();
    this.sampler?.disconnect();
    this.sampler = undefined;
    this.samplerStream?.getTracks().forEach((t) => {
      t.stop();
    });
    this.samplerStream = undefined;
    clearInterval(this.samplerPoll);
    this.samplerPoll = undefined;
  }
  private context?: AudioContext;
  private master?: GainNode;
  private limiter?: DynamicsCompressorNode;
  private instrument?: AudioWorkletNode;
  private nextVoice = 1;
  private buffers = new Map<string, AudioBuffer>();
  private sources = new Set<AudioBufferSourceNode>();
  private initializing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private anchor = 0;
  private clockOrigin = 0;
  private secondsFor(position: number) {
    return this.project
      ? musicalSeconds(this.project, this.clockOrigin + position) -
          musicalSeconds(this.project, this.clockOrigin)
      : 0;
  }
  private step = 0;
  private sceneStartStep = 0;
  private scene = "scene-0";
  private performance: PerformanceTransport | undefined;
  private audiblePerformance: PerformanceSnapshot | undefined;
  private performanceEnd: number | undefined;
  public onPerformance = (_snapshot: PerformanceSnapshot) => {};
  get performanceSnapshot() {
    return this.audiblePerformance;
  }
  get performancePosition() {
    return Math.max(0, this.position + (this.performance?.songOffset ?? 0));
  }
  get performanceControls() {
    return this.project
      ? performanceControls(this.project, this.performancePosition, this.performance?.overrides)
      : undefined;
  }
  get queuedLaunch() {
    return (
      this.performance?.queuedScene?.id ??
      (this.performance?.queuedClips.size ? "clips" : this.queuedScene)
    );
  }
  get launchQueue() {
    return { scene: this.performance?.queuedScene, clips: this.performance?.queuedClips };
  }
  private queuedScene?: string;
  private project?: Project;
  private visualEvents: {
    time: number;
    step: number;
    scene: string;
    performance?: PerformanceSnapshot;
  }[] = [];
  private frame = 0;
  private activeSwing = 0;
  private queuedSwing: number | undefined;
  public fill = false;
  public onSchedule = (_position: number, _at: number, _absolute: number) => {};
  public onStop = () => {};
  get position() {
    return this.playing && this.context && this.project
      ? Math.max(
          0,
          musicalPosition(
            this.project,
            musicalSeconds(this.project, this.clockOrigin) +
              Math.max(0, this.context.currentTime - this.anchor),
          ) - this.clockOrigin,
        )
      : 0;
  }
  get pendingGroove() {
    return this.queuedSwing;
  }
  public midiTrace: import("../../../packages/core/src/machines.ts").MidiEvent[] = [];
  public onMidi = () => {};
  public onMeter = (_meter: { left: number; right: number; rms: number; clipped: number }) => {};
  public playing = false;
  public lateSteps = 0;
  public onStep = (_step: number, _scene: string) => {};
  public onState = (_state: string) => {};
  get sampleRate() {
    return this.context?.sampleRate ?? 0;
  }
  get state() {
    return this.context?.state ?? "off";
  }

  async enable() {
    if (!this.initializing)
      this.initializing = (async () => {
        const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        this.context = context;
        this.master = context.createGain();
        this.master.gain.value = this.project
          ? hasSequence(this.project) || this.project.performance || this.project.mix
            ? 1
            : parameterValue(this.project, "master.gain")
          : 0.55;
        this.limiter = context.createDynamicsCompressor();
        this.limiter.threshold.value = this.project?.mix ? 0 : -6;
        this.limiter.ratio.value = this.project?.mix ? 1 : 12;
        this.master.connect(this.limiter).connect(context.destination);
        context.onstatechange = () => {
          if (context.state !== "running" && this.playing) this.stop();
          this.onState(context.state);
        };
        if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
          await context.audioWorklet.addModule(workletUrl);
          this.instrument = new AudioWorkletNode(context, "xmp-instruments", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          this.instrument.connect(this.master);
          this.instrument.port.onmessage = (event) => {
            if (event.data.meter) this.onMeter(event.data.meter);
            if (event.data.midi) {
              this.midiTrace.push(event.data.midi);
              this.midiTrace = this.midiTrace.slice(-1024);
              this.onMidi();
            }
            if (event.data.error) {
              // The worklet may have refused a palette: the next one carries every sound.
              this.sentSounds = undefined;
              this.onState(event.data.error);
            }
          };
        }
        if (this.project) {
          this.buildBuffers(this.project);
          this.instrument?.port.postMessage({
            op: "project",
            palette: this.palette(this.project),
          });
        }
      })().catch((error) => {
        this.initializing = undefined;
        throw error;
      });
    await this.initializing;
    await this.context?.resume();
    this.onState(this.state);
  }

  // What the worklet is sent for a project: every sound the first time and
  // when a sample or pad changed, otherwise only the tracks, mixer and values
  // (a full song's sounds are megabytes, rebuilt and copied on every edit
  // before). Projects here come from the core's edits or an opened file, so
  // they are not parsed against the schema again.
  private sentSounds?: ReturnType<typeof soundsKey>;
  private palette(project: Project) {
    const key = soundsKey(project);
    const sounds = !this.sentSounds || !sameSounds(this.sentSounds, key);
    this.sentSounds = key;
    return prepareInstruments(project, { checked: true, sounds });
  }
  private buildBuffers(project: Project) {
    if (!this.context) return;
    this.buffers.clear();
    for (const sample of project.samples) {
      const buffer = this.context.createBuffer(1, sample.pcm.length, sample.sampleRate);
      buffer.copyToChannel(new Float32Array(sample.pcm), 0);
      this.buffers.set(sample.id, buffer);
    }
  }
  setProject(project: Project) {
    const samplesChanged = !this.project || this.project.samples !== project.samples;
    const timingChanged = this.project && this.project.bpm !== project.bpm;
    if (this.playing && this.project?.swing !== project.swing) this.queuedSwing = project.swing;
    else if (!this.playing) this.activeSwing = project.swing;
    this.project = project;
    if (project.performance || project.mix) {
      if (this.performance) this.performance.setProject(project);
      else this.performance = new PerformanceTransport(project);
    } else {
      this.performance = undefined;
      this.audiblePerformance = undefined;
    }
    const take = this.samplerTarget;
    if (take && trackPads(project, take.track)[take.pad]?.sampleId !== take.sample) {
      this.cancelSampler();
      const previous = project.tracks
        .find((t) => t.id === take.track)
        ?.clips.find((c) => c.id === take.previous);
      if (project.id === take.project && this.playing && previous)
        this.performance?.queueClip(take.track, previous.id);
    }
    this.master?.gain.setTargetAtTime(
      hasSequence(project) || project.performance || project.mix
        ? 1
        : parameterValue(project, "master.gain"),
      this.context?.currentTime ?? 0,
      parameterSmoothingMs(project, "master.gain") / 1000,
    );
    if (this.limiter) {
      this.limiter.threshold.value = project.mix ? 0 : -6;
      this.limiter.ratio.value = project.mix ? 1 : 12;
    }
    if (samplesChanged) this.buildBuffers(project);
    if (this.instrument)
      this.instrument.port.postMessage({ op: "project", palette: this.palette(project) });
    if (timingChanged && this.playing) {
      const scene = this.scene;
      this.stop();
      this.start(scene);
    }
  }

  trigger(
    pad: number,
    velocity = 0.8,
    at = this.context?.currentTime ?? 0,
    trackId = this.project?.tracks[0]?.id ?? "drums",
    note?: number,
    durationFrames = 0,
  ) {
    const id = this.nextVoice++;
    if (this.instrument && this.project && this.context) {
      const track = this.project.tracks.findIndex((t) => t.id === trackId);
      this.instrument.port.postMessage({
        op: "on",
        frame: Math.round(at * this.context.sampleRate),
        id,
        pad,
        track,
        note:
          note ??
          (this.project.tracks[track]?.machine?.id === "xmp.subtractive"
            ? 48 + pad
            : (trackPads(this.project, trackId)[pad]?.playback?.rootNote ?? 60)),
        velocity,
        duration: durationFrames,
      });
      return id;
    }
    if (this.project && hasInstruments(this.project))
      throw new Error("AudioWorklet is required for instrument machines");
    const context = this.context;
    const assignment = this.project ? trackPads(this.project, trackId)[pad] : undefined;
    const buffer = assignment ? this.buffers.get(assignment.sampleId) : undefined;
    if (!context || !this.master || !buffer || context.state !== "running") return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, velocity));
    source.buffer = buffer;
    source.connect(gain).connect(this.master);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      gain.disconnect();
    };
    const sample = this.project?.samples.find((sample) => sample.id === assignment?.sampleId);
    const start = assignment?.slice?.start ?? 0,
      end = assignment?.slice?.end ?? sample?.pcm.length ?? buffer.length;
    source.start(
      at,
      start / (sample?.sampleRate ?? buffer.sampleRate),
      (end - start) / (sample?.sampleRate ?? buffer.sampleRate),
    );
    return id;
  }
  noteOff(id: number) {
    this.instrument?.port.postMessage({ op: "off", id });
  }
  panic() {
    this.stopAudition();
    this.instrument?.port.postMessage({ op: "panic" });
    for (const source of this.sources) source.stop();
    this.sources.clear();
  }

  automate(values: Record<string, number>, parameter?: string) {
    if (parameter)
      this.instrument?.port.postMessage({ op: "gesture", parameter, value: values[parameter] });
    else
      this.instrument?.port.postMessage({
        op: "parameters",
        frame: Math.round((this.context?.currentTime ?? 0) * (this.context?.sampleRate ?? 48000)),
        values,
      });
  }
  clearAutomation() {
    this.instrument?.port.postMessage({ op: "gesture-end" });
  }
  start(scene: string, mode: "scene" | "song" = "scene", resume = false) {
    if (this.context?.state !== "running" || !this.project || this.playing) return;
    this.scene = scene;
    this.performanceEnd = undefined;
    if (this.performance) {
      this.performance.start(scene, mode, resume);
      this.audiblePerformance = this.performance.snapshot();
    } else if (mode === "song") throw new Error("Enable performance first");
    this.clockOrigin = this.performance?.clockOrigin ?? 0;
    this.queuedScene = undefined;
    this.anchor = this.context.currentTime + 0.04;
    this.step = 0;
    this.sceneStartStep = 0;
    this.lateSteps = 0;
    this.activeSwing = this.project.swing;
    this.queuedSwing = undefined;
    this.playing = true;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 25);
    const draw = () => {
      if (!this.playing || !this.context) return;
      this.consumeVisual();
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }
  queueScene(scene: string) {
    if (this.playing) {
      if (this.performance) this.performance.queueScene(scene);
      else this.queuedScene = scene;
    } else this.scene = scene;
  }
  queueClip(track: string, clip: string | null) {
    if (!this.performance || !this.playing) throw new Error("Start performance playback first");
    this.performance.queueClip(track, clip);
  }
  cancelLaunch() {
    if (this.performance) return this.performance.cancelLaunch();
    const had = Boolean(this.queuedScene);
    this.queuedScene = undefined;
    return had;
  }
  performanceControl(event: PerformanceEvent) {
    if (!this.performance) throw new Error("Enable performance first");
    this.performance.control(event);
    const current = performanceValues(this.performance, this.position);
    this.instrument?.port.postMessage({
      op: "performance-now",
      values: current.values,
      tracks: current.blocked,
    });
  }
  private consumeVisual() {
    if (!this.context) return;
    while (this.visualEvents[0] && this.visualEvents[0].time <= this.context.currentTime) {
      const event = this.visualEvents.shift();
      if (event) {
        if (event.performance) {
          this.audiblePerformance = event.performance;
          this.onPerformance(event.performance);
        }
        this.onStep(event.step, event.scene);
      }
    }
  }
  private schedule() {
    const context = this.context;
    const project = this.project;
    if (!context || !project) return;
    this.consumeVisual();
    if (this.performanceEnd !== undefined) {
      if (context.currentTime >= this.performanceEnd) this.stop();
      return;
    }
    let at = this.anchor + this.secondsFor(groovePosition(this.step, this.activeSwing));
    // Skip missed events after a main-thread stall instead of bursting them all at once.
    while (at < context.currentTime) {
      if (this.performance) {
        const result = this.performance.advance(this.step);
        if (result.releases.length)
          this.instrument?.port.postMessage({
            op: "release",
            frame: Math.round(context.currentTime * context.sampleRate),
            tracks: result.releases,
          });
      }
      this.step++;
      this.lateSteps++;
      at = this.anchor + this.secondsFor(groovePosition(this.step, this.activeSwing));
    }
    while (at < context.currentTime + 0.1) {
      if (this.step % 16 === 0 && this.queuedSwing !== undefined) {
        this.activeSwing = this.queuedSwing;
        this.queuedSwing = undefined;
        at = this.anchor + this.secondsFor(groovePosition(this.step, this.activeSwing));
      }
      if (!this.performance && this.queuedScene && this.step % 16 === 0) {
        this.scene = this.queuedScene;
        this.sceneStartStep = this.step;
        this.queuedScene = undefined;
      }
      if (this.performance) {
        const window = performanceWindow(
          this.performance,
          this.step,
          this.fill,
          this.activeSwing,
          context.sampleRate,
        );
        this.scene = window.snapshot.sceneId;
        this.onSchedule(this.step, at, this.step);
        for (const c of performanceCommands(window, project, context.sampleRate)) {
          const frame = Math.round(this.anchor * context.sampleRate) + c.frame;
          if (c.kind === "on" && c.note) {
            const n = c.note;
            this.trigger(
              n.pad,
              n.velocity,
              this.anchor + n.frame / context.sampleRate,
              n.trackId,
              n.note,
              n.durationFrames,
            );
          } else
            this.instrument?.port.postMessage({
              op: c.kind,
              frame,
              ...(c.kind === "clock" ? { position: c.position, bpm: c.bpm } : {}),
              ...(c.values ? { values: c.values } : {}),
              ...(c.tracks ? { tracks: c.tracks } : {}),
            });
        }
        this.visualEvents.push({
          time: at,
          step: this.step,
          scene: this.scene,
          performance: window.snapshot,
        });
        this.step++;
        if (!window.snapshot.running) {
          this.performanceEnd = at;
          break;
        }
        at = this.anchor + this.secondsFor(groovePosition(this.step, this.activeSwing));
        continue;
      }
      const relative = this.step - this.sceneStartStep;
      this.onSchedule(relative, at, this.step);
      if (hasSequence(project)) {
        const offset = this.anchor + (this.sceneStartStep * 60) / project.bpm / 4;
        for (const n of timeline(
          project,
          this.scene,
          relative,
          relative + 1,
          this.fill,
          this.activeSwing,
          context.sampleRate,
        ))
          this.trigger(
            n.pad,
            n.velocity,
            offset + n.frame / context.sampleRate,
            n.trackId,
            n.note,
            n.durationFrames,
          );
        const positions = new Set([relative, relative + 0.25, relative + 0.5, relative + 0.75]);
        const scene = project.scenes.find((s) => s.id === this.scene);
        for (const track of project.tracks) {
          const clip = track.clips.find((c) => c.id === scene?.clips[track.id]);
          if (clip?.sequence)
            for (const lane of clip.sequence.lanes)
              for (const p of lane.points) {
                const pos = Math.floor(relative / clip.length) * clip.length + p.position;
                if (pos >= relative && pos < relative + 1) positions.add(pos);
              }
        }
        for (const pos of [...positions].sort((a, b) => a - b))
          this.instrument?.port.postMessage({
            op: "parameters",
            frame: Math.round(
              (offset + (groovePosition(pos, this.activeSwing) * 60) / project.bpm / 4) *
                context.sampleRate,
            ),
            values: parameterFrame(project, this.scene, pos),
          });
      } else
        for (const event of eventsAtStep(project, this.scene, relative)) {
          const track = project.tracks.find((t) => t.id === event.trackId);
          const gain = track
            ? parameterValue(project, `track.${track.id}.gain`) *
              parameterValue(project, `track.${track.id}.effect.gain`) *
              2
            : 1;
          this.trigger(
            event.pad,
            this.instrument ? (gain ? event.velocity / gain : 0) : event.velocity,
            at,
            event.trackId,
            event.note,
            Math.round(
              (((event.duration ?? 1) * 60) / project.bpm / 4) *
                (this.context?.sampleRate ?? 48000),
            ),
          );
        }
      this.visualEvents.push({
        time: at,
        step: this.step - this.sceneStartStep,
        scene: this.scene,
      });
      this.step++;
      at = this.anchor + this.secondsFor(groovePosition(this.step, this.activeSwing));
    }
  }
  stop() {
    this.cancelSampler();
    this.stopAudition();
    this.consumeVisual();
    if (this.playing) this.onStop();
    this.instrument?.port.postMessage({ op: "reset" });
    this.queuedSwing = undefined;
    this.performance?.stop();
    this.performanceEnd = undefined;
    this.instrument?.port.postMessage({ op: "panic" });
    clearInterval(this.timer);
    cancelAnimationFrame(this.frame);
    this.playing = false;
    if (this.audiblePerformance) {
      this.audiblePerformance = { ...this.audiblePerformance, running: false };
      this.onPerformance(this.audiblePerformance);
    }
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.visualEvents = [];
    this.queuedScene = undefined;
    this.onStep(-1, this.scene);
  }
}

export async function renderScene(project: Project, scene: string): Promise<ArrayBuffer> {
  if (project.performance || project.mix)
    return renderPerformance(project, {
      scene,
      mode: "scene",
      steps: Math.max(
        16,
        ...project.tracks.map(
          (t) =>
            t.clips.find((c) => c.id === project.scenes.find((s) => s.id === scene)?.clips[t.id])
              ?.length ?? 16,
        ),
      ),
    }).wav;
  return renderProjectScene(project, scene);
}
