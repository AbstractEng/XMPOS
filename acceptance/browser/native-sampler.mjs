// Real browser I/O around the shared C++ workspace; Chromium supplies synthetic
// microphone audio. Isolated storage, no physical input/output or instrument.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { expandSong, loadCore } from "../../packages/core/src/edits.ts";
import { createDemoProject, encodeWav } from "../../packages/core/src/index.ts";
import { openProject, saveSong } from "../../packages/core/src/project-io.ts";
import { root } from "../lib/workspace.mjs";

await loadCore();
const p = expandSong(createDemoProject());
p.bpm = 300;
p.swing = 0;
p.samples = [{ id: "signal", name: "Original", sampleRate: 48000, pcm: [0, 0.25, 0] }];
for (const pad of p.pads) {
  pad.sampleId = "signal";
  delete pad.slice;
}
p.tracks[0].machine = { id: "xmp.sampler", base: "audio", version: 1, state: { mode: "keys" } };
p.extensions = { "com.example.performance": { version: 2, data: { retained: true } } };
const fixture = await saveSong(p);
const report = join(root, "reports/native-sampler");
await mkdir(report, { recursive: true });
const supplied = process.env.XMP_DEVICE_ORIGIN;
if (supplied && !/^http:\/\/127\.0\.0\.1:\d+$/.test(supplied))
  throw Error("Loopback origin required");
const server = supplied
  ? undefined
  : await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
const address = server?.httpServer.address();
const origin = supplied || `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  args: [
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const checks = [];
try {
  async function instrument() {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
      permissions: ["microphone"],
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${origin}/fixture`, (route) =>
      route.fulfill({ body: "<title>Sampler fixture</title>", contentType: "text/html" }),
    );
    await page.goto(`${origin}/fixture`);
    await page.evaluate(
      (text) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("xmp-studio-v1", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("projects");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const tx = request.result.transaction("projects", "readwrite");
            tx.objectStore("projects").put(text, "autosave");
            tx.oncomplete = () => {
              request.result.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
        }),
      fixture,
    );
    await page.goto(origin);
    await page.locator("#device-screen").waitFor();
    await expect(page.locator("#boot-screen")).toHaveCount(0);
    const key = (id) =>
      page.locator(id === "wheel" ? '[data-wheel="0"]' : `[data-panel="${id}"]`).click();
    const pad = (n) => page.locator(`[data-pad="${n}"]`).click();
    const menu = async (n) => {
      await key("menu");
      await pad(n);
    };
    async function saved() {
      await key("stop");
      await menu(4);
      await pad(14);
      await expect(page.locator("#device-screen")).toHaveAttribute("data-message", /Project saved/);
      const pending = page.waitForEvent("download");
      await page.locator('[data-host="download"]').click();
      const download = await pending;
      const path = await download.path();
      const { readFile } = await import("node:fs/promises");
      return openProject(await readFile(path, "utf8"));
    }
    return { context, page, key, pad, menu, saved, errors };
  }
  {
    const d = await instrument();
    // Play REC is a pad performance, not an input request on a Sampler.
    await d.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw Error("Unexpected microphone request from Play");
      };
    });
    await d.menu(12);
    await d.key("rec");
    assert.doesNotMatch(
      await d.page.locator("#device-host-state").textContent(),
      /Microphone unavailable/,
    );
    assert.deepEqual(d.errors, []);
    await d.context.close();
    checks.push("Play recording does not request input");
  }
  {
    const d = await instrument();
    await d.menu(14);
    await d.page.locator('[data-host="microphone"]').click();
    await expect(d.page.locator("#device-host-state")).toContainText("Microphone ready");
    await d.page.waitForTimeout(800); // allow the synthetic input stream to prime
    await d.key("play-start");
    await d.key("rec");
    await expect(d.page.locator("#device-screen")).toHaveAttribute(
      "data-message",
      /Live loop kept/,
      { timeout: 15000 },
    );
    await expect(d.page.locator('[data-panel="play"]')).toHaveAttribute("data-led", "on");
    await d.page.locator("#device-screen").screenshot({ path: join(report, "loop.png") });
    const song = await d.saved(),
      track = song.tracks[0];
    assert.equal(song.samples.find((s) => s.id === track.pads[0].sampleId).pcm.length, 153600);
    assert.equal(track.clips.find((c) => c.id === song.scenes[0].clips[track.id]).length, 64);
    assert.deepEqual(song.tracks.slice(1), p.tracks.slice(1));
    assert.deepEqual(
      song.extensions["com.example.performance"],
      p.extensions["com.example.performance"],
    );
    assert.deepEqual(song.extensions["xmp.sampler-input"].data.tracks[track.id], {
      monitor: true,
      bars: 4,
    });
    assert.deepEqual(await openProject(await saveSong(song)), song);
    assert.deepEqual(d.errors, []);
    await d.context.close();
    checks.push("next-bar four-bar microphone loop and portable reopen");
  }
  {
    const d = await instrument();
    await d.menu(14);
    await d.key("rec");
    await expect(d.page.locator("#device-host-state")).toContainText("Microphone ready");
    await d.page.waitForTimeout(1000);
    await d.key("rec");
    await d.key("wheel");
    const song = await d.saved(),
      track = song.tracks[0];
    const sample = song.samples.find((s) => s.id === track.pads[0].sampleId);
    assert.ok(sample.pcm.length > 1000 && sample.pcm.length <= 480000);
    assert.ok(Math.abs(sample.pcm.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0) - 1) < 1e-6);
    assert.deepEqual(track.clips, p.tracks[0].clips);
    assert.deepEqual(d.errors, []);
    await d.context.close();
    checks.push("stopped threshold microphone take");
  }
  {
    const d = await instrument();
    await d.menu(14);
    const wave = Buffer.from(
      encodeWav([Float32Array.from([0.125, 0.25, 0.5, 0.75, 1, 0.5, 0.25, 0.125])], 48000),
    );
    await d.page
      .locator("#device-capture")
      .setInputFiles({ name: "chops.wav", mimeType: "audio/wav", buffer: wave });
    await d.key("rec");
    await expect(d.page.locator("#device-screen")).toHaveAttribute("data-message", /Recorded/);
    const tap = async (x, y) => {
      const box = await d.page.locator("#device-screen").boundingBox();
      await d.page.mouse.click(box.x + (x * box.width) / 1280, box.y + (y * box.height) / 800);
    };
    for (let i = 0; i < 4; i++) await tap(150, 544); // cycle back to Equal slices
    for (let i = 0; i < 3; i++) await d.key("plus");
    await d.pad(2);
    await tap(440, 544);
    const song = await d.saved(),
      pads = song.tracks[0].pads;
    assert.deepEqual(
      pads.slice(0, 4).map((p) => [p.slice.start, p.slice.end]),
      [
        [0, 2],
        [2, 4],
        [4, 6],
        [6, 8],
      ],
    );
    assert.ok(
      pads
        .slice(0, 4)
        .every((p) => p.sampleId === pads[0].sampleId && p.playback.mode === "one-shot"),
    );
    assert.deepEqual(d.errors, []);
    await d.context.close();
    checks.push("WAV input, pad chop preview and Chop to drum kit");
  }
  {
    const d = await instrument();
    await d.menu(14);
    await d.page.locator('[data-host="microphone"]').click();
    await expect(d.page.locator("#device-host-state")).toContainText("Microphone ready");
    await d.page.waitForTimeout(800);
    await d.key("play-start");
    await d.key("rec");
    await expect(d.page.locator("#device-screen")).toHaveAttribute(
      "data-message",
      /Live loop kept/,
      { timeout: 15000 },
    );
    await d.menu(8);
    await d.page.keyboard.down("Shift");
    try {
      await d.key("copy");
    } finally {
      await d.page.keyboard.up("Shift");
    }
    await expect(d.page.locator("#device-screen")).toHaveAttribute("data-message", /Slot removed/);
    await expect(d.page.locator('[data-panel="play"]')).toHaveAttribute("data-led", "on");
    const song = await d.saved(),
      track = song.tracks[0];
    assert.equal(song.scenes[0].clips[track.id], undefined);
    assert.equal(song.samples.find((s) => s.id === track.pads[0].sampleId).pcm.length, 153600);
    assert.deepEqual(song.tracks.slice(1), p.tracks.slice(1));
    assert.deepEqual(d.errors, []);
    await d.context.close();
    checks.push("delete a fresh microphone loop before its engine handoff while other tracks play");
  }
  await writeFile(
    join(report, "result.json"),
    JSON.stringify(
      { passed: true, checks, physicalAudio: false, microphone: "Chromium synthetic input" },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Native sampler browser passed ${checks.length} input, looping and chopping journeys`,
  );
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
}
