import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { buildProbeImage, EXPECTED_CHANGES } from "../../tools/live-mk1/probe-image.mjs";
import { testProbeInVm } from "../../tools/live-mk1/probe-vm.mjs";
import { testBootScript } from "../../tools/live-mk1/uboot-test.mjs";

// These scenarios need the owner's copy of Akai's signed updater; they run
// locally only and never flash anything.
const UPDATER = join(homedir(), "Downloads", "MPC (Gen 1) 3.10.0 Updater.app");
const updaterPath = () => process.env.XMP_MPC_UPDATER ?? UPDATER;

Given("Akai's signed MPC 3.10.0 updater is on this Mac", () => {
  assert.ok(existsSync(updaterPath()), "Set XMP_MPC_UPDATER to Akai's MPC 3.10.0 updater app");
});
When("I build the step 4 probe image from it", { timeout: 3600000 }, async function () {
  this.probeImage = await buildProbeImage(updaterPath());
  this.evidence.probeImage = this.probeImage.manifest;
});
Then(
  "only the boot script, which carries the probe initramfs, and the XMP report service differ",
  function () {
    assert.deepEqual(this.probeImage.manifest.changes, EXPECTED_CHANGES);
    // The Live's U-Boot misreads inodes outside block group 0.
    assert.equal(this.probeImage.manifest.ubootInodes.allInGroup0, true);
  },
);
Then(
  "every other file is byte-identical to Akai's root filesystem and the filesystem checks clean",
  function () {
    const manifest = this.probeImage.manifest;
    assert.ok(manifest.unchangedFiles > 10000, String(manifest.unchangedFiles));
    assert.match(manifest.filesystemCheck, /files \(.*non-contiguous\)/);
    assert.match(manifest.source.signedBy, /inMusic/);
  },
);
Then(
  "the image is marked as vendor firmware that is never committed, redistributed or flashed by the tool",
  function () {
    const manifest = this.probeImage.manifest;
    assert.equal(manifest.containsVendorFirmware, true);
    assert.equal(manifest.flashed, false);
    assert.match(manifest.redistribution, /never commit/);
    assert.match(this.probeImage.directory, /\/artifacts\/live-mk1\//);
  },
);

// LK16
Given("the step 4 probe image has been built", () => {
  assert.ok(existsSync("artifacts/live-mk1/latest-probe-image.json"), "Run LK15 first");
});
When(
  "the probe boots on the ARM board with an XMPPROBE card and a protected disk",
  { timeout: 1800000 },
  async function () {
    this.probeVm = (await testProbeInVm()).result;
    this.evidence.probeVm = this.probeVm;
  },
);
Then(
  "it writes one complete report to the card, halts showing success and switches off at the power button",
  function () {
    const run = this.probeVm.withCard;
    assert.equal(run.wroteReport, true);
    assert.equal(run.reports, 1);
    assert.equal(run.reportComplete, true);
    assert.equal(run.reportHasKernel, true);
    assert.equal(run.haltedShowingSuccess, true);
    assert.equal(run.halted, true);
    assert.equal(run.neverRestarted, true);
    // The Live has a battery: the power button must switch the probe off.
    assert.equal(run.powerButtonSwitchesOff, true);
  },
);
Then("the protected disk is byte-identical afterwards", function () {
  assert.equal(this.probeVm.withCard.protectedDiskUnchanged, true);
});
Then("without a card it writes nothing and halts showing the failure", function () {
  assert.equal(this.probeVm.withoutCard.refusedToWrite, true);
  assert.equal(this.probeVm.withoutCard.halted, true);
  assert.equal(this.probeVm.withoutCard.neverRestarted, true);
  assert.equal(this.probeVm.withoutCard.diskUnchanged, true);
});

Then(
  "run as a service inside the stock system it records the fallback stage and exits",
  function () {
    assert.deepEqual(this.probeVm.reportMode, {
      ranAsService: true,
      exitedCleanly: true,
      reports: 1,
      recordsFallbackStage: true,
      reportComplete: true,
      touchedNoScreen: true,
      protectedDiskUnchanged: true,
    });
  },
);

// LK17
When("a real U-Boot boots the image through distro boot", { timeout: 3600000 }, async function () {
  this.uboot = (await testBootScript()).result;
  this.evidence.uboot = this.uboot;
});
Then(
  "the boot script loads Akai's kernel, the device tree and the probe ramdisk and starts the kernel",
  function () {
    assert.deepEqual(this.uboot.probe, {
      scriptFound: true,
      startedProbe: true,
      chosenHasInitrd: true,
      handedToKernel: true,
      fellBack: false,
    });
  },
);
Then(
  "an az01 kernel booted through that script receives the initramfs and runs the probe",
  function () {
    assert.deepEqual(this.uboot.kernel, { received: true, probeRan: true, noInitrdError: true });
  },
);
Then("with the probe ramdisk missing it boots Akai's stock system instead", function () {
  assert.equal(this.uboot.fallback.fellBack, true);
  assert.equal(this.uboot.fallback.startedProbe, false);
  assert.equal(this.uboot.fallback.stockScriptHandedToKernel, true);
});
