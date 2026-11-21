import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommunityManifest, negotiateModule } from "../../packages/sdk/src/community/contract.ts";
import { validateState } from "../../packages/sdk/src/community/program.ts";

const worker = fileURLToPath(new URL("./ui-worker.mjs", import.meta.url));
export class CommunityUiSupervisor {
  #child;
  #token = randomBytes(16).toString("hex");
  #next = 1;
  #pending = new Map();
  #manifest;
  #state;
  #closed = false;
  #starts = 0;
  faults = [];
  constructor(manifest, parameters) {
    this.#manifest = negotiateModule(CommunityManifest.parse(manifest)).manifest;
    this.#state = { revision: 0, parameters: { ...validateState(this.#manifest, parameters) } };
  }
  get pid() {
    return this.#child?.pid;
  }
  get snapshot() {
    return structuredClone(this.#state);
  }
  async open() {
    if (this.#closed) throw new Error("UI supervisor closed");
    if (this.#child) throw new Error("UI is already open");
    if (++this.#starts > 8)
      throw new Error("UI restart budget exhausted; open a new explicit session");
    const child = fork(worker, [], {
      execArgv: ["--max-old-space-size=64", "--permission", `--allow-fs-read=${worker}`],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { NODE_NO_WARNINGS: "1" },
    });
    this.#child = child;
    let errors = "";
    child.stderr.on("data", (b) => {
      errors = (errors + b.toString()).slice(-4096);
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("UI startup budget exceeded"));
      }, 3000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`UI exited before handshake: ${errors}`));
      });
      child.on("message", (message) => {
        if (message?.ready) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.on("message", (message) => {
      if (
        !message ||
        typeof message !== "object" ||
        Buffer.byteLength(JSON.stringify(message)) > 4096
      )
        return;
      const pending = this.#pending.get(message.request);
      if (!pending) return;
      this.#pending.delete(message.request);
      clearTimeout(pending.timer);
      if (message.ack) {
        try {
          if (
            !Number.isSafeInteger(message.ack.revision) ||
            message.ack.revision < this.#state.revision
          )
            throw new Error("Stale UI acknowledgement");
          const parameters = validateState(this.#manifest, message.ack.parameters);
          this.#state = { revision: message.ack.revision, parameters: { ...parameters } };
        } catch (error) {
          pending.reject(error);
          return;
        }
      }
      pending.resolve(message);
    });
    child.on("exit", (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      if (!this.#closed)
        this.faults.push({
          kind: "ui-process-exit",
          code,
          signal,
          policy: "engine continues; restore last acknowledgement",
          nativeHostFault: false,
        });
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("UI process unavailable; engine ownership unchanged"));
      }
      this.#pending.clear();
    });
    await ready;
    await this.#request("restore", { state: this.#state });
    return this.snapshot;
  }
  #request(op, fields = {}) {
    if (!this.#child?.connected || this.#pending.size >= 32)
      throw new Error("UI unavailable or request budget exceeded");
    const request = this.#next++,
      child = this.#child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request);
        child.kill("SIGKILL");
        reject(new Error("UI acknowledgement budget exceeded"));
      }, 2000);
      this.#pending.set(request, { resolve, reject, timer });
      child.send({ op, request, token: this.#token, ...fields }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(request);
          reject(error);
        }
      });
    });
  }
  async set(id, value) {
    const p = this.#manifest.parameters.find((p) => p.id === id);
    if (!p || !Number.isFinite(value) || value < p.min || value > p.max)
      throw new Error("UI parameter capability denied");
    await this.#request("set", { id, value });
    return this.snapshot;
  }
  async injectCrash() {
    const child = this.#child;
    if (!child) throw new Error("UI unavailable");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    this.#request("crash").catch(() => {});
    await exited;
  }
  async permissionProbe(path) {
    return (await this.#request("permission-probe", { path })).permissions;
  }
  async close() {
    this.#closed = true;
    const child = this.#child;
    if (child) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
}
export async function probeTrustedNativeFault(root) {
  // Fixed locally compiled test binary, never a path from a package or project.
  const binary = resolve(root, "build/native/xmp_community_fault");
  const child = spawn(binary, ["--inject-trusted-dsp-fault"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout = (stdout + b.toString()).slice(0, 4096);
  });
  child.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(0, 4096);
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Native fault probe timeout"));
    }, 3000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (result.signal !== "SIGKILL" || !stdout.includes('"trustedNativeInHost":true'))
    throw new Error(`Native fault fixture did not run: ${stderr}`);
  return {
    ...result,
    kind: "native-audio-host-fault",
    safe: true,
    outputEnabled: false,
    heldNotes: 0,
    automaticRestart: false,
    manifestSandboxContained: false,
    fixture: "SIGKILL injected inside trusted native DSP callback",
    evidence: JSON.parse(stdout),
  };
}
