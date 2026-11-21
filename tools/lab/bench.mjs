import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectGraph, startEngineHost } from "../../acceptance/lib/engine-target.mjs";
import { eightTrackFixture } from "../../acceptance/lib/song-fixture.mjs";
import { buildIdentity, root, sha256 } from "../../acceptance/lib/workspace.mjs";
import { exportPortable } from "../../packages/core/src/assets.ts";
import { labOperations } from "../../packages/lab/src/contracts.ts";
import { provisionBenchCertificates } from "./certificates.mjs";
import { LabClient, startLabAgent } from "./host.mjs";

export async function createBench(workspace) {
  if (!existsSync(resolve(root, "build/native/xmp_engine_host")))
    throw new Error("Build the native virtual engine first: npm run native:test");
  const project = eightTrackFixture(),
    text = await exportPortable(project),
    graph = await projectGraph(project, "scene-0");
  const pins = provisionBenchCertificates(workspace);
  const engine = await startEngineHost(workspace, { graph, seconds: 60 });
  const now = Date.now();
  const grant = {
    profile: "host-lab-development-v1",
    model: "XMP host simulator",
    alias: "bench-original",
    buildHash: buildIdentity(),
    bootTier: "host-simulator",
    protocol: 1,
    hostPin: pins.host,
    agentPin: pins["agent-a"],
    fixtureHash: sha256(text),
    issuedAt: now,
    expiresAt: now + 240000,
    operations: [...labOperations],
  };
  let agent, finished;
  const clients = new Set();
  try {
    agent = await startLabAgent(workspace, grant);
  } catch (error) {
    await engine.finish();
    throw error;
  }
  return {
    workspace,
    engine,
    pins,
    grant,
    text,
    physicalDeviceOperations: [],
    async connect(authorization = grant) {
      const client = await LabClient.connect(workspace, authorization);
      clients.add(client);
      return client;
    },
    async load(client, fixtureId = "fixture-one") {
      await client.request({ op: "stage", fixtureId, sha256: grant.fixtureHash, text });
      return client.request({ op: "load", fixtureId });
    },
    async disconnect(client) {
      if (client.socket.destroyed) return;
      if (agent.child.exitCode !== null || agent.child.signalCode !== null) {
        const closed = once(client.socket, "close");
        client.close();
        await closed;
        return;
      }
      const closed = once(client.socket, "close"),
        peerClosed = once(agent.child, "lab-closed");
      client.close();
      let timer;
      await Promise.race([
        Promise.all([closed, peerClosed]),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Simulator close acknowledgement timeout")),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    },
    async replacePeer() {
      for (const client of clients) await this.disconnect(client);
      await agent.close();
      agent = await startLabAgent(
        workspace,
        { ...grant, alias: "bench-replacement", agentPin: pins["agent-b"] },
        "agent-b",
      );
    },
    async finish() {
      if (finished) return finished;
      for (const client of clients) await this.disconnect(client);
      await agent.close();
      const report = await engine.finish();
      const capture = readFileSync(workspace.path("engine-capture.wav"));
      finished = {
        profile: grant.profile,
        buildHash: grant.buildHash,
        fixtureHash: grant.fixtureHash,
        native: report,
        nativeBinaryHash: engine.identity.nativeBinaryHash,
        captureHash: sha256(capture),
        capture,
        physicalAudioQualified: false,
        hardwareQualified: false,
        physicalDeviceOperations: [],
      };
      return finished;
    },
  };
}
