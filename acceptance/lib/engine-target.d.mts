import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import type { Project } from "../../packages/core/src/index.ts";
export interface EngineEvent {
  tick: number;
  sample: number;
  id: number;
  duration: number;
  velocity: number;
  track: number;
}
export interface EngineGraph {
  projectHash: string;
  projectDocument: string;
  bpm: number;
  swing?: number;
  loopTicks: number;
  samples: number[][];
  trackGains: number[];
  master: number;
  events: EngineEvent[];
}
export interface EngineSnapshot {
  id: number;
  status: number;
  revision: number;
  frame: number;
  tick: number;
  bpm: number;
  on: number;
  off: number;
  refused: number;
  queueDrops: number;
  callbacks: number;
  callbackOverruns: number;
  traceDrops: number;
  running: boolean;
  safe: boolean;
  pending: number;
  callbackMaxNs: number;
  auditFaults: number;
  sampleRate: number;
  bufferFrames: number;
  generation: number;
  projectHash: string;
  dataBytes: number;
  data?: Buffer;
}
export interface EngineCommandFields {
  version?: number;
  payloadBytes?: number;
  timestamp?: number | bigint;
  a?: number;
  b?: number;
  value?: number;
}
export const engineProfile: Readonly<{
  id: string;
  sampleRate: number;
  bufferFrames: number;
  tracks: number;
  voices: number;
  queueCapacity: number;
  criticalCapacity: number;
  callbackP99MaximumFraction: number;
  physicalAudio: false;
  v1Qualification: false;
}>;
export const operations: Readonly<{
  hello: 1;
  snapshot: 2;
  start: 3;
  stop: 4;
  noteOn: 5;
  noteOff: 6;
  tempo: 7;
  shutdown: 8;
  backendLost: 9;
  reconnect: 10;
  project: 11;
}>;
export function encodeCommand(op: number, id: number, fields?: EngineCommandFields): Buffer;
export function decodeSnapshot(bytes: Buffer): EngineSnapshot;
export function developmentGraph(): EngineGraph;
export function projectGraph(project: Project, sceneId: string): Promise<EngineGraph>;
export function encodeGraph(graph: EngineGraph): Buffer;
export class EngineClient {
  constructor(socket: Socket);
  static connect(path: string): Promise<EngineClient>;
  request(op: number, fields?: EngineCommandFields): Promise<EngineSnapshot>;
  snapshot(): Promise<EngineSnapshot>;
  project(snapshot: EngineSnapshot): Promise<unknown>;
  close(): void;
}
export function startEngineHost(
  workspace: { directory: string; path(name: string): string; processes: Set<ChildProcess> },
  options?: { graph?: EngineGraph; seconds?: number; boundedMetrics?: boolean },
): Promise<{
  child: ChildProcess;
  client: EngineClient;
  socket: string;
  graph: EngineGraph;
  identity: { profile: string; syntheticAudioEndpoint: true; nativeBinaryHash: string };
  finish(): Promise<Record<string, unknown>>;
}>;
