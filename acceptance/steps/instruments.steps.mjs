import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { exportPortable, hashSample, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderInstrumentScene } from "../../packages/core/src/edits.ts";
import { encodeWav, parseProject } from "../../packages/core/src/index.ts";
import {
  editedPcm,
  inputCapabilities,
  installSample,
  manualSlices,
  prepareInstruments,
  VoiceRack,
} from "../../packages/core/src/instruments.ts";
import { MachineRegistry, machines } from "../../packages/core/src/machines.ts";
import { decodeSampleWav, recordingPlan, TakeRecorder } from "../../packages/core/src/recording.ts";
import { ProjectSession } from "../../packages/core/src/session.ts";
import { instrumentFixture, renderRack, songWithSynth } from "../lib/instrument-fixture.mjs";
import { LocalProjectStore } from "../lib/project-store.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const peak = (pcm) => pcm.reduce((p, v) => Math.max(p, Math.abs(v)), 0);

Given("a kit contains one-shot, gated, looping and chromatic pad assignments", function () {
  this.kit = instrumentFixture();
  ["one-shot", "gate", "loop", "chromatic"].forEach((mode, i) => {
    this.kit.pads[i].playback = { mode, rootNote: 60, chokeGroup: 0 };
  });
});
When("the musician plays the documented note-on and note-off fixture", function () {
  this.modePcm = [];
  this.modeActive = [];
  for (let pad = 0; pad < 4; pad++) {
    const rack = new VoiceRack(prepareInstruments(this.kit));
    rack.noteOn(1, pad, 0, pad === 3 ? 72 : 60, 0.5);
    this.modePcm.push(
      renderRack(rack, 5000, [
        {
          frame: 480,
          run: () => {
            if (pad !== 3) rack.noteOff(1);
          },
        },
      ]),
    );
    this.modeActive.push(rack.active);
  }
  const p = structuredClone(this.kit);
  p.pads[2].playback.chokeGroup = 1;
  p.pads[1].playback.chokeGroup = 1;
  const rack = new VoiceRack(prepareInstruments(p));
  rack.noteOn(1, 2, 0);
  renderRack(rack, 480);
  rack.noteOn(2, 1, 0);
  renderRack(rack, 240);
  this.chokeActive = rack.active;
});
Then("each assignment follows its playback and choke-group rules", function () {
  assert.ok(peak(this.modePcm[0].slice(1000, 2000)) > 0.2);
  assert.equal(peak(this.modePcm[1].slice(721)), 0);
  assert.equal(peak(this.modePcm[2].slice(721)), 0);
  assert.ok(peak(this.modePcm[2].slice(0, 480)) > 0.2);
  assert.deepEqual(this.modeActive, [0, 0, 0, 0]);
  assert.equal(this.chokeActive, 1);
  const rack = new VoiceRack(prepareInstruments(this.kit));
  rack.noteOn(1, 2, 0);
  assert.ok(Math.abs(peak(renderRack(rack, 6000).slice(4000)) - 0.4) < 0.001);
});
Then("captured amplitude and pitch match the velocity and note expectations", function () {
  assert.ok(Math.abs(peak(this.modePcm[0]) - 0.25) < 0.001);
  const values = this.modePcm[3].slice(50, 1000);
  let crossings = 0;
  for (let i = 1; i < values.length; i++) if (values[i - 1] <= 0 && values[i] > 0) crossings++;
  assert.ok(Math.abs((crossings * 48000) / values.length - 880) < 55);
});
Given("a looping pad and a gated pad have active voices", function () {
  this.kit = instrumentFixture();
  this.kit.pads[0].playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
  this.kit.pads[1].playback = { mode: "gate", rootNote: 60, chokeGroup: 0 };
});
When("the track is removed or the transport receives panic", function () {
  this.cleanup = [];
  for (const mode of ["remove", "panic"]) {
    const rack = new VoiceRack(prepareInstruments(this.kit));
    rack.noteOn(1, 0, 0);
    rack.noteOn(2, 1, 0);
    renderRack(rack, 128);
    if (mode === "remove") rack.removeTrack("drums");
    else rack.panic();
    renderRack(rack, 240);
    this.cleanup.push({ active: rack.active, pcm: renderRack(rack, 256) });
  }
});
Then("all owned voices release within the documented release interval", function () {
  assert.ok(this.cleanup.every((r) => r.active === 0));
});
Then("no unowned or permanently sustained voice remains", function () {
  assert.ok(this.cleanup.every((r) => peak(r.pcm) === 0));
});

Given("a recorded waveform contains four transients at known sample offsets", async function () {
  const p = instrumentFixture();
  p.samples[0].pcm = [0, 0.2, 0, 0, 0.4, 0, 0, 0, 0.6, 0, 0, 0, 0.8, 0, 0, 0];
  this.editSession = new ProjectSession(p, true);
  this.assetHash = await hashSample(48000, p.samples[0].pcm);
});
When("the musician trims, reverses, normalizes and manually slices the recording", function () {
  this.editSession.edit((p) => {
    p.pads[0].slice = { start: 1, end: 14 };
    p.pads[0].edit = { reverse: true, normalize: true };
    return p;
  });
  const pcm = editedPcm(this.editSession.project, 0);
  assert.equal(pcm.length, 13);
  assert.equal(peak(pcm), 1);
  this.editSession.edit((p) => manualSlices(p, 0, [0, 4, 8, 12, 16]));
  this.editedText = JSON.stringify(this.editSession.project);
});
When("undoes and redoes those operations", function () {
  assert.equal(this.editSession.undo(), true);
  assert.equal(this.editSession.undo(), true);
  assert.equal(this.editSession.project.pads[0].edit, undefined);
  assert.equal(this.editSession.redo(), true);
  assert.equal(this.editSession.redo(), true);
});
Then("slice boundaries and playback agree with the selected sample offsets", function () {
  assert.equal(JSON.stringify(this.editSession.project), this.editedText);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(this.editSession.project.pads[i].slice, { start: i * 4, end: (i + 1) * 4 });
    assert.equal(editedPcm(this.editSession.project, i).length, 4);
  }
});
Then("the original asset hash remains unchanged", async function () {
  assert.equal(await hashSample(48000, this.editSession.project.samples[0].pcm), this.assetHash);
});
Given("a waveform contains a silent region", function () {
  const p = instrumentFixture();
  p.samples[0].pcm = [0, 0, 0, 0];
  this.silent = new ProjectSession(p, true);
});
When("an edit requests an end before its start or normalizes that silent region", function () {
  assert.throws(() =>
    this.silent.edit((p) => {
      p.pads[0].slice = { start: 3, end: 2 };
      return p;
    }),
  );
  assert.equal(this.silent.canUndo, false);
  this.silent.edit((p) => {
    p.pads[0].edit = { reverse: false, normalize: true };
    return p;
  });
  this.silentPcm = editedPcm(this.silent.project, 0);
});
Then("invalid boundaries are rejected and silence remains finite silence", function () {
  assert.deepEqual(Array.from(this.silentPcm), [0, 0, 0, 0]);
});
Then("no edit introduces NaN, infinity or out-of-range sample reads", function () {
  assert.ok(this.silentPcm.every(Number.isFinite));
  assert.equal(this.silent.project.samples[0].pcm.length, 4);
});

Given("a synth patch has oscillator, ADSR and filter settings", function () {
  this.synthProject = songWithSynth();
});
When(
  "the musician plays overlapping notes at different velocities and saves the patch",
  async function () {
    const rack = new VoiceRack(prepareInstruments(this.synthProject));
    rack.noteOn(1, 0, 1, 48, 0.4, 9600);
    this.synthCapture = renderRack(rack, 48000, [
      { frame: 2400, run: () => rack.noteOn(2, 0, 1, 55, 0.8, 14400) },
    ]);
    this.synthBundle = await exportPortable(this.synthProject);
  },
);
When("reloads it in a new project", async function () {
  this.synthReopened = await importPortable(this.synthBundle);
  const rack = new VoiceRack(prepareInstruments(this.synthReopened));
  rack.noteOn(1, 0, 1, 48, 0.4, 9600);
  this.synthAgain = renderRack(rack, 48000, [
    { frame: 2400, run: () => rack.noteOn(2, 0, 1, 55, 0.8, 14400) },
  ]);
});
Then("the same seeded note fixture produces audio within the synth render tolerance", function () {
  assert.deepEqual(this.synthAgain, this.synthCapture);
  assert.ok(peak(this.synthCapture) > 0.02);
  assert.deepEqual(this.synthReopened.tracks[1].machine, this.synthProject.tracks[1].machine);
});
Then("note releases respect the saved envelope settings", function () {
  assert.equal(peak(this.synthCapture.slice(24000)), 0);
  assert.ok(peak(this.synthCapture.slice(9600, 13000)) > 0.01);
});
Given("a synth receives more notes than its qualified voice budget", function () {
  this.overload = new VoiceRack(prepareInstruments(songWithSynth()));
});
When("the voice policy and overload handling are applied", function () {
  this.admissions = Array.from({ length: 33 }, (_, i) =>
    this.overload.noteOn(i, 0, 1, 48 + (i % 12), 0.5),
  );
  this.overloadPcm = renderRack(this.overload, 128);
});
Then("processing remains bounded and all samples are finite", function () {
  assert.equal(this.admissions.filter(Boolean).length, 32);
  assert.equal(this.overload.refused, 1);
  assert.ok(this.overloadPcm.every((v) => Number.isFinite(v) && Math.abs(v) <= 1));
});
Then("transport stop still releases all synth voices", function () {
  this.overload.panic();
  renderRack(this.overload, 240);
  assert.equal(this.overload.active, 0);
  assert.equal(peak(renderRack(this.overload, 128)), 0);
});

Given("the musician has selected a test input and enabled monitoring", function () {
  this.recordProject = songWithSynth();
  this.recordPlan = recordingPlan(this.recordProject, 48000, 15);
  this.recorder = new TakeRecorder();
  this.recorder.arm(this.recordPlan);
  this.inputPcm = Float32Array.from(
    { length: 192000 },
    (_, i) => 0.1 * Math.sin((2 * Math.PI * 300 * i) / 48000),
  );
  this.recorder.push(this.inputPcm.subarray(0, 128));
  assert.equal(this.recorder.frames, 0);
  assert.ok(this.recorder.peak > 0);
});
When("the musician arms recording and captures exactly two bars", function () {
  assert.equal(this.recorder.state, "armed");
  this.recorder.start();
  for (let at = 0; at < this.inputPcm.length; at += 256)
    this.recorder.push(this.inputPcm.subarray(at, at + 256));
  this.recorded = this.recorder.commit(this.recordProject, 15);
});
When("separately resamples the internal master bus", function () {
  this.resampled = renderInstrumentScene(this.recordProject, "scene-0", 32);
});
Then("the input take and resampled take have the expected lengths and routing", function () {
  assert.equal(this.recorder.take.length, 192000);
  assert.deepEqual(this.recorder.take, this.inputPcm);
  assert.equal(this.resampled.pcm.length, 192000);
  assert.ok(peak(this.resampled.pcm) > 0.03);
  assert.deepEqual(new Set(this.resampled.events.map((e) => e.track)), new Set([0, 1]));
  assert.deepEqual(
    this.recorded.samples.find((s) => s.id === this.recorded.pads[15].sampleId).pcm,
    Array.from(this.inputPcm),
  );
});
Then("recording does not start before the explicit arm and start actions", function () {
  assert.throws(() => new TakeRecorder().start());
  assert.equal(this.recorder.state, "complete");
});
Given("recording is active against a bounded temporary take", function () {
  this.interruptedProject = instrumentFixture();
  this.beforeInterrupted = JSON.stringify(this.interruptedProject);
});
When("the input disappears or the recording storage budget is exhausted", function () {
  this.partialTakes = [];
  for (const reason of ["Input disconnected", "Storage quota reached"]) {
    const recorder = new TakeRecorder();
    recorder.arm({ frames: 1000, sampleRate: 48000, budget: 1000 });
    recorder.start();
    recorder.push(new Float32Array(500).fill(0.1));
    recorder.interrupt(reason);
    this.partialTakes.push(recorder);
  }
});
Then("the recording stops with an actionable status and a recoverable valid take", function () {
  for (const r of this.partialTakes) {
    assert.equal(r.state, "interrupted");
    assert.ok(r.reason);
    assert.equal(decodeSampleWav(new Uint8Array(encodeWav([r.take], 48000))).pcm.length, 500);
  }
});
Then("existing project assets are neither overwritten nor deleted", function () {
  assert.equal(JSON.stringify(this.interruptedProject), this.beforeInterrupted);
});
Given(
  "the default kit is loaded and the source declares note and velocity input only",
  function () {
    this.velocityProject = instrumentFixture();
  },
);
When("the musician plays the supplied velocity fixture without opening an editor", function () {
  this.velocityPeaks = [0.2, 0.8].map((velocity) => {
    const rack = new VoiceRack(prepareInstruments(this.velocityProject));
    rack.noteOn(1, 0, 0, 60, velocity);
    return peak(renderRack(rack, 2400));
  });
});
Then("each hit uses the captured velocity and the declared velocity curve", function () {
  assert.ok(Math.abs(this.velocityPeaks[0] - 0.1) < 0.001);
  assert.ok(Math.abs(this.velocityPeaks[1] - 0.4) < 0.001);
});
Then(
  "pressure, pitch-slide and timbre-slide controls are unavailable rather than simulated",
  () => {
    assert.deepEqual(inputCapabilities, {
      notes: true,
      velocity: true,
      pressure: false,
      pitchSlide: false,
      timbreSlide: false,
    });
  },
);

Given("a musician starts with an empty project and an approved test input", function () {
  this.journey = instrumentFixture();
  this.journey.tracks[0].clips[0].steps = [];
  const recorder = new TakeRecorder();
  recorder.arm(recordingPlan(this.journey, 48000, 0));
  recorder.start();
  recorder.push(
    Float32Array.from(
      { length: 192000 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 400 * i) / 48000),
    ),
  );
  this.journeyRecorder = recorder;
});
When("the musician records a sample, trims it and assigns slices to pads", function () {
  this.journey = this.journeyRecorder.commit(this.journey, 0, "New recorded tone");
  this.journey = manualSlices(this.journey, 0, [0, 48000, 96000, 144000, 192000]);
  this.journey.pads[0].slice = { start: 48, end: 47000 };
  this.journey.tracks[0].clips[0].steps = [{ pad: 0, step: 0, velocity: 0.8, probability: 1 }];
});
When("adds a bass patch from the subtractive synthesizer", function () {
  const bass = songWithSynth().tracks[1];
  this.journey.tracks.push(bass);
  this.journey.scenes[0].clips.bass = "bass-0";
});
When("resamples the combined performance and saves the project", async function () {
  this.journeyRender = renderInstrumentScene(this.journey, "scene-0", 32);
  this.journey = installSample(this.journey, 15, "Resampled song", 48000, this.journeyRender.pcm);
  this.journeySession = new ProjectSession(this.journey);
  this.journeyStore = new LocalProjectStore(this.workspace);
  await this.journeySession.save(this.journeyStore);
});
Then("reopening restores the samples, slice assignments and synth preset", async function () {
  const reopened = await this.journeyStore.load();
  assert.deepEqual(reopened.project, this.journey);
  assert.equal(reopened.project.version, 8);
  assert.equal(this.journeySession.dirty, false);
});
Then("the rendered performance contains the expected sample and synth events", function () {
  assert.equal(this.journeyRender.events.length, 3);
  assert.deepEqual(new Set(this.journeyRender.events.map((e) => e.track)), new Set([0, 1]));
  assert.ok(peak(this.journeyRender.pcm) > 0.01);
  this.artifacts.push({ kind: "audio", data: Buffer.from(this.journeyRender.wav) });
});
Given(
  "a developer defines an original audio machine with a versioned state and parameter schema",
  function () {
    this.extensionDefinition = {
      id: "example.constant",
      name: "Example pulse",
      base: "audio",
      version: 1,
      capabilities: ["notes", "velocity", "audio-output"],
      parameters: [
        { id: "level", name: "Level", unit: "normalized", min: 0, max: 1, defaultValue: 0.25 },
      ],
      defaults: { level: 0.25 },
      validate(state) {
        if (
          Object.keys(state).join() !== "level" ||
          !Number.isFinite(state.level) ||
          state.level < 0 ||
          state.level > 1
        )
          throw new Error("Invalid example state");
      },
      create({ state }) {
        let remaining = 0;
        return {
          noteOn(e) {
            remaining = e.durationFrames || 4800;
            return true;
          },
          noteOff() {
            remaining = 0;
          },
          panic() {
            remaining = 0;
          },
          process(output, frames) {
            for (let i = 0; i < frames; i++) output[i] = remaining-- > 0 ? state.level : 0;
          },
        };
      },
    };
  },
);
When("the developer registers it and a musician selects it on one track", async function () {
  machines.register(this.extensionDefinition);
  this.extensionProject = songWithSynth();
  this.extensionProject.tracks[0].machine = machines.instantiate("example.constant");
  this.extensionReopened = await importPortable(await exportPortable(this.extensionProject));
  const rack = new VoiceRack(prepareInstruments(this.extensionReopened));
  rack.noteOn(1, 0, 0, 60, 1, 480);
  this.extensionPcm = renderRack(rack, 600);
});
Then(
  "its custom processor produces the expected audio and its state survives project save and reopen",
  function () {
    assert.ok(this.extensionPcm.slice(0, 480).every((v) => v === 0.25));
    assert.equal(peak(this.extensionPcm.slice(480)), 0);
    assert.deepEqual(
      this.extensionReopened.tracks[0].machine,
      this.extensionProject.tracks[0].machine,
    );
  },
);
Then("other tracks keep their own machine identities", function () {
  assert.equal(this.extensionReopened.tracks[1].machine.id, "xmp.subtractive");
});
Given("a project contains an unknown machine and a future machine-state version", function () {
  this.missingMachine = instrumentFixture();
  this.missingMachine.tracks[0].machine = {
    id: "future.uninstalled",
    base: "audio",
    version: 12,
    state: { userPatch: { level: 0.25, preset: "Keep me" } },
  };
});
When("a musician reopens the project without that machine installed", async function () {
  this.missingReopened = await importPortable(await exportPortable(this.missingMachine));
  const rack = new VoiceRack(prepareInstruments(this.missingReopened));
  this.missingAdmitted = rack.noteOn(1, 0, 0);
  this.missingPcm = renderRack(rack, 1024);
});
Then(
  "its state is preserved and its track stays silent without substituting another machine",
  function () {
    assert.deepEqual(this.missingReopened.tracks[0].machine, this.missingMachine.tracks[0].machine);
    assert.equal(this.missingAdmitted, false);
    assert.equal(peak(this.missingPcm), 0);
  },
);
Then("invalid built-in state and duplicate machine registration are rejected", () => {
  const p = instrumentFixture();
  p.tracks[0].machine = {
    id: "xmp.subtractive",
    base: "audio",
    version: 1,
    state: { cutoff: Infinity },
  };
  assert.throws(() => parseProject(JSON.stringify(p)));
  const registry = new MachineRegistry(),
    definition = machines.list()[0];
  registry.register(definition);
  assert.throws(() => registry.register(definition), /already/);
});
Given("a MIDI machine has an explicitly configured virtual output fixture", function () {
  this.midiProject = instrumentFixture();
  this.midiProject.tracks[0].machine = machines.instantiate("xmp.midi");
  this.midiProject.tracks[0].machine.state.channel = 3;
  this.midiTrace = [];
});
When("notes are played and then the transport receives panic", function () {
  const rack = new VoiceRack(prepareInstruments(this.midiProject), 48000, (e) =>
    this.midiTrace.push(e),
  );
  rack.noteOn(1, 0, 0, 64, 0.8);
  this.midiAudio = renderRack(rack, 128);
  rack.panic();
});
Then(
  "the virtual trace contains matching note-ons and note-offs on the selected channel",
  function () {
    assert.deepEqual(
      this.midiTrace.map((e) => [e.kind, e.note, e.channel]),
      [
        ["on", 64, 3],
        ["off", 64, 3],
      ],
    );
  },
);
Then("no physical MIDI or device adapter is opened", function () {
  assert.equal(peak(this.midiAudio), 0);
  assert.deepEqual(this.deviceOperations, []);
});
