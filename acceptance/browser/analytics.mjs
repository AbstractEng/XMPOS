// Hosted bundle -> real browser interactions -> Worker handlers -> SQLite ->
// private dashboard. Isolated local data only; never records a visitor or audio.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import worker from "../../tools/web-host/worker.mjs";
import { root } from "../lib/workspace.mjs";

const sql = new DatabaseSync(":memory:");
sql.exec(readFileSync(resolve(root, "tools/web-host/migrations/0001_usage.sql"), "utf8"));
const db = {
  prepare(query) {
    return {
      bind(...values) {
        const ordered = [...query.matchAll(/\?(\d+)/g)].map((m) => values[Number(m[1]) - 1]);
        const statement = sql.prepare(query.replace(/\?\d+/g, "?"));
        return {
          run: async () => ({ success: true, results: [], meta: statement.run(...ordered) }),
          all: async () => ({ success: true, results: statement.all(...ordered) }),
        };
      },
    };
  },
  async batch(statements) {
    return Promise.all(statements.map((s) => s.all()));
  },
};
const token = "Q".repeat(43),
  env = { ANALYTICS_DB: db, ANALYTICS_KEY_HASH: createHash("sha256").update(token).digest("hex") };
const directory = resolve(root, "reports/web-analytics");
mkdirSync(directory, { recursive: true });
const server = await preview({
  mode: "hosted",
  preview: { host: "127.0.0.1", port: 0, open: false },
});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
const snapshots = [],
  errors = [];
async function context(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    ...options,
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/api/analytics/**", async (route) => {
    const r = route.request();
    if (r.url().includes("/collect")) snapshots.push(JSON.parse(r.postData() ?? "{}"));
    const result = await worker.fetch(
      new Request(r.url(), {
        method: r.method(),
        headers: await r.allHeaders(),
        ...(r.method() === "POST" ? { body: r.postDataBuffer() } : {}),
      }),
      env,
    );
    await route.fulfill({
      status: result.status,
      headers: Object.fromEntries(result.headers),
      ...(result.status === 204 ? {} : { body: await result.text() }),
    });
  });
  return context;
}
try {
  const c = await context(),
    page = await c.newPage();
  await page.goto(`${origin}/xmpos/`);
  const screen = page.locator("#device-screen");
  await expect(screen).toBeVisible();
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  await page.locator('[data-panel="main"]').click();
  await expect(screen).toHaveAttribute("data-page", "clips");
  await page.locator('[data-panel="menu"]').click();
  await page.locator('[data-pad="12"]').click();
  await expect(screen).toHaveAttribute("data-page", "play");
  await page.locator('[data-pad="12"]').click();
  await page.keyboard.press("1");
  await page.locator('[data-panel="menu"]').click();
  await page.locator('[data-pad="4"]').click();
  await page.locator('[data-pad="14"]').click();
  await expect(screen).toHaveAttribute("data-message", /Project saved/);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "private-input";
    document.body.append(input);
  });
  await page.locator("#private-input").fill("private-song-name-never-report");
  await expect.poll(async () => screen.getAttribute("data-page")).not.toBe("menu");
  await page.waitForTimeout(700);
  await page.goto(`${origin}/xmpos/analytics/`);
  await expect
    .poll(() => snapshots.some((s) => s.counters?.["feature:project_save"] > 0))
    .toBe(true);
  const latest = snapshots.at(-1);
  assert.equal(
    latest.counters["control:pad-13:play"],
    2,
    "pointer and keyboard pads each count once",
  );
  assert.equal(JSON.stringify(snapshots).includes("private-song-name-never-report"), false);
  await page.locator("#key").fill("R".repeat(43));
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(page.locator("#status")).toContainText("not accepted");
  await page.locator("#key").fill(token);
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#features")).toContainText("Project Save");
  await expect(page.locator("#controls")).toContainText("Pad 13");
  await page.locator("#days").selectOption("90");
  await expect(page.locator("#status")).toBeEmpty();
  const download = page.waitForEvent("download");
  await page.locator("#download").click();
  const file = await download;
  const csv = readFileSync(await file.path(), "utf8");
  assert.match(csv, /feature:project_save/);
  assert.equal(csv.includes(latest.id), false);
  await page.screenshot({ path: resolve(directory, "dashboard-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#metrics")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(directory, "dashboard-mobile.png"), fullPage: true });
  await page.locator("#logout").click();
  await expect(page.locator("#dashboard")).toBeHidden();
  await expect(page.locator("#metrics")).toBeEmpty();
  await c.close();
  const studio = await context(),
    studioPage = await studio.newPage();
  await studioPage.goto(`${origin}/xmpos/?view=studio`);
  await expect(studioPage.locator("#boot-screen")).toHaveCount(0);
  await studioPage.locator("#help").click();
  await studioPage.goto(`${origin}/xmpos/analytics/`);
  await expect
    .poll(() =>
      snapshots.some((s) => s.workspace === "studio" && s.counters?.["control:help:studio"] === 1),
    )
    .toBe(true);
  await studio.close();
  for (const privacy of ["opt-out", "dnt", "gpc"]) {
    const c = await context();
    await c.addInitScript((mode) => {
      if (mode === "opt-out" && location.protocol.startsWith("http"))
        localStorage.setItem("xmp-usage-opt-out", "1");
      if (mode === "dnt") Object.defineProperty(navigator, "doNotTrack", { value: "1" });
      if (mode === "gpc") Object.defineProperty(navigator, "globalPrivacyControl", { value: true });
    }, privacy);
    const before = snapshots.length,
      p = await c.newPage();
    await p.goto(`${origin}/xmpos/`);
    await expect(p.locator("#boot-screen")).toHaveCount(0);
    if (privacy === "opt-out") {
      await p.locator(".usage-notice summary").click();
      await p.getByRole("button", { name: "Enable usage analytics" }).click();
      await expect.poll(() => snapshots.length).toBeGreaterThan(before);
      await p.getByRole("button", { name: "Turn off usage analytics" }).click();
    }
    const afterPreference = snapshots.length;
    await p.locator('[data-panel="main"]').click();
    await p.locator('[data-pad="12"]').click();
    await p.goto(`${origin}/xmpos/analytics/`);
    assert.equal(snapshots.length, afterPreference, privacy);
    await c.close();
  }
  const off = await context();
  await off.route("**/api/analytics/collect", (route) => route.abort());
  const p = await off.newPage();
  await p.goto(`${origin}/xmpos/`);
  await expect(p.locator("#boot-screen")).toHaveCount(0);
  await p.locator('[data-panel="main"]').click();
  await expect(p.locator("#device-screen")).toHaveAttribute("data-page", "clips");
  await off.close();
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    hostedBundle: true,
    anonymousTiming: true,
    semanticFeatures: true,
    buttonCounts: true,
    duplicateSafe: true,
    privateDashboard: true,
    csv: true,
    mobile: true,
    optOut: true,
    dnt: true,
    gpc: true,
    collectorFailureDoesNotBreakMusic: true,
    pageErrors: errors,
    physicalAudio: false,
  };
  writeFileSync(
    resolve(directory, "browser-verification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  sql.close();
}
