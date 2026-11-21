import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { exportPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderExchange, renderProjectScene } from "../../packages/core/src/edits.ts";
import {
  createDemoProject,
  encodeWav,
  expandSong,
  type Project,
  ProjectSchema,
} from "../../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../../packages/core/src/instruments.ts";
import { machines } from "../../packages/core/src/machines.ts";
import { editPerformance } from "../../packages/core/src/performance.ts";
import { openProject } from "../../packages/core/src/project-io.ts";
import {
  compareParity,
  type ParityResult,
  parityIdentity,
  referenceParity,
} from "../../packages/sdk/src/parity.ts";
import { decodeResult, encodePlan } from "../../tools/sdk/parity-host.mjs";
import { diagnosticBundle, GuestCommand, ServiceLifecycle } from "./contract.ts";
import { ProjectJournal } from "./journal.ts";
import { osFixtureOracle, osFixtureProject } from "./shared.ts";

const filename = fileURLToPath(import.meta.url),
  now = () => Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]),
  hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const build = JSON.parse(readFileSync("/etc/xmp-build.json", "utf8"));
if (
  process.platform !== "linux" ||
  build.profile !== "p10-qemu-x86_64-v1" ||
  !readFileSync("/proc/cmdline", "utf8").includes(`xmp.build=${build.buildId}`)
)
  throw new Error("Guest image identity unavailable");
const role = process.argv[2] ?? "supervisor";
if (role === "ui") {
  if (readFileSync("/proc/cmdline", "utf8").includes("xmp.ui-start-fault=1")) process.exit(23);
  process.send?.({ ready: true, pid: process.pid });
  process.on("message", (m: { op: string }) => {
    if (m.op === "crash") process.exit(23);
  });
} else if (role === "engine") {
  // Only the audio/project engine needs WebAssembly. UI retries must not
  // repeatedly initialize the DSP runtime before reporting recovery.
  await loadCore();
  const journal = new ProjectJournal("/data"),
    initial = await journal.inspect();
  let project: Project | undefined =
      initial.project ?? (initial.report.empty ? expandSong(createDemoProject()) : undefined),
    recording = false;
  const faultEnabled = readFileSync("/proc/cmdline", "utf8").includes("xmp.fixture-faults=1");
  const save = async () => {
    if (!project) throw new Error("No valid project");
    return journal.commit(project);
  };
  const audio = (wav: ArrayBuffer, name: string) => {
    const dest = `/run/${name}.wav`;
    writeFileSync(dest, Buffer.from(wav));
    execFileSync("/usr/bin/aplay", ["-q", "-D", "hw:0,0", dest], {
      stdio: "ignore",
      timeout: 15000,
    });
  };
  const renderPad = (pad: number, project: Project) => {
    const rack = new VoiceRack(prepareInstruments(project));
    rack.masterGain = project.master;
    const left = new Float32Array(12000),
      right = new Float32Array(12000);
    rack.noteOn(1, pad, 0, 60, 0.8);
    for (let i = 0; i < left.length; i += 128) {
      const a = new Float32Array(Math.min(128, left.length - i)),
        b = new Float32Array(a.length);
      rack.process(a, b);
      left.set(a, i);
      right.set(b, i);
    }
    rack.panic();
    return encodeWav([left, right], 48000);
  };
  const metrics = (bytes: Buffer) => {
    let peak = 0,
      first = -1;
    for (let i = 44; i < bytes.length; i += 4) {
      const value = Math.abs(bytes.readInt16LE(i));
      if (value && first < 0) first = (i - 44) / 4;
      peak = Math.max(peak, value);
    }
    return {
      sha256: hash(bytes),
      bytes: bytes.length,
      header: bytes.subarray(0, 44).toString("base64"),
      frames: (bytes.length - 44) / 4,
      peak,
      firstNonzeroFrame: first,
    };
  };
  let chain = Promise.resolve();
  process.on("message", (m: { id: number; command: unknown }) => {
    chain = chain.then(async () => {
      try {
        const c = GuestCommand.parse(m.command);
        let result: unknown;
        if (c.op === "status") {
          result = {
            projectHash: project ? hash(await exportPortable(project)) : null,
            tracks: project?.tracks.length ?? 0,
            synth: project?.tracks.some((t) => t.machine?.id === "xmp.subtractive") ?? false,
            recording,
            chain: project?.performance?.chain.length ?? 0,
            projectRecovery: (await journal.inspect()).report,
          };
          process.send?.({ id: m.id, result });
          return;
        }
        if (c.op === "recovery-report") {
          process.send?.({ id: m.id, result: (await journal.inspect()).report });
          return;
        }
        if (c.op === "recovery-export") {
          process.send?.({ id: m.id, result: journal.exportRecovery() });
          return;
        }
        if (c.op === "fault-corrupt") {
          if (!faultEnabled) throw new Error("Fault fixtures disabled");
          journal.corruptFixture(c.all);
          const loaded = await journal.inspect();
          project = loaded.project ?? undefined;
          process.send?.({ id: m.id, result: loaded.report });
          return;
        }
        if (c.op === "reopen") {
          const loaded = await journal.inspect();
          project = loaded.project ?? undefined;
          process.send?.({
            id: m.id,
            result: {
              projectHash: project ? hash(await exportPortable(project)) : null,
              reopened: !!project,
              recovery: loaded.report,
            },
          });
          return;
        }
        if (c.op === "shutdown") {
          const state = await journal.inspect();
          if (project && !state.report.readOnly) await save();
          process.send?.({
            id: m.id,
            result: {
              flushed: true,
              projectSaved: !!project && !state.report.readOnly,
              recoveryPreserved: state.report.readOnly,
            },
          });
          return;
        }
        if (!project) throw new Error("No valid project; original candidates preserved");
        if (c.op === "sdk-parity") {
          const reference = referenceParity(c.plan);
          let capture: ParityResult = reference;
          if (c.backend === "native") {
            const binary = "/opt/xmp/xmp_parity_render";
            if (
              !build.nativeParitySha256 ||
              hash(readFileSync(binary)) !== build.nativeParitySha256
            )
              throw new Error("Native parity binary unavailable");
            const directory = `/run/parity-${m.id}`;
            mkdirSync(directory, { mode: 0o700 });
            writeFileSync(`${directory}/case.plan`, encodePlan(c.plan), { flag: "wx" });
            execFileSync(binary, ["case.plan", "case.result"], { cwd: directory, timeout: 15000 });
            capture = decodeResult(readFileSync(`${directory}/case.result`));
          }
          result = {
            identity: await parityIdentity(capture),
            referenceIdentity: await parityIdentity(reference),
            comparison: compareParity(reference, capture),
            backend: c.backend,
            assertedInsideGuest: true,
            nativeBinarySha256: build.nativeParitySha256 ?? null,
            physicalAccess: false,
          };
        } else if (c.op === "fault-save") {
          if (!faultEnabled) throw new Error("Fault fixtures disabled");
          const hash = await journal.commit(project, async (point, receipt) => {
            if (point === c.point) {
              process.send?.({ event: "save-checkpoint", point, ...receipt });
              await new Promise<void>(() => {});
            }
          });
          result = { projectHash: hash, flushed: true };
        } else if (c.op === "pad") {
          if (recording) {
            const clip = project.tracks[0]?.clips[0];
            if (clip && !clip.steps.some((s) => s.pad === c.pad && s.step === 0))
              clip.steps.push({ step: 0, pad: c.pad, velocity: 0.8, probability: 1 });
          }
          const wav = renderPad(c.pad, project);
          const sourcePeak = metrics(Buffer.from(wav)).peak;
          if (!sourcePeak) throw new Error("Silent pad");
          audio(wav, "pad");
          result = {
            played: true,
            sourcePeak,
            pad: c.pad,
            profile: "virtual-hda-48000",
            at: now(),
          };
        } else if (c.op === "record") {
          recording = true;
          const pcm = new Float32Array(24000);
          for (const start of [0, 12000])
            for (let i = 0; i < 480; i++)
              pcm[start + i] = Math.sin((i * 2 * Math.PI * 2200) / 48000) * (1 - i / 480) * 0.2;
          audio(encodeWav([pcm, pcm], 48000), "metronome");
          result = { recording: true, metronome: true, at: now() };
        } else if (c.op === "step") {
          const clip = project.tracks[0]?.clips[0];
          if (!clip) throw new Error("No clip");
          clip.steps = clip.steps.filter((s) => !(s.step === c.step && s.pad === c.pad));
          clip.steps.push({ step: c.step, pad: c.pad, velocity: 0.8, probability: 1 });
          project = ProjectSchema.parse(project);
          result = { step: c.step, pad: c.pad };
        } else if (c.op === "beat") {
          const clip = project.tracks[0]?.clips[0];
          if (!clip) throw new Error("No clip");
          clip.steps = [0, 4, 8, 12].map((step) => ({
            step,
            pad: 0,
            velocity: 0.9,
            probability: 1,
          }));
          project.bpm = 120;
          result = { beat: true };
        } else if (c.op === "synth") {
          const track = project.tracks[1],
            clip = track?.clips[0];
          if (!track || !clip) throw new Error("No synth track");
          track.machine = machines.instantiate("xmp.subtractive");
          clip.steps = [
            { step: 2, pad: 0, note: 60, duration: 4, velocity: 0.6, probability: 1 },
            { step: 10, pad: 0, note: 67, duration: 4, velocity: 0.6, probability: 1 },
          ];
          project = ProjectSchema.parse(project);
          result = { synth: true };
        } else if (c.op === "arrange") {
          for (const track of project.tracks)
            if (track.clips[0] && track.clips[1]) {
              track.clips[1].steps = structuredClone(track.clips[0].steps);
            }
          project = editPerformance(project, (p) => {
            p.chain = [
              { id: "intro", sceneId: "scene-0", repeats: 1 },
              { id: "verse", sceneId: "scene-1", repeats: 1 },
            ];
            p.end = "stop";
          });
          result = { scenes: 2 };
        } else if (c.op === "save") result = { projectHash: await save(), flushed: true };
        else if (c.op === "load-project") {
          project = await openProject(c.text);
          result = { loaded: true, samples: project.samples.length };
        } else if (c.op === "rename") {
          project.name = c.name;
          project = ProjectSchema.parse(project);
          result = { renamed: true };
        } else if (c.op === "export") {
          const render = renderExchange(
              project,
              project.performance?.chain.length ? "song" : "scene",
              "scene-0",
              0.25,
            ),
            bytes = Buffer.from(render.wav);
          writeFileSync("/data/song.wav", bytes);
          result = {
            ...metrics(readFileSync("/data/song.wav")),
            notes: render.trace.length,
            synth: project.tracks.some((t) => t.machine?.id === "xmp.subtractive"),
          };
        } else if (c.op === "fixture") {
          const fixture = osFixtureProject(),
            bytes = Buffer.from(renderProjectScene(fixture, "scene-0")),
            m = metrics(bytes);
          if (
            m.frames !== osFixtureOracle.frames ||
            m.firstNonzeroFrame !== osFixtureOracle.peakFrame ||
            m.peak !== osFixtureOracle.pcm16
          )
            throw new Error("Shared fixture mismatch");
          result = {
            ...m,
            oracle: osFixtureOracle,
            assertedInsideGuest: true,
            aroundPeak: bytes.subarray(44 + 24000 * 4, 44 + 24004 * 4).toString("base64"),
          };
        } else throw new Error("Unsupported engine command");
        process.send?.({ id: m.id, result });
      } catch {
        process.send?.({ id: m.id, error: "COMMAND_REJECTED" });
      }
    });
  });
  process.send?.({
    ready: true,
    pid: process.pid,
    defaultKit: true,
    storageRecovery: initial.report.recoveryRequired,
    at: now(),
  });
} else {
  const lifecycle = new ServiceLifecycle();
  lifecycle.storageReady(now());
  const kernel = readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    net = readdirSync("/sys/class/net"),
    sound = readFileSync("/proc/asound/cards", "utf8");
  const listeners = ["/proc/net/tcp", "/proc/net/tcp6"]
    .flatMap((p) => readFileSync(p, "utf8").trim().split("\n").slice(1))
    .filter((l) => l.trim().split(/\s+/)[3] === "0A").length;
  const hostShares = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .some((l) => /^(9p|virtiofs|nfs|nfs4|cifs)$/.test(l.split(" ")[2] ?? ""));
  const board = readFileSync("/sys/class/dmi/id/product_name", "utf8").trim();
  if (listeners || hostShares || net.some((n) => n !== "lo") || !sound.includes("HDA Intel"))
    throw new Error("Unexpected virtual-device profile");
  const engine = fork(filename, ["engine"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let ui: ReturnType<typeof fork> | undefined,
    ready = false,
    storageRecovery = false,
    next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const rpc = (command: unknown) =>
    new Promise((resolve, reject) => {
      if (pending.size >= 16) return reject(new Error("Request budget"));
      const id = next++;
      pending.set(id, { resolve, reject });
      engine.send({ id, command });
    });
  const emit = (value: unknown) => process.stdout.write(`XMP!${JSON.stringify(value)}\n`);
  let uiWaiters: (() => void)[] = [];
  const startUi = () => {
    ui = fork(filename, ["ui"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    ui.on("message", (m) => {
      if ((m as { ready?: boolean }).ready) {
        lifecycle.uiReady(now());
        for (const resolve of uiWaiters) resolve();
        uiWaiters = [];
        if (!ready) {
          ready = true;
          emit({
            ready: true,
            buildId: build.buildId,
            profile: build.profile,
            kernel,
            networkInterfaces: net,
            labAgentEnabled: false,
            hostShares,
            controlListeners: listeners,
            board,
            node: process.version,
            physicalAudioQualified: false,
            storageRecoveryRequired: storageRecovery,
            playable: !storageRecovery,
            bootReadySeconds: now(),
            enginePid: engine.pid,
            uiPid: ui?.pid,
            services: lifecycle.events,
          });
          process.stdout.write(
            "XMP OS · pad 0 · record · beat · synth · arrange · save · export · shutdown\n",
          );
        }
      }
    });
    ui.on("exit", () => {
      if (lifecycle.engine && lifecycle.uiCrash(now())) startUi();
      else {
        for (const resolve of uiWaiters) resolve();
        uiWaiters = [];
        if (!ready && lifecycle.recovery) {
          ready = true;
          emit({
            ready: true,
            recovery: true,
            playable: false,
            buildId: build.buildId,
            profile: build.profile,
            kernel,
            networkInterfaces: net,
            labAgentEnabled: false,
            hostShares,
            controlListeners: listeners,
            board,
            node: process.version,
            physicalAudioQualified: false,
            bootReadySeconds: now(),
            enginePid: engine.pid,
            restarts: lifecycle.restarts,
            services: lifecycle.events,
          });
        }
      }
    });
  };
  engine.on("message", (m) => {
    const message = m as {
      ready?: boolean;
      id?: number;
      result?: unknown;
      error?: string;
      event?: string;
      storageRecovery?: boolean;
    };
    if (message.event === "save-checkpoint") {
      emit(message);
      return;
    }
    if (message.ready) {
      storageRecovery = message.storageRecovery ?? false;
      lifecycle.engineReady(now());
      startUi();
    } else if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) p?.reject(new Error(message.error));
      else p?.resolve(message.result);
    }
  });
  engine.on("exit", () => {
    if (lifecycle.engine) {
      lifecycle.error("ENGINE_FAILED");
      emit({ fault: "ENGINE_FAILED" });
      process.exit(2);
    }
  });
  const input = createInterface({ input: process.stdin });
  let processing = Promise.resolve();
  input.on("line", (line) => {
    processing = processing.then(async () => {
      let id = 0;
      try {
        if (Buffer.byteLength(line) > 262144) throw new Error("Oversized command");
        let request: unknown;
        if (line.startsWith("{")) {
          const m = JSON.parse(line);
          id = m.id;
          request = m.command;
          if (!Number.isSafeInteger(id) || id < 1) throw new Error("Bad request");
        } else {
          const [op, value] = line.trim().split(/\s+/);
          request = op === "pad" ? { op, pad: Number(value) } : { op };
        }
        const command = GuestCommand.parse(request);
        if (!ready) throw new Error("Not ready");
        let result: unknown;
        if (command.op === "diagnostics")
          result = diagnosticBundle(
            { buildId: build.buildId, profile: build.profile, kernel },
            lifecycle.events,
            lifecycle.errors,
          );
        else if (command.op === "status")
          result = {
            ...((await rpc(command)) as object),
            recovery: lifecycle.recovery,
            restarts: lifecycle.restarts,
            enginePid: engine.pid,
            uiPid: ui?.pid,
            services: lifecycle.events,
          };
        else if (command.op === "crash-ui" || command.op === "exhaust-ui") {
          const times = command.op === "crash-ui" ? 1 : 4;
          for (let i = 0; i < times && !lifecycle.recovery; i++)
            await new Promise<void>((resolve) => {
              uiWaiters.push(resolve);
              ui?.send({ op: "crash" });
            });
          result = {
            recovery: lifecycle.recovery,
            restarts: lifecycle.restarts,
            services: lifecycle.events,
          };
        } else {
          result = await rpc(command);
          if (command.op === "pad") lifecycle.event("first-pad", now());
          if (command.op === "record") lifecycle.event("record-metronome", now());
          if (command.op === "save") lifecycle.event("project-saved", now());
        }
        emit({ id, ok: true, result });
        if (command.op === "shutdown") {
          lifecycle.stop(now());
          ui?.kill("SIGTERM");
          engine.kill("SIGTERM");
          emit({ services: lifecycle.events, shutdown: true });
          input.close();
          setTimeout(() => process.exit(0), 50);
        }
      } catch {
        lifecycle.error("COMMAND_REJECTED");
        emit({ id, ok: false, error: "COMMAND_REJECTED" });
      }
    });
  });
}
