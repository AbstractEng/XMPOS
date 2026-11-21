import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AfterAll, Given, Then, When } from "@cucumber/cucumber";
import { resizeClip } from "../../packages/core/src/edits.ts";
import { ProjectSchema } from "../../packages/core/src/index.ts";
import { machines } from "../../packages/core/src/machines.ts";
import { ensureFonts } from "../../tools/fonts.mjs";
import { command, root } from "../lib/workspace.mjs";

const firstTrack = (p) => p.tracks[0];
const slotClip = (p, scene) =>
  firstTrack(p).clips.find((c) => c.id === p.scenes[scene].clips[firstTrack(p).id]);
const hasHit = (clip, pad, step) =>
  clip.steps.some((hit) => hit.pad === pad - 1 && hit.step === step);
function drumFixture(p) {
  const track = firstTrack(p);
  track.clips[0].length = 16;
  track.clips[0].steps = [0, 4, 8, 12].map((step) => ({
    step,
    pad: 0,
    velocity: 0.8,
    probability: 1,
  }));
  track.clips[1].length = 16;
  track.clips[1].steps = [{ step: 2, pad: 1, velocity: 0.6, probability: 1 }];
  p.scenes[0].clips[track.id] = track.clips[0].id;
  p.scenes[1].clips[track.id] = track.clips[1].id;
  return p;
}
function remember(world) {
  world.controlBefore = structuredClone(world.panel.project);
  world.controlDepth = world.panel.session.historyDepth;
}
When("I press the 16 LEVEL button", async function () {
  await this.panel.button("16-level");
});
Then(
  "the selected clip is open in Steps with the project unchanged and audio unopened",
  function () {
    assert.equal(this.panel.nav.page, "steps");
    assert.deepEqual(this.panel.project, this.panelBefore);
    assert.equal(this.panelAudio.enabled, 0);
  },
);
Given("an existing drum pattern and a different variation", function () {
  this.panel.edit(drumFixture);
});
Given("the variation is 32 steps long", function () {
  this.panel.edit((p) => resizeClip(p, firstTrack(p).id, slotClip(p, 1).id, 32));
});
When("I start the pattern and queue the variation before its launch bar", async function () {
  await this.panel.button("play-start");
  this.panelAudio.advance(3);
  await this.panel.pad(8);
  remember(this);
});
When("I engage live OVER DUB", async function () {
  if (!this.controlBefore) remember(this);
  await this.panel.button("overdub");
  assert.equal(this.panel.record, true, "OVER DUB must start while playback continues");
  assert.equal(this.panel.overdub, true);
});
When("I play pad {int} at software transport step {int}", async function (pad, step) {
  this.panelAudio.advance(step);
  await this.panel.pad(pad - 1);
});
When("I finish the pass with {string}", async function (button) {
  assert.ok(["REC", "OVER DUB"].includes(button));
  await this.panel.button(button === "REC" ? "rec" : "overdub");
  assert.equal(this.panel.record, false);
});
Then("only the audible pattern contains the new pad 8 hit at clip offset 5", function () {
  assert.ok(hasHit(slotClip(this.panel.project, 0), 8, 5));
  assert.deepEqual(slotClip(this.panel.project, 1), slotClip(this.controlBefore, 1));
  assert.equal(
    slotClip(this.panel.project, 0).steps.length,
    slotClip(this.controlBefore, 0).steps.length + 1,
  );
});
Then("the transport has not stopped or restarted", function () {
  assert.equal(this.panelAudio.playing, true);
  assert.equal(this.panelAudio.starts, 1);
});
Then("one UNDO restores the previous project and REDO restores the change", async function () {
  const after = structuredClone(this.panel.project);
  assert.equal(this.panel.session.historyDepth, this.controlDepth + 1);
  await this.panel.button("undo");
  assert.deepEqual(this.panel.project, this.controlBefore);
  await this.panel.button("undo", true);
  assert.deepEqual(this.panel.project, after);
});
When("I launch the variation at software transport step 16", async function () {
  await this.panel.button("play-start");
  this.panelAudio.advance(3);
  await this.panel.pad(8);
  this.panelAudio.advance(16);
});
Then("the variation contains the pad 7 hit at clip offset 2 and not offset 18", function () {
  const clip = slotClip(this.panel.project, 1);
  assert.ok(hasHit(clip, 7, 2));
  assert.ok(!hasHit(clip, 7, 18));
});
When("I stop and arm REC and restart from the beginning", async function () {
  await this.panel.button("stop");
  await this.panel.button("rec");
  await this.panel.button("play-start");
});
When("I play the pattern and record its occupied kick twice and a new pad hit", async function () {
  await this.panel.button("play-start");
  remember(this);
  await this.panel.button("overdub");
  this.panelAudio.advance(0);
  await this.panel.pad(0);
  await this.panel.pad(0);
  this.panelAudio.advance(1);
  await this.panel.pad(6);
  await this.panel.button("stop");
});
Then("the kick cell still contains exactly one hit and the new hit is retained", function () {
  const clip = slotClip(this.panel.project, 0);
  assert.equal(clip.steps.filter((hit) => hit.step === 0 && hit.pad === 0).length, 1);
  assert.ok(hasHit(clip, 7, 1));
  assert.equal(clip.steps.length, slotClip(this.controlBefore, 0).steps.length + 1);
});
When("I overdub a hit and the queued variation launches during the pass", async function () {
  await this.panel.button("play-start");
  remember(this);
  await this.panel.button("overdub");
  this.panelAudio.advance(2);
  await this.panel.pad(6);
  this.panelAudio.queueClip(this.panel.trackId, slotClip(this.panel.project, 1).id);
  this.panelAudio.advance(16);
  await this.panel.pad(7);
});
Then("the old pattern keeps its captured hit and the new clip remains unchanged", function () {
  assert.ok(hasHit(slotClip(this.panel.project, 0), 7, 2));
  assert.deepEqual(slotClip(this.panel.project, 1), slotClip(this.controlBefore, 1));
  assert.ok(!hasHit(slotClip(this.panel.project, 0), 8, 0));
});
Then("the recording pass is finished while playback continues", function () {
  assert.equal(this.panel.record, false);
  assert.equal(this.panelAudio.playing, true);
});
Given("two scenes reference the same variation clip", function () {
  this.panel.edit((p) => {
    p.scenes[2].clips[firstTrack(p).id] = slotClip(p, 1).id;
    return p;
  });
});
When("I copy the pattern into the first variation slot and confirm", async function () {
  remember(this);
  await this.panel.button("copy");
  await this.panel.pad(8);
  this.panel.confirm();
});
Then(
  "the destination has an independent copy and the other scene keeps its original variation",
  function () {
    const p = this.panel.project,
      copy = slotClip(p, 1);
    assert.notEqual(copy.id, slotClip(this.controlBefore, 1).id);
    assert.notEqual(copy.id, slotClip(this.controlBefore, 0).id);
    assert.deepEqual(copy.steps, slotClip(this.controlBefore, 0).steps);
    assert.deepEqual(slotClip(p, 2), slotClip(this.controlBefore, 2));
  },
);
Then("the source clip and destination instrument are unchanged", function () {
  assert.deepEqual(slotClip(this.panel.project, 0), slotClip(this.controlBefore, 0));
  assert.deepEqual(firstTrack(this.panel.project).machine, firstTrack(this.controlBefore).machine);
});
function fillTrack(p) {
  const track = firstTrack(p);
  while (track.clips.length < 16)
    track.clips.push({ id: `capacity-${track.clips.length}`, name: "Keep", length: 16, steps: [] });
  return p;
}
Given("the drum track already contains sixteen clips", function () {
  this.panel.edit(fillTrack);
});
When("I try to copy the pattern into the variation slot", async function () {
  remember(this);
  await this.panel.button("copy");
  await this.panel.pad(8);
  this.copyError = undefined;
  try {
    this.panel.confirm();
  } catch (error) {
    this.copyError = error;
  }
});
Then("the copy is refused with the project and undo history unchanged", function () {
  assert.match(this.panel.message, /sixteen clips/);
  assert.deepEqual(this.panel.project, this.controlBefore);
  assert.equal(this.panel.session.historyDepth, this.controlDepth);
});

// Compile a memory-only CLI against the production native Ui and edit functions.
// Its only I/O is bounded JSON on stdin/stdout; it has no hardware adapter.
let nativeDirectory, nativeBinary;
AfterAll(() => {
  if (nativeDirectory) rmSync(nativeDirectory, { recursive: true, force: true });
});
async function nativeRun(world) {
  if (!nativeBinary) {
    await ensureFonts();
    nativeDirectory = mkdtempSync(join(tmpdir(), "xmp-native-controls-"));
    nativeBinary = join(nativeDirectory, "controls");
    command("c++", [
      "-std=c++17",
      "-O1",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${join(root, "native/include")}`,
      `-I${join(root, "build/fonts")}`,
      join(root, "acceptance/native/live-controls.cpp"),
      "-o",
      nativeBinary,
    ]);
  }
  const result = spawnSync(nativeBinary, [], {
    input: JSON.stringify({ project: world.nativeProject, events: world.nativeEvents }),
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  world.native = JSON.parse(result.stdout);
  return world.native;
}
const button = (name, down = true) => ({ type: "button", name, down });
const shiftedMenu = [
  button("shift"),
  button("menu"),
  button("shift", false),
  button("menu", false),
];
async function nativeEvents(world, events) {
  world.nativeEvents.push(...events);
  return nativeRun(world);
}
Given("the native Live controls are running in a memory-only host", async function () {
  const p = drumFixture(structuredClone(this.panel.project));
  for (const sample of p.samples) sample.pcm = [0, 0.5, -0.25, 0];
  p.samples[1].sampleRate = 24000; // Four source frames must preview as eight at 48 kHz.
  p.tracks[0].machine = machines.instantiate("xmp.sampler");
  p.tracks[1].machine = machines.instantiate("xmp.subtractive");
  p.scenes[2].clips[firstTrack(p).id] = slotClip(p, 1).id;
  this.nativeProject = ProjectSchema.parse(p);
  this.nativeEvents = [];
  await nativeRun(this);
  this.nativeBefore = structuredClone(this.native.project);
});
Given("two native scenes reference the same variation clip", function () {
  assert.equal(
    this.nativeBefore.scenes[1].clips[firstTrack(this.nativeBefore).id],
    this.nativeBefore.scenes[2].clips[firstTrack(this.nativeBefore).id],
  );
});
Given("the native kit track shares its pads with another track", function () {
  assert.equal(firstTrack(this.nativeBefore).pads, undefined);
  assert.ok(
    this.nativeBefore.tracks
      .slice(1)
      .some((t) => !t.pads && (!t.machine || t.machine.id === "xmp.sampler")),
  );
});
Given("the second native project sound has four frames at 24 kHz", function () {
  assert.equal(this.nativeBefore.samples[1].pcm.length, 4);
  assert.equal(this.nativeBefore.samples[1].sampleRate, 24000);
});
When("I copy the focused native clip using {string}", async function (gesture) {
  assert.ok(["COPY then target", "hold COPY and pads"].includes(gesture));
  const events =
    gesture === "COPY then target"
      ? [button("copy"), button("copy", false), { type: "pad", pad: 8 }]
      : [button("copy"), { type: "pad", pad: 12 }, { type: "pad", pad: 8 }, button("copy", false)];
  await nativeEvents(this, events);
});
Then(
  "the native destination is independent and the reused clip and instrument stay unchanged",
  function () {
    const p = this.native.project,
      before = this.nativeBefore;
    assert.equal(this.native.errors.length, 0);
    assert.notEqual(slotClip(p, 1).id, slotClip(before, 0).id);
    assert.notEqual(slotClip(p, 1).id, slotClip(before, 1).id);
    assert.deepEqual(slotClip(p, 1).steps, slotClip(before, 0).steps);
    assert.deepEqual(slotClip(p, 0), slotClip(before, 0));
    assert.deepEqual(slotClip(p, 2), slotClip(before, 2));
    assert.deepEqual(firstTrack(p).machine, firstTrack(before).machine);
  },
);
Then("native copying has not requested transport playback", function () {
  assert.equal(this.native.transportRequests, 0);
  assert.equal(this.native.noteRequests, 0);
});
Then(
  /^native UNDO and REDO restore the complete projects before and after (?:the copy|the sound load)$/,
  async function () {
    const after = structuredClone(this.native.project);
    await nativeEvents(this, [button("undo")]);
    assert.deepEqual(this.native.project, this.nativeBefore);
    assert.equal(this.native.canUndo, false, "one change must need exactly one undo");
    await nativeEvents(this, [button("shift"), button("undo"), button("shift", false)]);
    assert.deepEqual(this.native.project, after);
  },
);
Given("the native track already contains sixteen clips", async function () {
  this.nativeProject = fillTrack(structuredClone(this.nativeProject));
  await nativeRun(this);
  this.nativeBefore = structuredClone(this.native.project);
});
Then("native copying is refused with the project and undo history unchanged", function () {
  assert.match(this.native.errors.join(" "), /sixteen clips/);
  assert.deepEqual(this.native.project, this.nativeBefore);
  assert.equal(this.native.canUndo, false);
});
When("I unlink the native variation slot with SHIFT and COPY", async function () {
  await nativeEvents(this, [
    { type: "wheel", delta: 1 },
    button("shift"),
    button("copy"),
    button("copy", false),
    button("shift", false),
  ]);
});
Then("only that scene slot is removed and the reusable clip data is retained", function () {
  const p = this.native.project;
  assert.equal(p.scenes[1].clips[firstTrack(p).id], undefined);
  assert.deepEqual(firstTrack(p).clips, firstTrack(this.nativeBefore).clips);
  assert.deepEqual(slotClip(p, 2), slotClip(this.nativeBefore, 2));
  assert.equal(this.native.transportRequests, 0);
  assert.equal(this.native.noteRequests, 0);
});
Then("native UNDO restores the complete original project", async function () {
  await nativeEvents(this, [button("undo")]);
  assert.deepEqual(this.native.project, this.nativeBefore);
  assert.equal(this.native.canUndo, false);
});
When("I open native Steps then press SHIFT and MENU and release SHIFT first", async function () {
  await nativeEvents(this, [button("16-level"), ...shiftedMenu]);
});
Then("native Browse is displayed with its own sample and target-pad knob labels", function () {
  assert.equal(this.native.view, "BROWSE");
  assert.deepEqual(this.native.knobNames.slice(0, 2), ["Sample", "Target pad"]);
  assert.deepEqual(this.native.project, this.nativeBefore);
});
When("I select the second project sound and pad 4 and press SHIFT and PLAY", async function () {
  await nativeEvents(this, [
    { type: "wheel", delta: 1 },
    { type: "pad", pad: 3 },
    button("shift"),
    button("play"),
    button("shift", false),
  ]);
});
Then(
  "the selected sound is previewed without changing the project or requesting transport playback",
  function () {
    assert.equal(this.native.previewFrames, 8);
    assert.equal(this.native.previewSampleId, this.nativeBefore.samples[1].id);
    assert.equal(this.native.transportRequests, 0);
    assert.equal(this.native.noteRequests, 0);
    assert.deepEqual(this.native.project, this.nativeBefore);
  },
);
When("I press the native data wheel to load the sound", async function () {
  await nativeEvents(this, [button("wheel")]);
});
Then("only the target track gets its own kit with that sound on pad 4", function () {
  const p = this.native.project,
    before = this.nativeBefore;
  assert.equal(this.native.errors.length, 0);
  assert.equal(firstTrack(p).pads[3].sampleId, before.samples[1].id);
  assert.deepEqual(p.pads, before.pads);
  assert.deepEqual(p.samples, before.samples);
  assert.deepEqual(p.tracks.slice(1), before.tracks.slice(1));
});
When("I close native Browse with SHIFT and MENU", async function () {
  await nativeEvents(this, shiftedMenu);
});
Then("native Steps is displayed again", function () {
  assert.equal(this.native.view, "STEPS");
});
When("I browse a sound and try to load it onto the native synth track", async function () {
  await nativeEvents(this, [button("bank-b"), ...shiftedMenu, button("wheel")]);
});
Then("native sample loading is refused with the project and undo history unchanged", function () {
  assert.match(this.native.errors.join(" "), /kit track/);
  assert.deepEqual(this.native.project, this.nativeBefore);
  assert.equal(this.native.canUndo, false);
});
