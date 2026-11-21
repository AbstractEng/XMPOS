// Developer-only verification. Every device call uses worker simulation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { chromium } from "@playwright/test";
import { FIRST_PROJECT } from "./first-project.mjs";
import { startInstaller } from "./server.mjs";

const root = resolve(import.meta.dirname, "../../..");
const updater = process.argv[2];
const existingLoaderIndex = process.argv.indexOf("--prepared-loader");
const existingLoader = existingLoaderIndex < 0 ? null : process.argv[existingLoaderIndex + 1];
if (!updater?.endsWith(".app"))
  throw new Error("Pass the owner-local official 3.10.1 updater app; no device is used");
const resources = join(root, "artifacts/installer/XMP OS Installer.app/Contents/Resources");
const workspace = await realpath(await mkdtemp("/private/tmp/xmp-installer-e2e-"));
process.env.XMP_INSTALLER_WORKSPACE = workspace;
process.env.XMP_INSTALLER_RESOURCES = resources;
const reportDir = join(root, "reports/installer");
await mkdir(reportDir, { recursive: true });
const verifyAppSeal = () =>
  execFileSync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    join(root, "artifacts/installer/XMP OS Installer.app"),
  ]);
verifyAppSeal();
const manifest = JSON.parse(await readFile(join(resources, "bundle-manifest.json"), "utf8"));
for (const path of manifest.workspaceFiles) {
  await mkdir(dirname(join(workspace, path)), { recursive: true });
  await copyFile(join(resources, "workspace", path), join(workspace, path));
}
// Borrow a private read-only stock cache using hard links; extraction re-verifies it
// against the signed owner updater on every use. No cached receipt is trusted alone.
const cacheIndex = process.argv.indexOf("--stock-cache");
const cache =
  cacheIndex < 0 ? join(root, "artifacts/live-mk1") : resolve(process.argv[cacheIndex + 1]);
await mkdir(join(workspace, "artifacts/live-mk1"), { recursive: true });
for (const name of await readdir(cache))
  if (/^stock-rootfs-[a-f0-9]{64}\.ext4(?:\.json)?$/.test(name))
    await link(join(cache, name), join(workspace, "artifacts/live-mk1", name));
// Reuse the verified loader through read-only hard links in this isolated
// fixture; a cache miss fails the low-space check rather than modifying it.
if (existingLoader) {
  const at = join(workspace, "artifacts/live-mk1/reused-loader");
  await mkdir(at);
  for (const name of await readdir(existingLoader)) {
    const src = join(existingLoader, name);
    const { lstat } = await import("node:fs/promises");
    if ((await lstat(src)).isFile()) await link(src, join(at, name));
  }
  await writeFile(
    join(workspace, "artifacts/live-mk1/latest-loader-image.json"),
    JSON.stringify({ directory: "artifacts/live-mk1/reused-loader" }),
  );
}
const simulationProfile = process.argv.includes("--legacy") ? "legacy" : "reported";

const requests = [];
const execute = (request, log) =>
  new Promise((done, fail) => {
    requests.push(request.task);
    const worker = new Worker(join(resources, "worker.mjs"), {
      workerData: { resources, workspace, request, simulation: true, simulationProfile },
    });
    let settled = false;
    worker.on("message", (msg) => {
      if (msg.log !== undefined) log(msg.log);
      if (msg.progress !== undefined) log(msg.progress);
      if (msg.error !== undefined) {
        settled = true;
        fail(new Error(msg.error));
      }
      if (msg.result !== undefined) {
        settled = true;
        done(msg.result);
      }
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!settled) fail(new Error(`Worker exited ${code}`));
    });
  });
const instance = await startInstaller({
  execute,
  pick: async (kind) => (kind === "updater" ? updater : existingLoader),
  simulation: true,
  html: await readFile(join(resources, "index.html"), "utf8"),
});
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1150, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(instance.origin);
  await page.getByRole("button", { name: "Choose updater…", exact: true }).click();
  await page.getByRole("button", { name: "Prepare installation files", exact: true }).click();
  await page
    .locator("#status")
    .filter({ hasText: "Loader and stock recovery verified" })
    .waitFor({ timeout: 300000 });
  await page.locator("#stockAddress").fill("192.168.1.50");
  await page.locator("#stockConfirmed").check();
  await page.locator("#verifyStock").click();
  await page
    .locator("#stockStatus")
    .filter({ hasText: "Verified stock 3.10.1" })
    .waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Refresh USB keys", exact: true }).click();
  await page.locator('#usb option[value="simulation-volume"]').waitFor({ state: "attached" });
  await page.locator("#usb").selectOption("simulation-volume");
  await page.locator("#usbConfirmed").check();
  await page.locator("#prepareUsb").click();
  await page
    .locator("#usbStatus")
    .filter({ hasText: "Copied and SHA-256 verified" })
    .waitFor({ timeout: 120000 });
  const firstSong = await readFile(join(workspace, "build/simulated-usb/xmp/project.xmpsong"));
  assert.equal(createHash("sha256").update(firstSong).digest("hex"), FIRST_PROJECT.sha256);
  assert.equal(JSON.parse(firstSong).project.name, "Acid Circuit");
  await page.screenshot({ path: join(reportDir, "prepared.png"), fullPage: true });
  await page.getByRole("button", { name: "Check Live and image", exact: true }).click();
  await page.locator("#confirmation").waitFor();
  await page.locator("#saved").check();
  await page.locator("#baseline").check();
  await page.locator("#phrase").fill("FLASH MPC LIVE");
  assert.equal(await page.locator("#write").isDisabled(), true);
  await page.locator("#phrase").fill("XMPOS");
  assert.equal(await page.locator("#write").isEnabled(), true);
  await page.screenshot({ path: join(reportDir, "confirm.png"), fullPage: true });
  await page.locator("#write").click();
  await page
    .locator("#status")
    .filter({ hasText: "Simulation finished" })
    .waitFor({ timeout: 60000 });
  await page.locator("#mode").selectOption("restore");
  await page.getByRole("button", { name: "Check Live and image", exact: true }).click();
  await page.locator("#confirmation").waitFor({ timeout: 120000 });
  assert.equal(await page.locator("#identity").count(), 0);
  await page.locator("#saved").check();
  await page.locator("#baseline").check();
  await page.locator("#phrase").fill("XMPOS");
  await page.getByRole("button", { name: "Restore stock", exact: true }).click();
  await page
    .locator("#status")
    .filter({ hasText: "Simulation finished" })
    .waitFor({ timeout: 120000 });
  assert.deepEqual(errors, []);
  verifyAppSeal();
  const state = instance.controller.view();
  const result = {
    passed: true,
    simulation: true,
    simulationProfile,
    hardwareContacted: false,
    nativePickerAutomated: false,
    reusedVerifiedLoader: !!existingLoader,
    sourceHash: manifest.sourceHash,
    workspace,
    requests,
    log: state.log,
    testedAt: new Date().toISOString(),
    firstBootDemoVerified: FIRST_PROJECT.name,
  };
  await writeFile(join(reportDir, "packaged-verification.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      hardwareContacted: false,
      workspace,
      sourceHash: manifest.sourceHash,
    }),
  );
} catch (error) {
  const diagnostic = {
    error: error.message,
    state: instance.controller.view(),
    requests,
    browserErrors: errors,
  };
  await writeFile(join(reportDir, "packaged-failure.json"), JSON.stringify(diagnostic, null, 2));
  await page.screenshot({ path: join(reportDir, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  instance.server.closeAllConnections();
  await new Promise((done) => instance.server.close(done));
}
