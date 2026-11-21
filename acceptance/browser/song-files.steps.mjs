import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { exportPortable, exportSong, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderProjectScene } from "../../packages/core/src/edits.ts";
import { songFixture } from "../lib/portable-song-fixture.mjs";
import { isolatedBrowserPage, navigateDevicePage } from "./production.steps.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const origin = process.env.XMP_E2E_ORIGIN;
async function projectPage(page) {
  await navigateDevicePage(page, "Project");
}
async function openDevice(_world, page, path) {
  await projectPage(page);
  await page.locator("#device-project-file").setInputFiles(path);
}
async function save(world, page, pack = true, advanced = false) {
  if (!advanced) await projectPage(page);
  await page
    .getByRole("checkbox", { name: "Package samples with song", exact: true })
    .setChecked(pack);
  const pending = page.waitForEvent("download");
  await page.locator(advanced ? "#save" : '[data-action="save"]').click();
  const download = await pending;
  assert.ok(download.suggestedFilename().endsWith(".xmpsong"));
  world.downloadCount = (world.downloadCount ?? 0) + 1;
  const path = join(world.directory, `song-${world.downloadCount}.xmpsong`);
  await download.saveAs(path);
  return { path, text: await readFile(path, "utf8") };
}
async function fresh(world, advanced = false) {
  const page = await isolatedBrowserPage(world);
  await page.goto(`${origin}/${advanced ? "?view=studio" : ""}`);
  return page;
}
async function sameSong(world, page, advanced = false) {
  const exported = await save(world, page, true, advanced),
    project = await importPortable(exported.text);
  assert.deepEqual(project, world.song);
  assert.deepEqual(
    Buffer.from(renderProjectScene(project, "scene-0")),
    Buffer.from(renderProjectScene(world.song, "scene-0")),
  );
  return exported;
}
Given(
  "a song with clips, MIDI routing and an unavailable custom machine is open in Device view",
  async function () {
    const fixture = songFixture();
    this.song = fixture.project;
    this.songWav = fixture.wav;
    const path = join(this.directory, "legacy-input.xmp.json");
    await writeFile(path, await exportPortable(this.song));
    await this.page.goto(origin);
    await openDevice(this, this.page, path);
    await expect(this.page.locator(".screen-header")).toContainText(this.song.name);
  },
);
When("I save the song with Package samples checked", async function () {
  this.file = await save(this, this.page);
  const wire = JSON.parse(this.file.text);
  assert.equal(wire.version, 2);
  assert.equal(wire.sampleMode, "embedded");
  assert.equal(wire.assets.length, 1);
});
When("I open that file in Advanced Studio in a clean browser profile", async function () {
  this.advanced = await fresh(this, true);
  await this.advanced.locator("#project-file").setInputFiles(this.file.path);
  await expect(this.advanced.locator("#project-title")).toHaveText(this.song.name);
});
Then(
  "the notes, scenes, machine state, sample aliases and rendered audio are unchanged",
  async function () {
    await sameSong(this, this.advanced, true);
  },
);
When("I save it in Advanced Studio and reopen it in another Device profile", async function () {
  const file = await save(this, this.advanced, true, true);
  this.receiver = await fresh(this);
  await openDevice(this, this.receiver, file.path);
  await expect(this.receiver.locator(".screen-header")).toContainText(this.song.name);
});
Then(
  "the same complete song and audio are restored without the original library",
  async function () {
    await sameSong(this, this.receiver);
  },
);
When("I save the song without packaging samples", async function () {
  this.file = await save(this, this.page, false);
  const wire = JSON.parse(this.file.text);
  assert.equal(wire.sampleMode, "referenced");
  assert.deepEqual(wire.assets, []);
});
When("I open the referenced song in a clean Device profile", async function () {
  this.receiver = await fresh(this);
  const previous = await save(this, this.receiver);
  this.before = await importPortable(previous.text);
  this.expectedConsoleErrors.push("[XMP] Opening song: Missing samples:");
  await openDevice(this, this.receiver, this.file.path);
});
Then("the missing sounds are listed and the current song is retained", async function () {
  await expect(this.receiver.getByRole("alert")).toContainText("Kick café");
  assert.deepEqual(await importPortable((await save(this, this.receiver)).text), this.before);
});
When("I choose a different sound with the expected file name", async function () {
  const wrong = Buffer.from(this.songWav);
  wrong[244] ^= 255;
  const path = join(this.directory, "Kick café.wav");
  await writeFile(path, wrong);
  this.expectedConsoleErrors.push("[XMP] Locating samples: No matching sample content found.");
  await this.receiver.locator("#song-missing-files").setInputFiles(path);
});
Then("that sound is rejected and the current song is retained", async function () {
  await expect(this.receiver.getByRole("status")).toContainText("No matching sample content");
  assert.deepEqual(await importPortable((await save(this, this.receiver)).text), this.before);
});
When("I locate the matching WAV under a different file name", async function () {
  const path = join(this.directory, "relocated-original.wav");
  await writeFile(path, this.songWav);
  await this.receiver.locator("#song-missing-files").setInputFiles(path);
});
Then("the complete transferred song is restored with the correct audio", async function () {
  await expect(this.receiver.locator(".screen-header")).toContainText(this.song.name);
  await sameSong(this, this.receiver);
});
When("I reload that browser and open the referenced song", async function () {
  await this.page.reload();
  await openDevice(this, this.page, this.file.path);
});
Then("the local sample library resolves the song without choosing files", async function () {
  await expect(this.page.locator(".screen-header")).toContainText(this.song.name);
  await expect(this.page.getByRole("alert")).toHaveCount(0);
  await sameSong(this, this.page);
});
When("I open a song whose metadata checksum is invalid", async function () {
  const value = JSON.parse(await exportSong(this.song));
  value.project.bpm = 133;
  const path = join(this.directory, "corrupt.xmpsong");
  await writeFile(path, JSON.stringify(value));
  this.expectedConsoleErrors.push("[XMP] Opening song: Corrupt song metadata");
  await openDevice(this, this.page, path);
});
Then("the corrupt transfer is rejected without changing the active song", async function () {
  await expect(this.page.getByRole("status")).toContainText("Could not open this project");
  await expect(this.page.getByRole("button", { name: "Choose another file" })).toBeVisible();
  await sameSong(this, this.page);
});
Then("a legacy project copy remains readable", async function () {
  await projectPage(this.page);
  await this.page.getByText("Legacy format", { exact: true }).click();
  const pending = this.page.waitForEvent("download");
  await this.page.getByRole("button", { name: "Save legacy copy", exact: true }).click();
  const download = await pending,
    path = join(this.directory, "legacy-roundtrip.xmp.json");
  await download.saveAs(path);
  assert.deepEqual(await importPortable(await readFile(path, "utf8")), this.song);
});
