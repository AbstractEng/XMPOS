import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AfterAll, BeforeAll, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderProjectScene } from "../../packages/core/src/edits.ts";
import { toggleStep } from "../../packages/core/src/index.ts";
import { buildDeviceImage } from "../../tools/os/device-build.mjs";
import { downloadVmSong, finishDeviceVm, uploadVmFile } from "../../tools/os/device-client.mjs";
import { bootVm, createVmSession, imageIdentity } from "../../tools/os/vm.mjs";
import { songFixture } from "../lib/portable-song-fixture.mjs";
import { buildIdentity, root, sha256 } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

setDefaultTimeout(240000);
const output = process.env.XMP_SONG_VM_EVIDENCE;
if (!output?.startsWith(join(root, "reports/"))) throw new Error("Use npm run bdd:songs:vm");
let image, server, browser, origin, vm, directory, fixture, fromBrowser, fromVm, expected;
const contexts = [],
  errors = [],
  evidence = { physicalDeviceOperations: [], hardwareQualified: false };
BeforeAll({ timeout: 1200000 }, async () => {
  try {
    image = await imageIdentity(join(root, "artifacts/os/device"));
    if (image.manifest.sourceHash !== buildIdentity()) image = null;
  } catch {
    image = null;
  }
  if (!image) {
    await buildDeviceImage();
    image = await imageIdentity(join(root, "artifacts/os/device"));
  }
  directory = await mkdtemp(join(output, "case-"));
  fixture = songFixture();
  // Build finishes before starting this browser; no shared dist writes or competing VM boots.
  server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-audio-output", "--mute-audio"],
  });
});
AfterAll(async () => {
  try {
    if (vm) {
      const current = vm;
      vm = null;
      evidence.shutdown = await finishDeviceVm(current);
    }
    assert.deepEqual(errors, []);
  } finally {
    for (const c of contexts) await c.close();
    await browser?.close();
    await server?.close();
    if (directory)
      await writeFile(
        join(directory, "evidence.json"),
        JSON.stringify(
          { ...evidence, sourceHash: buildIdentity(), buildId: image?.manifest.buildId, errors },
          null,
          2,
        ),
      );
  }
});
async function page() {
  const context = await browser.newContext({
    permissions: [],
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  });
  contexts.push(context);
  await context.route("**/*", async (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await context.addInitScript(() => {
    globalThis.__xmpHardwareAttempts = [];
    for (const [o, names] of [
      [navigator, ["requestMIDIAccess"]],
      [navigator.usb, ["requestDevice", "getDevices"]],
      [navigator.hid, ["requestDevice", "getDevices"]],
      [navigator.serial, ["requestPort", "getPorts"]],
      [navigator.mediaDevices, ["getUserMedia", "enumerateDevices"]],
    ])
      for (const name of names)
        if (o && typeof o[name] === "function")
          Object.defineProperty(o, name, {
            value: () => {
              globalThis.__xmpHardwareAttempts.push(name);
              throw Error("Physical API prohibited");
            },
          });
  });
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  return p;
}
async function projectPage(p) {
  await p.locator('[data-panel="menu"]').click();
  await p.locator('[data-action="page:project"]').click();
}
async function save(p, name) {
  await projectPage(p);
  await p.getByRole("checkbox", { name: "Package samples with song", exact: true }).check();
  const pending = p.waitForEvent("download");
  await p.getByRole("button", { name: "Save portable project", exact: true }).click();
  const download = await pending,
    path = join(directory, `${name}.xmpsong`);
  await download.saveAs(path);
  return readFile(path);
}
Given("a packaged song has been saved by the desktop Device browser", async () => {
  const p = await page(),
    path = join(directory, "initial.xmp.json");
  await writeFile(path, await exportPortable(fixture.project));
  await p.locator("#device-project-file").setInputFiles(path);
  await expect(p.locator(".screen-header")).toContainText(fixture.project.name);
  fromBrowser = await save(p, "desktop-song");
  assert.deepEqual(await importPortable(fromBrowser.toString("utf8")), fixture.project);
  evidence.browserFileSha256 = sha256(fromBrowser);
});
Given("the offline Linux Device image is booted with no hardware access", async () => {
  const session = await createVmSession(join(directory, "session"), image.directory);
  vm = await bootVm(session);
  assert.deepEqual(vm.boot.networkInterfaces, ["lo"]);
  assert.equal(vm.boot.hostShares, false);
  assert.ok(!vm.args.some((a) => /usb-host|hostfwd|virtfs|coreaudio|host_device/.test(a)));
  evidence.boot = vm.boot;
  evidence.args = vm.args;
});
When("I open the browser song through the VM's normal project file input", async () => {
  const result = await uploadVmFile(vm, fromBrowser);
  assert.equal(result.opened, true);
  evidence.import = result;
});
Then("the VM can export the same complete song and sample audio", async () => {
  const file = await downloadVmSong(vm),
    project = await importPortable(file.bytes.toString("utf8"));
  assert.deepEqual(project, fixture.project);
  assert.deepEqual(
    Buffer.from(renderProjectScene(project, "scene-0")),
    Buffer.from(renderProjectScene(fixture.project, "scene-0")),
  );
  evidence.vmRoundTrip = file.receipt;
});
When("I edit the drum clip using the VM's virtual controls", async () => {
  await vm.request({ op: "device-control", kind: "panel", id: "main" });
  await vm.request({ op: "device-control", kind: "slot", id: "12" });
  if ((await vm.request({ op: "device-status" })).page.startsWith("CLIPS"))
    await vm.request({ op: "device-control", kind: "action", id: "enter" });
  for (const command of [
    { op: "device-select", id: "device-sound", value: "0" },
    { op: "device-control", kind: "step", id: "4" },
  ])
    await vm.request(command);
  expected = toggleStep(fixture.project, "drums", "clip-0", 0, 4);
  fromVm = (await downloadVmSong(vm)).bytes;
});
When("I transfer the edited song back to a clean desktop browser", async () => {
  const p = await page(),
    path = join(directory, "from-vm.xmpsong");
  await writeFile(path, fromVm);
  await p.locator("#device-project-file").setInputFiles(path);
  await expect(p.locator(".screen-header")).toContainText(fixture.project.name);
  fromVm = await save(p, "desktop-roundtrip");
});
Then("the desktop retains the VM edit and the remaining song state", async () => {
  const project = await importPortable(fromVm.toString("utf8"));
  assert.deepEqual(project, expected);
  assert.deepEqual(
    Buffer.from(renderProjectScene(project, "scene-0")),
    Buffer.from(renderProjectScene(expected, "scene-0")),
  );
  evidence.editedSongSha256 = sha256(fromVm);
});
Then(
  "invalid transfer chunks are rejected without opening a device or changing the song",
  async () => {
    await vm.request({ op: "device-file-start", kind: "song", bytes: 8, sha256: "0".repeat(64) });
    await assert.rejects(vm.request({ op: "device-file-write", offset: 1, data: "AAAA" }));
    await assert.rejects(vm.request({ op: "device-file-open" }));
    const unchanged = await downloadVmSong(vm);
    assert.deepEqual(await importPortable(unchanged.bytes.toString("utf8")), expected);
    for (const c of contexts)
      for (const p of c.pages())
        assert.deepEqual(await p.evaluate(() => globalThis.__xmpHardwareAttempts), []);
    const status = await vm.request({ op: "device-status" });
    assert.deepEqual(status.attempts, []);
    assert.deepEqual(status.errors, []);
    evidence.invalidChunksRejected = true;
  },
);
