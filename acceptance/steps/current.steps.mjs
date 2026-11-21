import assert from "node:assert/strict";
import { Before, Given, setWorldConstructor, Then, When, World } from "@cucumber/cucumber";
import {
  createDemoProject,
  encodeWav,
  eventsAtStep,
  parseProject,
  stepTime,
  toggleStep,
} from "../../packages/core/src/index.ts";
import { ModuleManifest } from "../../packages/sdk/src/index.ts";
import { openTarget } from "../target-policy.mjs";

class AcceptanceWorld extends World {}
setWorldConstructor(AcceptanceWorld);
Before(function () {
  this.error = undefined;
  this.transportCalls = 0;
});

Given("a current demo project", function () {
  this.project = createDemoProject();
  this.original = JSON.stringify(this.project);
});
When("I serialize and reopen the project", function () {
  this.reopened = parseProject(JSON.stringify(this.project));
});
Then("all project values and embedded sample values match", function () {
  assert.deepEqual(this.reopened, this.project);
});
When("I open it with project version {int}", function (version) {
  try {
    parseProject(JSON.stringify({ ...this.project, version }));
  } catch (error) {
    this.error = error;
  }
});
When("I open a copy referencing an absent sample", function () {
  const copy = structuredClone(this.project);
  copy.pads[0].sampleId = "absent";
  try {
    parseProject(JSON.stringify(copy));
  } catch (error) {
    this.error = error;
  }
});
Then("project validation fails", function () {
  assert.ok(this.error);
});
Then("the original project remains unchanged", function () {
  assert.equal(JSON.stringify(this.project), this.original);
});
When("I enable pad 6 on step 4 of the first clip", function () {
  this.edited = toggleStep(this.project, "drums", "clip-0", 5, 3);
});
Then("that event exists only in the edited project", function () {
  const hasEvent = (project) =>
    project.tracks[0].clips[0].steps.some((event) => event.pad === 5 && event.step === 3);
  assert.equal(hasEvent(this.edited), true);
  assert.equal(hasEvent(this.project), false);
  assert.equal(JSON.stringify(this.project), this.original);
});
When("I calculate 16 steps at 120 BPM with swing 0.5", function () {
  this.nextBar = stepTime(16, 120, 0.5);
  this.secondStep = stepTime(1, 120, 0.5);
});
Then("the next bar starts at exactly 2 seconds", function () {
  assert.equal(this.nextBar, 2);
});
Then("the second step starts at exactly 0.1875 seconds", function () {
  assert.equal(this.secondStep, 0.1875);
});
When("all events in the first clip have probability zero", function () {
  for (const event of this.project.tracks[0].clips[0].steps) event.probability = 0;
});
When("I mute the drum track", function () {
  this.project.tracks[0].muted = true;
});
Then("the first scene emits no events across 64 steps", function () {
  for (let step = 0; step < 64; step++)
    assert.deepEqual(eventsAtStep(this.project, "scene-0", step), []);
});
Given("left audio samples -2 and 0.5 and right audio samples 2 and -0.5", function () {
  this.channels = [new Float32Array([-2, 0.5]), new Float32Array([2, -0.5])];
});
When("I encode a stereo WAV at 48000 Hz", function () {
  this.wav = encodeWav(this.channels, 48000);
});
Then("the WAV has two channels and two frames at 48000 Hz", function () {
  const view = new DataView(this.wav);
  assert.equal(new TextDecoder().decode(this.wav.slice(0, 4)), "RIFF");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 8);
});
Then("the first stereo frame is clamped to -32768 and 32767", function () {
  const view = new DataView(this.wav);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 32767);
});
Given("a valid preview instrument manifest", function () {
  this.manifest = {
    id: "test-instrument",
    name: "Test instrument",
    version: "0.1.0",
    apiVersion: 1,
    kind: "instrument",
    license: "MIT",
    permissions: [],
    parameters: [],
  };
  ModuleManifest.parse(this.manifest);
});
When("I add the permission {string}", function (permission) {
  try {
    ModuleManifest.parse({ ...this.manifest, permissions: [permission] });
  } catch (error) {
    this.error = error;
  }
});
Then("module validation fails before any module execution", function () {
  assert.ok(this.error);
});

Given("a target request for the standalone profile", function () {
  this.request = { profile: "standalone" };
});
Given("a USB lab request naming an Akai Force with a generic allow flag", function () {
  this.request = { profile: "usb-lab", allow: true, device: { model: "Akai Force" } };
});
Given("a USB lab request naming an Akai MPC Live Mk1", function () {
  this.request = { profile: "usb-lab", device: { model: "Akai MPC Live Mk1" } };
});
Given("a standalone request also naming an Akai MPC Live Mk1", function () {
  this.request = { profile: "standalone", device: { model: "Akai MPC Live Mk1" } };
});
When(
  "target preflight and opening are attempted with a counted transport factory",
  async function () {
    try {
      this.target = await openTarget(this.request, () => {
        this.transportCalls++;
        throw new Error("Unexpected physical transport access");
      });
    } catch (error) {
      this.error = error;
    }
  },
);
Then("standalone preflight succeeds", function () {
  assert.equal(this.error, undefined);
  assert.equal(this.target.physicalTransport, false);
});
Then("the transport factory has been called zero times", function () {
  assert.equal(this.transportCalls, 0);
});
Then("preflight rejects the protected Force", function () {
  assert.match(this.error?.message ?? "", /Protected Force/);
});
Then("preflight reports that the USB lab adapter is not implemented", function () {
  assert.match(this.error?.message ?? "", /not implemented/);
});
Then("preflight rejects the mixed standalone and physical request", function () {
  assert.match(this.error?.message ?? "", /cannot select a physical/);
});
