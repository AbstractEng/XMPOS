import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { encodeWav } from "../../packages/core/src/index.ts";
import { analyzeLoopback } from "../../packages/core/src/latency.ts";
import { EngineClient, operations, startEngineHost } from "../lib/engine-target.mjs";
import { command, root, sha256 } from "../lib/workspace.mjs";

const nativeTest = (mode) =>
  JSON.parse(command(resolve(root, "build/native/xmp_engine_test"), [mode]));
Given("sample buffers and thirty-two voices are prepared before playback", function () {
  this.enginePrepared = true;
});
When("the engine renders a one-minute multitrack fixture", function () {
  this.canary = nativeTest("canary");
  this.minute = nativeTest("render");
  this.evidenceDirectory = this.workspace.path("callback-evidence");
  mkdirSync(this.evidenceDirectory);
  writeFileSync(resolve(this.evidenceDirectory, "minute.json"), JSON.stringify(this.minute));
  writeFileSync(resolve(this.evidenceDirectory, "canary.json"), JSON.stringify(this.canary));
});
Then(
  "callback instrumentation observes zero allocations, locks and file or network operations",
  function () {
    for (const field of ["allocations", "frees", "locks", "files", "network"]) {
      assert.ok(this.canary[field] > 0, `Canary missing ${field}`);
      assert.equal(this.minute[field], 0);
    }
    assert.equal(this.minute.frames, 60 * 48000);
    assert.equal(this.minute.voices, 32);
    assert.equal(this.minute.tracks, 8);
  },
);
Then("every output sample is finite and inside the declared output range", function () {
  assert.equal(this.minute.nonFinite, 0);
  assert.equal(this.minute.rangeErrors, 0);
  this.artifacts.push({
    kind: "log",
    data: { event: "native-minute-render", frame: this.minute.frames, outcome: "passed" },
  });
});
Given("all voices in the active profile are in use", function () {
  this.voiceProfile = 32;
});
When("another note arrives", function () {
  this.exhaustion = nativeTest("exhaustion");
});
Then("the documented voice-stealing or refusal rule is applied deterministically", function () {
  assert.equal(this.exhaustion.on, 32);
  assert.equal(this.exhaustion.refused, 1);
});
Then("no buffer overrun, unbounded allocation or engine crash occurs", function () {
  assert.equal(this.exhaustion.allocations, 0);
  assert.equal(this.exhaustion.nonFinite, 0);
  assert.equal(this.exhaustion.rangeErrors, 0);
});
Given("a song plays at 120 BPM with notes that span the next bar", function () {
  this.oldTempo = 120;
});
When("the musician queues 90 BPM for the next bar", function () {
  this.tempo = nativeTest("tempo");
});
Then(
  "event times follow the old tempo before the boundary and the new tempo afterward",
  function () {
    assert.equal(this.tempo.tempoFrame, 96000);
    assert.equal(this.tempo.oldStepFrames, 6000);
    assert.equal(this.tempo.newStepFrames, 8000);
  },
);
Then("active notes receive exactly one note-off without a transport restart", function () {
  assert.equal(this.tempo.noteOffs, 1);
  assert.equal(this.tempo.releaseFrame, 128000);
});
Given("the engine has a validated finite event queue", function () {
  this.queueValidated = true;
});
When("a command has an invalid timestamp, unsupported version or oversized payload", function () {
  this.malformed = nativeTest("commands");
});
Then("that command is rejected with a bounded error response", function () {
  assert.equal(this.malformed.rejected, 3);
  assert.equal(this.malformed.responseBytes, 176);
});
Then("previously queued musical events keep their order", function () {
  assert.deepEqual(this.malformed.eventFrames, [100, 200]);
});

async function hostFor(world) {
  const host = await startEngineHost(world.workspace, { seconds: 15 });
  world.host = host;
  world.evidenceDirectory = world.workspace.path("host-evidence");
  mkdirSync(world.evidenceDirectory);
  world.finalizers.push(async () => {
    const report = await host.finish();
    for (const name of ["engine-report.json", "engine-capture.wav", "engine-trace.json"])
      copyFileSync(world.workspace.path(name), resolve(world.evidenceDirectory, name));
    writeFileSync(resolve(world.evidenceDirectory, "identity.json"), JSON.stringify(host.identity));
    world.hostReport = report;
  });
  return host;
}
Given("an engine is running a project while no UI client is connected", async function () {
  const host = await hostFor(this);
  const started = await host.client.request(operations.start);
  assert.equal(started.status, 5);
  this.enginePid = host.child.pid;
  host.client.close();
});
When("a compatible UI client completes the version handshake", async function () {
  this.reconnected = await EngineClient.connect(this.host.socket);
  this.finalizers.push(() => this.reconnected.close());
  this.snapshot = await this.reconnected.snapshot();
  this.engineProject = await this.reconnected.project(this.snapshot);
});
Then("it receives an atomic project and transport snapshot", function () {
  assert.equal(this.snapshot.projectHash, this.host.graph.projectHash);
  assert.equal(this.engineProject.profileId, this.host.identity.profile);
  assert.equal(this.engineProject.events.length, 32);
  assert.equal(this.snapshot.running, true);
  assert.equal(this.snapshot.sampleRate, 48000);
  assert.equal(this.snapshot.bufferFrames, 256);
  assert.ok(this.snapshot.frame > 0 && this.snapshot.tick > 0);
  assert.equal(this.host.child.pid, this.enginePid);
});
Then("subsequent commands acknowledge the applied state revision", async function () {
  const stopped = await this.reconnected.request(operations.stop);
  assert.equal(stopped.status, 5);
  assert.ok(stopped.revision > this.snapshot.revision);
  const state = await this.reconnected.snapshot();
  assert.equal(state.running, false);
  assert.equal(state.on, state.off);
});
Given("a client floods the control channel beyond its declared queue capacity", async function () {
  const host = await hostFor(this);
  await host.client.request(operations.start);
  this.flood = await Promise.all(
    Array.from({ length: 200 }, () =>
      host.client.request(operations.noteOn, { a: 500, b: 0, value: 0.1 }),
    ),
  );
});
When("the engine applies backpressure", async function () {
  this.afterFlood = await this.host.client.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  this.afterNotes = await this.host.client.snapshot();
});
Then("excess commands are rejected or coalesced by the documented policy", function () {
  assert.ok(
    this.flood.some((reply) => reply.status === 3),
    JSON.stringify(this.afterFlood),
  );
  assert.ok(this.afterFlood.queueDrops > 0);
  assert.ok(this.afterFlood.pending <= 144);
});
Then(
  "callback deadlines and transport note-off processing remain within budget",
  async function () {
    assert.ok(this.afterNotes.off >= 32);
    const report = await this.host.finish();
    assert.equal(report.auditFaults, 0);
    assert.equal(report.traceDrops, 0);
    assert.ok(report.callbackP99Ns < (256 / 48000) * 1e9 * 0.8, JSON.stringify(report));
    assert.ok(report.off >= report.on);
  },
);

Given(
  "the P04 development workload is playing through the independent native host",
  async function () {
    const host = await hostFor(this);
    await host.client.request(operations.start);
    this.startSnapshot = await host.client.snapshot();
  },
);
When("its control client process is killed and a fresh client reconnects", async function () {
  const spawnClient = async () => {
    const child = spawn(process.execPath, ["tools/engine-client.mjs", this.host.socket], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.workspace.processes.add(child);
    let text = "",
      error = "";
    child.stderr.on("data", (data) => {
      error += data;
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Client startup failed ${error}`)), 5000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Client exited ${code} ${error}`));
      });
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) {
          clearTimeout(timer);
          resolve(JSON.parse(text.split("\n")[0]));
        }
      });
    });
    return { child, ready };
  };
  this.originalClient = await spawnClient();
  const exited = once(this.originalClient.child, "exit");
  this.originalClient.child.kill("SIGKILL");
  await exited;
  this.workspace.processes.delete(this.originalClient.child);
  await new Promise((resolve) => setTimeout(resolve, 150));
  this.freshClient = await spawnClient();
  this.finalizers.push(async () => {
    if (this.freshClient.child.exitCode === null && this.freshClient.child.signalCode === null) {
      const exited = once(this.freshClient.child, "exit");
      this.freshClient.child.kill("SIGTERM");
      await exited;
    }
    this.workspace.processes.delete(this.freshClient.child);
  });
  await new Promise((resolve) => setTimeout(resolve, 2100));
});
Then(
  "the native clock and captured event sequence continue without a client-driven restart",
  async function () {
    assert.equal(this.freshClient.ready.generation, this.originalClient.ready.generation);
    assert.equal(this.freshClient.ready.projectHash, this.originalClient.ready.projectHash);
    assert.ok(this.freshClient.ready.frame > this.originalClient.ready.frame);
    assert.ok(this.freshClient.ready.tick > this.originalClient.ready.tick);
    this.restartReport = await this.host.finish();
    const trace = JSON.parse(readFileSync(this.workspace.path("engine-trace.json"), "utf8"));
    const starts = trace.filter((event) => event.kind === 1 && event.id === 1);
    assert.ok(starts.length >= 2);
    for (let i = 1; i < starts.length; i++)
      assert.equal(starts[i].frame - starts[i - 1].frame, 96000);
    for (let id = 1; id <= 32; id++) {
      assert.equal(
        trace.filter((event) => event.kind === 1 && event.id === id).length,
        starts.length,
      );
      assert.equal(
        trace.filter((event) => event.kind === 2 && event.id === id).length,
        starts.length,
      );
    }
    assert.equal(this.restartReport.traceDrops, 0);
  },
);
Then("the capture is qualified only against the named software audio profile", function () {
  assert.equal(this.restartReport.backend, "virtual-paced");
  assert.equal(this.restartReport.physicalAudio, false);
  assert.equal(this.restartReport.auditFaults, 0);
  assert.ok(this.restartReport.callbackP99Ns < (256 / 48000) * 1e9 * 0.8);
});

Given("the native development backend is playing a validated project", async function () {
  const host = await hostFor(this);
  await host.client.request(operations.start);
  this.beforeLoss = await host.client.snapshot();
});
When("its test endpoint reports a loss", async function () {
  const lost = await this.host.client.request(operations.backendLost);
  assert.equal(lost.status, 5);
  this.lost = await this.host.client.snapshot();
});
Then("the engine becomes silent and retains the project identity", function () {
  assert.equal(this.lost.safe, true);
  assert.equal(this.lost.running, false);
  assert.equal(this.lost.on, this.lost.off);
  assert.equal(this.lost.projectHash, this.beforeLoss.projectHash);
});
Then("unsupported rates fail before a valid reconnect and explicit resume", async function () {
  const invalid = await this.host.client.request(operations.reconnect, { a: 44100, b: 256 });
  assert.equal(invalid.status, 2);
  assert.equal((await this.host.client.snapshot()).safe, true);
  const reconnect = await this.host.client.request(operations.reconnect, { a: 48000, b: 256 });
  assert.equal(reconnect.status, 5);
  const state = await this.host.client.snapshot();
  assert.equal(state.safe, false);
  assert.equal(state.running, false);
  await this.host.client.request(operations.start);
  assert.equal((await this.host.client.snapshot()).running, true);
});
Given("a thousand generated capture trials have a known ten-millisecond delay", function () {
  const pcm = new Float32Array(6000000);
  const emittedFrames = Array.from({ length: 1000 }, (_, i) => i * 6000);
  for (const frame of emittedFrames) pcm[frame + 480] = 0.5;
  this.loopbackCapture = new Uint8Array(encodeWav([pcm], 48000));
  this.calibration = {
    version: 1,
    sampleRate: 48000,
    bufferFrames: 256,
    clockRatio: 1,
    clockOffsetFrames: 0,
    captureStartFrame: 0,
    maximumResidualFrames: 0,
    independentCalibration: true,
    physicalFixtureObserved: false,
    synthetic: true,
    emittedFrames,
  };
});
When("the calibrated loopback analyzer reads the capture", function () {
  this.measurement = analyzeLoopback(this.loopbackCapture, this.calibration);
  this.evidenceDirectory = this.workspace.path("measurement-evidence");
  mkdirSync(this.evidenceDirectory);
  writeFileSync(resolve(this.evidenceDirectory, "capture.wav"), this.loopbackCapture);
  writeFileSync(
    resolve(this.evidenceDirectory, "measurement.json"),
    JSON.stringify({ ...this.measurement, captureHash: sha256(this.loopbackCapture) }),
  );
});
Then("its measured p95 is ten milliseconds with a preserved capture hash", function () {
  assert.equal(this.measurement.outcome, "measured");
  assert.equal(this.measurement.p95Ms, 10);
  assert.equal(this.measurement.latencyMs.length, 1000);
  assert.equal(
    sha256(readFileSync(resolve(this.evidenceDirectory, "capture.wav"))),
    sha256(this.loopbackCapture),
  );
});
Then("the synthetic result cannot qualify a physical audio path", function () {
  assert.equal(this.measurement.synthetic, true);
  assert.equal(this.measurement.physicalQualification, false);
});
Given("no approved physical capture or valid clock calibration is supplied", function () {
  this.noCapture = undefined;
});
When("the loopback qualification and audio selection checks run", function () {
  this.absentMeasurement = analyzeLoopback(undefined, undefined);
  this.selectionPolicy = JSON.parse(command(resolve(root, "build/native/xmp_backend_test"), []));
});
Then("latency remains inconclusive and protected or default outputs are rejected", function () {
  assert.equal(this.absentMeasurement.outcome, "inconclusive");
  assert.equal(this.absentMeasurement.p95Ms, null);
  assert.equal(this.absentMeasurement.physicalQualification, false);
  assert.equal(this.selectionPolicy.openedEndpoints, 0);
  assert.equal(this.selectionPolicy.defaultSelection, false);
  assert.equal(this.selectionPolicy.policyCases, 8);
});
