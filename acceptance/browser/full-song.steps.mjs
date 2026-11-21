import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { importPortable } from "../../packages/core/src/assets.ts";
import { decodeMidi, loadCore } from "../../packages/core/src/edits.ts";
import { trackPads } from "../../packages/core/src/pads.ts";
import {
  bounce,
  clipAt,
  editSlot,
  library,
  navigate,
  newContext,
  press,
  projectDownload,
  qlink,
  selectTrack,
  setMachine,
  setTempo,
  steps,
} from "./production.steps.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

// features/25-full-song-e2e.feature: a song built from a blank project in the
// Device view, one track at a time, on the C++ core in WebAssembly. Every
// track's notes are written here once; the saved song is checked against them.
const origin = process.env.XMP_E2E_ORIGIN;

// The four tracks: on the Clips page the pads are slots (pad 12 + t: track t
// in scene 1, the verse; pad 8 + t: scene 2, the chorus). For a kit the sound
// is the pad; for a synth it is the note 48 + sound. Steps are 1-based.
const TRACKS = [
  {
    name: "drums",
    machine: undefined, // the kit sampler the empty song starts with
    verse: [
      [0, [1, 5, 9, 13]],
      [1, [5, 13]],
      [2, [3, 7, 11, 15]],
    ],
    chorus: [
      [0, [1, 5, 9, 13]],
      [1, [5, 13]],
      [2, [1, 3, 5, 7, 9, 11, 13, 15]],
    ],
  },
  {
    name: "bass",
    machine: "xmp.subtractive",
    verse: [
      [0, [1, 4, 9, 12]],
      [7, [7, 15]],
    ],
    chorus: [
      [5, [1, 9]],
      [3, [5, 13]],
    ],
  },
  {
    name: "chords",
    machine: "xmp.subtractive",
    verse: [
      [0, [1, 9]],
      [4, [1, 9]],
      [7, [1, 9]],
    ],
    chorus: [
      [5, [1, 9]],
      [9, [1, 9]],
      [12, [1, 9]],
    ],
  },
  {
    name: "lead",
    machine: "xmp.subtractive",
    verse: [
      [12, [3]],
      [14, [7]],
      [15, [11]],
      [14, [15]],
    ],
    chorus: [
      [15, [1, 5]],
      [12, [9, 13]],
    ],
  },
];
const LEVELS = [1, 0.9, 0.6, 0.75];

async function buildTrack(world, index) {
  const track = TRACKS[index];
  const page = world.page;
  if (index === 0) await library(world);
  else {
    await selectTrack(page, index);
    await setMachine(page, track.machine);
  }
  await editSlot(page, 12 + index);
  if (index === 0) await setTempo(page, 120);
  for (const [sound, positions] of track.verse) await steps(page, sound, positions);
  await editSlot(page, 8 + index);
  for (const [sound, positions] of track.chorus) await steps(page, sound, positions);
}

// What a clip should hold: [pad or note, step] pairs, sorted.
function expected(track, part) {
  const pairs = [];
  for (const [sound, positions] of track[part])
    for (const p of positions) pairs.push([track.machine ? 48 + sound : sound, p - 1]);
  return pairs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
function held(project, t, scene, synth) {
  const clip = clipAt(project, t, scene);
  assert.ok(clip, `track ${t + 1} has a clip in scene ${scene + 1}`);
  return clip.steps
    .map((s) => [synth ? s.note : s.pad, s.step])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
function assertSong(project) {
  assert.equal(project.bpm, 120);
  for (const [t, track] of TRACKS.entries()) {
    const machine = project.tracks[t].machine?.id;
    if (track.machine) assert.equal(machine, track.machine, `track ${t + 1}'s machine`);
    else assert.ok(!machine || machine === "xmp.sampler", `track ${t + 1} stays a kit`);
    assert.deepEqual(
      held(project, t, 0, Boolean(track.machine)),
      expected(track, "verse"),
      `track ${t + 1} verse`,
    );
    assert.deepEqual(
      held(project, t, 1, Boolean(track.machine)),
      expected(track, "chorus"),
      `track ${t + 1} chorus`,
    );
  }
  assert.deepEqual(
    trackPads(project, project.tracks[0].id)
      .slice(0, 3)
      .map((pad) => pad.name),
    ["Kick", "Snare", "Hat"],
  );
}

When(
  "I build track 1 as drums from my own WAV folder with a verse and a chorus beat",
  async function () {
    await buildTrack(this, 0);
  },
);
When("I build track 2 as a synth bass with a verse and a chorus line", async function () {
  await buildTrack(this, 1);
});
When("I build track 3 as synth chords with a verse and a chorus part", async function () {
  await buildTrack(this, 2);
});
When("I build track 4 as a synth lead with a verse and a chorus hook", async function () {
  await buildTrack(this, 3);
});
When(
  "I set the tempo and balance the four tracks in the mixer",
  { timeout: 180000 },
  async function () {
    await navigate(this.page, "Mixer");
    for (const [t, level] of LEVELS.entries()) {
      await this.page.locator("[data-track]").nth(t).click();
      await qlink(this.page, 0, level);
    }
  },
);
When("I arrange verse, verse, chorus and verse as the song", async function () {
  await navigate(this.page, "Song chain");
  for (const index of [0, 0, 1, 0]) {
    await this.page.locator("#device-scene").selectOption({ index });
    await this.page.getByRole("button", { name: "Append scene", exact: true }).click();
  }
  await expect(this.page.locator(".song-chain li")).toHaveCount(4);
});
Then("the saved song has all four tracks with their machines, clips and notes", async function () {
  this.song = (await projectDownload(this)).project;
  assertSong(this.song);
});
Then("the arrangement and the mix are saved", function () {
  const p = this.song;
  assert.deepEqual(
    p.performance.chain.map((part) => part.sceneId),
    [p.scenes[0].id, p.scenes[0].id, p.scenes[1].id, p.scenes[0].id],
  );
  for (const [t, level] of LEVELS.entries())
    assert.ok(
      Math.abs(p.tracks[t].volume - level) < 0.011,
      `track ${t + 1} level ${p.tracks[t].volume}`,
    );
});
When("I play the song to its end", async function () {
  await this.page.evaluate(() => {
    globalThis.__xmpAudio.peak = 0;
  });
  // The song plays from the Song chain page (elsewhere Play Start loops the current scene).
  await navigate(this.page, "Song chain");
  await press(this.page, "play-start");
  await expect(this.page.locator("#device-audio-state")).toContainText("PLAY");
  this.observedBars = [];
  for (const bar of ["01", "02", "03", "04"]) {
    await expect(this.page.locator("#device-clock")).toHaveText(new RegExp(`^${bar} :`), {
      timeout: 10000,
    });
    this.observedBars.push(bar);
  }
  await expect(this.page.locator("#device-audio-state")).toHaveText("STOPPED", { timeout: 10000 });
  this.playedPeak = await this.page.evaluate(() => globalThis.__xmpAudio.peak);
});
Then("the clock crosses every bar, audio is heard, and playback stops by itself", function () {
  assert.deepEqual(this.observedBars, ["01", "02", "03", "04"]);
  assert.ok(this.playedPeak > 0.001, `audio peak ${this.playedPeak}`);
});
Then("every track is audible on its own in the exported verse and chorus", async function () {
  const ids = this.song.tracks.slice(0, 4).map((t) => t.id);
  const mute = async (id) => {
    await navigate(this.page, "Track mutes");
    await this.page.locator(`[data-mute="${id}"]`).click();
  };
  // The full verse first.
  const full = await bounce(this);
  assert.ok(full.peak > 0.01, `the verse is heard (${full.peak})`);
  for (const [t, id] of ids.entries()) {
    for (const other of ids) if (other !== id) await mute(other);
    const solo = await bounce(this);
    assert.ok(solo.rms > 0.0005, `track ${t + 1} alone is heard (${solo.rms})`);
    for (const other of ids) if (other !== id) await mute(other);
  }
  // Unmuting restores the saved song exactly.
  assert.deepEqual((await projectDownload(this)).project, this.song);
});
Then("the reloaded song is the same complete song", async function () {
  const p = (await projectDownload(this)).project;
  assert.deepEqual(p, this.song);
});
Then("the second browser has the same complete song and it still plays", async function () {
  const p = (await projectDownload(this)).project;
  assert.deepEqual(p, this.song);
  await press(this.page, "play-start");
  await expect(this.page.locator("#device-audio-state")).toContainText("PLAY");
  await expect(this.page.locator("#device-clock")).not.toHaveText("01 : 01");
  await press(this.page, "stop");
  assert.ok((await bounce(this)).peak > 0.01);
});

// ---- the legacy copy, and MIDI out and back in ----
When("I save a legacy copy", async function () {
  this.song = (await projectDownload(this)).project;
  await navigate(this.page, "Project");
  await this.page.getByText("Legacy format", { exact: true }).click();
  const pending = this.page.waitForEvent("download");
  await this.page.getByRole("button", { name: "Save legacy copy", exact: true }).click();
  const file = await pending;
  this.legacyPath = join(this.directory, "legacy.xmp.json");
  await file.saveAs(this.legacyPath);
});
Then("the legacy copy opens to the same song", async function () {
  const text = await readFile(this.legacyPath, "utf8");
  assert.equal(JSON.parse(text).version, 1, "a version 1 bundle");
  assert.deepEqual(await importPortable(text), this.song);
});
When("I open the song in Advanced Studio and export the scene as MIDI", async function () {
  const { text } = await projectDownload(this);
  const songPath = join(this.directory, "for-studio.xmpsong");
  await writeFile(songPath, text);
  this.studio = await newContext(this);
  await this.studio.goto(`${origin}/?view=studio`);
  await this.studio.locator("#project-file").setInputFiles(songPath);
  await expect(this.studio.locator("#project-file")).toHaveValue("");
  await expect(this.studio.locator("#project-title")).toHaveText(this.song.name);
  await this.studio.getByRole("tab", { name: "Mix", exact: true }).click();
  const pending = this.studio.waitForEvent("download");
  await this.studio.locator("#export-scene-midi").click();
  const file = await pending;
  this.midiPath = join(this.directory, "verse.mid");
  await file.saveAs(this.midiPath);
});
Then("the MIDI file has the bass line's notes", async function () {
  const document = decodeMidi(new Uint8Array(await readFile(this.midiPath)));
  const bassNotes = expected(TRACKS[1], "verse").map(([note]) => note);
  // The file track whose notes are the bass verse's.
  const byTrack = new Map();
  for (const n of document.notes) byTrack.set(n.track, [...(byTrack.get(n.track) ?? []), n]);
  const match = [...byTrack].find(
    ([, notes]) =>
      notes
        .map((n) => n.note)
        .sort((a, b) => a - b)
        .join() === [...bassNotes].sort((a, b) => a - b).join(),
  );
  assert.ok(match, `a file track holds the bass line (${[...byTrack.keys()].join(",")})`);
  this.bassFileTrack = match[0];
});
When("I import that MIDI into the bass track's chorus clip", async function () {
  const bass = this.song.tracks[1].id,
    chorus = this.song.scenes[1].id;
  await this.studio.getByRole("tab", { name: "Perform", exact: true }).click();
  if (!(await this.studio.locator("#scenes").isVisible()))
    await this.studio.locator(".scenes-panel summary").click();
  await this.studio.locator(`#scenes [data-scene="${chorus}"]`).click();
  await this.studio.locator(`#tracks [data-track="${bass}"]`).click();
  await this.studio.getByRole("tab", { name: "Mix", exact: true }).click();
  await this.studio.locator("#midi-file").setInputFiles(this.midiPath);
  await expect(this.studio.locator("#status")).toContainText("MIDI staged");
  await this.studio.locator("#midi-track").selectOption(String(this.bassFileTrack));
  await this.studio.locator("#midi-keep").click();
  const pending = this.studio.waitForEvent("download");
  await this.studio.locator("#save").click();
  const file = await pending;
  const path = join(this.directory, "after-import.xmpsong");
  await file.saveAs(path);
  this.imported = await importPortable(await readFile(path, "utf8"));
});
Then("the chorus clip holds the verse's bass line", function () {
  const clip = clipAt(this.imported, 1, 1);
  const notes = (clip.sequence?.notes ?? [])
    .map((n) => [n.note, Math.round(n.position)])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  assert.deepEqual(notes, expected(TRACKS[1], "verse"));
  // Everything else is the song as it was.
  assert.deepEqual(clipAt(this.imported, 1, 0), clipAt(this.song, 1, 0));
  assert.deepEqual(clipAt(this.imported, 0, 0), clipAt(this.song, 0, 0));
});
