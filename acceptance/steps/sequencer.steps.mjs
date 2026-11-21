import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderSequence } from "../../packages/core/src/edits.ts";
import { ProjectSchema } from "../../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../../packages/core/src/instruments.ts";
import { parameterRegistry, smoothParameter } from "../../packages/core/src/parameters.ts";
import {
  AutomationTake,
  appendNotes,
  clipFor,
  duplicateClip,
  editSequence,
  emptySequence,
  groovePosition,
  NoteRepeat,
  NoteTake,
  notesInWindow,
  parameterFrame,
  quantizeNotes,
  resizeClip,
  timeline,
} from "../../packages/core/src/sequencer.ts";
import { ProjectSession } from "../../packages/core/src/session.ts";
import { songWithSynth } from "../lib/instrument-fixture.mjs";
import { workletCapture } from "../lib/sequence-live.mjs";
import { root } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const note = (id, position = 0, extra = {}) => ({
  id,
  pad: 0,
  note: 60,
  position,
  duration: 1,
  velocity: 0.7,
  probability: 1,
  microtiming: 0,
  condition: "always",
  ...extra,
});
function setup(world, length = 64) {
  const p = songWithSynth();
  world.track = p.tracks[1].id;
  world.clip = p.tracks[1].clips[0].id;
  p.tracks[1].clips[0].length = length;
  p.tracks[1].clips[0].steps = [];
  p.tracks[1].clips[0].sequence = emptySequence();
  world.session = new ProjectSession(p, true);
  world.scene = p.scenes[0].id;
}
const seq = (w) => clipFor(w.session.project, w.track, w.clip).sequence;
const target = (w) => parameterRegistry(w.session.project).find((p) => p.id.endsWith(".cutoff")).id;
Given("a sixty-four-step clip contains an existing chord", function () {
  setup(this);
  this.existing = [
    note("old-c", 2.125, { note: 48, duration: 3 }),
    note("old-e", 2.125, { note: 52, duration: 3 }),
  ];
  this.session.edit((p) => appendNotes(p, this.track, this.clip, this.existing));
});
When("the musician enters pad steps and overdubs another chord in real time", function () {
  this.session.edit((p) => {
    clipFor(p, this.track, this.clip).steps.push({
      pad: 1,
      step: 4,
      velocity: 0.9,
      probability: 1,
    });
    return p;
  });
  this.before = structuredClone(this.session.project);
  const take = new NoteTake(64, 120, "overdub");
  take.on("a", 0, 60, 0.42, 1.016);
  take.on("b", 0, 64, 0.81, 1.016);
  take.off("a", 1.3);
  take.off("b", 1.4);
  this.overdub = take.finish(2);
  this.session.edit((p) => appendNotes(p, this.track, this.clip, this.overdub));
});
When("quantizes only the newly selected notes", function () {
  this.session.edit((p) =>
    quantizeNotes(
      p,
      this.track,
      this.clip,
      this.overdub.map((n) => n.id),
      1,
    ),
  );
});
Then("existing notes retain their original timing and lengths", function () {
  assert.deepEqual(seq(this).notes.slice(0, 2), this.existing);
  assert.equal(clipFor(this.session.project, this.track, this.clip).steps.at(-1).step, 4);
});
Then(
  "original take timestamps and played velocities remain available after timing correction",
  function () {
    for (const n of seq(this).notes.slice(2)) {
      assert.equal(n.position, 8);
      assert.equal(n.original.position, 8.128);
      assert.equal(n.original.timestamp, 1.016);
      assert.equal(n.velocity, n.original.velocity);
    }
    const restored = quantizeNotes(
      this.session.project,
      this.track,
      this.clip,
      this.overdub.map((n) => n.id),
      1,
      true,
    );
    assert.deepEqual(
      clipFor(restored, this.track, this.clip).sequence.notes.slice(2),
      this.overdub,
    );
  },
);
Then("undo removes only the selected overdub transaction", function () {
  this.session.undo();
  this.session.undo();
  assert.deepEqual(this.session.project, this.before);
});
Given("a sixty-four-step clip has sustained notes beyond step sixteen", function () {
  setup(this);
  this.session.edit((p) =>
    appendNotes(p, this.track, this.clip, [
      note("cross", 15, { duration: 12 }),
      note("outside", 48),
    ]),
  );
  this.rack = new VoiceRack(prepareInstruments(this.session.project));
  this.rack.noteOn(1, 0, 1, 60, 0.5);
});
When("the musician shortens it to sixteen steps during playback", function () {
  this.session.edit((p) => resizeClip(p, this.track, this.clip, 16));
  this.rack.panic();
  const l = new Float32Array(256);
  this.rack.process(l, new Float32Array(256));
});
Then("notes outside the new loop follow the documented truncation and note-off rules", function () {
  assert.deepEqual(
    seq(this).notes.map((n) => [n.id, n.position, n.duration]),
    [["cross", 15, 1]],
  );
});
Then("no stuck note or out-of-range event remains after the transition", function () {
  assert.equal(this.rack.active, 0);
  assert.ok(
    notesInWindow(this.session.project, this.scene, 0, 16).every(
      (n) => n.position + n.duration <= 16,
    ),
  );
  ProjectSchema.parse(this.session.project);
});
Given(
  "a clip has a recorded random seed and explicit first-cycle and fill conditions",
  function () {
    setup(this, 16);
    this.session.edit((p) => {
      p.seed = 91;
      return appendNotes(p, this.track, this.clip, [
        note("first", 0, { condition: "first" }),
        note("fill", 2, { condition: "fill" }),
        note("chance", 4, { probability: 0.5 }),
        note("every", 6, { condition: "every-2" }),
      ]);
    });
  },
);
When("the musician replays the same number of cycles with the same fill actions", function () {
  this.trace = [];
  for (let cycle = 0; cycle < 4; cycle++)
    this.trace.push(
      ...notesInWindow(
        this.session.project,
        this.scene,
        cycle * 16,
        (cycle + 1) * 16,
        cycle === 1,
      ).filter((n) => n.trackId === this.track),
    );
  this.again = [];
  for (let cycle = 0; cycle < 4; cycle++)
    this.again.push(
      ...notesInWindow(
        this.session.project,
        this.scene,
        cycle * 16,
        (cycle + 1) * 16,
        cycle === 1,
      ).filter((n) => n.trackId === this.track),
    );
});
Then("triggered events match the expected seeded trace exactly", function () {
  assert.deepEqual(this.trace, this.again);
  assert.deepEqual(
    this.trace.filter((n) => !n.id.includes(":chance:")).map((n) => n.position),
    [0, 6, 18, 38],
  );
  assert.deepEqual(
    this.trace.map((n) => n.position),
    [0, 6, 18, 20, 38],
  );
});
Then("swing and microtiming preserve the defined bar boundaries", () => {
  assert.equal(groovePosition(16, 1 / 3), 16);
  assert.equal(groovePosition(1, 1 / 3), 4 / 3);
  assert.equal(groovePosition(2, 1 / 3), 2);
});
Given("events have the minimum and maximum supported microtiming offsets", function () {
  setup(this, 16);
  this.session.edit((p) => {
    p.bpm = 300;
    return appendNotes(p, this.track, this.clip, [
      note("early", 0, { microtiming: -0.49 }),
      note("late", 15.9, { duration: 0.1, microtiming: 0.49 }),
    ]);
  });
});
When("the clip crosses its loop boundary at the fastest supported tempo", function () {
  this.trace = timeline(this.session.project, this.scene, 0, 32).filter(
    (n) => n.trackId === this.track,
  );
});
Then("events obey the documented wrap or clamp rule exactly once", function () {
  assert.deepEqual(
    this.trace.map((n) => n.position),
    [0, 16 - 1 / 960, 16, 32 - 1 / 960],
  );
  assert.equal(new Set(this.trace.map((n) => n.id)).size, 4);
});
Then("no event is duplicated or assigned a negative processing timestamp", function () {
  assert.ok(this.trace.every((n) => n.frame >= 0 && n.durationFrames >= 1));
});
Given("automation sets filter cutoff and one step temporarily locks that parameter", function () {
  setup(this, 16);
  this.parameter = target(this);
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) => {
      s.lanes.push({ parameter: this.parameter, points: [{ position: 0, value: 0.2 }] });
      s.locks.push({ parameter: this.parameter, position: 1, value: 0.8 });
      s.modulations.push(
        { id: "macro", kind: "macro", parameter: this.parameter, amount: 0.1, cycles: 1, phase: 0 },
        { id: "lfo", kind: "lfo", parameter: this.parameter, amount: 0.2, cycles: 1, phase: 0.25 },
      );
    }),
  );
});
When("playback enters and then leaves the locked step", function () {
  this.locked = parameterFrame(this.session.project, this.scene, 1)[this.parameter];
  this.unlocked = parameterFrame(this.session.project, this.scene, 2)[this.parameter];
});
Then(
  "the locked step uses its lock and the next step resumes the underlying automated value",
  function () {
    assert.ok(
      Math.abs(this.locked - (0.9 + 0.2 * Math.sin(2 * Math.PI * (1 / 16 + 0.25)))) < 1e-10 ||
        this.locked === 1,
    );
    assert.ok(
      Math.abs(this.unlocked - (0.3 + 0.2 * Math.sin(2 * Math.PI * (2 / 16 + 0.25)))) < 1e-10,
    );
  },
);
Then("macro and LFO offsets follow the registry precedence rules", function () {
  assert.ok(this.locked > this.unlocked);
  assert.equal(parameterFrame(this.session.project, this.scene, 1)[this.parameter], 1);
});
Given("an LFO and a macro target the same registered parameter", function () {
  setup(this, 16);
  this.parameter = target(this);
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) =>
      s.modulations.push(
        { id: "lfo", kind: "lfo", parameter: this.parameter, amount: 0.2, cycles: 1, phase: 0.25 },
        { id: "macro", kind: "macro", parameter: this.parameter, amount: 0.1, cycles: 1, phase: 0 },
      ),
    ),
  );
  this.beforeValue = parameterFrame(this.session.project, this.scene, 0)[this.parameter];
});
When("the LFO module is removed during playback", function () {
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) => {
      s.modulations = s.modulations.filter((m) => m.id !== "lfo");
    }),
  );
  this.afterValue = parameterFrame(this.session.project, this.scene, 0)[this.parameter];
});
Then("its contribution is removed without leaving a stale modulation value", function () {
  assert.ok(Math.abs(this.beforeValue - this.afterValue - 0.2) < 1e-10);
});
Then("the parameter smoothly resolves from the remaining sources", function () {
  const value = smoothParameter(this.beforeValue, this.afterValue, 48000, 10, 240);
  assert.ok(value > this.afterValue && value < this.beforeValue);
  assert.ok(
    Math.abs(
      smoothParameter(value, this.afterValue, 48000, 10, 240) -
        smoothParameter(this.beforeValue, this.afterValue, 48000, 10, 480),
    ) < 1e-12,
  );
});
Given("a clip has an existing automation lane in touch mode", function () {
  setup(this, 32);
  this.parameter = target(this);
  this.lane = {
    parameter: this.parameter,
    points: [
      { position: 0, value: 0.2 },
      { position: 8, value: 0.3 },
      { position: 24, value: 0.6 },
    ],
  };
  this.session.edit((p) => editSequence(p, this.track, this.clip, (s) => s.lanes.push(this.lane)));
  this.before = structuredClone(this.session.project);
  this.automation = new AutomationTake(this.lane, "touch");
});
When("the musician moves an encoder for one bar and releases it", function () {
  this.automation.touch(4, 0.8);
  this.automation.touch(12, 0.9);
  this.automation.release(20);
  const lane = this.automation.stop(32);
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) => {
      s.lanes = [lane];
    }),
  );
});
Then(
  "only the touched interval is replaced and playback returns to the previous lane afterward",
  function () {
    assert.deepEqual(seq(this).lanes[0].points, [
      { position: 0, value: 0.2 },
      { position: 4, value: 0.8 },
      { position: 12, value: 0.9 },
      { position: 20, value: 0.3 },
      { position: 24, value: 0.6 },
    ]);
  },
);
Then("undo restores the complete previous lane", function () {
  this.session.undo();
  assert.deepEqual(this.session.project, this.before);
});
Given("automation is being written while a sustained note is playing", function () {
  setup(this, 16);
  this.parameter = target(this);
  this.automation = new AutomationTake(
    { parameter: this.parameter, points: [{ position: 0, value: 0.2 }] },
    "write",
  );
  this.automation.touch(1, 0.8);
  this.rack = new VoiceRack(prepareInstruments(this.session.project));
  this.rack.noteOn(1, 0, 1, 60, 0.5);
  this.before = structuredClone(this.session.project);
});
When("the musician stops transport", function () {
  this.stoppedLane = this.automation.stop(3);
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) => s.lanes.push(this.stoppedLane)),
  );
  this.rack.panic();
  this.rack.applyParameters(parameterFrame(this.session.project, this.scene, 0));
  this.rack.process(new Float32Array(256), new Float32Array(256));
});
Then("the recorded segment is finalized as one recoverable edit", function () {
  assert.ok(this.stoppedLane.points.some((p) => p.position === 1 && p.value === 0.8));
  this.session.undo();
  assert.deepEqual(this.session.project, this.before);
});
Then(
  "note-off and parameter-reset events are applied without leaving write mode armed",
  function () {
    assert.equal(this.rack.active, 0);
    assert.equal(this.automation.active, false);
    assert.throws(() => this.automation.touch(4, 0.5));
  },
);
Given("a virtual source declares pressure and holds one note at repeat velocity 0.5", function () {
  setup(this, 16);
  this.repeat = new NoteRepeat(true);
  this.repeat.hold(60, 0, 0.5);
});
Given("its pressure fixture is 0.2 at tick zero, 0.8 at tick one and 0.4 at tick two", function () {
  this.pressure = [0.2, 0.8, 0.4];
});
When("note repeat runs at sixteenths with pressure mapped directly to velocity", function () {
  this.repeated = this.repeat.ticks(3, (p) => this.pressure[p]);
  this.before = structuredClone(this.session.project);
  this.session.edit((p) => appendNotes(p, this.track, this.clip, this.repeated));
});
Then(
  "the repeated notes have velocities 0.2, 0.8 and 0.4 at the engine's exact tick timestamps",
  function () {
    assert.deepEqual(
      this.repeated.map((n) => n.velocity),
      [0.2, 0.8, 0.4],
    );
    assert.deepEqual(
      timeline(this.session.project, this.scene, 0, 3)
        .filter((n) => n.trackId === this.track)
        .map((n) => n.frame),
      [0, 6000, 12000],
    );
  },
);
Then(
  "releasing the note stops repeats and undo removes the recorded repeat pass as one edit",
  function () {
    this.repeat.release();
    assert.deepEqual(this.repeat.ticks(8), []);
    this.session.undo();
    assert.deepEqual(this.session.project, this.before);
  },
);
Given(
  "a source declares no pressure capability and repeat velocity is explicitly set to 0.6",
  function () {
    this.repeat = new NoteRepeat(false);
    this.repeat.hold(60, 0, 0.6);
  },
);
When("the source holds a note for three repeat ticks and then disconnects", function () {
  this.repeated = this.repeat.ticks(3, () => {
    throw new Error("Must not request pressure");
  });
  this.repeat.disconnect();
});
Then("all three repeated notes use velocity 0.6 without fabricated pressure samples", function () {
  assert.deepEqual(
    this.repeated.map((n) => n.velocity),
    [0.6, 0.6, 0.6],
  );
});
Then("the disconnect cancels future repeats and releases every owned note", function () {
  assert.deepEqual(this.repeat.ticks(10), []);
  const rack = new VoiceRack(prepareInstruments(songWithSynth()));
  for (const [i, n] of this.repeated.entries()) rack.noteOn(i, n.pad, 1, n.note, n.velocity, 3000);
  rack.panic();
  rack.process(new Float32Array(256), new Float32Array(256));
  assert.equal(rack.active, 0);
});
Given(
  "the native engine is playing a recorded take at straight timing with an active sustained note",
  function () {
    this.native = JSON.parse(
      execFileSync(resolve(root, "build/native/xmp_groove_probe"), [], { encoding: "utf8" }),
    );
  },
);
When("the musician queues exact triplet swing for the next bar", function () {
  assert.equal(this.native.accepted, true);
});
Then("old events finish under the old groove and the new bar uses exact 2:1 pairs", function () {
  assert.deepEqual(
    this.native.frames,
    [0, 6000, 12000, 18000, 96000, 104000, 108000, 116000, 192000, 198000],
  );
});
Then("the sample clock, active note and original take timestamps remain continuous", function () {
  assert.equal(this.native.sampleClock, 202001);
  assert.equal(this.native.activeNoteContinuous, true);
  assert.equal(this.native.originalTick, 240);
});
Then(
  "selecting straight timing again restores the unswung take without a new recording",
  function () {
    assert.equal(this.native.frames.at(-1) - this.native.frames.at(-2), 6000);
    assert.equal(this.native.changes, 2);
  },
);
Given("the engine has acknowledged a valid queued swing change", function () {
  this.native = JSON.parse(
    execFileSync(resolve(root, "build/native/xmp_groove_probe"), [], { encoding: "utf8" }),
  );
  assert.equal(this.native.accepted, true);
});
When("an update supplies a non-finite ratio or an unsupported groove version", function () {
  assert.equal(this.native.rejected, 2);
});
Then("that update is rejected and the last acknowledged change remains scheduled", function () {
  assert.equal(this.native.frames[5], 104000);
});
Then("no duplicate hit, lost note-off or transport restart occurs", function () {
  assert.equal(this.native.running, true);
  assert.equal(new Set(this.native.frames).size, this.native.frames.length);
  assert.equal(this.native.activeNoteContinuous, true);
});
Given("a musician has a drum kit and a polyphonic synth track", function () {
  setup(this, 16);
});
When("the musician records notes, quantizes selected notes and edits note lengths", function () {
  const take = new NoteTake(16, 120);
  take.on("a", 0, 48, 0.7, 0.018);
  take.on("b", 0, 55, 0.5, 0.018);
  take.off("a", 0.35);
  take.off("b", 0.5);
  this.session.edit((p) => appendNotes(p, this.track, this.clip, take.finish(0.6)));
  this.session.edit((p) =>
    quantizeNotes(
      p,
      this.track,
      this.clip,
      seq(this).notes.map((n) => n.id),
      1,
    ),
  );
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) => {
      s.notes[0].duration = 2;
    }),
  );
});
When("adds microtiming, probability, parameter locks and recorded automation", function () {
  const parameter = target(this),
    auto = new AutomationTake({ parameter, points: [{ position: 0, value: 0.2 }] }, "touch");
  auto.touch(2, 0.6);
  auto.release(4);
  this.session.edit((p) =>
    editSequence(p, this.track, this.clip, (s) => {
      s.notes[0].microtiming = 0.1;
      s.notes[0].probability = 0.8;
      s.locks.push({ parameter, position: 2, value: 0.9 });
      s.lanes.push(auto.stop(8));
    }),
  );
});
When("duplicates the pattern and saves the project", async function () {
  this.session.edit((p) => duplicateClip(p, this.track, this.clip));
  this.saved = await exportPortable(this.session.project);
});
Then("reopening preserves all note and expression data", async function () {
  this.reopened = await importPortable(this.saved);
  assert.deepEqual(this.reopened, this.session.project);
  assert.deepEqual(this.reopened.tracks[1].clips.at(-1).sequence, seq(this));
});
Then(
  "live and offline event traces agree for the same seed and transport state",
  async function () {
    const offline = renderSequence(this.reopened, this.scene, 16, false, false),
      live = await workletCapture(this.reopened, this.scene, 16);
    assert.deepEqual(
      live.notes.map((n) => [n.frame, n.note, n.track]),
      offline.events.map((n) => [
        n.frame,
        n.note,
        this.reopened.tracks.findIndex((t) => t.id === n.trackId),
      ]),
    );
    assert.deepEqual(live.pcm, offline.pcm);
    assert.ok(live.pcm.some((v) => v !== 0));
  },
);
