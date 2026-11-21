import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { After, Before, BeforeAll, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { armElf, fileLedger, sha } from "../../tools/os/arm-build.mjs";
import { buildDeviceImage } from "../../tools/os/device-build.mjs";
import { deviceScreenshot, finishDeviceVm } from "../../tools/os/device-client.mjs";
import { bootVm, createVmSession, imageIdentity } from "../../tools/os/vm.mjs";
import { buildIdentity, root } from "../lib/workspace.mjs";

setDefaultTimeout(240000);
const report = process.env.XMP_DEVICE_EVIDENCE;
if (!report?.startsWith(join(root, "reports/"))) throw new Error("Use npm run bdd:device-vm");
let image;
BeforeAll({ timeout: 1200000 }, async () => {
  const sourceHash = buildIdentity();
  try {
    image = await imageIdentity(join(root, "artifacts/os/device"));
    if (image.manifest.sourceHash !== sourceHash) image = null;
  } catch {
    image = null;
  }
  if (!image) {
    await buildDeviceImage();
    image = await imageIdentity(join(root, "artifacts/os/device"));
  }
});
Before(async function ({ pickle }) {
  this.directory = await mkdtemp(join(report, "case-"));
  this.name = pickle.name;
  this.evidence = {};
});
After(async function ({ result }) {
  try {
    if (this.vm) {
      try {
        this.evidence.finalStatus = await this.vm.request({ op: "device-status" });
        assert.deepEqual(this.evidence.finalStatus.errors, []);
        assert.deepEqual(this.evidence.finalStatus.attempts, []);
      } finally {
        const vm = this.vm;
        this.vm = null;
        this.evidence.shutdown = await finishDeviceVm(vm);
        this.evidence.shutdownVerified = true;
      }
    }
  } finally {
    await writeFile(
      join(this.directory, "evidence.json"),
      JSON.stringify(
        {
          scenario: this.name,
          outcome: this.evidence.shutdownVerified ? result.status : "FAILED",
          sourceHash: buildIdentity(),
          buildId: image.manifest.buildId,
          ...this.evidence,
          physicalDeviceOperations: [],
          hardwareQualified: false,
        },
        null,
        2,
      ),
    );
  }
});
const control = (w, kind, id) => w.vm.request({ op: "device-control", kind, id: String(id) });
const panel = (w, id) => control(w, "panel", id);
const select = (w, id, value) => w.vm.request({ op: "device-select", id, value: String(value) });
async function page(w, id) {
  await panel(w, "menu");
  await control(w, "page", id);
}
async function poll(w, predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  do {
    const status = await w.vm.request({ op: "device-status" });
    if (predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  throw new Error("Guest UI condition did not become true");
}
async function edit(w, slot) {
  await panel(w, "main");
  await control(w, "slot", slot);
  if ((await w.vm.request({ op: "device-status" })).page.startsWith("CLIPS"))
    await control(w, "action", "enter");
  await poll(w, (s) => s.page.startsWith("STEPS"));
}
Given("the offline Device image is booted in its owned VM", async function () {
  this.session = await createVmSession(join(this.directory, "session"), image.directory);
  this.vm = await bootVm(this.session);
  this.evidence.boot = this.vm.boot;
  this.evidence.qemuArgs = this.vm.args;
});
Then(
  "Chromium renders Device view inside Linux without a host development server",
  async function () {
    const s = await this.vm.request({ op: "device-status" });
    assert.equal(s.device, true);
    assert.equal(s.renderer, "guest-chromium");
    assert.match(s.page, /CLIPS/);
    assert.deepEqual(s.logical, ["1280", "800"]);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(this.vm.boot.networkInterfaces, ["lo"]);
  },
);
Then("the screen has sixteen pads with pad one at the bottom left", async function () {
  const s = await this.vm.request({ op: "device-status" });
  assert.deepEqual(s.pads, [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]);
});
When("I capture the guest Device screen over bounded serial chunks", async function () {
  this.capture = await deviceScreenshot(this.vm);
  await writeFile(join(this.directory, "device.png"), this.capture.png);
  this.evidence.screenshot = this.capture.receipt;
});
Then("the captured PNG matches the guest hash and has the expected dimensions", function () {
  assert.equal(sha(this.capture.png), this.capture.receipt.sha256);
  assert.equal(this.capture.png.readUInt32BE(16), 1600);
  assert.equal(this.capture.png.readUInt32BE(20), 1000);
});
When("I start an empty song using the guest Device controls", async function () {
  await page(this, "project");
  const pending = await control(this, "action", "new");
  assert.match(pending.confirmationRequired, /replace/);
  await this.vm.request({ op: "device-control", kind: "action", id: "new", confirmed: true });
  await poll(this, (s) => s.message.includes("New empty song"));
});
When("I program a four-on-the-floor drum clip in the guest", async function () {
  await edit(this, 12);
  await select(this, "device-sound", 0);
  for (const step of [0, 4, 8, 12]) await control(this, "step", step);
  const s = await poll(this, (s) => s.steps.length === 4);
  assert.deepEqual(s.steps, [0, 4, 8, 12]);
});
When("I add a synth clip on track two and chain two scenes", async function () {
  await panel(this, "bank-b");
  await page(this, "sound");
  await control(this, "pad", 2); // Pad 3 chooses the subtractive synth.
  await edit(this, 13);
  await select(this, "device-sound", 7);
  for (const pad of [12, 4]) await control(this, "pad", pad); // Steps 1 and 9.
  await panel(this, "main");
  await panel(this, "copy");
  await control(this, "pad", 9); // Copy to scene two; the copy is immediate.
  await control(this, "action", "enter");
  await select(this, "device-sound", 12);
  await control(this, "pad", 0); // Step 13.
  await page(this, "song");
  for (const scene of ["scene-0", "scene-1"]) {
    await select(this, "device-scene", scene);
    await control(this, "action", "add-scene");
  }
});
When("I play and stop the guest song using the Live front panel", async function () {
  await panel(this, "play-start");
  await poll(this, (s) => s.transport.includes("PLAY"));
  await poll(this, (s) => s.clock !== "01 : 01");
  await panel(this, "stop");
  await poll(this, (s) => s.transport === "STOPPED");
});
Then("the guest portable project contains both machines and the song chain", async function () {
  this.saved = await this.vm.request({ op: "device-export" });
  assert.equal(this.saved.tracks[0].machine, "xmp.sampler");
  assert.equal(this.saved.tracks[1].machine, "xmp.subtractive");
  assert.equal(this.saved.tracks[0].clips[0].steps, 4);
  assert.equal(this.saved.tracks[1].clips[0].steps, 2);
  assert.equal(this.saved.tracks[1].clips[1].steps, 3);
  assert.equal(this.saved.songParts, 2);
  assert.deepEqual(this.saved.songChain, ["scene-0", "scene-1"]);
  assert.equal(this.saved.persistedInGuest, true);
  this.evidence.project = this.saved;
});
When("I cleanly shut down and cold boot the same owned VM disk", async function () {
  const vm = this.vm;
  this.vm = null;
  this.evidence.firstShutdown = await finishDeviceVm(vm);
  this.vm = await bootVm(this.session);
  this.evidence.coldBoot = this.vm.boot;
});
Then("the guest Device project retains the clips and song chain", async function () {
  assert.deepEqual(await this.vm.request({ op: "device-export" }), this.saved);
});
When("invalid Device actions and physical deployment requests are submitted", async function () {
  for (const command of [
    { op: "device-click", x: -1, y: 0 },
    { op: "device-click", x: 1600, y: 0 },
    { op: "device-control", kind: "action", id: "../shell" },
    { op: "device-select", id: "device-machine", value: "external://module" },
    { op: "flash", device: "Force" },
    { op: "device-status", script: "process.exit()" },
  ])
    await assert.rejects(this.vm.request(command));
  await assert.rejects(createVmSession("/dev/disk0", image.directory));
  await assert.rejects(bootVm({ disk: "/dev/disk0" }));
});
Then("those requests are rejected and the guest interface remains usable", async function () {
  const s = await this.vm.request({ op: "device-status" });
  assert.equal(s.device, true);
  assert.deepEqual(s.errors, []);
  await panel(this, "menu");
  await poll(this, (s) => s.page.startsWith("MENU"));
});
Then("no physical device API, network adapter or host share was used", async function () {
  assert.deepEqual((await this.vm.request({ op: "device-status" })).attempts, []);
  assert.equal(this.vm.boot.hostShares, false);
  assert.equal(this.vm.args[this.vm.args.indexOf("-nic") + 1], "none");
  assert.ok(
    !this.vm.args.some((a) => /usb-host|hostfwd|virtfs|fsdev|coreaudio|host_device/.test(a)),
  );
});
Then(
  "the ARM pipeline contains static hard-float binaries and the offline Device assets",
  async function () {
    const latest = JSON.parse(await readFile(join(root, "artifacts/arm/latest.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(latest.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.sourceHash, buildIdentity());
    assert.equal(manifest.target, "arm-linux-musleabihf");
    assert.deepEqual(await fileLedger(join(latest.directory, "studio")), manifest.files);
    for (const [name, b] of Object.entries(manifest.binaries)) {
      const bytes = await readFile(join(latest.directory, "bin", name));
      assert.equal(sha(bytes), b.sha256);
      assert.equal(armElf(bytes).hardFloat, true);
      assert.equal(image.manifest.overlay[`arm/bin/${name}`], b.sha256);
    }
    assert.ok(manifest.files["index.html"]);
    assert.equal(manifest.deviceViewDefault, true);
    this.evidence.armManifest = manifest;
  },
);
When("the ARM sampler and engine tests execute under emulation inside Linux", async function () {
  const tests = [];
  for (const name of [
    "sampler",
    "render-short",
    "exhaustion",
    "tempo",
    "commands",
    "critical",
    "canary",
  ]) {
    tests.push(await this.vm.request({ op: "arm-test", name }));
  }
  this.arm = { ...(await this.vm.request({ op: "arm-parity" })), tests };
  this.evidence.arm = this.arm;
});
Then("all native timing, queue, safe-state and callback audit tests pass on ARM", function () {
  assert.equal(this.arm.execution, "qemu-arm-inside-linux-guest");
  assert.deepEqual(
    this.arm.tests.map((t) => t.name),
    ["sampler", "render-short", "exhaustion", "tempo", "commands", "critical", "canary"],
  );
  const render = JSON.parse(this.arm.tests.find((t) => t.name === "render-short").output);
  assert.equal(render.frames, 48000);
  for (const key of [
    "allocations",
    "frees",
    "locks",
    "files",
    "network",
    "nonFinite",
    "rangeErrors",
  ])
    assert.equal(render[key], 0);
  const canary = JSON.parse(this.arm.tests.find((t) => t.name === "canary").output);
  for (const key of ["allocations", "locks", "files", "network"]) assert.ok(canary[key] > 0);
});
Then("ARM DSP fixtures match the reference PCM and reject malformed plans", function () {
  assert.equal(this.arm.parity.length, 5);
  for (const p of this.arm.parity) assert.equal(p.passed, true);
  assert.equal(this.arm.malformedRejected, true);
  assert.equal(this.arm.sourceHash, buildIdentity());
});
Then("MPC boot, drivers and physical audio qualification remain pending", function () {
  assert.equal(image.manifest.mpcBootable, false);
  assert.equal(image.manifest.mpcDriversQualified, false);
  assert.equal(image.manifest.physicalAudioQualified, false);
  assert.equal(this.arm.physicalAccess, false);
});
