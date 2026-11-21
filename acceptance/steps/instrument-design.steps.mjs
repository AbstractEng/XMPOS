import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Given, Then, When } from "@cucumber/cucumber";
import { loadCore, renderProjectScene } from "../../packages/core/src/edits.ts";
import { swingFromPercent, swingLabel, TRIPLET_SWING } from "../../packages/core/src/groove.ts";
import {
  createDemoProject,
  createLegacyDemoProject,
  parseProject,
  stepTime,
} from "../../packages/core/src/index.ts";
import { ProjectSession } from "../../packages/core/src/session.ts";
import { firstNonzero } from "../lib/fixtures.mjs";
import { command } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

Given("a single odd-sixteenth impulse at 120 BPM", function () {
  this.groove = createDemoProject();
  this.groove.bpm = 120;
  this.groove.samples = [{ ...this.groove.samples[0], sampleRate: 48000, pcm: [1, 0] }];
  for (const pad of this.groove.pads) pad.sampleId = this.groove.samples[0].id;
  this.groove.tracks[0].clips[0].steps = [{ pad: 0, step: 1, velocity: 0.7, probability: 1 }];
  this.grooveNotes = JSON.stringify(this.groove.tracks);
});
When("the musician selects musical swing {int} percent", function (percent) {
  this.groove.swing = swingFromPercent(percent);
});
When("the musician selects the exact triplet swing preset", function () {
  this.groove.swing = TRIPLET_SWING;
});
Then("its exported onset is frame {int} at 48000 Hz", function (frame) {
  const wav = Buffer.from(renderProjectScene(this.groove, "scene-0"));
  assert.equal(firstNonzero(wav), frame);
  assert.equal(wav.readUInt32LE(40) / 4, 96000);
  // One impulse, not merely an event in a plan: no other nonzero frame is permitted.
  let nonzero = 0;
  for (let at = 44; at < wav.length; at += 4) if (wav.readInt16LE(at)) nonzero++;
  assert.equal(nonzero, 1);
  this.artifacts.push({
    kind: "log",
    data: [{ frame, sampleRate: 48000, nonzeroFrames: nonzero }],
  });
});
Then("the next bar remains at frame 96000 without changing velocities", function () {
  assert.equal(stepTime(16, this.groove.bpm, this.groove.swing) * 48000, 96000);
  assert.equal(JSON.stringify(this.groove.tracks), this.grooveNotes);
});
Then("the swing label is {string}", function (label) {
  assert.equal(swingLabel(this.groove.swing), label);
});
Given("a version-1 project with stored swing delay 0.5", function () {
  this.legacySwing = { ...createLegacyDemoProject(), swing: 0.5, bpm: 120 };
});
When("the musician reopens it with the musical swing display", function () {
  this.groove = parseProject(JSON.stringify(this.legacySwing));
});
Then("the stored swing remains 0.5 and its label is {string}", function (label) {
  assert.equal(this.groove.swing, 0.5);
  assert.equal(swingLabel(this.groove.swing), label);
  assert.deepEqual(this.groove.tracks, this.legacySwing.tracks);
});
Then("its odd sixteenth still starts at 0.1875 seconds at 120 BPM", function () {
  assert.equal(stepTime(1, this.groove.bpm, this.groove.swing), 0.1875);
});
When("musical swing values below 50, above 75 or non-finite are submitted", function () {
  this.grooveSession = new ProjectSession(this.groove, true);
  this.grooveOriginal = JSON.stringify(this.grooveSession.project);
  for (const percent of [49.9, 75.1, NaN, Infinity, -Infinity])
    assert.throws(() =>
      this.grooveSession.edit((project) => ({ ...project, swing: swingFromPercent(percent) })),
    );
});
Then("all changes are rejected and the original project is intact", function () {
  assert.equal(JSON.stringify(this.grooveSession.project), this.grooveOriginal);
  assert.equal(this.grooveSession.canUndo, false);
  assert.equal(this.grooveSession.dirty, false);
});

Given("the Studio runs in an isolated DOM with mocked audio and storage", function () {
  this.uiReport = this.workspace.path("studio-dom.json");
});
function uiFlow(world, name) {
  command(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/instrument-design.test.ts",
    "--testNamePattern",
    name,
    "--reporter=json",
    "--outputFile",
    world.uiReport,
  ]);
  const report = JSON.parse(readFileSync(world.uiReport, "utf8"));
  const assertions = report.testResults
    .flatMap((suite) => suite.assertionResults)
    .filter((result) => result.status !== "skipped" && result.status !== "pending");
  assert.equal(assertions.length, 1, "The intended real UI test must execute exactly once");
  assert.equal(assertions[0].status, "passed");
  assert.equal(assertions[0].title, name);
  world.uiVerified = true;
  world.contributorReports = [["studio-dom.json", world.uiReport]];
}
When("the musician edits a pattern, queues a scene and requests swing help with F1", function () {
  uiFlow(this, "opens contextual help and restores focus without changing music or transport");
});
When("the musician opens help on a button and that control is replaced by a redraw", function () {
  uiFlow(this, "keeps Help available on buttons and falls back safely after a control is replaced");
});
When("the musician selects Triplet, undoes it and sets 62 percent on the slider", function () {
  uiFlow(this, "uses musical swing labels and an exact triplet without changing existing notes");
});
Then("Escape restores focus and music, undo, scene and transport state are unchanged", function () {
  assert.equal(this.uiVerified, true);
});
Then("help uses the focused topic and returns to a valid focus target", function () {
  assert.equal(this.uiVerified, true);
});
Then("the labels and stored delays agree while all existing notes remain unchanged", function () {
  assert.equal(this.uiVerified, true);
});
Then("no audio device or physical transport was opened", function () {
  assert.equal(this.uiVerified, true);
  assert.deepEqual(this.deviceOperations, []);
});
