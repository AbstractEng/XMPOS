import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { ARM_DEVICE_IMAGE, buildArmDeviceImage } from "../../tools/live-mk1/device-build.mjs";
import {
  buildG1Userspace,
  G1_COMPONENTS,
  verifyG1Archives,
} from "../../tools/live-mk1/g1-userspace.mjs";
import { deviceScreenshot, finishDeviceVm } from "../../tools/os/device-client.mjs";
import { bootVm, createVmSession, imageIdentity } from "../../tools/os/vm.mjs";
import { buildIdentity, json, root } from "../lib/workspace.mjs";

const G1_TOOLS = ["aplay", "amixer", "alsactl", "gpiodetect", "gpioinfo", "listdevs"];

async function latestG1() {
  const pointer = join(root, "artifacts/live-mk1/latest-g1-userspace.json");
  if (!existsSync(pointer)) return null;
  const directory = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    const verified = await verifyG1Archives();
    const current = manifest.officialSource.archives.every((a) =>
      verified.some((v) => v.archive === a.archive && v.sha256 === a.sha256),
    );
    return current ? { directory, manifest } : null;
  } catch {
    return null;
  }
}

// LK10
Given(
  "the official G1 ALSA, libgpiod and libusb archives match their catalog hashes",
  async function () {
    this.archives = await verifyG1Archives();
    assert.deepEqual(
      this.archives.map((a) => a.id),
      G1_COMPONENTS.map((c) => c.id),
    );
  },
);
When("I cross-build them in the locked-down container", { timeout: 3600000 }, async function () {
  this.g1 = (await latestG1()) ?? (await buildG1Userspace());
  this.evidence.g1 = { directory: this.g1.directory, binaries: this.g1.manifest.binaries };
});
Then(
  "aplay, amixer, alsactl, gpiodetect, gpioinfo and listdevs are static ARMv7 hard-float programs",
  function () {
    for (const tool of G1_TOOLS) {
      const binary = this.g1.manifest.binaries[tool];
      assert.ok(binary, tool);
      assert.deepEqual(
        {
          machine: binary.machine,
          bits: binary.bits,
          hardFloat: binary.hardFloat,
          static: binary.static,
        },
        { machine: "ARM", bits: 32, hardFloat: true, static: true },
        tool,
      );
    }
  },
);
Then("the manifest records each official archive, its hash and licence", function () {
  const recorded = this.g1.manifest.officialSource.archives;
  for (const archive of this.archives) {
    const entry = recorded.find((r) => r.archive === archive.archive);
    assert.equal(entry?.sha256, archive.sha256);
    assert.ok(entry.license && entry.officialPath.startsWith("arm-poky-linux-gnueabi/"));
  }
  assert.equal(
    this.g1.manifest.officialSource.commit,
    json(join(root, "references/official-g1-sources.json")).commit,
  );
  assert.equal(this.g1.manifest.deployable, false);
});
Then("the published G1 ALSA state contains no MPC mixer settings", async function () {
  const conf = await readFile(join(this.g1.directory, "share/asound.conf"), "utf8");
  assert.equal(conf.trim(), "# Global alsa-lib configuration");
  assert.match(this.g1.manifest.alsaStateNote, /no MPC mixer state is published/);
});

// LK11
Given("a G1 catalog entry whose hash does not match the local archive", function () {
  const catalog = json(join(root, "references/official-g1-sources.json"));
  this.catalog = {
    ...catalog,
    downloaded: catalog.downloaded.map((d) =>
      d.localPath.endsWith("alsa-lib-1.2.11-r0-patched.tar.xz")
        ? { ...d, sha256: "0".repeat(64) }
        : d,
    ),
  };
  this.artifactsBefore = existsSync(join(root, "artifacts/live-mk1/latest-g1-userspace.json"))
    ? json(join(root, "artifacts/live-mk1/latest-g1-userspace.json"))
    : null;
});
When("the G1 userspace build verifies its sources", async function () {
  try {
    await verifyG1Archives(this.catalog);
    this.error = null;
  } catch (error) {
    this.error = error;
  }
});
Then("it stops before anything is extracted or built", function () {
  assert.match(
    this.error?.message ?? "",
    /alsa-lib-1\.2\.11-r0-patched\.tar\.xz does not match the official G1 hash/,
  );
  const after = existsSync(join(root, "artifacts/live-mk1/latest-g1-userspace.json"))
    ? json(join(root, "artifacts/live-mk1/latest-g1-userspace.json"))
    : null;
  assert.deepEqual(after, this.artifactsBefore);
});

// LK05 additions
Then("the G1-built ALSA tools list the USB audio card and play a test tone into it", function () {
  const tests = this.boot.tests;
  assert.equal(tests["g1-aplay-list"]?.exit, 0, tests["g1-aplay-list"]?.output);
  assert.match(tests["g1-aplay-list"].output, /card 0: .*USB/i);
  assert.equal(tests["g1-aplay-tone"]?.exit, 0, tests["g1-aplay-tone"]?.output);
  assert.ok(this.boot.usbAudio.rms > 0.1, JSON.stringify(this.boot.usbAudio));
});
Then(
  "the G1-built gpiodetect and listdevs see the board's GPIO controller and USB devices",
  function () {
    const tests = this.boot.tests;
    assert.equal(tests["g1-gpiodetect"]?.exit, 0, tests["g1-gpiodetect"]?.output);
    assert.match(tests["g1-gpiodetect"].output, /gpiochip0 \[.*pl061|gpiochip0/i);
    assert.equal(tests["g1-listdevs"]?.exit, 0, tests["g1-listdevs"]?.output);
    // QEMU's emulated USB audio device, behind the xHCI root hub.
    assert.match(tests["g1-listdevs"].output, /46f4:0002/);
  },
);

// LK12
let armImage;
Given(
  "the ARMv7 Device image is booted in its owned VM on the official az01 kernel",
  { timeout: 3600000 },
  async function () {
    if (!armImage) {
      try {
        armImage = await imageIdentity(join(root, ARM_DEVICE_IMAGE));
        if (armImage.manifest.sourceHash !== buildIdentity()) armImage = null;
      } catch {
        armImage = null;
      }
      if (!armImage) {
        await buildArmDeviceImage();
        armImage = await imageIdentity(join(root, ARM_DEVICE_IMAGE));
      }
    }
    assert.equal(armImage.manifest.profile, "device-qemu-armv7-az01-v1");
    assert.equal(armImage.manifest.architecture, "armv7");
    this.session = await createVmSession(join(this.directory, "session"), armImage.directory);
    this.vm = await bootVm(this.session);
    this.evidence.armBoot = this.vm.boot;
    this.evidence.buildId = armImage.manifest.buildId;
  },
);
Then("the guest reports the az01 real-time kernel and a loopback-only network", function () {
  assert.match(this.vm.boot.kernel, /^6\.18\.44-az01-.*-rt\d+$/);
  assert.deepEqual(this.vm.boot.networkInterfaces, ["lo"]);
  assert.equal(this.vm.boot.physicalAccess, false);
});
Then(
  "Chromium renders Device view on ARM with sixteen pads and pad one at the bottom left",
  { timeout: 900000 },
  async function () {
    const end = Date.now() + 600000;
    let status;
    do {
      status = await this.vm.request({ op: "device-status" });
      if (status.device && /CLIPS/.test(status.page)) break;
      await new Promise((r) => setTimeout(r, 2000));
    } while (Date.now() < end);
    assert.equal(status.renderer, "guest-chromium");
    assert.match(status.page, /CLIPS/);
    assert.deepEqual(status.errors, []);
    assert.deepEqual(status.pads, [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]);
    const capture = await deviceScreenshot(this.vm);
    assert.equal(capture.png.readUInt32BE(16), 1600);
    assert.equal(capture.png.readUInt32BE(20), 1000);
    await writeFile(join(this.directory, "arm-device.png"), capture.png);
    this.evidence.screenshot = capture.receipt;
  },
);
When("XMP's ARM engine tests run natively in the guest", { timeout: 1800000 }, async function () {
  this.armTests = [];
  for (const name of ["sampler", "render-short", "tempo", "commands", "critical"])
    this.armTests.push(await this.vm.request({ op: "arm-test", name }));
  this.evidence.armTests = this.armTests;
});
Then("they pass without user-mode emulation", function () {
  for (const result of this.armTests) {
    assert.equal(result.execution, "native-armv7-official-az01-kernel", result.name);
    assert.ok(result.output.length > 0, result.name);
  }
});
Then(
  "the hardware probe uses the G1-built tools and reports a development host with USB audio",
  async function () {
    const probe = await this.vm.request({ op: "hardware-probe" });
    this.evidence.probe = probe;
    assert.equal(probe.profile.status, "development-host");
    assert.equal(probe.profile.kernel.officialAz01, true);
    assert.equal(probe.profile.kernel.realtime, true);
    assert.equal(probe.profile.audio.usbAudio, "present");
    assert.match(probe.g1.aplay, /card 0: .*USB/i);
    assert.match(probe.g1.listdevs, /46f4:0002/);
  },
);
Then(
  "the ARM VM shuts down cleanly with its data disk flushed",
  { timeout: 600000 },
  async function () {
    const vm = this.vm;
    this.vm = null;
    this.evidence.shutdown = (await finishDeviceVm(vm)).code;
  },
);
After({ timeout: 600000 }, async function () {
  if (this.vm) {
    const vm = this.vm;
    this.vm = null;
    try {
      await finishDeviceVm(vm);
    } catch {
      /* evidence already records the failure */
    }
  }
});
