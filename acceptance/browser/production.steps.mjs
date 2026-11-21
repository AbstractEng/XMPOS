import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  After,
  AfterAll,
  Before,
  BeforeAll,
  Given,
  setDefaultTimeout,
  Then,
  When,
} from "@cucumber/cucumber";
import { chromium, expect } from "@playwright/test";
import { importPortable } from "../../packages/core/src/assets.ts";
import { encodeWav } from "../../packages/core/src/index.ts";
import { trackPads } from "../../packages/core/src/pads.ts";
import { root, sha256 } from "../lib/workspace.mjs";

setDefaultTimeout(60000);
let browser;
const origin = process.env.XMP_E2E_ORIGIN;
const report = process.env.XMP_E2E_REPORT;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? "") || !report)
  throw new Error("Use npm run bdd:e2e with its owned loopback server and report directory");
BeforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-audio-output", "--mute-audio", "--use-fake-device-for-media-stream"],
  });
});
AfterAll(async () => {
  await browser?.close();
});

async function newContext(world, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1600, height: 1000 },
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    permissions: [],
    serviceWorkers: "block",
    acceptDownloads: true,
  });
  world.contexts.push(context);
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    world.errors.push(`Unexpected external request: ${route.request().url()}`);
    await route.abort();
  });
  await context.addInitScript(() => {
    globalThis.__xmpHardwareAttempts = [];
    const deny = (object, key) => {
      if (!object || typeof object[key] !== "function") return;
      Object.defineProperty(object, key, {
        value: () => {
          globalThis.__xmpHardwareAttempts.push(key);
          console.error(`XMP_FORBIDDEN_API:${key}`);
          throw new Error(`Physical API forbidden in browser regression: ${key}`);
        },
      });
    };
    for (const [object, names] of [
      [navigator, ["requestMIDIAccess"]],
      [navigator.usb, ["requestDevice", "getDevices"]],
      [navigator.hid, ["requestDevice", "getDevices"]],
      [navigator.serial, ["requestPort", "getPorts"]],
      [navigator.mediaDevices, ["getUserMedia", "enumerateDevices", "getDisplayMedia"]],
    ])
      for (const name of names) deny(object, name);
  });
  if (world.observeAudio)
    await context.addInitScript(() => {
      // Tap the real worklet output. No DSP, transport or AudioContext is mocked.
      globalThis.__xmpAudio = { peak: 0, latest: 0, midi: [] };
      const Worklet = globalThis.AudioWorkletNode;
      globalThis.AudioWorkletNode = class extends Worklet {
        constructor(...args) {
          super(...args);
          const analyser = args[0].createAnalyser();
          analyser.fftSize = 256;
          this.connect(analyser);
          const pcm = new Float32Array(analyser.fftSize);
          setInterval(() => {
            analyser.getFloatTimeDomainData(pcm);
            let peak = 0;
            for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
            globalThis.__xmpAudio.latest = peak;
            globalThis.__xmpAudio.peak = Math.max(globalThis.__xmpAudio.peak, peak);
          }, 10);
          this.port.addEventListener("message", ({ data }) => {
            if (data.midi) globalThis.__xmpAudio.midi.push(data.midi);
          });
        }
      };
    });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => world.errors.push(e.message));
  page.on("console", (message) => {
    const level = message.type();
    if (level !== "error" && level !== "warning") return;
    const text = message.text();
    const expected = world.expectedConsoleErrors.findIndex((prefix) => text.startsWith(prefix));
    if (expected >= 0) world.expectedConsoleErrors.splice(expected, 1);
    else if (level === "error") world.errors.push(text);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) world.errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  return page;
}
Before(async function ({ pickle }) {
  this.contexts = [];
  this.errors = [];
  this.expectedConsoleErrors = [];
  this.observeAudio = pickle.tags.some(
    (tag) => tag.name === "@midi_routing" || tag.name === "@observe_audio",
  );
  this.manualAudit = pickle.tags.some((tag) => tag.name === "@manual_e2e");
  this.directory = join(report, sha256(pickle.name).slice(0, 16));
  await mkdir(this.directory);
  this.page = await newContext(this);
});
After(async function ({ result }) {
  const attempts = [];
  try {
    for (const [i, context] of this.contexts.entries()) {
      for (const page of context.pages()) {
        if (!page.isClosed()) {
          attempts.push(...(await page.evaluate(() => globalThis.__xmpHardwareAttempts ?? [])));
          if (result.status !== "PASSED" || this.errors.length || attempts.length)
            await page.screenshot({
              path: join(this.directory, `failure-${i}.png`),
              fullPage: !this.manualAudit,
            });
        }
      }
      await context.tracing.stop(
        result.status === "PASSED" && !this.errors.length && !attempts.length
          ? {}
          : { path: join(this.directory, `trace-${i}.zip`) },
      );
    }
    await writeFile(
      join(this.directory, "browser-evidence.json"),
      JSON.stringify(
        {
          outcome: this.errors.length || attempts.length ? "FAILED" : result.status,
          browser: browser.version(),
          physicalApiAttempts: attempts,
          physicalAudioOutput: false,
          downloads: this.downloadCount ?? 0,
          errors: this.errors,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(attempts, [], "No physical API may be called");
    assert.deepEqual(this.errors, [], "Browser errors or failed requests");
    if (result.status === "PASSED")
      assert.deepEqual(this.expectedConsoleErrors, [], "Expected handled import diagnostics");
  } finally {
    for (const context of this.contexts) await context.close();
  }
});

export const openHardwareDevice = (page) => page.goto(`${origin}/?layout=hardware`);

const press = (page, id) => page.locator(`[data-panel="${id}"]`).click();

export { navigate as navigateDevicePage, newContext as isolatedBrowserPage };

async function navigate(page, name) {
  await press(page, "menu");
  const currentName =
    {
      Project: "Project & files",
      "Track mutes": "Mixer",
      "Sample library": "Browse",
    }[name] ?? name;
  await page
    .locator("#device-screen")
    .getByRole("button", { name: currentName, exact: false })
    .click();
}
async function projectDownload(world) {
  await navigate(world.page, "Project");
  const download = world.page.waitForEvent("download");
  await world.page.getByRole("button", { name: "Save portable project", exact: true }).click();
  const file = await download;
  world.downloadCount = (world.downloadCount ?? 0) + 1;
  const path = join(world.directory, `song-${world.downloadCount}.xmp.json`);
  await file.saveAs(path);
  const text = await readFile(path, "utf8");
  return { text, project: await importPortable(text) };
}
async function bounce(world) {
  await navigate(world.page, "Project");
  const download = world.page.waitForEvent("download");
  await world.page.getByRole("button", { name: "Export current scene WAV", exact: true }).click();
  const file = await download;
  world.downloadCount = (world.downloadCount ?? 0) + 1;
  const path = join(world.directory, `bounce-${world.downloadCount}.wav`);
  await file.saveAs(path);
  const bytes = await readFile(path);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 2);
  assert.equal(bytes.readUInt32LE(24), 48000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  let squares = 0,
    peak = 0;
  for (let i = 44; i < bytes.length; i += 2) {
    const sample = bytes.readInt16LE(i) / 32768;
    assert.ok(Number.isFinite(sample));
    squares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return {
    frames: (bytes.length - 44) / 4,
    rms: Math.sqrt(squares / ((bytes.length - 44) / 2)),
    peak,
  };
}
async function qlink(page, index, value) {
  await page.locator(".screen-qlinks .q-value").nth(index).click();
  await page.locator("#value-input").fill(String(value * 100));
  await page.getByRole("button", { name: "Apply", exact: true }).click();
}

async function editSlot(page, pad) {
  await press(page, "main");
  await page.locator(`[data-slot="${pad}"]`).click();
  // Touching the selected clip again opens it; otherwise the data dial opens it.
  if (!(await page.locator("#device-sound").count()))
    await page.getByRole("button", { name: "Press data dial", exact: true }).click();
  await expect(page.locator("#device-sound")).toBeVisible();
}
async function steps(page, sound, positions) {
  await page.locator("#device-sound").selectOption(String(sound));
  const pitched = await page.locator(".piano-roll").count();
  for (const step of positions) {
    const cell = pitched
      ? page.locator(`[data-roll-note="${48 + sound}"][data-roll-step="${step - 1}"]`)
      : page.getByRole("button", { name: `Step ${step}`, exact: true });
    await cell.click();
    await expect(cell).toHaveAttribute("aria-pressed", "true");
  }
}
async function setTempo(page, bpm) {
  await page.getByRole("button", { name: "Edit Tempo", exact: true }).click();
  await page.locator("#value-input").fill(String(bpm));
  await page.getByRole("button", { name: "Apply", exact: true }).click();
}
async function selectTrack(page, index) {
  await navigate(page, "Mixer");
  await page.locator(".mix-channel [data-track]").nth(index).click();
  await navigate(page, "Sound");
}
async function setMachine(page, id) {
  const choice = page.locator(`[data-action="machine:${id}"]`);
  if (!(await choice.isVisible())) await page.locator('[data-action="machine-picker"]').click();
  await choice.click();
  await expect(page.locator(".machine-grid")).toHaveCount(0);
  if (await page.locator("#wb-scale").count())
    await page.locator("#wb-scale").selectOption("chromatic");
}
async function makeBeat(world) {
  await editSlot(world.page, 12);
  await setTempo(world.page, 120);
  await steps(world.page, 0, [1, 5, 9, 13]);
  await steps(world.page, 1, [5, 13]);
  await steps(world.page, 2, [3, 7, 11, 15]);
}
async function library(world) {
  const folder = join(world.directory, "Original drums");
  await mkdir(folder);
  for (const [i, name] of ["Kick", "Snare", "Hat"].entries()) {
    const pcm = Float32Array.from(
      { length: 2400 },
      (_, frame) => 0.4 * Math.exp(-frame / (200 + i * 100)) * Math.sin(frame * (0.08 + i * 0.13)),
    );
    await writeFile(join(folder, `${name}.wav`), Buffer.from(encodeWav([pcm], 48000)));
  }
  await press(world.page, "shift");
  await press(world.page, "menu");
  await world.page.locator("#device-folder").setInputFiles(folder);
  await expect(world.page.getByRole("status")).toContainText("3 folder WAVs indexed");
  for (const [i, name] of ["Kick", "Snare", "Hat"].entries()) {
    await world.page.getByRole("textbox", { name: "Search sample library" }).fill("Original drums");
    await world.page
      .locator(".library-list button")
      .filter({ has: world.page.getByText(name, { exact: true }) })
      .click();
    await world.page.locator(`[data-pad="${i}"]`).click();
    await world.page.getByRole("button", { name: `Load to pad ${i + 1}`, exact: true }).click();
    await expect(world.page.getByRole("status")).toContainText(`Loaded ${name} to pad ${i + 1}`);
  }
}
function clipAt(project, track = 0, scene = 0) {
  const t = project.tracks[track];
  return t.clips.find((clip) => clip.id === project.scenes[scene].clips[t.id]);
}
function assertBeat(project) {
  assert.equal(project.bpm, 120);
  const hits = clipAt(project).steps;
  for (const [pad, expected] of [
    [0, [0, 4, 8, 12]],
    [1, [4, 12]],
    [2, [2, 6, 10, 14]],
  ])
    assert.deepEqual(
      hits
        .filter((hit) => hit.pad === pad)
        .map((hit) => hit.step)
        .sort((a, b) => a - b),
      expected,
    );
  assert.equal(hits.length, 10);
}

Given("I start a new empty song in an isolated browser", async function () {
  await openHardwareDevice(this.page);
  await expect(this.page.locator(".device-chassis")).toBeVisible();
  await navigate(this.page, "Project");
  this.page.once("dialog", (dialog) => dialog.accept());
  await this.page.getByRole("button", { name: "New empty song", exact: true }).click();
  await expect(this.page.getByRole("status")).toContainText("New empty song");
});
When(
  "I index an original three-sound WAV folder and load kick, snare and hat to pads",
  async function () {
    await library(this);
  },
);
When("I program a one-bar drum beat at 120 BPM", async function () {
  await makeBeat(this);
});
When("I play the loop and stop it using the front panel", async function () {
  await press(this.page, "play-start");
  await expect(this.page.locator("#device-audio-state")).toContainText("PLAY");
  await expect(this.page.locator("#device-clock")).not.toHaveText("01 : 01");
  await press(this.page, "stop");
  await expect(this.page.locator("#device-audio-state")).toHaveText("STOPPED");
});
Then("the portable song contains the programmed hits and imported samples", async function () {
  const { project } = await projectDownload(this);
  assertBeat(project);
  assert.deepEqual(
    trackPads(project, project.tracks[0].id)
      .slice(0, 3)
      .map((pad) => pad.name),
    ["Kick", "Snare", "Hat"],
  );
  for (const pad of trackPads(project, project.tracks[0].id).slice(0, 3))
    assert.equal(project.samples.find((sample) => sample.id === pad.sampleId).pcm.length, 2400);
});
Then("the current scene downloads as a non-silent 48 kHz stereo WAV", async function () {
  const audio = await bounce(this);
  assert.ok(audio.peak > 0.01 && audio.peak <= 1);
  assert.ok(audio.rms > 0.001);
  assert.equal(audio.frames, 192000); // One bar at 120 BPM + the scene export's two-second tail.
});
When("I build a drum beat and add a pitched synth loop on track 2", async function () {
  await library(this);
  await makeBeat(this);
  await selectTrack(this.page, 1);
  await setMachine(this.page, "xmp.subtractive");
  await editSlot(this.page, 13);
  await steps(this.page, 0, [1, 9]);
  await steps(this.page, 7, [7, 15]);
  this.layered = (await projectDownload(this)).project;
  assertBeat(this.layered);
});
When("I copy that loop to scene 2 and add a higher note", async function () {
  await editSlot(this.page, 13);
  await press(this.page, "copy");
  await this.page.locator('[data-pad="9"]').click();
  await this.page.getByRole("button", { name: "Press data dial", exact: true }).click();
  await steps(this.page, 12, [13]);
  this.variation = (await projectDownload(this)).project;
});
Then("the verse and chorus retain different notes and the same synth machine", function () {
  assert.deepEqual(clipAt(this.variation, 1, 0), clipAt(this.layered, 1, 0));
  assert.equal(this.variation.tracks[1].machine.id, "xmp.subtractive");
  assert.deepEqual(
    clipAt(this.variation, 1, 0).steps.map((hit) => hit.note),
    [48, 48, 55, 55],
  );
  assert.equal(clipAt(this.variation, 1, 1).steps.length, 5);
  assert.ok(clipAt(this.variation, 1, 1).steps.some((hit) => hit.note === 60 && hit.step === 12));
});
When("I undo and redo the chorus edit", async function () {
  await press(this.page, "undo");
  assert.equal(clipAt((await projectDownload(this)).project, 1, 1).steps.length, 4);
  await press(this.page, "shift");
  await press(this.page, "undo");
});
Then("the chorus variation is restored without changing the drum beat", async function () {
  const project = (await projectDownload(this)).project;
  assert.deepEqual(project, this.variation);
  assertBeat(project);
});
When("I arrange scene 1, scene 2 and scene 1 as three song occurrences", async function () {
  await navigate(this.page, "Song chain");
  for (const index of [0, 1, 0]) {
    await this.page.locator("#device-scene").selectOption({ index });
    await this.page.getByRole("button", { name: "Append scene", exact: true }).click();
  }
  await expect(this.page.locator(".song-chain li")).toHaveCount(3);
});
When("I play the Song chain to its end", async function () {
  await press(this.page, "play-start");
  await expect(this.page.locator("#device-audio-state")).toContainText("PLAY");
  this.observedBars = [];
  for (const bar of ["01", "02", "03"]) {
    await expect(this.page.locator("#device-clock")).toHaveText(new RegExp(`^${bar} :`), {
      timeout: 10000,
    });
    this.observedBars.push(bar);
  }
  await expect(this.page.locator("#device-audio-state")).toHaveText("STOPPED", { timeout: 10000 });
});
Then("the clock crosses all three bars and playback stops automatically", async function () {
  assert.deepEqual(this.observedBars, ["01", "02", "03"]);
  await expect(this.page.locator("#device-audio-state")).toHaveText("STOPPED");
});
Then("the saved arrangement retains the three occurrences in order", async function () {
  const project = (await projectDownload(this)).project;
  assert.deepEqual(
    project.performance.chain.map((part) => part.sceneId),
    [project.scenes[0].id, project.scenes[1].id, project.scenes[0].id],
  );
  assert.equal(new Set(project.performance.chain.map((part) => part.id)).size, 3);
});
When("I export the scene at full and half drum-track level", async function () {
  await navigate(this.page, "Mixer");
  await this.page.locator('[data-track="drums"]').click();
  await qlink(this.page, 0, 1);
  this.fullBounce = await bounce(this);
  await navigate(this.page, "Mixer");
  await qlink(this.page, 0, 0.5);
  this.halfBounce = await bounce(this);
  this.halfMix = (await projectDownload(this)).project;
});
Then("the half-level bounce has half the amplitude and the same duration", function () {
  assert.ok(this.fullBounce.rms > 0.001);
  assert.equal(this.fullBounce.frames, this.halfBounce.frames);
  assert.ok(Math.abs(this.halfBounce.rms / this.fullBounce.rms - 0.5) < 0.002);
});
When("I mute the drum track and export the scene again", async function () {
  await navigate(this.page, "Track mutes");
  await this.page.locator('[data-mute="drums"]').click();
  this.mutedBounce = await bounce(this);
});
Then("the muted bounce is silent and unmuting restores the previous mix", async function () {
  assert.equal(this.mutedBounce.peak, 0);
  await navigate(this.page, "Track mutes");
  await this.page.locator('[data-mute="drums"]').click();
  assert.deepEqual((await projectDownload(this)).project, this.halfMix);
  const audio = await bounce(this);
  assert.equal(audio.rms, this.halfBounce.rms);
});
When("I wait for autosave and reload the app", async function () {
  await expect(this.page.locator("#device-save-state")).toHaveText("Saved on this browser");
  await this.page.reload();
  await expect(this.page.locator("#device-save-state")).toHaveText("Restored local song");
});
Then("the restored song retains its samples, machines and notes", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.layered);
});
When("I download the song and open it in a second empty browser", async function () {
  const { text } = await projectDownload(this);
  this.page = await newContext(this);
  await openHardwareDevice(this.page);
  await expect(this.page.locator("#device-save-state")).toContainText("Ready");
  await navigate(this.page, "Project");
  await this.page.locator("#device-project-file").setInputFiles({
    name: "transfer.xmp.json",
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
  await expect(this.page.getByRole("status")).toContainText("Project opened");
});
Then("the second browser has the same playable song without the source folder", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.layered);
  await press(this.page, "play-start");
  await expect(this.page.locator("#device-audio-state")).toContainText("PLAY");
  await press(this.page, "stop");
  assert.ok((await bounce(this)).peak > 0.01);
  await navigate(this.page, "Sample library");
  await this.page.getByRole("textbox", { name: "Search sample library" }).fill("Original drums");
  await expect(this.page.locator(".library-list")).toContainText("No matches.");
});
When("I remove the drum clip and immediately undo it", async function () {
  this.beforeDamage = (await projectDownload(this)).project;
  await editSlot(this.page, 12);
  await press(this.page, "shift");
  await press(this.page, "copy");
  assert.equal(clipAt((await projectDownload(this)).project), undefined);
  await press(this.page, "undo");
});
Then("the complete song is unchanged", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.beforeDamage);
});
When("I try to open a portable project with a damaged sample hash", async function () {
  const { text } = await projectDownload(this);
  const damaged = JSON.parse(text);
  const bytes = Buffer.from(damaged.assets[0].chunks[0], "base64");
  bytes[0] ^= 1;
  damaged.assets[0].chunks[0] = bytes.toString("base64");
  this.expectedConsoleErrors.push("[XMP] Opening song: Corrupt sample hash");
  await this.page.locator("#device-project-file").setInputFiles({
    name: "damaged.xmp.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(damaged)),
  });
});
Then("an import error is visible and my current song is unchanged", async function () {
  await expect(this.page.getByRole("status")).toContainText(
    "Could not open this project. Your current song is unchanged.",
  );
  await expect(this.page.getByRole("button", { name: "Choose another file" })).toBeVisible();
  assert.deepEqual((await projectDownload(this)).project, this.beforeDamage);
});
When("I remove the drum clip again and undo it", async function () {
  await editSlot(this.page, 12);
  await press(this.page, "shift");
  await press(this.page, "copy");
  assert.equal(clipAt((await projectDownload(this)).project), undefined);
  await press(this.page, "undo");
});
Then("the complete song is restored", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.beforeDamage);
});
When("I arm recording and play two different pads during playback", async function () {
  await editSlot(this.page, 12);
  await setTempo(this.page, 120);
  await press(this.page, "rec");
  await press(this.page, "play-start");
  await expect(this.page.locator("#device-audio-state")).toHaveText("RECORDING");
  await this.page.locator('[data-pad="0"]').click();
  await expect(this.page.locator("#device-clock")).not.toHaveText("01 : 01");
  await this.page.locator('[data-pad="1"]').click();
});
When("I stop to commit the take", async function () {
  await press(this.page, "stop");
  await expect(this.page.getByRole("status")).toContainText("Stopped");
  this.take = (await projectDownload(this)).project;
});
Then("both recorded sounds are saved in the focused clip", function () {
  const hits = clipAt(this.take).steps;
  assert.deepEqual(
    hits.map((hit) => hit.pad),
    [0, 1],
  );
  assert.ok(hits.every((hit) => hit.step >= 0 && hit.step < 16 && hit.velocity === 0.8));
});
When("I undo the recording and redo it", async function () {
  await press(this.page, "undo");
  assert.deepEqual(clipAt((await projectDownload(this)).project).steps, []);
  await press(this.page, "shift");
  await press(this.page, "undo");
});
Then("the whole take is removed and restored as one edit", async function () {
  assert.deepEqual((await projectDownload(this)).project, this.take);
});

export {
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
};

When("I open Device's screen view at 1280 by 800", async function () {
  await this.page.setViewportSize({ width: 1280, height: 800 });
  await this.page.goto(`${origin}/?layout=screen`);
  await expect(this.page.getByRole("button", { name: "Show hardware layout" })).toBeVisible();
  for (const selector of [
    "#device-screen",
    '[data-panel="play"]',
    '[data-panel="stop"]',
    '[data-panel="rec"]',
    '[data-panel="undo"]',
  ]) {
    await expect(this.page.locator(selector)).toBeInViewport({ ratio: 0.99 });
  }
});

When("I open Device with the Live Mk1 layout", async function () {
  await this.page.setViewportSize({ width: 1280, height: 800 });
  await this.page.goto(origin);
  await expect(this.page.getByRole("button", { name: "Show screen view" })).toBeVisible();
  await expect(this.page.locator(".device-pad-grid button")).toHaveCount(16);
});

Then("its shortcuts and transport match the Mk1 stacks in both browser layouts", async function () {
  const page = this.page;
  const screen = page.locator("#device-screen");
  const logo = screen.getByRole("img", { name: "XMP", exact: true });
  await expect(logo).toBeVisible();
  const mark = await logo.evaluate(async (image) => {
    await image.decode();
    return [image.offsetLeft, image.offsetTop, image.offsetWidth, image.offsetHeight];
  });
  assert.deepEqual(mark, [24, 19, 88, 34]);
  const contents = await screen.innerHTML();
  const checkStacks = async () => {
    const positions = await page.locator(".device-controls [data-panel]").evaluateAll((keys) =>
      Object.fromEntries(
        keys.map((key) => {
          const { left, top, width, bottom } = key.getBoundingClientRect();
          return [key.dataset.panel, { center: left + width / 2, width, top, bottom }];
        }),
      ),
    );
    for (const [upper, lower] of [
      ["shift", "tap"],
      ["menu", "rec"],
      ["main", "stop"],
      ["undo", "play"],
      ["copy", "play-start"],
      ["plus", "minus"],
    ]) {
      assert.ok(positions[upper].width > 0, upper);
      assert.equal(positions[upper].center, positions[lower].center, `${upper} above ${lower}`);
      assert.ok(positions[lower].top > positions[upper].bottom, `${upper}/${lower} row gap`);
    }
    assert.equal(positions.overdub.top, positions.rec.top);
    const { rec, overdub, stop, tap, minus, "play-start": playStart } = positions;
    assert.ok(rec.center < overdub.center && overdub.center < stop.center);
    assert.ok(
      Object.values(positions).every((key) => key.center !== overdub.center || key === overdub),
    );
    assert.ok(rec.center - tap.center > overdub.center - rec.center);
    assert.ok(minus.center - playStart.center > overdub.center - rec.center);
  };
  await checkStacks();
  await expect(page.locator('[data-panel="stop"]')).toBeInViewport({ ratio: 0.99 });
  await page.getByRole("button", { name: "Show screen view" }).click();
  await expect(page.getByRole("button", { name: "Show hardware layout" })).toBeVisible();
  assert.equal(await screen.innerHTML(), contents);
  await checkStacks();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkStacks();
});
When("I launch Intro and queue Verse using the four-bar launch grid", async function () {
  const page = this.page;
  await page.locator('[data-action="menu-page"]').click();
  await page.locator('[data-action="page:preferences"]').click();
  await page.locator("#wb-launch").selectOption("64");
  await page.locator('[data-panel="main"]').click();
  await page.locator('[data-launch-scene="scene-0"]').click();
  await expect(
    page.locator('.clip-cell.playing[data-focus-scene="scene-0"]').first(),
  ).toBeVisible();
  await page.locator('[data-launch-scene="scene-1"]').click();
  await expect(page.locator('[data-launch-scene="scene-1"] .scene-queued')).toBeVisible();
  await expect(page.getByRole("status")).toContainText("4 bars");
});
Then("the queued marker becomes the playing marker without redrawing the grid", async function () {
  const page = this.page;
  const row = page.locator('[data-launch-scene="scene-1"]');
  await row.focus();
  await expect(page.locator('.clip-cell.playing[data-focus-scene="scene-1"]').first()).toBeVisible({
    timeout: 20000,
  });
  await expect(row.locator(".scene-queued")).toBeHidden();
  await expect(page.locator('.clip-cell.playing[data-focus-scene="scene-0"]')).toHaveCount(0);
  await expect(row).toBeFocused();
  await press(page, "stop");
});

When("I load the {word} browser workspace with startup scripts paused", async function (name) {
  const workspaces = {
    Device: ["/", '[data-action="toggle-layout"]'],
    Studio: ["/?view=studio", '#view-nav [data-view="perform"]'],
  };
  assert.ok(Object.hasOwn(workspaces, name), `Unknown workspace: ${name}`);
  const [path, control] = workspaces[name];
  const page = await newContext(this, { viewport: { width: 1280, height: 800 } });
  const { promise, resolve: resume } = Promise.withResolvers();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await promise;
    await route.fallback();
  });
  try {
    const [artwork] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(".png")),
      page.goto(origin + path, { waitUntil: "commit" }),
    ]);
    this.boot = { page, artwork, control, resume };
  } catch (error) {
    resume();
    throw error;
  }
});

Then("the approved startup artwork is visible until the workspace is ready", async function () {
  const { page, artwork, control, resume } = this.boot;
  try {
    const { artworkSha256 } = JSON.parse(
      await readFile(join(root, "os/live-mk1/assets/boot-screen.json"), "utf8"),
    );
    await expect(page.getByRole("status")).toHaveText("Starting XMP");
    const size = await page.locator("#boot-screen img").evaluate(async (image) => {
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    assert.deepEqual(size, [1280, 800]);
    assert.equal(sha256(await artwork.body()), artworkSha256);
    await expect(page.locator("#app[inert]")).toHaveCount(1);
  } finally {
    resume();
  }
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  await expect(page.locator("#app[inert]")).toHaveCount(0);
  await expect(page.locator(control)).toBeEnabled();
});
