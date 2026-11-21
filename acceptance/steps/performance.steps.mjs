import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderPerformance } from "../../packages/core/src/edits.ts";
import { prepareInstruments, VoiceRack } from "../../packages/core/src/instruments.ts";
import { machines } from "../../packages/core/src/machines.ts";
import {
  deleteTrack,
  editChain,
  editPerformance,
  PerformanceTake,
  PerformanceTransport,
  performanceControls,
  performanceValues,
  performanceWindow,
} from "../../packages/core/src/performance.ts";
import { ProjectSession } from "../../packages/core/src/session.ts";
import {
  chainFixture,
  performanceFixture,
  performanceOracle,
} from "../lib/performance-fixture.mjs";
import { workletCapture } from "../lib/sequence-live.mjs";
import { auditStudioLayout } from "../lib/studio-layout.mjs";
import { buildIdentity, command, root, sha256 } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

Given(
  "a sixteen-step clip is playing and the next scene selects a sixty-four-step clip",
  function () {
    this.performance = performanceFixture();
    this.player = new PerformanceTransport(this.performance);
    this.player.start("scene-0");
    this.player.advance(0);
  },
);
When("the musician queues that scene for the next bar", function () {
  this.player.queueScene("scene-1");
  this.player.advance(15);
  this.beforeLaunch = this.player.snapshot();
  this.boundary = performanceWindow(this.player, 16);
});
Then("the new clip starts from step zero at that boundary", function () {
  assert.equal(this.beforeLaunch.sceneId, "scene-0");
  assert.equal(this.boundary.snapshot.anchors.drums, 16);
  assert.deepEqual(
    this.boundary.notes.filter((n) => n.trackId === "drums").map((n) => [n.position, n.frame]),
    [[16, 96000]],
  );
  const later = performanceWindow(this.player, 64);
  assert.ok(later.notes.some((n) => n.trackId === "drums" && n.frame === 384000));
});
Then("independent clips on other tracks obey the declared restart or continue policy", function () {
  assert.equal(this.boundary.snapshot.anchors["track-1"], 16);
  this.player.queueClip("drums", "clip-0");
  const next = performanceWindow(this.player, 80);
  assert.equal(next.snapshot.anchors.drums, 80);
  assert.equal(next.snapshot.anchors["track-1"], 16);
  assert.deepEqual(next.releases, ["drums"]);
});
Given("a scene launch is queued and another scene has an empty track slot", function () {
  this.performance = performanceFixture();
  delete this.performance.scenes[2].clips.drums;
  this.player = new PerformanceTransport(this.performance);
  this.player.start("scene-0");
  this.player.advance(0);
  this.player.queueScene("scene-1");
});
When("the musician cancels the queued launch and later launches the other scene", function () {
  assert.equal(this.player.cancelLaunch(), true);
  this.player.advance(16);
  this.canceled = this.player.snapshot();
  this.player.queueScene("scene-2");
  this.emptyWindow = performanceWindow(this.player, 32);
});
Then("the canceled launch never occurs", function () {
  assert.equal(this.canceled.sceneId, "scene-0");
  assert.equal(this.emptyWindow.snapshot.sceneId, "scene-2");
});
Then("the empty slot follows the documented stop, continue or silence rule", function () {
  assert.equal(this.emptyWindow.snapshot.clips.drums, undefined);
  assert.ok(this.emptyWindow.releases.includes("drums"));
  assert.ok(!this.emptyWindow.notes.some((n) => n.trackId === "drums"));
  const rack = new VoiceRack(prepareInstruments(this.performance));
  rack.noteOn(1, 0, 0, 60, 1);
  rack.releaseTrack("drums");
  rack.process(new Float32Array(256), new Float32Array(256));
  assert.equal(rack.active, 0);
});
Given(
  "a song contains sixteen-step and sixty-four-step clips and explicit scene repeat counts",
  function () {
    this.performance = editChain(performanceFixture(), chainFixture());
  },
);
When("the musician plays the song from its beginning", function () {
  this.player = new PerformanceTransport(this.performance);
  this.player.start("scene-0", "song");
  this.transitions = [];
  let last = "";
  for (let step = 0; step <= 112; step++) {
    const s = this.player.advance(step).snapshot,
      key = s.position?.occurrenceId;
    if (key !== last) {
      this.transitions.push({ step, id: key });
      last = key;
    }
  }
});
Then("scene changes occur at the expected absolute musical positions", function () {
  assert.deepEqual(
    this.transitions.map((t) => t.step),
    performanceOracle.sceneSteps,
  );
  assert.deepEqual(
    this.transitions.map((t) => t.id),
    ["intro", "long", "outro"],
  );
});
Then("the final scene follows the configured end or loop behavior", function () {
  assert.equal(this.player.running, false);
  const loop = editPerformance(this.performance, (p) => {
      p.end = "loop";
    }),
    a = new PerformanceTransport(loop);
  a.start("scene-0", "song");
  a.advance(112);
  assert.equal(a.running, true);
  assert.equal(a.snapshot().position.occurrenceId, "intro");
});
Given("the current scene appears twice in the song chain", function () {
  this.performance = editChain(performanceFixture(), [
    { id: "active", sceneId: "scene-0", repeats: 2 },
    { id: "later-copy", sceneId: "scene-0", repeats: 1 },
    { id: "long", sceneId: "scene-1", repeats: 1 },
    { id: "future", sceneId: "scene-2", repeats: 1 },
  ]);
  this.player = new PerformanceTransport(this.performance);
  this.player.start("scene-0", "song");
  this.player.advance(4);
});
When("the musician removes the later occurrence and reorders a future scene", function () {
  this.performance = editChain(this.performance, [
    { id: "active", sceneId: "scene-0", repeats: 1 },
    { id: "future", sceneId: "scene-2", repeats: 1 },
    { id: "long", sceneId: "scene-1", repeats: 1 },
  ]);
  this.player.setProject(this.performance);
  this.player.advance(31);
  this.beforeEditBoundary = this.player.snapshot();
  this.player.advance(32);
});
Then("the active scene completes under the documented edit-boundary policy", function () {
  assert.equal(this.beforeEditBoundary.position.occurrenceId, "active");
  assert.equal(this.beforeEditBoundary.position.offset, 31);
  assert.equal(this.player.snapshot().position.occurrenceId, "future");
});
Then("song position resolves to a valid next occurrence without a transport crash", function () {
  this.player.advance(48);
  assert.equal(this.player.snapshot().position.occurrenceId, "long");
  assert.ok(
    this.performance.performance.chain.some(
      (e) => e.id === this.player.snapshot().position.occurrenceId,
    ),
  );
});
Given("drum and synth tracks are playing through a shared delay send", function () {
  this.performance = performanceFixture();
  const t = this.performance.tracks[1];
  t.machine = machines.instantiate("xmp.subtractive");
  t.clips[0].steps = [{ step: 0, pad: 1, note: 48, duration: 8, velocity: 0.5, probability: 1 }];
  this.parameter = "track.track-1.machine.xmp.subtractive.v1.cutoff";
  this.performance = editPerformance(this.performance, (p) => {
    p.delay = { steps: 2, feedback: 0.5, wet: 0.5, sends: { drums: 1, "track-1": 0 } };
    p.macros = [
      {
        id: "tone",
        name: "Tone",
        value: 0.5,
        assignments: [{ parameter: this.parameter, amount: 0.2 }],
      },
    ];
  });
});
When("the musician mutes the drum track, solos the synth and moves a macro", function () {
  this.performance = editPerformance(this.performance, (p) => {
    p.events = [
      { id: "mute", kind: "mute", trackId: "drums", at: 1, value: true },
      { id: "solo", kind: "solo", trackId: "track-1", at: 2, value: true },
      { id: "macro", kind: "macro", macroId: "tone", at: 3, value: 1 },
    ];
  });
  this.wet = renderPerformance(this.performance, { mode: "scene", steps: 16, tailSeconds: 1 });
  this.dry = renderPerformance(
    editPerformance(this.performance, (p) => {
      p.delay.wet = 0;
    }),
    { mode: "scene", steps: 16, tailSeconds: 1 },
  );
});
Then(
  "newly triggered events and effect tails follow the documented mute and solo rules",
  function () {
    assert.ok(!this.wet.trace.some((e) => e.trackId === "drums" && e.frame >= 6000));
    assert.ok(this.wet.trace.some((e) => e.trackId === "track-1"));
    assert.ok(Math.abs(this.wet.pcm[12000] - this.dry.pcm[12000] - 0.25) < 1e-6);
    assert.ok(Math.abs(this.wet.pcm[24000] - this.dry.pcm[24000] - 0.125) < 1e-6);
    assert.ok(this.wet.pcm.every(Number.isFinite));
  },
);
Then("the macro controls only its assigned parameter identities", function () {
  const c = performanceControls(this.performance, 3);
  assert.deepEqual(Object.keys(c.offsets), [this.parameter]);
  const a = new PerformanceTransport(this.performance);
  a.start("scene-0");
  a.advance(3);
  assert.ok(performanceValues(a, 3).values[this.parameter] > 0.2);
  assert.equal(performanceValues(a, 3).values["track.drums.effect.gain"], 0.5);
});
Given("a performance macro controls parameters on a selected track", function () {
  this.performance = editPerformance(performanceFixture(), (p) => {
    p.macros = [
      {
        id: "selected",
        name: "Selected",
        value: 0.5,
        assignments: [{ parameter: "track.track-1.gain", amount: 0.5 }],
      },
    ];
  });
});
When("the musician deletes that track and later moves the macro", function () {
  this.performance = deleteTrack(this.performance, "track-1");
  this.player = new PerformanceTransport(this.performance);
  this.player.start("scene-0");
  this.player.advance(0);
  this.player.control({ id: "move", kind: "macro", macroId: "selected", at: 1, value: 1 });
});
Then("stale assignments are removed or clearly marked unavailable", function () {
  assert.deepEqual(this.performance.performance.macros[0].assignments, []);
});
Then("no other track receives the deleted track's control events", function () {
  const c = performanceValues(this.player, 1);
  assert.equal(c.values["track.track-1.gain"], undefined);
  assert.equal(c.values["track.drums.gain"], 1);
});
Given("a musician has eight tracks and sixteen scenes", function () {
  this.session = new ProjectSession(performanceFixture(), true);
  assert.equal(this.session.project.tracks.length, 8);
  assert.equal(this.session.project.scenes.length, 16);
});
When(
  "the musician creates a scene chain with repeats, performs mutes and records macros",
  function () {
    this.session.edit((p) => editChain(p, chainFixture()));
    this.session.edit((p) =>
      editPerformance(p, (s) =>
        s.macros.push({
          id: "level",
          name: "Level",
          value: 0.5,
          assignments: [{ parameter: "track.track-1.gain", amount: 0.5 }],
        }),
      ),
    );
    const take = new PerformanceTake("stage");
    take.record({ at: 17, kind: "macro", macroId: "level", value: 0 });
    take.record({ at: 32, kind: "mute", trackId: "drums", value: true });
    this.session.edit((p) =>
      editPerformance(p, (s) => {
        s.events = take.finish();
        s.selection = { sceneId: "scene-1", clips: { ...p.scenes[1].clips } };
        s.position = { occurrenceId: "long", offset: 12 };
      }),
    );
  },
);
When("saves, closes and reopens the song", async function () {
  const file = this.workspace.path("performance.xmp.json");
  writeFileSync(file, await exportPortable(this.session.project));
  this.performance = await importPortable(readFileSync(file, "utf8"));
});
Then("the scene chain, clip selections and performance automation are preserved", function () {
  assert.deepEqual(this.performance, this.session.project);
  assert.equal(this.performance.performance.position.offset, 12);
  assert.deepEqual(this.performance.performance.chain, chainFixture());
});
Then("replaying the song produces the expected transitions and event trace", async function () {
  const r = renderPerformance(this.performance, { steps: 113, tailSeconds: 0 }),
    live = await workletCapture(this.performance, "scene-0", 0, r);
  assert.deepEqual(
    r.transitions.map((t) => t.step),
    [0, 32, 96],
  );
  assert.equal(r.bodySteps, 112);
  assert.deepEqual(
    r.trace.map((e) => [e.frame, e.trackId]),
    [
      [0, "drums"],
      [0, "track-1"],
      [96000, "drums"],
      [96000, "track-1"],
      [192000, "track-1"],
      [288000, "track-1"],
      [384000, "track-1"],
      [480000, "track-1"],
      [576000, "track-1"],
    ],
  );
  assert.deepEqual(
    live.notes.map((n) => [n.frame, n.track]),
    r.trace.map((n) => [n.frame, this.performance.tracks.findIndex((t) => t.id === n.trackId)]),
  );
  assert.deepEqual(live.pcm, r.pcm);
  this.artifacts.push({
    kind: "log",
    data: { transitions: r.transitions, trace: r.trace, hardwareQualified: false },
  });
});
Given("Studio runs in an isolated DOM under the declared Mac preview profile", function () {
  this.uiReport = this.workspace.path("performance-ui.json");
});
function uiFlow(world, name) {
  command(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/performance-ui.test.ts",
    "--testNamePattern",
    name,
    "--reporter=json",
    "--outputFile",
    world.uiReport,
  ]);
  const r = JSON.parse(readFileSync(world.uiReport, "utf8")),
    cases = r.testResults.flatMap((s) => s.assertionResults).filter((t) => t.status === "passed");
  assert.equal(cases.length, 1);
  assert.equal(cases[0].title, name);
  world.uiPassed = true;
  world.contributorReports = [["performance-ui.json", world.uiReport]];
}
When(
  "the musician browses a sound, edits notes, selects a scene and opens Mix in the preview",
  function () {
    uiFlow(this, "navigates primary preview views without opening an audio or hardware device");
  },
);
Then("the primary preview controls retain their view and parameter identities", function () {
  assert.equal(this.uiPassed, true);
});
Then("no hardware display or input capability is inferred from the DOM check", function () {
  assert.equal(this.uiPassed, true);
  assert.deepEqual(this.deviceOperations, []);
});
When(
  "a sample import fails while a virtual track encoder is assigned and views redraw",
  function () {
    uiFlow(
      this,
      "restores the same error assignment or clears it when a redraw changes the selected track",
    );
  },
);
Then(
  "dismissal restores the same parameter or explicitly clears the unavailable assignment",
  function () {
    assert.equal(this.uiPassed, true);
  },
);
Then("the next virtual encoder movement cannot alter another track", function () {
  assert.equal(this.uiPassed, true);
});
When(
  "the musician requests Help on a focused sound parameter and closes it after a redraw",
  function () {
    uiFlow(this, "keeps performance state and scoped focus intact while Help survives a redraw");
  },
);
Then(
  "the clock anchor, queued launch, project revision and undo depths are preserved",
  function () {
    assert.equal(this.uiPassed, true);
  },
);
Then(
  "focus and the next virtual encoder action retain their original parameter identity",
  function () {
    assert.equal(this.uiPassed, true);
  },
);
Given(
  "a current-source browser audit of the declared Mac performance layout",
  { timeout: 120000 },
  async function () {
    this.layout = await auditStudioLayout(process.env.XMP_EVIDENCE_DIR);
    assert.equal(this.layout.sourceHash, buildIdentity());
    assert.equal(this.layout.width, 1280);
    assert.equal(this.layout.height, 800);
  },
);
When(
  "the primary target rectangles are checked across Play, Sounds, Pattern, Perform and Mix",
  function () {
    assert.deepEqual(
      this.layout.views.map((v) => v.name),
      ["play", "sounds", "pattern", "perform", "mix"],
    );
    for (const view of this.layout.views) {
      assert.ok(view.controls.length >= 4);
      for (const c of view.controls) {
        assert.ok(c.focusable && c.visible);
        assert.ok(c.width >= 44 && c.height >= 44, `${view.name}: ${c.id} small`);
        assert.ok(
          c.left >= 0 && c.top >= 0 && c.right <= 1280 && c.bottom <= 800,
          `${view.name}: ${c.id} outside viewport`,
        );
      }
      for (let i = 0; i < view.controls.length; i++)
        for (let j = i + 1; j < view.controls.length; j++) {
          const a = view.controls[i],
            b = view.controls[j];
          assert.ok(
            a.right <= b.left + 0.5 ||
              b.right <= a.left + 0.5 ||
              a.bottom <= b.top + 0.5 ||
              b.bottom <= a.top + 0.5,
            `${view.name}: ${a.id} overlaps ${b.id}`,
          );
        }
      assert.equal(sha256(readFileSync(resolve(root, view.screenshot))), view.screenshotHash);
    }
  },
);
Then(
  "measured targets are reachable without overlap and have visible focusable controls",
  function () {
    assert.ok(this.layout.views.every((v) => v.controls.length >= 4));
  },
);
Then("the audit keeps physical display and hardware control qualification pending", function () {
  assert.equal(this.layout.physicalDisplayQualified, false);
  assert.equal(this.layout.hardwareControlsQualified, false);
});
