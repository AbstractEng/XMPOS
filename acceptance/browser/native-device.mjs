// Exercise the shipped device entry point and compare it with the native
// touchscreen for the shared workflow. This runner uses isolated browser storage.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { synthPresets } from "../../packages/core/src/instrument-schema.ts";
import { openProject, saveSong } from "../../packages/core/src/project-io.ts";
import { factoryKits } from "../../tools/factory-kits.mjs";
import { root } from "../lib/workspace.mjs";

const fixture = join(root, "acceptance/fixtures/device-project.json");
const report = join(root, "reports/native-device");
const nativeOut = join(report, "native");
const browserOut = join(report, "browser");
await mkdir(browserOut, { recursive: true });
execFileSync(join(root, "build/native/xmp_live_project_workflow_test"), [fixture, nativeOut], {
  stdio: "inherit",
});
const existing = process.env.XMP_DEVICE_ORIGIN;
if (existing && !/^http:\/\/127\.0\.0\.1:\d+$/.test(existing))
  throw new Error("Use a loopback XMP_DEVICE_ORIGIN");
const origin = existing || "http://127.0.0.1:4177";
const server = existing
  ? undefined
  : spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        "4177",
        "--strictPort",
      ],
      { cwd: root, stdio: "ignore" },
    );

let browser;
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(origin)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
  const page = await browser.newPage({ viewport: { width: 1720, height: 1080 } });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route(`${origin}/fixture`, (route) =>
    route.fulfill({ body: "<title>XMP test setup</title>", contentType: "text/html" }),
  );
  async function seed(text) {
    await page.goto(`${origin}/fixture`);
    await page.evaluate(
      (initial) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("xmp-studio-v1", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("projects");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("projects", "readwrite");
            tx.objectStore("projects").put(initial, "autosave");
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
        }),
      text,
    );
  }
  const original = await readFile(join(nativeOut, "initial.xmpsong"), "utf8");
  await seed(original);

  const device = page.locator("canvas#device-screen");
  const press = (id) => page.locator(`[data-panel="${id}"]`).click();
  const pad = (number) => page.locator(`[data-pad="${number - 1}"]`).click();
  async function touch(x, y) {
    const bounds = await device.boundingBox();
    assert(bounds, "Touchscreen is visible");
    await page.mouse.click(
      bounds.x + (x * bounds.width) / 1280,
      bounds.y + (y * bounds.height) / 800,
    );
  }
  function stored(key) {
    return page.evaluate(
      (requested) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("xmp-studio-v1", 1);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("projects", "readonly");
            const got = tx.objectStore("projects").get(requested);
            tx.oncomplete = () => {
              req.result.close();
              resolve(typeof got.result === "string" ? got.result : got.result?.text);
            };
            tx.onabort = () => reject(tx.error);
          };
        }),
      key,
    );
  }
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  async function snapshot(name) {
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    const pixels = await device.evaluate((canvas) => {
      const p = canvas.getContext("2d").getImageData(0, 72, 1140, 670).data;
      const rgb = new Uint8Array((p.length / 4) * 3);
      for (let i = 0, j = 0; i < p.length; i += 4, j += 3) {
        rgb[j] = p[i];
        rgb[j + 1] = p[i + 1];
        rgb[j + 2] = p[i + 2];
      }
      return {
        image: canvas.toDataURL(),
        pixels: Array.from({ length: Math.ceil(rgb.length / 32768) }, (_, i) =>
          btoa(String.fromCharCode(...rgb.subarray(32768 * i, 32768 * (i + 1)))),
        ),
      };
    });
    await writeFile(
      join(browserOut, `${name}.png`),
      Buffer.from(pixels.image.split(",")[1], "base64"),
    );
    const ppm = await readFile(join(nativeOut, `${name}.ppm`));
    const rows = [];
    for (let y = 72; y < 742; ++y) {
      const start = "P6\n1280 800\n255\n".length + y * 1280 * 3;
      rows.push(ppm.subarray(start, start + 1140 * 3));
    }
    assert.equal(
      sha(Buffer.concat(pixels.pixels.map((chunk) => Buffer.from(chunk, "base64")))),
      sha(Buffer.concat(rows)),
      `${name}: native and browser page pixels`,
    );
  }

  await page.goto(origin);
  await expect(device).toHaveAttribute("data-project", "Parity original");
  const replay = JSON.parse(await readFile(fixture, "utf8"));
  for (const [step, [kind, a, b]] of replay.entries()) {
    try {
      if (kind === "menu") await press("menu");
      else if (kind === "hold-menu") {
        const menu = page.locator('[data-panel="menu"]');
        await menu.scrollIntoViewIfNeeded();
        const bounds = await menu.boundingBox();
        assert(bounds, "Menu button is visible");
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await expect(device).toHaveAttribute("data-page", "menu");
        await page.waitForTimeout(a);
        await page.mouse.up();
        await expect(menu).toHaveAttribute("aria-pressed", "false");
      } else if (kind === "touch") await touch(a, b);
      else if (kind === "pad") await pad(a);
      else if (kind === "delete") {
        await page.keyboard.down("Shift");
        try {
          await press("copy");
        } finally {
          await page.keyboard.up("Shift");
        }
      } else if (kind === "playing-empty") {
        await expect(page.locator('[data-panel="play"]')).toHaveAttribute("data-led", "on");
        await expect(device).toHaveAttribute("data-message", /Slot removed/);
      } else if (kind === "saved-empty") {
        await expect
          .poll(async () => {
            const text = await stored("autosave");
            if (!text) return false;
            const project = await openProject(text);
            return !project.scenes[0].clips[project.tracks[0].id];
          })
          .toBe(true);
      } else if (kind === "undo") await press("undo");
      else if (kind === "verify") {
        await expect(device).toHaveAttribute("data-page", a.toLowerCase());
        await expect(device).toHaveAttribute("data-project", b);
      } else if (kind === "saved") {
        const key = a === "project.xmpsong" ? "autosave" : `copy:${a.toLowerCase()}`;
        await expect
          .poll(async () => {
            const text = await stored(key);
            return text ? (await openProject(text)).name : undefined;
          })
          .toBe(b);
      } else if (kind === "saved-clip") {
        await expect
          .poll(async () => {
            const text = await stored("autosave");
            if (!text) return null;
            const project = await openProject(text);
            const track = project.tracks[0];
            const clip = track.clips.find((item) => item.id === project.scenes[0].clips[track.id]);
            return clip ? [clip.length, clip.steps.length] : null;
          })
          .toEqual([a, b]);
      } else if (kind === "image") await snapshot(a);
    } catch (error) {
      throw new Error(`Project step ${step + 1}: ${kind} ${a ?? ""} ${b ?? ""}`, { cause: error });
    }
  }
  await expect
    .poll(async () => (await openProject(await stored("autosave"))).name)
    .toBe("Parity original");
  await page.reload();
  await expect(device).toHaveAttribute("data-project", "Parity original");
  await press("menu");
  await touch(970, 230);
  await expect(device).toHaveAttribute("data-page", "sound");
  await touch(565, 673);
  await touch(145, 270);
  await expect(device).toHaveAttribute("data-message", /Edit kept/);
  const factory = await factoryKits();
  const names = [
    "Kick",
    "Kick",
    "Kick",
    ...factory.entries.map((entry) => JSON.parse(factory.assets.get(entry.file)).samples[0].name),
  ];
  for (const [kit, firstPad] of names.entries()) {
    await touch(790, 674);
    await expect(device).toHaveAttribute("data-page", "browse");
    for (let i = 0; i < kit; ++i)
      await page.getByRole("button", { name: "Turn data dial clockwise" }).click();
    await touch(554, 674);
    await expect(device).toHaveAttribute("data-page", "sound");
    await expect(device).toHaveAttribute("data-message", /Kit loaded/);
    await expect(page.locator('[data-pad="0"]')).toHaveAttribute(
      "aria-label",
      `Pad 1: ${firstPad}`,
    );
  }
  await device.screenshot({ path: join(browserOut, "06-kit-sound.png") });

  await touch(565, 673);
  await touch(660, 270);
  for (const [index, preset] of synthPresets.entries()) {
    const slot = index % 16;
    const row = Math.floor(slot / 4);
    if (slot === 0 && index > 0) await touch(345, 674);
    if (slot === 15) await touch(990, 515);
    else await pad(13 - row * 4 + (slot % 4));
    await expect(device).toHaveAttribute("data-message", `Track 1: ${preset.name}`);
  }
  console.log(
    "Loaded all seven kits and selected all 32 synth presets across two 4×4 banks in the web touchscreen.",
  );
  // A project with six other independent kits and a full shared bank.
  // Both factory loads crossed the older limits on a populated Live.
  const busy = await openProject(original);
  busy.name = "Populated kit test";
  busy.samples = Array.from({ length: 112 }, (_, i) => ({
    id: `busy-sample-${i}`,
    name: `Retained ${i}`,
    sampleRate: 24000,
    pcm: Array.from({ length: 8200 }, (_, j) => (j === 0 ? i / 128 : 0)),
  }));
  const savedBanks = busy.tracks.slice(1, 7);
  for (const [bank, track] of savedBanks.entries())
    track.pads = busy.pads.map((pad, i) => ({
      ...pad,
      name: `Retained ${bank + 1}-${i}`,
      sampleId: `busy-sample-${(bank + 1) * 16 + i}`,
    }));
  busy.pads = busy.pads.map((pad, i) => ({ ...pad, sampleId: `busy-sample-${i}` }));
  await seed(await saveSong(busy));
  await page.goto(origin);
  await expect(device).toHaveAttribute("data-project", busy.name, { timeout: 25000 });
  await press("menu");
  await pad(16);
  await expect(device).toHaveAttribute("data-page", "sound");
  await pad(13);
  await expect(device).toHaveAttribute("data-message", /Edit kept/);
  async function checkBudgetKit(index, description, condition) {
    if ((await device.getAttribute("data-page")) !== "sound") {
      await press("menu");
      await pad(16);
      await expect(device).toHaveAttribute("data-page", "sound");
    }
    await press("shift");
    await press("menu");
    await pad(16);
    await expect(device).toHaveAttribute("data-page", "browse");
    for (let i = 0; i < index; ++i)
      await page.getByRole("button", { name: "Turn data dial clockwise" }).click();
    await pad(8);
    await expect(device).toHaveAttribute("data-page", "sound", { timeout: 25000 });
    await expect(device).toHaveAttribute("data-message", /Kit loaded/);
    await expect
      .poll(
        async () => {
          const text = await stored("autosave");
          if (!text) return false;
          const saved = await openProject(text);
          return condition(saved);
        },
        { timeout: 25000 },
      )
      .toBe(true);
    const saved = await openProject(await stored("autosave"));
    assert.deepEqual(
      saved.tracks.slice(1, 7).map((track) => track.pads),
      savedBanks.map((track) => track.pads),
    );
    assert.deepEqual(saved.samples.slice(0, 112), busy.samples);
    console.log(`${description} loaded and autosaved with the six other kits unchanged.`);
  }
  await checkBudgetKit(
    5,
    "Octal Punch",
    (project) =>
      project.tracks[0].pads?.some((p) => p.name === "Kick Punch") &&
      project.samples.reduce((frames, sample) => frames + sample.pcm.length, 0) > 1000000,
  );
  await checkBudgetKit(
    3,
    "Velvet",
    (project) =>
      project.tracks[0].pads?.every((p) => p.layers?.length >= 2) && project.samples.length > 128,
  );
  assert.deepEqual(browserErrors, []);

  console.log(
    `Browser passed ${replay.length} shared steps, matched ${replay.filter(([kind]) => kind === "image").length} screenshots, and restored the autosave after reload.`,
  );
} finally {
  await browser?.close();
  server?.kill();
}
