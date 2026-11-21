import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { After, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { requireMacBookDevice } from "../../packages/core/src/acoustic.ts";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { installSample } from "../../packages/core/src/instruments.ts";
import { decodeSampleWav } from "../../packages/core/src/recording.ts";
import { instrumentFixture } from "../lib/instrument-fixture.mjs";
import { buildIdentity, root, sha256 } from "../lib/workspace.mjs";

setDefaultTimeout(45000);
const base = "http://127.0.0.1:5173/api/recording/";
async function json(path, options) {
  const r = await fetch(base + path, options),
    value = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
Given(
  "the local Studio recording service reports the built-in MacBook microphone",
  async function () {
    assert.equal(process.platform, "darwin");
    assert.ok(!process.env.CI && process.env.GITHUB_ACTIONS !== "true");
    this.directory = process.env.XMP_RECORD_CHECK_DIR;
    assert.ok(this.directory?.startsWith(resolve(root, "reports/verification/p05-recording-")));
    this.sourceHash = buildIdentity();
    this.input = await json("input");
    requireMacBookDevice(this.input, true);
  },
);
When("the musician explicitly starts a two-bar recording at 120 BPM", async function () {
  this.started = await json("start", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
    body: JSON.stringify({ bpm: 120 }),
  });
  for (let i = 0; i < 180; i++) {
    const state = await json(`status?id=${this.started.id}`);
    if (state.state !== "recording") {
      this.status = state;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(this.status?.state, "recorded", JSON.stringify(this.status));
  const r = await fetch(`${base}take?id=${this.started.id}`);
  assert.equal(r.ok, true);
  this.wav = Buffer.from(await r.arrayBuffer());
  this.take = decodeSampleWav(this.wav);
  writeFileSync(resolve(this.directory, "capture.wav"), this.wav);
});
Then(
  "a complete four-second microphone WAV is returned with stopped input and no output stream",
  function () {
    assert.equal(this.take.pcm.length, this.input.sampleRate * 4);
    assert.equal(this.take.sampleRate, this.input.sampleRate);
    assert.equal(this.status.io.outputStreamsStarted, 0);
    assert.equal(this.status.io.inputStreamsStarted, 1);
    assert.equal(this.status.io.streamsStopped, true);
    assert.equal(this.status.io.callbackErrors, 0);
    assert.equal(this.status.io.protectedDeviceOperations, 0);
    requireMacBookDevice(this.status.io.input, true);
  },
);
Then("that take can be kept and reopened in an isolated XMP project", async function () {
  const p = installSample(
    instrumentFixture(),
    15,
    "Mac built-in take",
    this.take.sampleRate,
    this.take.pcm,
  );
  const reopened = await importPortable(await exportPortable(p));
  assert.deepEqual(reopened, p);
});
Then("formal loopback, OS and USB qualification remain pending", function () {
  assert.equal(buildIdentity(), this.sourceHash);
  this.qualification = { formalLoopback: false, os: false, usb: false };
});
After(function ({ result }) {
  if (this.directory)
    writeFileSync(
      resolve(this.directory, "result.json"),
      JSON.stringify(
        {
          outcome: result.status.toLowerCase(),
          sourceHash: this.sourceHash,
          input: this.input,
          status: this.status,
          captureHash: this.wav ? sha256(this.wav) : null,
          qualification: this.qualification ?? { formalLoopback: false, os: false, usb: false },
        },
        null,
        2,
      ),
    );
});
