import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { exportPortable } from "../../packages/core/src/assets.ts";
import { loadCore, prepareScene } from "../../packages/core/src/edits.ts";
import { ownedScenarioDirectory, root, sha256 } from "./workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();
export const engineProfile = Object.freeze({
  id: "p04-mac-development-v1",
  sampleRate: 48000,
  bufferFrames: 256,
  tracks: 8,
  voices: 32,
  queueCapacity: 64,
  criticalCapacity: 16,
  callbackP99MaximumFraction: 0.8,
  physicalAudio: false,
  v1Qualification: false,
});
export const operations = Object.freeze({
  hello: 1,
  snapshot: 2,
  start: 3,
  stop: 4,
  noteOn: 5,
  noteOff: 6,
  tempo: 7,
  shutdown: 8,
  backendLost: 9,
  reconnect: 10,
  project: 11,
  groove: 12,
});
export function encodeCommand(op, id, fields = {}) {
  const bytes = Buffer.alloc(40);
  bytes.write("XMP4");
  bytes.writeUInt16LE(fields.version ?? 1, 4);
  bytes.writeUInt16LE(op, 6);
  bytes.writeUInt32LE(id, 8);
  bytes.writeUInt32LE(fields.payloadBytes ?? ([1, 2, 8].includes(op) ? 0 : 16), 12);
  bytes.writeBigUInt64LE(BigInt(fields.timestamp ?? 0), 16);
  bytes.writeUInt32LE(fields.a ?? 0, 24);
  bytes.writeUInt32LE(fields.b ?? 0, 28);
  bytes.writeDoubleLE(fields.value ?? 0, 32);
  return bytes;
}
export function decodeSnapshot(bytes) {
  if (
    bytes.length !== 176 ||
    bytes.toString("ascii", 0, 4) !== "XMR4" ||
    bytes.readUInt16LE(4) !== 1
  )
    throw new Error("Invalid native engine response");
  const integer = (offset) => Number(bytes.readBigUInt64LE(offset));
  return {
    id: bytes.readUInt32LE(8),
    status: bytes.readUInt32LE(12),
    revision: integer(16),
    frame: integer(24),
    tick: bytes.readDoubleLE(32),
    bpm: bytes.readDoubleLE(40),
    on: integer(48),
    off: integer(56),
    refused: integer(64),
    queueDrops: integer(72),
    callbacks: integer(80),
    callbackOverruns: integer(88),
    traceDrops: integer(96),
    running: Boolean(bytes.readUInt32LE(104) & 1),
    safe: Boolean(bytes.readUInt32LE(104) & 2),
    pending: bytes.readUInt32LE(108),
    callbackMaxNs: integer(112),
    auditFaults: bytes.readUInt32LE(120),
    dataBytes: bytes.readUInt32LE(124),
    sampleRate: bytes.readUInt32LE(128),
    bufferFrames: bytes.readUInt32LE(132),
    generation: integer(136),
    projectHash: bytes.subarray(144, 176).toString("hex"),
  };
}
export class EngineClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.lastSnapshot = undefined;
    socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 65536) {
        socket.destroy(new Error("Engine response budget exceeded"));
        return;
      }
      while (this.buffer.length >= 176) {
        const payload = this.buffer.readUInt32LE(124);
        if (payload > 4096) {
          socket.destroy(new Error("Oversized engine chunk"));
          return;
        }
        if (this.buffer.length < 176 + payload) break;
        const reply = decodeSnapshot(this.buffer.subarray(0, 176));
        reply.data = Buffer.from(this.buffer.subarray(176, 176 + payload));
        this.buffer = this.buffer.subarray(176 + payload);
        const pending = this.pending.get(reply.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(reply.id);
          this.lastSnapshot = reply;
          pending.resolve(reply);
        }
      }
    });
    const closed = (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          error instanceof Error ? error : new Error("Engine control connection closed"),
        );
      }
      this.pending.clear();
    };
    socket.on("error", closed);
    socket.on("close", closed);
  }
  static async connect(path) {
    const socket = createConnection(path);
    await once(socket, "connect");
    const client = new EngineClient(socket);
    const hello = await client.request(operations.hello);
    if (hello.status !== 0) {
      client.close();
      throw new Error("Native engine handshake failed");
    }
    return client;
  }
  request(op, fields = {}) {
    if (this.pending.size >= 256)
      return Promise.reject(new Error("Client pending-command budget exceeded"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Engine response timeout ${id}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeCommand(op, id, fields));
    });
  }
  async project(snapshot) {
    const chunks = [];
    let size = 0;
    while (size <= 24 * 1024 * 1024) {
      const reply = await this.request(operations.project, { a: size, b: 4096 });
      if (
        reply.status !== 0 ||
        reply.projectHash !== snapshot.projectHash ||
        reply.generation !== snapshot.generation
      )
        throw new Error("Engine project generation mismatch");
      if (!reply.data.length) break;
      chunks.push(reply.data);
      size += reply.data.length;
    }
    if (size > 24 * 1024 * 1024) throw new Error("Project snapshot exceeds profile");
    const text = Buffer.concat(chunks).toString("utf8");
    if (sha256(text) !== snapshot.projectHash) throw new Error("Project snapshot hash mismatch");
    return JSON.parse(text);
  }
  async snapshot() {
    return this.request(operations.snapshot);
  }
  close() {
    this.socket.destroy();
  }
}
export function developmentGraph() {
  const pcm = Array.from({ length: 480 }, (_, i) => Math.sin((i * 2 * Math.PI) / 480) * 0.01);
  const graph = {
    projectHash: sha256("xmp-p04-mac-development-v1-original-32-voice-fixture"),
    bpm: 120,
    loopTicks: 3840,
    samples: [pcm],
    trackGains: Array(8).fill(1),
    master: 1,
    events: Array.from({ length: 32 }, (_, id) => ({
      tick: 0,
      sample: 0,
      id: id + 1,
      duration: 3839,
      velocity: 1,
      track: Math.floor(id / 4),
    })),
  };
  const { projectHash: _hash, ...document } = graph;
  const projectDocument = JSON.stringify({
    format: "xmp-engine-graph",
    version: 1,
    profileId: engineProfile.id,
    ...document,
  });
  return { ...graph, projectHash: sha256(projectDocument), projectDocument };
}
export async function projectGraph(project, sceneId) {
  const plan = prepareScene({ ...project, swing: 0 }, sceneId);
  if (plan.events.length > 512) throw new Error("Native host supports 512 events per loop");
  const selected = project.scenes.find((scene) => scene.id === sceneId);
  const loopTicks =
    Math.max(
      16,
      ...project.tracks.map(
        (track) => track.clips.find((clip) => clip.id === selected?.clips[track.id])?.length ?? 16,
      ),
    ) * 240;
  const projectDocument = await exportPortable(project);
  return {
    projectHash: sha256(projectDocument),
    projectDocument,
    bpm: project.bpm,
    swing: project.swing,
    loopTicks: Math.min(15360, Math.max(3840, loopTicks)),
    samples: plan.samples.map((sample) => Array.from(sample)),
    trackGains: Array(8).fill(1),
    master: 1,
    events: plan.events.map((event, index) => ({
      tick: Math.round((((event.frame / 48000) * project.bpm) / 60) * 960),
      sample: event.sample,
      id: index + 1,
      duration: 0,
      velocity: event.velocity,
      track: project.tracks.findIndex((track) => track.id === event.trackId),
    })),
  };
}
const graphSchema = z
  .object({
    projectHash: z.string().regex(/^[a-f0-9]{64}$/),
    projectDocument: z
      .string()
      .min(1)
      .max(24 * 1024 * 1024),
    bpm: z.number().finite().min(30).max(300),
    swing: z.number().finite().min(0).max(0.5).default(0),
    loopTicks: z.number().int().min(1).max(15360),
    samples: z
      .array(z.array(z.number().finite().min(-1).max(1)).min(1).max(1000000))
      .min(1)
      .max(16),
    trackGains: z.array(z.number().finite().min(0).max(1)).length(8),
    master: z.number().finite().min(0).max(1),
    events: z
      .array(
        z
          .object({
            tick: z.number().int().min(0),
            sample: z.number().int().min(0),
            id: z.number().int().min(1).max(65535),
            duration: z.number().int().min(0).max(15360),
            velocity: z.number().finite().min(0).max(1),
            track: z.number().int().min(0).max(7),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();
export function encodeGraph(input) {
  const graph = graphSchema.parse(input);
  if (
    sha256(graph.projectDocument) !== graph.projectHash ||
    Buffer.byteLength(graph.projectDocument) > 24 * 1024 * 1024
  )
    throw new Error("Prepared project hash or size mismatch");
  for (const [index, event] of graph.events.entries())
    if (
      event.sample >= graph.samples.length ||
      event.tick >= graph.loopTicks ||
      (index > 0 && event.tick < graph.events[index - 1].tick)
    )
      throw new Error("Invalid prepared event reference or order");
  if (
    graph.samples.length < 1 ||
    graph.samples.length > 16 ||
    graph.events.length > 512 ||
    graph.samples.reduce((n, sample) => n + sample.length, 0) > 1000000
  )
    throw new Error("Native graph exceeds preparation profile");
  const bytes = Buffer.alloc(
    104 +
      graph.samples.reduce((n, sample) => n + 4 + sample.length * 4, 0) +
      graph.events.length * 24,
  );
  bytes.write("XMPH");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(graph.samples.length, 8);
  bytes.writeUInt32LE(graph.events.length, 12);
  bytes.writeUInt32LE(graph.loopTicks, 16);
  bytes.writeDoubleLE(graph.bpm, 20);
  Buffer.from(graph.projectHash, "hex").copy(bytes, 28);
  graph.trackGains.forEach((gain, index) => {
    bytes.writeFloatLE(gain, 60 + index * 4);
  });
  bytes.writeFloatLE(graph.master, 92);
  bytes.writeDoubleLE(graph.swing, 96);
  let offset = 104;
  for (const sample of graph.samples) {
    bytes.writeUInt32LE(sample.length, offset);
    offset += 4;
    for (const value of sample) {
      bytes.writeFloatLE(value, offset);
      offset += 4;
    }
  }
  for (const event of graph.events) {
    for (const value of [event.tick, event.sample, event.id, event.duration]) {
      bytes.writeUInt32LE(value, offset);
      offset += 4;
    }
    bytes.writeFloatLE(event.velocity, offset);
    bytes.writeUInt32LE(event.track, offset + 4);
    offset += 8;
  }
  return bytes;
}
export async function startEngineHost(
  workspace,
  { graph = developmentGraph(), seconds = 10, boundedMetrics = false } = {},
) {
  ownedScenarioDirectory(workspace.directory);
  writeFileSync(workspace.path("engine.xmph"), encodeGraph(graph));
  writeFileSync(workspace.path("engine-project.json"), graph.projectDocument);
  // Darwin's UDS path cap is 104 bytes. The owned temp path is often longer;
  // a relative socket name inside cwd avoids symlinks or shortening through /Volumes.
  const child = spawn(
    resolve(root, "build/native/xmp_engine_host"),
    [
      boundedMetrics ? "--virtual-bounded" : "--virtual",
      workspace.path("engine.xmph"),
      "engine.sock",
      workspace.path("engine-report.json"),
      workspace.path("engine-capture.wav"),
      workspace.path("engine-trace.json"),
      String(seconds),
      workspace.path("engine-project.json"),
    ],
    { cwd: workspace.directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  workspace.processes.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let stdout = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Engine startup timeout: ${stderr}`)), 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Engine exited ${code}: ${stderr}`));
    });
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const socket = workspace.path("engine.sock");
  const client = await EngineClient.connect(socket);
  let finishedReport;
  return {
    child,
    client,
    socket,
    graph,
    identity: {
      profile: engineProfile.id,
      syntheticAudioEndpoint: true,
      nativeBinaryHash: sha256(readFileSync(resolve(root, "build/native/xmp_engine_host"))),
    },
    async finish() {
      if (finishedReport) return finishedReport;
      client.close();
      let code = child.exitCode;
      if (code === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        [code] = await exit;
      }
      workspace.processes.delete(child);
      if (code !== 0) throw new Error(`Engine failed ${code}: ${stderr}`);
      finishedReport = JSON.parse(readFileSync(workspace.path("engine-report.json"), "utf8"));
      return finishedReport;
    },
  };
}
