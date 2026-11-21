import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { buildAlsaEngine } from "../../tools/live-mk1/alsa-engine-build.mjs";
import { bootKernel } from "../../tools/live-mk1/boot.mjs";
import { assertHostNotThrottled } from "../lib/host-thermal.mjs";
import { buildIdentity, root } from "../lib/workspace.mjs";

// LK13
Given(
  "XMP's ALSA engine is built from this source against the official G1 alsa-lib",
  { timeout: 1800000 },
  async function () {
    const pointer = join(root, "artifacts/live-mk1/latest-alsa-engine.json");
    const latest = existsSync(pointer) ? JSON.parse(await readFile(pointer, "utf8")) : null;
    if (!latest || latest.sourceHash !== buildIdentity()) await buildAlsaEngine();
    const current = JSON.parse(await readFile(pointer, "utf8"));
    const manifest = JSON.parse(
      await readFile(join(resolve(root, current.directory), "manifest.json"), "utf8"),
    );
    assert.equal(manifest.binary.static, true);
    assert.equal(manifest.binary.hardFloat, true);
    assert.match(manifest.alsaLib.archive, /^alsa-lib-1\.2\.11-r0-patched\.tar\.xz$/);
    this.evidence.alsaEngine = manifest;
  },
);
When(
  "the official kernel boots on the ARM board and runs the engine for 20 seconds",
  { timeout: 1800000 },
  async function () {
    this.evidence.hostCpuSpeedFraction = assertHostNotThrottled();
    const { directory, report } = await bootKernel();
    this.engineBoot = report;
    this.evidence.engineBoot = { directory, alsaEngine: report.alsaEngine };
    assert.equal(report.boot.ended, true);
    assert.equal(report.tests["alsa-timing"]?.exit, 0, report.tests["alsa-timing"]?.output);
  },
);
Then(
  "all 20 seconds reach the USB audio device with no underruns on a real-time thread",
  function () {
    const timing = this.engineBoot.alsaEngine.timing;
    assert.ok(timing, "timing run report missing");
    assert.equal(timing.framesWritten, 20 * 48000);
    assert.equal(timing.xruns, 0);
    assert.equal(timing.deviceErrors, 0);
    assert.equal(timing.realtimeScheduling, "sched-fifo");
    assert.equal(timing.memoryLocked, true);
    assert.equal(timing.auditFaults, 0);
    assert.equal(timing.notesOn, 40);
    assert.equal(timing.interrupted, false);
  },
);
Then("the captured quarter notes land on a 0.5 second grid", function () {
  const engine = this.engineBoot.alsaEngine;
  // The mean spacing is measured from the host-side capture, end to end.
  assert.ok(engine.beatOnsets >= 38, `onsets ${engine.beatOnsets}`);
  assert.ok(
    Math.abs(engine.beatIntervalMeanSeconds - 0.5) < 0.002,
    `${engine.beatIntervalMeanSeconds}`,
  );
  // Per-interval jitter includes QEMU's USB audio and WAV capture batching; recorded, not gated.
  this.evidence.beatIntervalMaxErrorMs = engine.beatIntervalMaxErrorMs;
});
Then(
  "the 32-voice stress graph completes with its emulation timing recorded, not hidden",
  function () {
    const stress = this.engineBoot.alsaEngine.stress;
    assert.equal(this.engineBoot.tests["alsa-engine"]?.exit, 0);
    assert.equal(stress.framesWritten, 10 * 48000);
    assert.equal(stress.auditFaults, 0);
    for (const key of ["xruns", "deviceErrors", "lateRenders", "renderMaxNs", "renderP99UpperNs"])
      assert.ok(Number.isSafeInteger(stress[key]), key);
    this.evidence.stressTiming = {
      xruns: stress.xruns,
      deviceErrors: stress.deviceErrors,
      lateRenders: stress.lateRenders,
      renderMaxMs: stress.renderMaxNs / 1e6,
      qualifies: "nothing: emulated CPU",
    };
  },
);

// LK14
Given(
  "ALSA card identities for an Akai Force, an MPC Live and QEMU's USB audio device",
  function () {
    this.policyTest = join(root, "build/native/xmp_card_policy_test");
    if (!existsSync(this.policyTest)) {
      const build = spawnSync("npm", ["run", "native:test"], { cwd: root, encoding: "utf8" });
      assert.equal(build.status, 0, build.stderr);
    }
  },
);
When("the engine's card protection policy is checked natively", function () {
  this.policy = spawnSync(this.policyTest, [], { encoding: "utf8", timeout: 30000 });
});
Then(
  "the Akai and inMusic cards are refused and only the emulated device is accepted",
  function () {
    assert.equal(this.policy.status, 0, this.policy.stdout);
    assert.match(this.policy.stdout, /card policy passed/);
  },
);
Then("the engine has no default-device, discovery or MIDI path", async () => {
  const source = await readFile(join(root, "native/src/alsa_engine.cpp"), "utf8");
  assert.match(source, /plughw:%d,0/);
  for (const forbidden of [/"default"/, /snd_card_next/, /snd_rawmidi/, /snd_seq/, /libusb/])
    assert.doesNotMatch(source, forbidden);
  assert.match(source, /protected_card_identity\(identity\)/);
});
