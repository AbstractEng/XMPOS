import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { After, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { acousticProfile, preflightAcoustic } from "../../packages/core/src/acoustic.ts";
import { collectAcousticCapture } from "../../tools/lib/acoustic-capture.mjs";
import { acousticProject } from "../lib/acoustic-fixture.mjs";
import { nativeSongCapture } from "../lib/song-target.mjs";
import { buildIdentity, command, root, sha256 } from "../lib/workspace.mjs";

setDefaultTimeout(120000);
Given(
  "this MacBook's exact built-in speaker and microphone identities pass acoustic preflight",
  function () {
    this.directory = process.env.XMP_ACOUSTIC_DIR;
    assert.ok(
      this.directory?.startsWith(resolve(root, "reports/acoustic/run-")),
      "Use npm run audio:acoustic to create an owned session",
    );
    assert.equal(process.platform, "darwin");
    assert.ok(
      !process.env.CI && process.env.GITHUB_ACTIONS !== "true",
      "Physical test cannot run in CI",
    );
    this.sourceHash = buildIdentity();
    const inventory = JSON.parse(
      command(resolve(root, "build/native/xmp_acoustic_capture"), ["--inspect"]),
    );
    preflightAcoustic(inventory, { platform: process.platform, ci: false, capture: false });
    this.inventory = inventory;
    const rendered = nativeSongCapture(acousticProject(), "scene-0", {
      path: (name) => resolve(this.directory, name),
    });
    writeFileSync(resolve(this.directory, "reference.wav"), rendered.audio);
    this.referenceHash = sha256(rendered.audio);
  },
);
When(
  "the XMP acoustic tool plays its original eight-note pattern and records six seconds locally",
  function () {
    this.report = collectAcousticCapture(this.directory, this.inventory);
    this.report.sourceHash = this.sourceHash;
    this.report.referenceHash = this.referenceHash;
    this.report.profile = acousticProfile.id;
    this.report.synthetic = false;
    if (buildIdentity() !== this.sourceHash) {
      this.report.outcome = "inconclusive";
      this.report.reason = "Source changed during physical check";
    }
    writeFileSync(
      resolve(this.directory, "measurement.json"),
      `${JSON.stringify(this.report, null, 2)}\n`,
    );
  },
);
Then("all eight recorded tones match the expected order and relative timing", function () {
  assert.equal(this.report.outcome, "passed", `${this.report.reason}; evidence: ${this.directory}`);
  assert.equal(this.report.detectedNotes, 8);
  assert.ok(this.report.maximumErrorMs <= 40);
  assert.ok(this.report.intervalErrorMs <= 40);
});
Then("only the built-in pair was opened and every audio stream has stopped", function () {
  const capture = this.report.capture;
  preflightAcoustic(
    { ...capture, microphonePermission: "authorized" },
    { platform: "darwin", ci: false, capture: true },
  );
  assert.equal(capture.inputStreamsStarted, 1);
  assert.equal(capture.outputStreamsStarted, 1);
  assert.equal(capture.streamsStopped, true);
  assert.equal(capture.protectedDeviceOperations, 0);
  assert.equal(capture.callbackErrors, 0);
});
Then(
  "the acoustic report leaves calibrated loopback and P04 physical qualification pending",
  function () {
    assert.equal(this.report.formalLoopbackQualified, false);
    assert.equal(this.report.physicalAudioQualified, false);
    assert.equal(this.report.latencyMs, null);
    assert.equal(this.report.jitterMs, null);
    assert.equal(this.report.synthetic, false);
  },
);
After(function ({ result }) {
  if (!this.directory) return;
  const record = {
    profile: acousticProfile.id,
    scope: "Built-in MacBook acoustic playback only; not formal loopback qualification",
    outcome: result.status.toLowerCase(),
    sourceHash: this.sourceHash ?? buildIdentity(),
    report: this.report ?? null,
  };
  writeFileSync(
    resolve(this.directory, "gherkin-result.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  this.attach(JSON.stringify(record), "application/json");
  if (this.report?.captureHash)
    assert.equal(
      sha256(readFileSync(resolve(this.directory, "capture.wav"))),
      this.report.captureHash,
    );
});
