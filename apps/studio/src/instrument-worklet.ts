import { type InstrumentPalette, VoiceRack } from "../../../packages/core/src/instruments.ts";
// Local bundled machines register here too; project files never supply executable code.
import "./track-machines.ts";

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
interface Command {
  op: "on" | "off" | "parameters" | "release" | "gates" | "clock";
  position?: number;
  bpm?: number;
  tracks?: string[];
  values?: Record<string, number>;
  frame: number;
  id: number;
  pad: number;
  track: number;
  note: number;
  velocity: number;
  duration: number;
}
class InstrumentProcessor extends AudioWorkletProcessor {
  private rack?: VoiceRack;
  private trackIds: string[] = [];
  private blocked = new Set<string>();
  private queue: Command[] = [];
  private liveParameter: { id: string; value: number } | undefined;
  private lastValues: Record<string, number> = {};
  private observe = false;
  private observed = 0;
  private meteredFrames = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      try {
        if (data.op === "observe") {
          this.observe = data.enabled === true;
          this.observed = 0;
        } else if (data.op === "clock") {
          if (
            !Number.isFinite(data.position) ||
            data.position < 0 ||
            data.position > 1000100 ||
            !Number.isFinite(data.bpm) ||
            data.bpm < 30 ||
            data.bpm > 300 ||
            !Number.isSafeInteger(data.frame) ||
            data.frame < 0 ||
            data.frame > currentFrame + sampleRate * 10 ||
            this.queue.length >= 256
          )
            throw new Error("Invalid effect clock");
          this.queue.push(data);
          this.queue.sort((a, b) => a.frame - b.frame);
        } else if (data.op === "gesture") {
          if (
            typeof data.parameter !== "string" ||
            data.parameter.length > 180 ||
            !Number.isFinite(data.value) ||
            data.value < 0 ||
            data.value > 1
          )
            throw new Error("Invalid gesture");
          this.liveParameter = { id: data.parameter, value: data.value };
          this.rack?.applyParameters({ ...this.lastValues, [data.parameter]: data.value });
        } else if (data.op === "gesture-end") {
          this.liveParameter = undefined;
          this.rack?.applyParameters(this.lastValues);
        } else if (data.op === "project") {
          if (this.rack) this.rack.configure(data.palette as InstrumentPalette);
          else
            this.rack = new VoiceRack(data.palette, sampleRate, (midi) =>
              this.port.postMessage({ midi, physical: false }),
            );
          this.trackIds = data.palette.tracks.map((t: { id: string }) => t.id);
          this.lastValues = data.palette.parameterBase ?? {};
          this.queue = this.queue.filter((c) => c.op !== "parameters");
        } else if (data.op === "reset") {
          this.blocked.clear();
          this.rack?.setBlockedTracks([]);
          this.liveParameter = undefined;
          this.queue = [];
          this.rack?.panic();
          this.rack?.resetParameters();
        } else if (data.op === "panic") {
          this.queue = [];
          this.rack?.panic();
        } else if (data.op === "off") {
          this.queue = this.queue.filter((c) => c.id !== data.id);
          this.rack?.noteOff(data.id);
        } else if (data.op === "release" || data.op === "gates" || data.op === "performance-now") {
          if (
            !Array.isArray(data.tracks) ||
            data.tracks.length > 8 ||
            data.tracks.some(
              (id: unknown) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id),
            )
          )
            throw new Error("Invalid owner command");
          if (data.op === "performance-now") {
            if (
              !data.values ||
              typeof data.values !== "object" ||
              Object.keys(data.values).length > 512 ||
              Object.values(data.values).some(
                (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1,
              )
            )
              throw new Error("Invalid live performance control");
            this.rack?.setBlockedTracks(data.tracks);
            this.queue = this.queue.filter(
              (c) =>
                c.op !== "parameters" &&
                c.op !== "gates" &&
                !(c.op === "on" && this.rack?.isTrackBlocked(c.track)),
            );
            this.blocked = new Set(data.tracks);
            this.lastValues = data.values;
            this.rack?.applyParameters(
              this.liveParameter
                ? { ...data.values, [this.liveParameter.id]: this.liveParameter.value }
                : data.values,
            );
          } else {
            if (
              !Number.isSafeInteger(data.frame) ||
              data.frame < 0 ||
              data.frame > currentFrame + sampleRate * 60 ||
              this.queue.length >= 256
            )
              throw new Error("Invalid owner timestamp");
            this.queue.push(data);
            this.queue.sort((a, b) => a.frame - b.frame);
          }
        } else if (data.op === "parameters") {
          if (
            !Number.isSafeInteger(data.frame) ||
            data.frame < 0 ||
            data.frame > currentFrame + sampleRate * 60 ||
            !data.values ||
            typeof data.values !== "object" ||
            Object.keys(data.values).length > 512 ||
            Object.values(data.values).some(
              (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1,
            ) ||
            this.queue.length >= 256
          )
            throw new Error("Invalid parameter packet");
          this.queue.push(data);
          this.queue.sort((a, b) => a.frame - b.frame || (a.op === "parameters" ? -1 : 1));
        } else if (data.op === "on") {
          if (this.queue.length >= 256) {
            this.port.postMessage({ error: "Note queue full" });
            return;
          }
          if (
            !Number.isSafeInteger(data.frame) ||
            data.frame < 0 ||
            data.frame > currentFrame + sampleRate * 60
          )
            throw new Error("Invalid note timestamp");
          if (
            !Number.isSafeInteger(data.id) ||
            data.id < 0 ||
            !Number.isInteger(data.pad) ||
            data.pad < 0 ||
            data.pad > 15 ||
            !Number.isInteger(data.track) ||
            data.track < 0 ||
            data.track > 7 ||
            !Number.isInteger(data.note) ||
            data.note < 0 ||
            data.note > 127 ||
            !Number.isFinite(data.velocity) ||
            data.velocity < 0 ||
            data.velocity > 1 ||
            !Number.isInteger(data.duration) ||
            data.duration < 0 ||
            data.duration > sampleRate * 32
          )
            throw new Error("Invalid note payload");
          this.queue.push(data);
          this.queue.sort((a, b) => a.frame - b.frame);
        }
      } catch {
        if (data.op !== "project") {
          this.queue = [];
          this.rack?.panic();
        }
        this.port.postMessage({ error: "Instrument command rejected" });
      }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0],
      a = output?.[0],
      b = output?.[1];
    if (!a || !b) return true;
    // Commands apply on their exact frame; the engine renders the runs between them.
    for (let offset = 0; offset < a.length; ) {
      while (this.queue[0] && this.queue[0].frame <= currentFrame + offset) {
        const c = this.queue.shift();
        if (c?.op === "clock") this.rack?.clock(c.position ?? 0, c.bpm ?? 120);
        else if (c?.op === "release") {
          for (const id of c.tracks ?? []) this.rack?.releaseTrack(id);
        } else if (c?.op === "gates") {
          this.rack?.setBlockedTracks(c.tracks ?? []);
          this.blocked = new Set(c.tracks);
        } else if (c?.op === "parameters" && c.values) {
          this.lastValues = c.values;
          this.rack?.applyParameters(
            this.liveParameter
              ? { ...c.values, [this.liveParameter.id]: this.liveParameter.value }
              : c.values,
          );
        } else if (c && !this.blocked.has(this.trackIds[c.track] ?? "")) {
          const played = this.rack?.noteOn(c.id, c.pad, c.track, c.note, c.velocity, c.duration);
          if (played && this.observe && this.observed++ < 8192)
            this.port.postMessage({
              noteTrace: { id: c.id, frame: currentFrame + offset, note: c.note, track: c.track },
              physical: false,
            });
        }
      }
      const due = this.queue[0]?.frame;
      const n =
        due === undefined
          ? a.length - offset
          : Math.max(1, Math.min(a.length - offset, due - (currentFrame + offset)));
      if (this.rack)
        this.rack.process(a.subarray(offset, offset + n), b.subarray(offset, offset + n), n);
      else {
        a.fill(0, offset, offset + n);
        b.fill(0, offset, offset + n);
      }
      offset += n;
    }
    this.meteredFrames += a.length;
    if (this.meteredFrames >= 2048) {
      this.meteredFrames = 0;
      const meter = this.rack?.meter;
      if (meter) this.port.postMessage({ meter, physical: false });
    }
    return true;
  }
}
registerProcessor("xmp-instruments", InstrumentProcessor);
