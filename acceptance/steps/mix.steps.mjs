import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Given, Then, When } from "@cucumber/cucumber";
import {
  decodeMidi,
  exchangePlan,
  loadCore,
  renderExchange,
} from "../../packages/core/src/edits.ts";
import { saveExport } from "../../packages/core/src/export-sink.ts";
import { createDemoProject, encodeWav, ProjectSchema } from "../../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../../packages/core/src/instruments.ts";
import { VirtualMidiRoute, virtualClock } from "../../packages/core/src/midi.ts";
import { editMix, musicalSeconds, tempoAt, validateRoute } from "../../packages/core/src/mix.ts";
import { createEffect, EffectSchema, emptyMix } from "../../packages/core/src/mix-schema.ts";
import { EffectProcessor, panGains, StereoMixer } from "../../packages/core/src/mixer.ts";
import { setParameter } from "../../packages/core/src/parameters.ts";
import { editPerformance } from "../../packages/core/src/performance.ts";
import { fileExportSink } from "../../tools/lib/export-sink.mjs";
import { mixFixture, mixOracle } from "../lib/mix-fixture.mjs";
import { workletCapture } from "../lib/sequence-live.mjs";
import { command } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const fixturePort = (id) => ({
  kind: "virtual",
  id: `fixture-${id}`,
  generation: 1,
  connected: true,
});
Given("test tones are assigned to distinct tracks and known pan positions", function () {
  this.mix = emptyMix();
  this.mix.tracks.a = { pan: 0, sends: [0.5, 0], inserts: [] };
  this.mix.tracks.b = { pan: 1, sends: [0, 0], inserts: [] };
});
When("the musician changes volume, pan and send levels", function () {
  this.mixer = new StereoMixer(this.mix, ["a", "b"]);
  this.mixer.process(Float64Array.from([0.4, 0.2]), 0.5);
});
Then("measured channel levels match the declared pan law and gain mapping", function () {
  near(this.mixer.left, 0.3);
  near(this.mixer.right, 0.1);
  const [l, r] = panGains(0.5);
  near(l, Math.SQRT1_2);
  near(l * l + r * r, 1);
});
Then("the master meter reflects the actual routed output", function () {
  const m = this.mixer.meter();
  near(m.left, 0.3);
  near(m.right, 0.1);
  near(m.rms, Math.sqrt(0.05));
  this.artifacts.push({ kind: "trace", data: { profile: mixOracle, meter: m } });
});
Given("a route would create an unqualified cycle in the audio graph", function () {
  this.p = editMix(createDemoProject(), () => {});
  this.palette = prepareInstruments(this.p);
  this.rack = new VoiceRack(this.palette);
  this.reference = new VoiceRack(prepareInstruments(this.p));
  this.rack.noteOn(1, 0, 0);
  this.reference.noteOn(1, 0, 0);
});
When("the musician attempts to connect it", function () {
  assert.throws(() => validateRoute("return.0", "return.1", this.p), /Unsupported/);
  assert.throws(() =>
    this.rack.configure({
      ...this.palette,
      mix: { spec: { ...emptyMix(), returns: [[], [], []] }, bpm: 120 },
    }),
  );
});
Then("the route is rejected before replacing the active graph", function () {
  const a = new Float32Array(128),
    b = new Float32Array(128),
    c = new Float32Array(128),
    d = new Float32Array(128);
  this.rack.process(a, b);
  this.reference.process(c, d);
  assert.deepEqual(a, c);
  assert.deepEqual(b, d);
  this.validSound = a;
});
Then("playback continues through the previous valid routing", function () {
  assert.ok(this.validSound.some((v) => v !== 0));
});
Given(
  "a chain contains EQ, filter, delay, reverb, distortion and compressor fixtures",
  function () {
    this.effects = Object.keys({
      eq: 1,
      filter: 1,
      delay: 1,
      reverb: 1,
      distortion: 1,
      compressor: 1,
    }).map((k) => createEffect(k, k));
    this.responses = [];
  },
);
When("the musician saves and reloads its presets and automates bypass", function () {
  for (const e of this.effects) {
    const saved = EffectSchema.parse(JSON.parse(JSON.stringify(e))),
      a = new EffectProcessor(e),
      b = new EffectProcessor(saved);
    const pcm = new Float32Array(14000);
    for (let i = 0; i < pcm.length; i++) {
      const input = i === 0 ? 0.5 : 0,
        values = { "effect.bypass": i >= 10000 ? 1 : 0 };
      const x = a.process(input, 0, 120, values, "effect"),
        y = b.process(input, 0, 120, values, "effect");
      assert.equal(x, y);
      pcm[i] = x;
    }
    this.responses.push({ kind: e.kind, pcm });
  }
});
Then("each effect matches its reference response within its declared tolerance", function () {
  const at = (k) => this.responses.find((r) => r.kind === k).pcm;
  near(at("eq")[0], 0.5);
  const alpha = 1 - Math.exp((-2 * Math.PI * (20 * 1000 ** 0.7)) / 48000);
  near(at("filter")[0], alpha * 0.5);
  near(at("distortion")[0], 0.25 + (0.5 * Math.tanh(0.5 * 5.75)) / Math.tanh(5.75));
  near(at("compressor")[0], 0.5);
  const d = createEffect("delay", "oracle");
  d.params = { time: 0.001, feedback: 0.5, wet: 1 };
  const engine = new EffectProcessor(d),
    capture = Array.from({ length: 385 }, (_, i) => engine.process(i === 0 ? 1 : 0));
  near(capture[192], 1);
  near(capture[384], 0.375);
  near(at("reverb")[6576], 0.125);
});
Then("bypass and tail behavior match the documented transition policy", () => {
  const e = createEffect("delay", "tail");
  e.params = { time: 0.001, feedback: 0, wet: 1 };
  const processor = new EffectProcessor(e);
  processor.process(1);
  let last = 0;
  for (let i = 1; i <= 192; i++) last = processor.process(0, 0, 120, { "p.bypass": 1 }, "p");
  near(last, Math.exp(-192 / 480));
  processor.clear();
  for (let i = 0; i < 400; i++) assert.equal(processor.process(0), 0);
});
Given(
  "an effect receives a non-finite parameter or requests a delay beyond its memory budget",
  function () {
    this.p = mixFixture();
    this.before = JSON.stringify(this.p);
  },
);
When("the engine validates that change", function () {
  assert.throws(() => setParameter(this.p, "track.drums.pan", NaN));
  assert.throws(() =>
    editMix(this.p, (m) => {
      m.returns[0][0].params.time = 1.01;
    }),
  );
  assert.equal(JSON.stringify(this.p), this.before);
});
Then("the effect change is rejected or safely bypassed without non-finite output", function () {
  const e = new EffectProcessor(createEffect("delay", "safe"));
  assert.equal(e.process(NaN), 0);
  const rack = new VoiceRack(prepareInstruments(this.p));
  rack.noteOn(1, 1, 1);
  this.left = new Float32Array(4096);
  const right = new Float32Array(4096),
    start = performance.now();
  rack.process(this.left, right);
  this.elapsed = performance.now() - start;
  assert.ok(this.left.every(Number.isFinite));
});
Then("unrelated tracks continue within the callback budget", function () {
  assert.ok(this.left.some((v) => v !== 0));
  assert.ok(this.elapsed < 2000, `Mac software guardrail 4096 frames/2s exceeded: ${this.elapsed}`);
  this.artifacts.push({
    kind: "trace",
    data: {
      frames: 4096,
      elapsedMs: this.elapsed,
      guardrailMs: 2000,
      hardRealtimeQualified: false,
    },
  });
});
Given(
  "a declared effect preset uses a sixteenth-note filter sequence and eighth-note delay",
  function () {
    this.rhythm = mixFixture();
    this.rhythm = editMix(this.rhythm, (m) => {
      m.tracks.drums.inserts = [createEffect("filter", "rhythm")];
      m.tracks.drums.inserts[0].sync = {
        division: 1,
        sequence: [0.25, 0.8, 0.4, 0.65],
        phase: "transport",
        loss: "hold-last-tempo",
      };
      m.returns[0][0].sync = {
        division: 2,
        sequence: [1],
        phase: "transport",
        loss: "hold-last-tempo",
      };
    });
  },
);
When(
  "the musician changes tempo at an acknowledged bar boundary and records a macro gesture",
  function () {
    this.rhythm = editPerformance(this.rhythm, (p) => {
      p.macros = [
        {
          id: "gesture",
          name: "Filter gesture",
          value: 0.5,
          assignments: [{ parameter: "track.drums.insert.rhythm.cutoff", amount: 0.2 }],
        },
      ];
      p.events = [{ id: "gesture-1", at: 16, kind: "macro", macroId: "gesture", value: 1 }];
    });
    this.roundtrip = ProjectSchema.parse(JSON.parse(JSON.stringify(this.rhythm)));
  },
);
Then(
  "sequence ticks and delay divisions follow the engine's musical clock under the preset's phase policy",
  function () {
    near(musicalSeconds(this.rhythm, 16), 0.8);
    near(musicalSeconds(this.rhythm, 18) - musicalSeconds(this.rhythm, 16), 0.125);
    assert.equal(tempoAt(this.rhythm, 16), 240);
    const e = this.rhythm.mix.returns[0][0],
      d = new EffectProcessor(e);
    d.process(1, 16, 240);
    let echo = 0;
    for (let i = 1; i <= 6000; i++) echo = d.process(0, 16 + i / 3000, 240);
    near(echo, 1);
  },
);
Then(
  "the saved preset and gesture reproduce the same offline response within the declared tolerance",
  function () {
    const a = renderExchange(this.rhythm, "song", "scene-0", 0.1),
      b = renderExchange(this.roundtrip, "song", "scene-0", 0.1);
    assert.deepEqual(a.pcm, b.pcm);
    assert.deepEqual(a.rightPcm, b.rightPcm);
    assert.deepEqual(a.midiFile, b.midiFile);
  },
);
Given("an effect follows an explicitly selected clock source", function () {
  this.holdMix = emptyMix();
  const effect = createEffect("delay", "clocked");
  effect.params = { time: 0.001, feedback: 0, wet: 1 };
  effect.sync = { division: 2, sequence: [1], phase: "transport", loss: "hold-last-tempo" };
  this.holdMix.tracks.drums = { pan: 0, sends: [0, 0], inserts: [effect] };
  this.hold = new StereoMixer(this.holdMix, ["drums"]);
  this.hold.clock(0, 120);
});
When("that source disappears during a sustained note", function () {
  this.hold.process(Float64Array.of(1), 1);
  for (let i = 1; i <= 12000; i++) this.hold.process(Float64Array.of(0), 1);
});
Then(
  "the effect follows its documented hold-last-tempo or stop policy without an implicit port switch",
  function () {
    assert.equal(this.hold.bpm, 120);
    near(this.hold.left, 1);
    near(this.hold.step, 2 + 1 / 6000);
  },
);
Then(
  "all output remains finite and panic still releases the note within the declared limit",
  function () {
    const p = editMix(createDemoProject(), (m) => Object.assign(m, this.holdMix));
    p.pads[0].playback = { mode: "loop", rootNote: 60, chokeGroup: 0 };
    const rack = new VoiceRack(prepareInstruments(p));
    rack.noteOn(1, 0, 0);
    rack.panic();
    const a = new Float32Array(240),
      b = new Float32Array(240);
    rack.process(a, b);
    assert.equal(rack.active, 0);
    assert.ok(a.every(Number.isFinite));
    assert.ok(b.every(Number.isFinite));
  },
);
Given("approved virtual input and output identities are selected", function () {
  this.input = fixturePort("input");
  this.output = fixturePort("output");
  this.route = new VirtualMidiRoute();
  this.route.select(this.input, this.output);
});
When("the virtual master starts, changes tempo at a bar and stops a sustained note", function () {
  const p = editMix(createDemoProject(), (m) => {
    m.tempos = [{ step: 16, bpm: 60 }];
  });
  p.bpm = 120;
  this.route.send({ frame: 0, bytes: [0x90, 60, 100] });
  virtualClock(p, 32, this.route);
});
Then(
  "its capture has twenty-four clocks per quarter and correctly timed transport and cleanup",
  function () {
    const clock = this.route.capture.filter((e) => e.bytes[0] === 0xf8);
    assert.equal(clock.length, 192);
    assert.deepEqual(
      [clock[0].frame, clock[1].frame, clock[96].frame, clock[97].frame],
      mixOracle.clockFrames,
    );
    assert.deepEqual(this.route.capture.at(-2), { frame: 288000, bytes: [0x80, 60, 0] });
    assert.equal(this.route.activeNotes, 0);
    assert.deepEqual(this.route.capture.at(-1).bytes, [0xfc]);
  },
);
Then("the result declares physical MIDI timing unqualified", function () {
  assert.equal(mixOracle.physicalMidiQualified, false);
  this.artifacts.push({
    kind: "trace",
    data: { virtualPackets: this.route.capture, physicalMidiQualified: false },
  });
});
Given("a selected virtual output owns a sustained note", function () {
  this.input = fixturePort("input");
  this.output = fixturePort("output");
  this.route = new VirtualMidiRoute();
  this.route.select(this.input, this.output);
  assert.equal(this.route.send({ frame: 0, bytes: [0x90, 60, 127] }), true);
});
When("it disconnects and another fixture takes its previous list position", function () {
  this.output.connected = false;
  this.replacement = fixturePort("replacement");
  this.route.revalidate([this.input, this.replacement]);
  this.count = this.route.capture.length;
});
Then("no packet reaches the replacement and the old route stays disabled", function () {
  assert.equal(this.route.send({ frame: 100, bytes: [0x90, 64, 127] }), false);
  this.output.connected = true;
  assert.equal(this.route.send({ frame: 101, bytes: [0x90, 64, 127] }), false);
  assert.equal(this.route.capture.length, this.count);
});
Then("only explicit revalidation of the intended identities can restore output", function () {
  this.route.select(this.input, this.output);
  assert.equal(this.route.send({ frame: 102, bytes: [0x90, 64, 127] }), true);
  assert.throws(
    () => this.route.select({ ...this.input, kind: "physical" }, this.output),
    /virtual/,
  );
  this.route.stop(103);
});
Given("a song has a seeded probability trace, tempo changes and a final reverb tail", function () {
  this.p = mixFixture();
  this.p.seed = 42;
  for (const t of this.p.tracks)
    for (const c of t.clips)
      c.steps.push({ step: 15, pad: 0, note: 72, duration: 0.5, velocity: 0.8, probability: 0.7 });
});
When("the musician exports the selected scene and the entire song", function () {
  this.scene = renderExchange(this.p, "scene", "scene-0", 0.5);
  this.song = renderExchange(this.p, "song", "scene-0", 0.5);
  this.plan = exchangePlan(this.p, "song");
});
Then(
  "the stereo WAV headers, durations, event alignment and tails match the export contract",
  function () {
    for (const [render, steps] of [
      [this.scene, 16],
      [this.song, 32],
    ]) {
      const wav = new DataView(render.wav);
      assert.equal(wav.getUint16(22, true), 2);
      assert.equal(wav.getUint32(24, true), 48000);
      assert.equal(wav.getUint16(34, true), 16);
      const body = Math.round(musicalSeconds(this.p, steps) * 48000);
      assert.equal(render.pcm.length, body + 24000);
      assert.ok(render.pcm.slice(body).some((v) => Math.abs(v) > 1e-7));
      assert.ok(render.trace.some((n) => n.frame === 0));
      assert.notDeepEqual(render.pcm, render.rightPcm);
    }
    assert.ok(this.song.trace.some((n) => n.frame === 38400));
  },
);
Then("the MIDI export preserves the supported notes, velocities and tempo map", function () {
  const decoded = decodeMidi(this.song.midiFile);
  assert.deepEqual(decoded.tempos, [
    { tick: 0, micros: 200000 },
    { tick: 3840, micros: 250000 },
  ]);
  assert.deepEqual(
    decoded.notes.map((n) => [n.tick, n.duration, n.note, n.velocity, n.channel]).sort(),
    this.plan.document.notes.map((n) => [n.tick, n.duration, n.note, n.velocity, n.channel]).sort(),
  );
  this.artifacts.push(
    { kind: "audio", data: Buffer.from(this.song.wav) },
    { kind: "trace", data: { notes: decoded.notes, tempos: decoded.tempos } },
  );
});
Given("a valid export already exists at the selected destination", function () {
  this.destination = this.workspace.path("existing.wav");
  this.previous = Buffer.from(
    encodeWav([Float32Array.of(0.25, 0), Float32Array.of(0, 0.25)], 48000),
  );
  writeFileSync(this.destination, this.previous);
});
When("a new export runs out of storage or the musician declines overwrite", async function () {
  const sink = fileExportSink(this.destination, true);
  await assert.rejects(
    saveExport(sink, false, async () => Uint8Array.of(1)),
    /Overwrite/,
  );
  const fail = {
    ...sink,
    stage: async (bytes) => {
      await sink.stage(bytes);
      throw new Error("ENOSPC");
    },
  };
  await assert.rejects(
    saveExport(fail, true, async () => Uint8Array.of(1, 2, 3)),
    /ENOSPC/,
  );
  await assert.rejects(
    saveExport(sink, true, async () => {
      throw new Error("Render failed");
    }),
    /Render failed/,
  );
});
Then("the previous valid file remains unchanged", function () {
  assert.deepEqual(readFileSync(this.destination), this.previous);
});
Then(
  "partial output is removed or clearly identified without a success message",
  async function () {
    assert.ok(!readdirSync(this.workspace.directory).some((p) => p.endsWith(".partial")));
    const bytes = Uint8Array.of(82, 73, 70, 70);
    await saveExport(fileExportSink(this.destination, true), true, async () => bytes);
    assert.deepEqual(readFileSync(this.destination), Buffer.from(bytes));
  },
);
Given(
  "a Mac song uses eight tracks, two inserts per track and two stereo send returns",
  function () {
    this.p = mixFixture();
    assert.equal(this.p.tracks.length, 8);
    assert.ok(Object.values(this.p.mix.tracks).every((t) => t.inserts.length === 2));
  },
);
Given("the MIDI adapter is a named virtual fixture with no physical ports", function () {
  this.route = new VirtualMidiRoute();
  this.route.select(fixturePort("input"), fixturePort("output"));
});
When("the Mac renders the song and exchanges its notes and tempo map", async function () {
  this.render = renderExchange(this.p, "song", "scene-0", 0.1);
  this.live = await workletCapture(this.p, "scene-0", 32, this.render);
  this.decoded = decodeMidi(this.render.midiFile);
  virtualClock(this.p, 32, this.route);
});
Then("the routed stereo worklet matches offline audio and note frames exactly", function () {
  assert.deepEqual(this.live.pcm, this.render.pcm);
  assert.deepEqual(this.live.rightPcm, this.render.rightPcm);
  assert.deepEqual(
    this.live.notes.map((n) => [n.frame, n.note, n.track]),
    this.render.trace.map((n) => [
      n.frame,
      n.note,
      this.p.tracks.findIndex((t) => t.id === n.trackId),
    ]),
  );
  assert.ok(this.live.meters.length > 0);
});
Then(
  "the virtual exchange preserves supported musical data without device operations",
  function () {
    assert.equal(this.decoded.notes.length, this.render.trace.length);
    assert.equal(this.decoded.tempos.length, 2);
    assert.equal(this.route.activeNotes, 0);
    assert.equal(this.deviceOperations.length, 0);
    this.artifacts.push({
      kind: "trace",
      data: {
        profile: mixOracle,
        workletNotes: this.live.notes,
        virtualPackets: this.route.capture.length,
      },
    });
  },
);
Given("the Studio is open with audio disabled", function () {
  this.uiReport = this.workspace.path("mix-ui.json");
});
When("the musician enables stereo mixing, edits pan and an insert, and imports MIDI", function () {
  command(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/mix-ui.test.ts",
    "--reporter=json",
    `--outputFile=${this.uiReport}`,
  ]);
});
Then("the clip replacement requires an explicit action and retains undo support", function () {
  this.ui = JSON.parse(readFileSync(this.uiReport, "utf8"));
  assert.equal(this.ui.success, true);
  assert.ok(this.ui.numPassedTests >= 3);
});
Then("exporting MIDI or testing virtual clock never enables audio or physical MIDI", function () {
  assert.ok(
    this.ui.testResults
      .flatMap((r) => r.assertionResults)
      .some((t) => t.fullName.includes("without enabling audio")),
  );
  this.artifacts.push({ kind: "trace", data: this.ui });
});
