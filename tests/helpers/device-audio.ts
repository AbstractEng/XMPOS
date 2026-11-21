import type { DeviceAudio } from "../../apps/studio/src/device/controller.ts";
import type { Project } from "../../packages/core/src/index.ts";
import { PerformanceTransport } from "../../packages/core/src/performance.ts";

// Real sequencing transport, with no AudioContext, browser device API, or physical adapter.
export class ContractAudio implements DeviceAudio {
  playing = false;
  position = 0;
  enabled = 0;
  starts = 0;
  panics = 0;
  auditions = 0;
  previewStops = 0;
  transport?: PerformanceTransport;
  get performanceSnapshot() {
    return this.transport?.snapshot();
  }
  get performancePosition() {
    return this.position + (this.transport?.songOffset ?? 0);
  }
  hits: { pad: number; track?: string; note?: number }[] = [];
  async enable() {
    this.enabled++;
  }
  setProject(p: Project) {
    if (this.transport) this.transport.setProject(p);
    else this.transport = new PerformanceTransport(p);
  }
  start(scene: string, mode: "scene" | "song" = "scene", resume = false) {
    this.transport?.start(scene, mode, resume);
    this.playing = true;
    this.starts++;
  }
  stop() {
    this.playing = false;
    this.transport?.stop();
  }
  panic() {
    this.panics++;
  }
  trigger(pad: number, _velocity?: number, _at?: number, track?: string, note?: number) {
    this.hits.push({ pad, track, note });
    return this.hits.length;
  }
  queueClip(track: string, clip: string | null) {
    this.transport?.queueClip(track, clip);
  }
  queueScene(scene: string) {
    this.transport?.queueScene(scene);
  }
  cancelLaunch() {
    return this.transport?.cancelLaunch();
  }
  async audition() {
    this.auditions++;
  }
  stopAudition() {
    this.previewStops++;
  }
  advance(step: number) {
    this.position = step;
    return this.transport?.advance(step);
  }
}
