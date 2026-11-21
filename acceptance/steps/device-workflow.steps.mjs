import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { DeviceController, deviceDemo } from "../../apps/studio/src/device/controller.ts";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderPerformance } from "../../packages/core/src/edits.ts";
import { encodeWav } from "../../packages/core/src/index.ts";
import { ContractAudio } from "../../tests/helpers/device-audio.ts";
import { command, root } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

Given("a fresh Device song with a software-only sequencing transport", function () {
  this.panelAudio = new ContractAudio();
  this.panel = new DeviceController(deviceDemo(), this.panelAudio);
  this.panelBefore = this.panel.project;
});
When("I press MAIN", async function () {
  await this.panel.button("main");
});
Then("the Clips home is displayed", function () {
  assert.equal(this.panel.nav.page, "clips");
});
When("I press SHIFT and MENU", async function () {
  await this.panel.button("shift");
  await this.panel.button("menu");
});
Then("the Sample library is displayed without changing the song", function () {
  assert.equal(this.panel.nav.page, "library");
  assert.deepEqual(this.panel.project, this.panelBefore);
});
When("I press SHIFT and MAIN", async function () {
  await this.panel.button("shift");
  await this.panel.button("main");
});
Then("the Play machine page is displayed", function () {
  assert.equal(this.panel.nav.page, "play");
});
When("I press MENU and turn the data dial to Song and press it", async function () {
  await this.panel.button("menu");
  await this.panel.dispatch({ type: "focus", delta: 5 });
  await this.panel.dispatch({ type: "activate" });
});
Then("the Song page is displayed without opening audio", function () {
  assert.equal(this.panel.nav.page, "song");
  assert.equal(this.panelAudio.enabled, 0);
  assert.deepEqual(this.panel.project, this.panelBefore);
});
When("I press SHIFT and MAIN and choose the Pad sampler machine for track 1", async function () {
  await this.panel.button("main", true);
  this.panel.setMachine("xmp.sampler");
});
When("I press SHIFT and MENU and choose a Mac folder containing 40 WAV sounds", async function () {
  await this.panel.button("menu", true);
  this.panelReads = 0;
  const bytes = new Uint8Array(
    encodeWav(
      [
        Float32Array.from(
          { length: 2400 },
          (_, i) => 0.5 * Math.exp(-i / 300) * Math.sin(i * 0.12),
        ),
      ],
      48000,
    ),
  );
  this.panel.library.addFolder(
    Array.from({ length: 40 }, (_, i) => ({
      name: `Library Hit ${i}.wav`,
      size: bytes.length,
      webkitRelativePath: `Library/Drums/Library Hit ${i}.wav`,
      arrayBuffer: async () => {
        this.panelReads++;
        return bytes.buffer;
      },
    })),
  );
});
Then("all 40 folder sounds are searchable without reading their audio", function () {
  this.panel.query = "Library Hit";
  assert.equal(this.panel.samples.length, 40);
  assert.equal(this.panelReads, 0);
});
When("I search for {string} and load it to pad 1", async function (query) {
  this.panel.query = query;
  this.panel.nav.pad = 0;
  assert.equal(this.panel.samples.length, 1);
  await this.panel.assignSample(this.panel.samples[0].id);
});
Then("only the selected WAV is read and pad 1 uses that sound", function () {
  assert.equal(this.panelReads, 1);
  assert.equal(this.panel.track.pads[0].name, "Library Hit 39");
});
When("I press MAIN and select the first track in the fifth scene", async function () {
  await this.panel.button("main");
  this.panel.nav.bank = 1;
  this.panel.select(12);
});
When("I press the data dial to create a clip", async function () {
  assert.equal(this.panel.clip, undefined);
  await this.panel.dispatch({ type: "activate" });
  assert.equal(this.panel.nav.page, "steps");
});
When("I choose pad 1 and enable steps 1, 5, 9 and 13", async function () {
  this.panel.nav.pad = 0;
  for (const step of [0, 4, 8, 12]) this.panel.stepPress(step);
});
When("I press PLAY START", async function () {
  await this.panel.button("play-start");
});
Then("that track plays a one-bar clip containing four hits", function () {
  assert.equal(this.panelAudio.playing, true);
  assert.equal(this.panel.clip.length, 16);
  assert.equal(this.panel.clip.steps.length, 4);
  this.panelAudio.advance(0);
  assert.equal(this.panelAudio.transport.slots.get(this.panel.trackId).clipId, this.panel.clip.id);
});
When("I press STOP", async function () {
  await this.panel.button("stop");
});
Then("playback stops and the queued launches are cleared", function () {
  assert.equal(this.panelAudio.playing, false);
  assert.equal(this.panelAudio.transport.queuedClips.size, 0);
});
When("I choose a synth machine on track 2 and program a pitched loop", async function () {
  this.panel.select(13);
  await this.panel.button("main", true);
  this.panel.setMachine("xmp.subtractive");
  this.panel.nav.pad = 3;
  this.panel.createClip();
  await this.panel.pad(12);
  this.panelCopyBefore = this.panel.project;
});
When("I press COPY and choose the second scene for that track", async function () {
  await this.panel.button("copy");
  await this.panel.pad(9);
});
Then("the copy is applied immediately as one undoable edit", function () {
  assert.notDeepEqual(this.panel.project, this.panelCopyBefore);
  assert.equal(this.panel.pending, undefined);
});
Then(
  "the copied notes retain their pitch and the destination machine remains the synth",
  function () {
    assert.equal(this.panel.track.machine.id, "xmp.subtractive");
    assert.equal(this.panel.clip.steps[0].note, 53);
  },
);
When("I press UNDO", async function () {
  await this.panel.button("undo");
});
Then("the destination scene is restored", function () {
  assert.deepEqual(this.panel.project, this.panelCopyBefore);
});
When("I press PLAY START and advance the software clock to step 3", async function () {
  await this.panel.button("play-start");
  this.panelAudio.advance(3);
  this.panelTrack2 = this.panel.project.tracks[1].id;
  this.panelAnchor = this.panelAudio.transport.slots.get(this.panelTrack2).anchor;
});
When("I launch the first track's clip in scene 2", async function () {
  await this.panel.pad(8);
});
Then("the old clip plays until the next bar", function () {
  this.panelAudio.advance(15);
  assert.equal(
    this.panelAudio.transport.slots.get(this.panel.trackId).clipId,
    this.panel.project.scenes[0].clips[this.panel.trackId],
  );
});
Then("the new clip begins at the bar without restarting track 2", function () {
  this.panelAudio.advance(16);
  assert.equal(
    this.panelAudio.transport.slots.get(this.panel.trackId).clipId,
    this.panel.project.scenes[1].clips[this.panel.trackId],
  );
  assert.equal(this.panelAudio.transport.slots.get(this.panelTrack2).anchor, this.panelAnchor);
});
When("I launch an empty slot for track 2", async function () {
  await this.panel.pad(9);
});
Then("track 2 stops at the next bar while track 1 continues", function () {
  this.panelAudio.advance(31);
  assert.ok(this.panelAudio.transport.slots.get(this.panelTrack2).clipId);
  this.panelAudio.advance(32);
  assert.equal(this.panelAudio.transport.slots.get(this.panelTrack2).clipId, undefined);
  assert.ok(this.panelAudio.transport.slots.get(this.panel.project.tracks[0].id).clipId);
});
When("I add scene 1, scene 2 and scene 1 again to the Song chain", async function () {
  await this.panel.dispatch({ type: "navigate", page: "song" });
  for (const index of [0, 1, 0]) {
    this.panel.sceneId = this.panel.project.scenes[index].id;
    await this.panel.dispatch({ type: "activate" });
  }
  assert.equal(new Set(this.panel.project.performance.chain.map((p) => p.id)).size, 3);
});
When("I press PLAY START on the Song page", async function () {
  await this.panel.button("play-start");
});
Then("the occurrences play in that order and stop at the end", function () {
  const order = [];
  for (const step of [0, 16, 32]) {
    this.panelAudio.advance(step);
    order.push(this.panelAudio.transport.sceneId);
  }
  assert.deepEqual(order, ["scene-0", "scene-1", "scene-0"]);
  this.panelAudio.advance(48);
  assert.equal(this.panelAudio.transport.running, false);
});
Then("a portable save and reopen retains the clips, machines and song order", async function () {
  assert.deepEqual(
    await importPortable(await exportPortable(this.panel.project)),
    this.panel.project,
  );
});
Then("the song renders finite nonzero stereo audio without opening hardware", function () {
  const {
    wav: bytes,
    pcm,
    rightPcm,
  } = renderPerformance(this.panel.project, {
    mode: "song",
    steps: 48,
    tailSeconds: 0.05,
  });
  assert.ok(pcm.every(Number.isFinite) && rightPcm.every(Number.isFinite));
  const view = new DataView(bytes);
  assert.equal(view.getUint16(22, true), 2);
  let peak = 0;
  for (let i = 44; i < bytes.byteLength; i += 2)
    peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  assert.ok(peak > 0);
  assert.equal(this.deviceOperations.length, 0);
});
const run = (...files) =>
  command(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...files], root);
When("the browser panel and default-entry contracts are exercised", function () {
  this.panelContracts = run("tests/device-native-sampler.test.ts", "tests/device-workflow.test.ts");
});
Then(
  "Device view opens by default with 22 front buttons and pad 1 at the bottom left",
  function () {
    assert.match(this.panelContracts, /Test Files\s+2 passed \(2\)/);
  },
);
When("the asynchronous loading and transport cancellation contracts are exercised", function () {
  this.panelContracts = command(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/device-workflow.test.ts",
      "-t",
      "rejects stale|STOP cancels",
    ],
    root,
  );
});
Then("canceled work cannot alter the project or start late audio", function () {
  assert.match(this.panelContracts, /2 passed/);
});
When("machine metadata, clip copying and recording contracts are exercised", function () {
  this.panelContracts = command(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/device-workflow.test.ts",
      "-t",
      "uses machine metadata|creates and copies|STOP cancels",
    ],
    root,
  );
});
Then("per-track machine state, notes and Undo remain consistent", function () {
  assert.match(this.panelContracts, /3 passed/);
});
