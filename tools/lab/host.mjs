import { fork } from "node:child_process";
import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "node:tls";
import { ownedScenarioDirectory } from "../../acceptance/lib/workspace.mjs";
import { Attestation, labLimits, validateGrant } from "../../packages/lab/src/contracts.ts";
import { channelProof, encodeFrame, FrameDecoder, hash } from "./wire.mjs";

export async function startLabAgent(workspace, grant, certificate = "agent-a") {
  const directory = ownedScenarioDirectory(workspace.directory);
  validateGrant(grant);
  if (!["agent-a", "agent-b"].includes(certificate))
    throw new Error("Unknown simulator credential");
  writeFileSync(resolve(directory, "agent-config.json"), JSON.stringify({ grant, certificate }), {
    mode: 0o600,
  });
  const child = fork(resolve(import.meta.dirname, "agent.mjs"), ["--host-simulator"], {
    execArgv: [],
    cwd: directory,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workspace.processes.add(child);
  child.on("message", (message) => {
    if (message.sessionClosed) child.emit("lab-closed");
  });
  let errorLog = "";
  child.stderr.on("data", (b) => {
    errorLog = (errorLog + b.toString()).slice(-4096);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Host lab agent startup timeout"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Host lab agent exited ${code}: ${errorLog}`));
    });
    child.on("message", (message) => {
      if (message.ready) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    child,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGTERM");
        await closed;
      }
      workspace.processes.delete(child);
    },
  };
}

export class LabClient {
  constructor(socket, grant, attestation) {
    this.socket = socket;
    this.grant = grant;
    this.attestation = attestation;
    this.session = attestation.session;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    const invalidate = () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Lab session invalidated; commands were not replayed"));
      }
      this.pending.clear();
    };
    const decoder = new FrameDecoder((message) => {
      if (
        !message ||
        message.session !== this.session ||
        !Number.isInteger(message.sequence) ||
        typeof message.ok !== "boolean"
      ) {
        this.close();
        return;
      }
      const pending = this.pending.get(message.sequence);
      if (!pending) {
        this.close();
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.sequence);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error("COMMAND_REJECTED"));
    });
    socket.on("data", (b) => {
      try {
        decoder.push(b);
      } catch {
        this.close();
      }
    });
    socket.once("close", invalidate);
    socket.on("error", invalidate);
  }
  static async connect(workspace, input) {
    const grant = validateGrant(input),
      directory = ownedScenarioDirectory(workspace.directory);
    // Only a fixed owned Unix socket can be selected. No host, port, device or transport flags.
    if (
      hash(new X509Certificate(readFileSync(resolve(directory, "host.pem"))).raw) !== grant.hostPin
    )
      throw new Error("Host credential pin mismatch");
    const socket = connect({
      path: resolve(directory, "lab.sock"),
      servername: "xmp-simulator.local",
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      ca: readFileSync(resolve(directory, "ca.pem")),
      cert: readFileSync(resolve(directory, "host.pem")),
      key: readFileSync(resolve(directory, "host.key")),
    });
    const nonce = randomBytes(32).toString("hex");
    try {
      const attestation = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Lab authentication timeout")), 5000);
        const fail = () => {
          clearTimeout(timer);
          reject(new Error("Lab TLS authentication failed"));
        };
        const decoder = new FrameDecoder((message) => {
          try {
            const a = Attestation.parse(message);
            if (
              a.nonce !== nonce ||
              a.alias !== grant.alias ||
              a.buildHash !== grant.buildHash ||
              a.expiresAt !== grant.expiresAt ||
              a.fixtureHash !== grant.fixtureHash ||
              JSON.stringify(a.operations) !== JSON.stringify(grant.operations) ||
              !timingSafeEqual(
                Buffer.from(a.proof, "hex"),
                Buffer.from(channelProof(socket, a), "hex"),
              )
            )
              throw new Error("Lab attestation mismatch");
            clearTimeout(timer);
            socket.off("data", data);
            socket.off("close", fail);
            socket.off("error", fail);
            resolve(a);
          } catch {
            fail();
          }
        });
        const data = (chunk) => {
          try {
            decoder.push(chunk);
          } catch {
            fail();
          }
        };
        socket.once("secureConnect", () => {
          const peer = socket.getPeerCertificate();
          if (!socket.authorized || !peer.raw || hash(peer.raw) !== grant.agentPin) {
            fail();
            return;
          }
          socket.write(
            encodeFrame({
              type: "hello",
              protocol: 1,
              nonce,
              alias: grant.alias,
              buildHash: grant.buildHash,
            }),
          );
        });
        socket.on("data", data);
        socket.once("close", fail);
        socket.on("error", fail);
      });
      return new LabClient(socket, grant, attestation);
    } catch (error) {
      socket.on("error", () => {});
      socket.destroy();
      throw error;
    }
  }
  request(command) {
    try {
      validateGrant(this.grant);
      if (this.closed || this.socket.destroyed)
        throw new Error("Lab session closed; no commands queued for reconnect");
      if (!this.grant.operations.includes(command?.op)) throw new Error("Operation not granted");
      if (this.pending.size >= labLimits.pendingCommands)
        throw new Error("Lab pending-command budget");
      const sequence = this.sequence + 1;
      const bytes = encodeFrame({ session: this.session, sequence, command });
      if (sequence > 4096) throw new Error("Session sequence budget");
      this.sequence = sequence;
      this.lastFrame = bytes;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(sequence);
          this.close();
          reject(new Error("Lab command timeout"));
        }, 10000);
        this.pending.set(sequence, { resolve, reject, timer });
        this.socket.write(bytes);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  close() {
    this.closed = true;
    this.socket.destroy();
  }
}
