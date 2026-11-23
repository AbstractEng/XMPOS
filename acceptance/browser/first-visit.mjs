// Isolated browser lifecycle: first visit, music, new work, reload and return.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { openProject } from "../../packages/core/src/project-io.ts";
import { root } from "../lib/workspace.mjs";

const supplied = process.env.XMP_FIRST_VISIT_ORIGIN;
if (supplied && !/^https:\/\/(abstracteng|irregularsizes)\.com$/.test(supplied))
  throw Error("Use the deployed XMP origin only");
const server = supplied
  ? undefined
  : await preview({ mode: "hosted", preview: { host: "127.0.0.1", port: 0, open: false } });
const origin = supplied || `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } }),
  errors = [],
  demoRequests = [];
await context.addInitScript(() => {
  try {
    localStorage.setItem("xmp-usage-opt-out", "1");
  } catch {}
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (this.buffer) {
      let peak = globalThis.__xmpFirstVisitPeak ?? 0;
      for (const sample of this.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      globalThis.__xmpFirstVisitPeak = peak;
    }
    return start.apply(this, args);
  };
});
context.on("request", (r) => {
  if (r.url().endsWith("/demo/night-shift.xmpsong")) demoRequests.push(r.url());
});
async function saved(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("xmp-studio-v1", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("projects", "readonly"),
            q = tx.objectStore("projects").get("autosave");
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => reject(q.error);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
try {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const boot = async () => {
    await expect(page.locator("#boot-screen")).toHaveCount(0);
    await expect(page.locator("#device-screen")).toBeVisible();
  };
  const key = (id) => page.locator(`[data-panel="${id}"]`).click(),
    pad = (n) => page.locator(`[data-pad="${n}"]`).click();
  const menu = async (n) => {
    await key("menu");
    await pad(n);
  };
  await page.goto(`${origin}/xmpos/`);
  await boot();
  const screen = page.locator("#device-screen");
  await expect(screen).toHaveAttribute("data-project", "Night Shift");
  await expect(page.locator('[data-panel="play"]')).toHaveAttribute("data-led", "off");
  const first = await openProject(await saved(page));
  assert.equal(first.name, "Night Shift");
  assert.equal(first.tracks.length, 6);
  assert.equal(first.performance.chain.length, 6);
  await key("play");
  await expect(page.locator('[data-panel="play"]')).toHaveAttribute("data-led", "on");
  await expect
    .poll(() => page.evaluate(() => globalThis.__xmpFirstVisitPeak ?? 0))
    .toBeGreaterThan(0.001);
  await key("stop");
  await page.screenshot({
    path: join(root, "reports/first-visit/night-shift.png"),
    fullPage: true,
  });
  await menu(4);
  await pad(12);
  await pad(13);
  await expect(screen).toHaveAttribute("data-project", "Untitled");
  // A valid empty project is still the user's project, not a reason to reseed.
  await expect.poll(async () => JSON.parse(await saved(page)).project.name).toBe("Untitled");
  const before = demoRequests.length;
  await page.reload();
  await boot();
  await expect(screen).toHaveAttribute("data-project", "Untitled");
  assert.equal(demoRequests.length, before);
  const b = await screen.boundingBox();
  await page.mouse.click(b.x + (100 * b.width) / 1280, b.y + (200 * b.height) / 800);
  await expect(screen).toHaveAttribute("data-page", "sound");
  await pad(12);
  await expect(screen).toHaveAttribute("data-page", "clips");
  await menu(13);
  await pad(12);
  await expect
    .poll(async () => {
      const p = await openProject(await saved(page));
      return p.tracks[0].clips.some((c) => c.steps.length > 0);
    })
    .toBe(true);
  const work = await saved(page),
    worked = await openProject(work);
  assert.equal(worked.name, "Untitled");
  assert.equal(worked.performance?.chain.length ?? 0, 0);
  await page.reload();
  await boot();
  assert.deepEqual(await openProject(await saved(page)), worked);
  assert.equal(demoRequests.length, before);
  await page.goto(`${origin}/xmpos/?view=studio`);
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  await expect(page.locator("#project-title")).toHaveText("Untitled");
  assert.equal(demoRequests.length, before);
  assert.deepEqual(await openProject(await saved(page)), worked);
  await page.close();
  const returned = await context.newPage();
  await returned.goto(`${origin}/xmpos/`);
  await expect(returned.locator("#boot-screen")).toHaveCount(0);
  await expect(returned.locator("#device-screen")).toHaveAttribute("data-project", "Untitled");
  assert.deepEqual(await openProject(await saved(returned)), worked);
  assert.equal(demoRequests.length, before);
  // Advanced Studio also starts with Night Shift in an entirely fresh profile.
  const other = await browser.newContext();
  await other.addInitScript(() => {
    try {
      localStorage.setItem("xmp-usage-opt-out", "1");
    } catch {}
  });
  const detail = await other.newPage();
  await detail.goto(`${origin}/xmpos/?view=studio`);
  await expect(detail.locator("#boot-screen")).toHaveCount(0);
  await expect(detail.locator("#project-title")).toHaveText("Night Shift");
  await other.close();
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    origin,
    firstVisit: "Night Shift",
    playProducesMusic: true,
    noAutoplay: true,
    emptyProjectRetained: true,
    newNotesRetained: true,
    returnVisitRetained: true,
    studioSharesProject: true,
    freshStudioDemo: true,
    defaultFetchesForFirstProfile: before,
    pageErrors: errors,
    physicalAudio: false,
  };
  await writeFile(
    join(root, "reports/first-visit/result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await context.close();
  await browser.close();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
}
