import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { exportSong } from "../../packages/core/src/assets.ts";
import { trackPads } from "../../packages/core/src/pads.ts";
import {
  bounce,
  clipAt,
  editSlot,
  library,
  navigate,
  newContext,
  openHardwareDevice,
  press,
  projectDownload,
  selectTrack,
  setMachine,
  steps,
} from "./production.steps.mjs";

async function trackPage(page, index) {
  await selectTrack(page, index);
}
async function synthRoute(world) {
  await trackPage(world.page, 1);
  await setMachine(world.page, "xmp.subtractive");
  await selectTrack(world.page, 0);
  await setMachine(world.page, "xmp.midi");
  const options = await world.page
    .locator("#device-midi-destination option")
    .evaluateAll((items) => items.map((item) => item.value));
  world.synthId = options[1]; // first eligible destination is track 2
  await world.page.locator("#device-midi-destination").selectOption(world.synthId);
  await editSlot(world.page, 12);
  await steps(world.page, 0, [1, 9]);
  await steps(world.page, 7, [5, 13]);
}
async function playCapture(world, audible, requireMidi = audible) {
  await world.page.evaluate(() => {
    globalThis.__xmpAudio.peak = 0;
    globalThis.__xmpAudio.midi = [];
  });
  await press(world.page, "play-start");
  await expect(world.page.locator("#device-audio-state")).toContainText("PLAY");
  await expect(world.page.locator("#device-clock")).not.toHaveText("01 : 01");
  if (audible)
    await expect
      .poll(() => world.page.evaluate(() => globalThis.__xmpAudio.peak))
      .toBeGreaterThan(0.001);
  await press(world.page, "stop");
  await expect.poll(() => world.page.evaluate(() => globalThis.__xmpAudio.latest)).toBe(0);
  // Silence is immediate for an event-only track. Port messages arrive on a
  // separate task queue, so wait for delivery before checking note ownership.
  if (requireMidi)
    await expect
      .poll(() =>
        world.page.evaluate(() => globalThis.__xmpAudio.midi.some((event) => event.kind === "on")),
      )
      .toBe(true);
  await expect
    .poll(
      () =>
        world.page.evaluate(() => {
          const active = new Set();
          for (const event of globalThis.__xmpAudio.midi) {
            if (event.kind === "on") active.add(event.id);
            else active.delete(event.id);
          }
          return active.size;
        }),
      { message: "STOP must deliver every paired MIDI note-off" },
    )
    .toBe(0);
  const observed = await world.page.evaluate(() => globalThis.__xmpAudio);
  if (!audible) assert.equal(observed.peak, 0);
  const active = new Set();
  for (const event of observed.midi) {
    if (event.kind === "on") active.add(event.id);
    else active.delete(event.id);
  }
  assert.equal(active.size, 0, "STOP must pair every observed MIDI note-on");
  return observed;
}
When("I create a MIDI clip routed to a built-in synth track", async function () {
  await synthRoute(this);
});
Then("the routed clip produces real worklet audio and a non-silent scene WAV", async function () {
  await playCapture(this, true);
  assert.ok((await bounce(this)).peak > 0.001);
});
Then("its portable project retains the MIDI notes and destination", async function () {
  this.routed = (await projectDownload(this)).project;
  const source = this.routed.tracks[0];
  assert.equal(source.machine.id, "xmp.midi");
  assert.equal(source.machine.state.destination, this.synthId);
  assert.deepEqual(
    clipAt(this.routed).steps.map((hit) => hit.note),
    [48, 48, 55, 55],
  );
  assert.equal(clipAt(this.routed, 1).steps.length, 0);
});
When("I clear the MIDI destination", async function () {
  await trackPage(this.page, 0);
  await this.page.locator("#device-midi-destination").selectOption("");
});
Then("the same clip produces paired MIDI events and silent audio", async function () {
  const observed = await playCapture(this, false, true);
  assert.ok(observed.midi.some((e) => e.kind === "on"));
  assert.equal((await bounce(this)).peak, 0);
});
When("I load original drum samples and route a MIDI drum clip to the sampler", async function () {
  await library(this);
  // Preserve track 1's imported kit; track 2 sends the MIDI notes.
  await trackPage(this.page, 1);
  await setMachine(this.page, "xmp.midi");
  this.samplerId = await this.page
    .locator("#device-midi-destination option")
    .nth(1)
    .getAttribute("value");
  await this.page.locator("#device-midi-destination").selectOption(this.samplerId);
  await editSlot(this.page, 13);
  await steps(this.page, 0, [1, 5, 9, 13]);
  await steps(this.page, 1, [5, 13]);
  await steps(this.page, 2, [3, 7, 11, 15]);
});
Then("the selected clip pads sound through the real worklet and exported WAV", async function () {
  await playCapture(this, true);
  const project = (await projectDownload(this)).project;
  assert.equal(clipAt(project, 1).steps.length, 10);
  assert.equal(clipAt(project).steps.length, 0);
  assert.deepEqual(
    trackPads(project, project.tracks[0].id)
      .slice(0, 3)
      .map((pad) => pad.name),
    ["Kick", "Snare", "Hat"],
  );
  assert.ok((await bounce(this)).peak > 0.001);
});
When("I mute the sampler destination", async function () {
  await navigate(this.page, "Track mutes");
  await this.page.locator(`[data-mute="${this.samplerId}"]`).click();
});
Then("the MIDI clip is silent until I unmute that destination", async function () {
  await playCapture(this, false);
  assert.equal((await bounce(this)).peak, 0);
  await navigate(this.page, "Track mutes");
  await this.page.locator(`[data-mute="${this.samplerId}"]`).click();
  await playCapture(this, true);
  assert.ok((await bounce(this)).peak > 0.001);
});
When("I autosave the routed project and reopen it in another empty browser", async function () {
  await expect(this.page.locator("#device-save-state")).toHaveText("Saved on this browser");
  this.routed = (await projectDownload(this)).project;
  await this.page.reload();
  assert.deepEqual((await projectDownload(this)).project, this.routed);
  const { text } = await projectDownload(this);
  this.page = await newContext(this);
  await openHardwareDevice(this.page);
  await navigate(this.page, "Project");
  await this.page.locator("#device-project-file").setInputFiles({
    name: "routed.xmp.json",
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
  await expect(this.page.getByRole("status")).toContainText("Project opened");
});
Then("the same destination, notes and sound are restored", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.routed);
  await playCapture(this, true);
});
When("I change the MIDI destination and undo that edit", async function () {
  this.beforeReroute = (await projectDownload(this)).project;
  await trackPage(this.page, 0);
  await this.page.locator("#device-midi-destination").selectOption("");
  await playCapture(this, false, true);
  await press(this.page, "undo");
});
Then("the original routed synth sound is restored", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.beforeReroute);
  await playCapture(this, true);
});
Then("MIDI destinations offer only other built-in audio instrument tracks", async function () {
  await trackPage(this.page, 0);
  const ids = await this.page
    .locator("#device-midi-destination option")
    .evaluateAll((options) => options.map((o) => o.value));
  const { project } = await projectDownload(this);
  assert.ok(!ids.includes(project.tracks[0].id));
  assert.equal(ids.length, 8); // none + seven built-in audio tracks
});
async function invalidDestination(world, destination) {
  const { project } = await projectDownload(world);
  project.tracks[0].machine.state.destination =
    destination === "self" ? project.tracks[0].id : "missing-instrument";
  await world.page.locator("#device-project-file").setInputFiles({
    name: "unavailable.xmp.json",
    mimeType: "application/json",
    buffer: Buffer.from(await exportSong(project)),
  });
  await expect(world.page.getByRole("status")).toContainText("Project opened");
}
When("I open a project whose saved MIDI destination is unavailable", async function () {
  await invalidDestination(this, "missing");
});
When("I open a project with a self-referencing MIDI destination", async function () {
  await invalidDestination(this, "self");
});
Then("the route is shown as unavailable and the clip is silent", async function () {
  await trackPage(this.page, 0);
  await expect(this.page.locator("#device-midi-destination option:checked")).toContainText(
    "Unavailable",
  );
  await playCapture(this, false);
  assert.equal((await bounce(this)).peak, 0);
  assert.ok((await projectDownload(this)).project.tracks[0].machine.state.destination);
});
When("I select a valid synth destination again", async function () {
  await trackPage(this.page, 0);
  await this.page.locator("#device-midi-destination").selectOption(this.synthId);
});
