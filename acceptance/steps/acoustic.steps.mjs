import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import {
  acousticProfile,
  analyzeAcoustic,
  decodeAcousticWav,
  preflightAcoustic,
} from "../../packages/core/src/acoustic.ts";
import { loadCore, prepareScene, renderProjectScene } from "../../packages/core/src/edits.ts";
import {
  acousticProject,
  mockBuiltins,
  monoWav,
  syntheticAcoustic,
} from "../lib/acoustic-fixture.mjs";
import { command, root } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

Given(
  "a synthetic six-second acoustic capture at {int} Hz with the complete eight-note pattern",
  function (rate) {
    this.acousticRate = rate;
    this.acousticPcm = syntheticAcoustic({ rate });
  },
);
Given("a synthetic acoustic capture with {string}", function (fault) {
  this.acousticRate = 48000;
  const options = {
    silence: { silence: true },
    "missing hit": { missing: 3 },
    "late hit": { delayed: 4 },
    "wrong order": { wrongOrder: true },
    noise: { noise: true },
    clipping: { clipped: true },
  };
  this.acousticPcm = syntheticAcoustic(options[fault] ?? {});
  if (fault === "truncated") this.acousticPcm = this.acousticPcm.slice(0, 100);
  if (fault === "non-finite") this.acousticPcm[100] = NaN;
});
When("the acoustic detector analyzes the capture", function () {
  this.acousticResult = analyzeAcoustic(this.acousticPcm, this.acousticRate);
  this.artifacts.push({
    kind: "log",
    data: [{ event: "synthetic-acoustic-analysis", outcome: this.acousticResult.outcome }],
  });
});
Then("all eight tones and their relative timing pass the acoustic profile", function () {
  assert.equal(this.acousticResult.outcome, "passed");
  assert.equal(this.acousticResult.detectedNotes, 8);
  assert.ok(this.acousticResult.maximumErrorMs <= 40);
  assert.ok(this.acousticResult.intervalErrorMs <= 40);
});
Then("the acoustic outcome is {string}", function (outcome) {
  assert.equal(this.acousticResult.outcome, outcome);
});
Then("no formal latency or hardware qualification is claimed", function () {
  assert.equal(this.acousticResult.physicalAudioQualified, false);
  assert.equal(this.acousticResult.formalLoopbackQualified, false);
  assert.equal(this.acousticResult.latencyMs, null);
  assert.equal(this.acousticResult.jitterMs, null);
});
Given("the original acoustic-check project is loaded on the host", function () {
  this.acousticProject = acousticProject();
});
When("the XMP offline renderer prepares and renders it", function () {
  this.acousticPlan = prepareScene(this.acousticProject, "scene-0");
  this.acousticReference = Buffer.from(renderProjectScene(this.acousticProject, "scene-0"));
});
Then("the reference contains exactly eight events at the expected musical positions", function () {
  assert.deepEqual(
    this.acousticPlan.events.map((event) => event.frame),
    [0, 18000, 48000, 60000, 96000, 126000, 144000, 168000],
  );
  assert.equal(this.acousticPlan.events.length, 8);
  assert.equal(this.acousticPlan.samples.length, 8);
});
Then("it lasts four seconds and stays below the acoustic output level limit", function () {
  assert.equal(this.acousticReference.readUInt32LE(40) / 4, 192000);
  let peak = 0;
  for (let at = 44; at < this.acousticReference.length; at += 2)
    peak = Math.max(peak, Math.abs(this.acousticReference.readInt16LE(at)) / 32768);
  assert.ok(peak > 0.1 && peak <= 0.25);
});
Given(
  "acoustic preflight receives protected, external, headphone, missing or mismatched device metadata",
  function () {
    const changes = [
      { name: "Akai Force", builtIn: false },
      { name: "AKAI MPC Live", builtIn: false },
      { builtIn: false },
      { uid: "BuiltInHeadphoneDevice" },
      { alive: false },
      { id: 0 },
      { sampleRate: NaN },
      { outputChannels: 0 },
    ];
    this.acousticRequests = changes.map((change) => {
      const inventory = mockBuiltins();
      Object.assign(inventory.output, change);
      return { inventory, options: { platform: "darwin", ci: false, capture: true } };
    });
    for (const change of [
      { uid: "BuiltInSpeakerDevice" },
      { builtIn: false },
      { name: "MacBook Pro Headphones" },
      { inputChannels: 0 },
    ]) {
      const inventory = mockBuiltins();
      Object.assign(inventory.input, change);
      this.acousticRequests.push({
        inventory,
        options: { platform: "darwin", ci: false, capture: true },
      });
    }
  },
);
Given("acoustic preflight receives a CI request or a denied microphone request", function () {
  const denied = mockBuiltins();
  denied.microphonePermission = "denied";
  this.acousticRequests = [
    { inventory: mockBuiltins(), options: { platform: "darwin", ci: true, capture: true } },
    { inventory: denied, options: { platform: "darwin", ci: false, capture: true } },
    { inventory: mockBuiltins(), options: { platform: "linux", ci: false, capture: true } },
  ];
});
When("each selection is attempted through a counted stream factory", function () {
  this.streamCalls = 0;
  this.rejections = 0;
  for (const { inventory, options } of this.acousticRequests) {
    try {
      preflightAcoustic(inventory, options);
      this.streamCalls++;
    } catch {
      this.rejections++;
    }
  }
});
Then("every selection is refused and no stream factory is called", function () {
  assert.equal(this.rejections, this.acousticRequests.length);
  assert.equal(this.streamCalls, 0);
});
Then("the compiled native policy independently rejects unsafe selections", () => {
  assert.match(
    command(resolve(root, "build/native/xmp_acoustic_policy_test"), []),
    /protected, external, headphones, wrong role and missing devices rejected/,
  );
});
Given("valid synthetic microphone PCM and malformed WAV variants", function () {
  const valid = monoWav(syntheticAcoustic(), 48000);
  assert.equal(decodeAcousticWav(valid).samples.length, 288000);
  this.invalidWavs = [Buffer.alloc(0), valid.subarray(0, 100)];
  for (const [at, value] of [
    [20, 3],
    [22, 2],
    [24, 1],
    [32, 4],
    [34, 32],
    [40, 2],
  ]) {
    const bytes = Buffer.from(valid);
    bytes.writeUInt32LE(value, at);
    this.invalidWavs.push(bytes);
  }
});
When("the acoustic WAV decoder reads every malformed variant", function () {
  this.wavRejections = 0;
  for (const bytes of this.invalidWavs) {
    assert.throws(() => decodeAcousticWav(bytes));
    this.wavRejections++;
  }
});
Then("every malformed capture is rejected before analysis", function () {
  assert.equal(this.wavRejections, this.invalidWavs.length);
  assert.equal(acousticProfile.captureSeconds, 6);
});

Given("a synthetic native capture report with {string}", function (fault) {
  this.acousticInventory = mockBuiltins();
  this.nativeAcousticReport = {
    ...structuredClone(this.acousticInventory),
    outcome: "captured",
    streamsStopped: true,
    callbackErrors: 0,
    timestampDiscontinuities: 0,
    protectedDeviceOperations: 0,
    inputStreamsStarted: 1,
    outputStreamsStarted: 1,
    inputFrames: 44100 * 6,
  };
  this.nativeAcousticBytes = monoWav(syntheticAcoustic({ rate: 44100 }), 44100);
  if (fault === "permission denied") this.nativeAcousticReport.microphonePermission = "denied";
  if (fault === "changed device") this.nativeAcousticReport.input.id = 999;
  if (fault === "callback error") this.nativeAcousticReport.callbackErrors = 1;
  if (fault === "timestamp gap") this.nativeAcousticReport.timestampDiscontinuities = 1;
  if (fault === "stream not stopped") this.nativeAcousticReport.streamsStopped = false;
  if (fault === "missing WAV") this.nativeAcousticBytes = undefined;
  if (fault === "wrong frame count") this.nativeAcousticReport.inputFrames = 1;
});
When("the acoustic evidence validator checks the report and WAV", async function () {
  const { assessAcousticCapture } = await import("../../tools/lib/acoustic-capture.mjs");
  this.acousticResult = assessAcousticCapture(
    this.acousticInventory,
    this.nativeAcousticReport,
    this.nativeAcousticBytes,
  );
});
