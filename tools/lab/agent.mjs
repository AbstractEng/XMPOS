// Development process only: fixed owned Unix socket, no TCP or USB transport.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:tls";
import { EngineClient, operations } from "../../acceptance/lib/engine-target.mjs";
import { ownedScenarioDirectory } from "../../acceptance/lib/workspace.mjs";
import { exportPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderProjectScene } from "../../packages/core/src/edits.ts";
import { openProject } from "../../packages/core/src/project-io.ts";
import {
  Envelope,
  Hello,
  LabCommand,
  labLimits,
  validateGrant,
} from "../../packages/lab/src/contracts.ts";
import { channelProof, encodeFrame, FrameDecoder, hash } from "./wire.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

if (process.argv[2] !== "--host-simulator" || process.argv.length !== 3)
  throw new Error("Only the owned host simulator is implemented");
const directory = ownedScenarioDirectory(process.cwd());
const config = JSON.parse(readFileSync(resolve(directory, "agent-config.json"), "utf8"));
if (!["agent-a", "agent-b"].includes(config.certificate))
  throw new Error("Unknown bench credential");
const grant = validateGrant(config.grant),
  sockets = new Set();
let latestResult = null;
const server = createServer(
  {
    key: readFileSync(resolve(directory, `${config.certificate}.key`)),
    cert: readFileSync(resolve(directory, `${config.certificate}.pem`)),
    ca: readFileSync(resolve(directory, "ca.pem")),
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
    handshakeTimeout: 3000,
  },
  (socket) => {
    sockets.add(socket);
    let alive = true,
      authenticated = false,
      session = "",
      sequence = 0,
      pending = 0,
      chain = Promise.resolve(),
      client;
    const fixtures = new Map();
    let bytes = 0,
      loaded = null,
      rendered = null,
      minute = Date.now(),
      commands = 0;
    let timeout, helloTimeout;
    socket.once("close", () => {
      alive = false;
      authenticated = false;
      fixtures.clear();
      clearTimeout(timeout);
      clearTimeout(helloTimeout);
      client?.close();
      sockets.delete(socket);
      process.send?.({ sessionClosed: true });
    });
    const peer = socket.getPeerCertificate();
    if (!socket.authorized || !peer.raw || hash(peer.raw) !== grant.hostPin) {
      socket.destroy();
      return;
    }
    timeout = setTimeout(() => socket.destroy(), grant.expiresAt - Date.now());
    helloTimeout = setTimeout(() => socket.destroy(), 3000);
    socket.on("error", () => {});
    const invalidate = () => {
      alive = false;
      authenticated = false;
      fixtures.clear();
      client?.close();
      socket.destroy();
    };
    socket.on("end", invalidate);
    const send = (value) => {
      if (alive) socket.write(encodeFrame(value));
    };
    const decoder = new FrameDecoder((message) => {
      if (++pending > labLimits.pendingCommands) throw new Error("Command queue budget");
      chain = chain
        .then(async () => {
          if (!alive || socket.destroyed) return;
          validateGrant(grant);
          if (!authenticated) {
            const hello = Hello.parse(message);
            if (hello.alias !== grant.alias || hello.buildHash !== grant.buildHash)
              throw new Error("Target mismatch");
            authenticated = true;
            clearTimeout(helloTimeout);
            session = randomBytes(32).toString("hex");
            const body = {
              type: "attestation",
              protocol: 1,
              nonce: hello.nonce,
              session,
              alias: grant.alias,
              model: grant.model,
              buildHash: grant.buildHash,
              bootTier: grant.bootTier,
              expiresAt: grant.expiresAt,
              fixtureHash: grant.fixtureHash,
              operations: grant.operations,
            };
            send({ ...body, proof: channelProof(socket, body) });
            return;
          }
          const envelope = Envelope.parse(message);
          if (envelope.session !== session || envelope.sequence !== sequence + 1)
            throw new Error("Stale or replayed session");
          sequence = envelope.sequence;
          if (Date.now() - minute >= 60000) {
            minute = Date.now();
            commands = 0;
          }
          if (++commands > labLimits.commandsPerMinute) throw new Error("Command rate budget");
          let result;
          try {
            const command = LabCommand.parse(envelope.command);
            if (!grant.operations.includes(command.op)) throw new Error("Operation not granted");
            if (command.op === "stage") {
              const size = Buffer.byteLength(command.text);
              if (
                size > labLimits.fixtureBytes ||
                fixtures.has(command.fixtureId) ||
                fixtures.size >= labLimits.fixtureCount ||
                bytes + size > labLimits.totalFixtureBytes ||
                hash(command.text) !== command.sha256 ||
                command.sha256 !== grant.fixtureHash
              )
                throw new Error("Fixture budget or hash mismatch");
              const project = await openProject(command.text);
              if (
                hash(await exportPortable(project)) !== command.sha256 ||
                project.tracks.length !== 8
              )
                throw new Error("Noncanonical approved fixture");
              if (!alive || socket.destroyed) return;
              fixtures.set(command.fixtureId, { project, sha256: command.sha256 });
              bytes += size;
              result = {
                staged: true,
                fixtureId: command.fixtureId,
                sha256: command.sha256,
                bytes: size,
              };
            } else if (command.op === "load") {
              const fixture = fixtures.get(command.fixtureId);
              if (!fixture) throw new Error("Unknown fixture");
              client ??= await EngineClient.connect(resolve(directory, "engine.sock"));
              if (!alive) {
                client.close();
                return;
              }
              const state = await client.snapshot();
              if (state.projectHash !== fixture.sha256)
                throw new Error("Native fixture identity mismatch");
              loaded = command.fixtureId;
              result = { loaded: true, fixtureId: loaded, projectHash: state.projectHash };
            } else if (command.op === "action") {
              if (!loaded || !client) throw new Error("Load the approved fixture first");
              const state = await client.request(
                command.action === "start" ? operations.start : operations.stop,
              );
              if (state.status !== 5) throw new Error("Engine action rejected");
              result = {
                revision: state.revision,
                running: state.running,
                frame: state.frame,
                projectHash: state.projectHash,
              };
            } else if (command.op === "render") {
              const fixture = fixtures.get(command.fixtureId);
              if (!fixture) throw new Error("Unknown fixture");
              const wav = Buffer.from(renderProjectScene(fixture.project, "scene-0"));
              let peak = 0;
              for (let i = 44; i < wav.length; i += 2)
                peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
              rendered = {
                sha256: hash(wav),
                frames: (wav.length - 44) / 4,
                bytes: wav.length,
                peak,
                fixtureHash: fixture.sha256,
                source: "host-offline-render",
                physicalAudioQualified: false,
              };
              result = rendered;
              latestResult = rendered;
            } else if (command.op === "status") {
              const state = client ? await client.snapshot() : null;
              result = {
                profile: grant.profile,
                alias: grant.alias,
                buildHash: grant.buildHash,
                bootTier: grant.bootTier,
                fixtures: fixtures.size,
                fixtureBytes: bytes,
                loaded,
                engine: state
                  ? {
                      running: state.running,
                      frame: state.frame,
                      revision: state.revision,
                      projectHash: state.projectHash,
                    }
                  : null,
                hardwareQualified: false,
              };
            } else
              result = {
                render: latestResult,
                hardwareQualified: false,
                physicalAudioQualified: false,
              };
            send({ session, sequence, ok: true, result });
          } catch {
            send({ session, sequence, ok: false, error: "COMMAND_REJECTED" });
          }
        })
        .catch(invalidate)
        .finally(() => {
          pending--;
        });
    });
    socket.on("data", (data) => {
      try {
        decoder.push(data);
      } catch {
        invalidate();
      }
    });
  },
);
server.maxConnections = 1;
server.on("tlsClientError", () => {});
server.listen("lab.sock", () => {
  chmodSync(resolve(directory, "lab.sock"), 0o600);
  process.send?.({
    ready: true,
    profile: grant.profile,
    transport: "owned-unix-tls",
    physicalTransport: false,
  });
});
process.once("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
