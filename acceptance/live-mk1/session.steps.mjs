import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Then, When } from "@cucumber/cucumber";
import { buildProbeImage } from "../../tools/live-mk1/probe-image.mjs";
import { buildSessionImage } from "../../tools/live-mk1/session-image.mjs";
import { testSessionInVm } from "../../tools/live-mk1/session-vm.mjs";

// LK20: the XMP session system image, booted by the stick loader in QEMU.
// Needs the owner's copy of Akai's signed updater for the loader; local only.
const UPDATER = join(homedir(), "Downloads", "MPC (Gen 1) 3.10.0 Updater.app");
const updaterPath = () => process.env.XMP_MPC_UPDATER ?? UPDATER;

When(
  "I build the session system image and boot it through the stick loader",
  { timeout: 5400000 },
  async function () {
    assert.ok(existsSync(updaterPath()));
    if (!existsSync(join(process.cwd(), "artifacts/live-mk1/latest-loader-image.json")))
      await buildProbeImage(updaterPath(), { kind: "loader" });
    this.sessionImage = await buildSessionImage();
    this.evidence.sessionImage = this.sessionImage.manifest;
    this.sessionVm = (await testSessionInVm()).result;
    this.evidence.sessionVm = this.sessionVm;
    assert.equal(
      this.sessionVm.verification.passed,
      true,
      JSON.stringify(this.sessionVm.verification),
    );
  },
);
Then(
  "the loader starts the session from the stick and the session accepts only the allowed audio card",
  function () {
    const { pads } = this.sessionVm;
    assert.equal(this.sessionImage.manifest.containsVendorFiles, false);
    assert.equal(this.sessionVm.machine.stickOnUsbStorage, true);
    assert.equal(this.sessionVm.machine.sameSessionBinaryAsLive, true);
    assert.equal(pads.audioCardAccepted, true);
  },
);
Then(
  "scripted controller bytes are parsed into pad, button, control and SysEx events and logged to the stick",
  function () {
    const { pads } = this.sessionVm;
    for (const key of [
      "padOneHard",
      "padSixteenSoft",
      "runningStatusOff",
      "buttonLogged",
      "eightAtOnce",
      "startupBytesExactOnPrivatePort",
      "identityReplyLoggedWithoutSerial",
    ])
      assert.equal(pads[key], true, key);
  },
);
Then(
  "the pads are heard in the recorded output, which never exceeds -12 dBFS, with no xruns",
  function () {
    const { pads, audio } = this.sessionVm;
    assert.ok(Number.isFinite(audio.peakDbfs) && audio.peakDbfs > -90);
    assert.equal(pads.peakWithinMinus12dBFS, true);
    assert.equal(pads.noXruns, true);
    assert.ok(audio.peakDbfs <= -12);
  },
);
Then("the session switches the machine off when it ends and at the power button", function () {
  assert.equal(this.sessionVm.pads.switchedOff, true);
  assert.equal(this.sessionVm.pads.powerButtonEndsSession, true);
});
Then(
  "touches program a pattern that plays on exact sixteenths, records a live pad and follows a tempo change",
  function () {
    const s = this.sessionVm.sequencer;
    for (const key of [
      "touchesSelectAndProgram",
      "played",
      "recordedLiveHit",
      "tempoChanged",
      "stopped",
      "noLateNotes",
      "stepsAt120BpmExact",
      "stepsAt125BpmExact",
      "peakWithinMinus12dBFS",
      "noXruns",
      "switchedOff",
    ])
      assert.equal(s[key], true, key);
  },
);
Then("the pattern is saved to the stick", function () {
  assert.equal(this.sessionVm.sequencer.patternSavedToStick, true);
});
Then(
  "track buttons, synth steps and the level knob build an eight-track song that plays on exact quarter notes",
  function () {
    const t = this.sessionVm.tracks;
    for (const key of [
      "trackButtonsSelect",
      "synthStepsEntered",
      "knobSetsLevel",
      "kitStepsOnTrack1",
      "liveSynthNote",
      "noLateNotes",
      "bassOnQuarterNotes",
      "soundOnOutputsOneTwoOnly",
      "peakWithinMinus12dBFS",
      "noXruns",
      "screenShowsTrackStrip",
      "switchedOff",
    ])
      assert.equal(t[key], true, key);
  },
);
Then("the eight-track song is saved to the stick", function () {
  assert.equal(this.sessionVm.tracks.songSavedToStick, true);
});
Then("the root disk is byte-identical after every session", function () {
  assert.equal(this.sessionVm.tracks.rootDiskUnchanged, true);
  assert.equal(this.sessionVm.pads.rootDiskUnchanged, true);
  assert.equal(this.sessionVm.project.rootDiskUnchanged, true);
  assert.equal(this.sessionVm.bridge.rootDiskUnchanged, true);
  assert.equal(this.sessionVm.sequencer.rootDiskUnchanged, true);
});
