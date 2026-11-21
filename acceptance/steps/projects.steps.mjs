import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { parameterDisplay } from "../../apps/studio/src/parameter-view.ts";
import { exportPortable, hashSample, importPortable } from "../../packages/core/src/assets.ts";
import { loadCore, renderProjectScene } from "../../packages/core/src/edits.ts";
import {
  createDemoProject,
  createLegacyDemoProject,
  eventsAtStep,
  openProject,
  PROJECT_VERSION,
  toggleStep,
} from "../../packages/core/src/index.ts";
import {
  advanceParameter,
  clearParameterSource,
  parameterSmoothingMs,
  parameterValue,
  setParameter,
} from "../../packages/core/src/parameters.ts";
import { ProjectSession } from "../../packages/core/src/session.ts";
import { LocalProjectStore } from "../lib/project-store.mjs";
import { eightTrackFixture } from "../lib/song-fixture.mjs";
import { command, root, scenarioWorkspace } from "../lib/workspace.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const trace = (project) =>
  Array.from({ length: 64 }, (_, step) => eventsAtStep(project, "scene-0", step));
Given("a version-1 project with known notes, scenes and samples", function () {
  this.legacy = createLegacyDemoProject();
  this.legacyText = JSON.stringify(this.legacy);
  this.expectedLegacyTrace = trace({ ...this.legacy, seed: 0, parameters: [] });
});
When("the musician opens it in the next supported project-format version", function () {
  this.opened = openProject(this.legacyText);
});
Then("a validated migration preserves the musical event trace", function () {
  assert.equal(this.opened.project.version, 8);
  assert.equal(this.opened.migrated, true);
  assert.deepEqual(trace(this.opened.project), this.expectedLegacyTrace);
  assert.deepEqual(this.opened.project.samples, this.legacy.samples);
  assert.deepEqual(this.opened.project.scenes, this.legacy.scenes);
});
Then("the original file remains available for recovery", function () {
  assert.equal(this.opened.originalText, this.legacyText);
  assert.deepEqual(JSON.parse(this.opened.originalText), this.legacy);
});
Given("the musician has unsaved changes in a valid project", function () {
  this.unsavedSession = new ProjectSession(createDemoProject(), true);
  this.unsavedSession.edit((project) => ({ ...project, name: "Unsaved pattern" }));
  this.current = this.unsavedSession.project;
  this.before = JSON.stringify(this.current);
});
When(
  "the musician opens a future-version project or one with a missing clip reference",
  async function () {
    const broken = structuredClone(this.current);
    broken.scenes[0].clips.drums = "missing-clip";
    this.openErrors = [];
    for (const candidate of [{ ...this.current, version: 99 }, broken]) {
      try {
        await this.unsavedSession.open(JSON.stringify(candidate));
      } catch (error) {
        this.openErrors.push(error.message);
      }
    }
    this.current = this.unsavedSession.project;
  },
);
Then("an actionable validation error is shown", function () {
  assert.equal(this.openErrors.length, 2);
  assert.match(this.openErrors[0], /Unsupported project version/);
  assert.match(this.openErrors[1], /missing track or clip/);
});
Then("the current project and its unsaved changes remain intact", function () {
  assert.equal(JSON.stringify(this.current), this.before);
  assert.equal(this.unsavedSession.dirty, true);
  assert.equal(this.unsavedSession.canUndo, true);
});

Given("a normalized parameter has base 0.2, automation 0.4 and a step lock of 0.7", function () {
  this.parameterProject = createDemoProject();
  this.parameterId = "track.drums.gain";
  for (const [source, value] of [
    ["base", 0.2],
    ["automation", 0.4],
    ["stepLock", 0.7],
  ])
    this.parameterProject = setParameter(this.parameterProject, this.parameterId, value, source);
});
Given("its macro adds 0.1 and its LFO adds -0.2", function () {
  this.parameterProject = setParameter(this.parameterProject, this.parameterId, 0.1, "macro");
  this.parameterProject = setParameter(this.parameterProject, this.parameterId, -0.2, "lfo");
});
When("the engine resolves the parameter for the locked step", function () {
  this.effective = parameterValue(this.parameterProject, this.parameterId);
  this.nativeEffective = Number(
    command(resolve(root, "build/native/xmp_parameter"), [
      "0.2",
      "0.4",
      "0.7",
      "0.1",
      "-0.2",
    ]).trim(),
  );
});
Then("the effective value is 0.6 within 0.000001", function () {
  assert.ok(Math.abs(this.effective - 0.6) < 0.000001);
});
Then("the UI, offline render and native engine report the same effective value", function () {
  assert.ok(
    Math.abs(
      parameterDisplay(this.parameterProject, this.parameterId).value - this.nativeEffective,
    ) < 0.000001,
  );
  const event = eventsAtStep(this.parameterProject, "scene-0", 0).find((event) => event.pad === 0);
  assert.ok(Math.abs(event.velocity / 0.9 - this.nativeEffective) < 0.000001);
  assert.equal(parameterSmoothingMs(this.parameterProject, this.parameterId), 10);
  const smoothed = advanceParameter(this.parameterProject, this.parameterId, 0, 480);
  const nativeSmoothed = Number(
    command(resolve(root, "build/native/xmp_parameter"), [
      "--smooth",
      "0",
      "0.6",
      "48000",
      "10",
      "480",
    ]).trim(),
  );
  assert.ok(Math.abs(smoothed - 0.6 * (1 - Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(smoothed - nativeSmoothed) < 1e-12);
  const released = clearParameterSource(this.parameterProject, this.parameterId, "stepLock");
  assert.ok(Math.abs(parameterValue(released, this.parameterId) - 0.3) < 0.000001);
});
Given("a running project has registered parameter identities and ranges", function () {
  this.parameterProject = createDemoProject();
  this.parameterBefore = JSON.stringify(this.parameterProject);
  this.playbackBefore = eventsAtStep(this.parameterProject, "scene-0", 0);
  this.dspCalls = 0;
});
When("a command addresses an unknown parameter or supplies a non-finite value", function () {
  this.parameterErrors = [];
  for (const [id, value] of [
    ["track.absent.gain", 0.2],
    ["master.gain", NaN],
    ["master.gain", Infinity],
    ["master.gain", -0.1],
    ["master.gain", 1.1],
  ]) {
    try {
      const next = setParameter(this.parameterProject, id, value);
      this.dspCalls++;
      this.parameterProject = next;
    } catch (error) {
      this.parameterErrors.push(error);
    }
  }
});
Then("the command is rejected before reaching DSP processing", function () {
  assert.equal(this.parameterErrors.length, 5);
  assert.equal(this.dspCalls, 0);
  assert.equal(
    spawnSync(resolve(root, "build/native/xmp_parameter"), ["nan", "none", "none", "0", "0"])
      .status,
    1,
  );
});
Then("existing parameter values and audio playback remain valid", function () {
  assert.equal(JSON.stringify(this.parameterProject), this.parameterBefore);
  assert.deepEqual(eventsAtStep(this.parameterProject, "scene-0", 0), this.playbackBefore);
});

Given("two pads reference one content-addressed sample", async function () {
  this.sharedProject = createDemoProject();
  this.sharedProject.pads.forEach((pad) => {
    pad.sampleId = "sample-0";
  });
  this.sharedProject.samples = [this.sharedProject.samples[0]];
  this.assetHash = await hashSample(
    this.sharedProject.samples[0].sampleRate,
    this.sharedProject.samples[0].pcm,
  );
});
When("the musician packages and reopens the project in an empty workspace", async function () {
  this.portable = await exportPortable(this.sharedProject);
  writeFileSync(this.workspace.path("portable.xmp.json"), this.portable);
  this.reopenedPortable = await importPortable(
    readFileSync(this.workspace.path("portable.xmp.json"), "utf8"),
  );
});
Then("both pads resolve the same verified sample content", async function () {
  for (const pad of this.reopenedPortable.pads.slice(0, 2)) {
    const sample = this.reopenedPortable.samples.find((sample) => sample.id === pad.sampleId);
    assert.equal(await hashSample(sample.sampleRate, sample.pcm), this.assetHash);
  }
  assert.deepEqual(this.reopenedPortable, this.sharedProject);
});
Then("duplicate sample data is not required in the package", function () {
  const bundle = JSON.parse(this.portable);
  assert.equal(bundle.assets.length, 1);
  assert.ok(bundle.project.samples.every((sample) => !("pcm" in sample)));
});
Given("an import exceeds the profile size limit or contains a corrupt sample hash", function () {
  this.current = createDemoProject();
  this.before = JSON.stringify(this.current);
});
When("the musician attempts to import it", function () {
  this.budgetProcess = spawnSync(
    process.execPath,
    ["--max-old-space-size=256", "acceptance/lib/import-budget-fixture.mjs"],
    { cwd: root, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(this.budgetProcess.status, 0, this.budgetProcess.stderr);
  this.budget = JSON.parse(this.budgetProcess.stdout);
  this.evidenceDirectory = this.workspace.path("import-evidence");
  mkdirSync(this.evidenceDirectory);
  writeFileSync(resolve(this.evidenceDirectory, "budget.json"), JSON.stringify(this.budget));
});
Then("the import fails before committing project or asset changes", function () {
  assert.equal(this.budget.failures.length, 3);
  assert.match(this.budget.failures[0], /exceeds 96 MiB/);
  assert.match(this.budget.failures[1], /Corrupt sample hash/);
  assert.equal(this.budget.committedChanges, 0);
  assert.equal(JSON.stringify(this.current), this.before);
});
Then("memory use remains inside the declared import budget", function () {
  assert.ok(this.budget.rssBytes <= this.budget.rssBudgetBytes, JSON.stringify(this.budget));
  this.artifacts.push({
    kind: "log",
    data: {
      event: "bounded-import-rss",
      frame: this.budget.rssBytes,
      expectedFrame: this.budget.rssBudgetBytes,
      outcome: "passed",
    },
  });
});

Given("a musician edits a pattern, a sample slice and an effect parameter", async function () {
  this.store = new LocalProjectStore(this.workspace);
  this.committed = createDemoProject();
  await this.store.save(this.committed);
  this.session = new ProjectSession(this.committed, true);
  this.session.edit((project) => {
    const edited = toggleStep(project, "drums", "clip-0", 5, 3);
    edited.pads[0].slice = { start: 1, end: 100 };
    return setParameter(edited, "track.drums.effect.gain", 0.6);
  });
  this.edited = this.session.project;
});
When("the save process is interrupted before its atomic commit", async function () {
  writeFileSync(this.workspace.path("candidate.xmp.json"), await exportPortable(this.edited));
  this.interrupted = spawnSync(
    process.execPath,
    ["acceptance/lib/interrupted-save-fixture.mjs", this.workspace.directory],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(this.interrupted.status, 77, this.interrupted.stderr);
});
When("the application restarts", async function () {
  this.restarted = await new LocalProjectStore(this.workspace).load();
});
Then("the previous committed project or a validated recovery snapshot is offered", function () {
  assert.deepEqual(this.restarted.project, this.committed);
  assert.notDeepEqual(this.restarted.project, this.edited);
});
Then("no partially written project is silently treated as valid", async function () {
  assert.equal(this.restarted.recovered, false);
  await assert.rejects(
    importPortable(readFileSync(this.workspace.path("pending.xmp.json"), "utf8")),
  );
});
Given("the musician has unsaved project changes", async function () {
  this.store = new LocalProjectStore(this.workspace);
  this.committed = createDemoProject();
  await this.store.save(this.committed);
  this.session = new ProjectSession(this.committed, true);
  this.session.edit((project) => toggleStep(project, "drums", "clip-0", 5, 3));
  this.edited = this.session.project;
});
Given("the project storage fixture reports no free space", function () {
  this.fullStorage = {
    save: async () => {
      throw new Error("Storage is full (ENOSPC); free space or download a portable copy");
    },
  };
});
When("the musician saves the project", async function () {
  await assert.rejects(this.session.save(this.fullStorage), /Storage is full/);
});
Then("save status remains unsaved and the storage failure is explained", function () {
  assert.equal(this.session.dirty, true);
  assert.match(this.session.error, /Unsaved changes: Storage is full/);
  assert.deepEqual(this.session.project, this.edited);
});
Then("undo history and the previous committed project remain available", async function () {
  assert.equal(this.session.canUndo, true);
  assert.deepEqual((await this.store.load()).project, this.committed);
  this.session.undo();
  assert.deepEqual(this.session.project, this.committed);
  this.session.redo();
  assert.deepEqual(this.session.project, this.edited);
});

Given(
  "a musician has eight tracks, sixteen scenes, samples and parameter assignments",
  function () {
    this.song = eightTrackFixture();
    assert.equal(this.song.tracks.length, 8);
    assert.equal(this.song.scenes.length, 16);
    assert.equal(this.song.seed, 73019);
  },
);
When(
  "the musician exports a portable project and opens it on another supported target",
  async function () {
    this.songPackage = await exportPortable(this.song);
    this.emptyTarget = scenarioWorkspace();
    this.additionalWorkspaces.push(this.emptyTarget);
    writeFileSync(this.emptyTarget.path("portable.xmp.json"), this.songPackage);
    const result = spawnSync(
      process.execPath,
      ["acceptance/lib/reopen-song-fixture.mjs", this.emptyTarget.directory],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    this.nativeIdentity = JSON.parse(result.stdout);
    this.nativeSong = JSON.parse(readFileSync(this.emptyTarget.path("reopened.json"), "utf8"));
    this.nativeTrace = JSON.parse(readFileSync(this.emptyTarget.path("event-trace.json"), "utf8"));
    this.nativeAudio = readFileSync(this.emptyTarget.path("native-song.wav"));
    this.macAudio = Buffer.from(renderProjectScene(this.song, "scene-0"));
    this.evidenceDirectory = this.workspace.path("song-evidence");
    mkdirSync(this.evidenceDirectory);
    writeFileSync(
      resolve(this.evidenceDirectory, "native-identity.json"),
      JSON.stringify(this.nativeIdentity),
    );
    writeFileSync(resolve(this.evidenceDirectory, "events.json"), JSON.stringify(this.nativeTrace));
    writeFileSync(resolve(this.evidenceDirectory, "native.wav"), this.nativeAudio);
    writeFileSync(resolve(this.evidenceDirectory, "mac.wav"), this.macAudio);
  },
);
Then("track, clip, scene, asset and parameter identities are preserved", async function () {
  assert.deepEqual(this.nativeSong, this.song);
  assert.equal(await exportPortable(this.nativeSong), this.songPackage);
  assert.equal(this.nativeIdentity.projectVersion, PROJECT_VERSION);
  assert.match(this.nativeIdentity.nativeBinaryHash, /^[a-f0-9]{64}$/);
});
Then(
  "rendering the same seeded song produces the expected event trace and audio within the render tolerance",
  function () {
    const expected = Array.from({ length: 8 }, (_, index) => ({
      frame: index * 6000,
      sample: 0,
      velocity: index === 0 ? 0.6 : 0.5,
      trackId: `t${index}`,
      pad: index,
      step: index,
    }));
    // Independent Python FNV-1a oracle: 0.10757778701372445 < 0.5, so step 12 plays.
    expected.push({ frame: 72000, sample: 0, velocity: 0.3, trackId: "t0", pad: 15, step: 12 });
    assert.equal(this.nativeTrace.length, expected.length);
    this.nativeTrace.forEach((event, index) => {
      assert.deepEqual({ ...event, velocity: expected[index].velocity }, expected[index]);
      assert.ok(Math.abs(event.velocity - expected[index].velocity) < 1e-6);
    });
    assert.equal(this.nativeAudio.length, 44 + 96000 * 4);
    assert.equal(this.macAudio.length, this.nativeAudio.length);
    for (let frame = 0; frame < 96000; frame++)
      for (let channel = 0; channel < 2; channel++) {
        const expectedPcm =
          frame === 72000
            ? 4915
            : frame % 6000 === 0 && frame < 48000
              ? frame === 0
                ? 9830
                : 8192
              : 0;
        const actual = this.nativeAudio.readInt16LE(44 + frame * 4 + channel * 2),
          desktop = this.macAudio.readInt16LE(44 + frame * 4 + channel * 2);
        assert.ok(
          Math.abs(actual - expectedPcm) <= 2,
          `Native PCM mismatch at ${frame}: ${actual} vs ${expectedPcm}`,
        );
        assert.ok(Math.abs(desktop - actual) <= 2, `Mac/native difference at ${frame}`);
      }
    this.artifacts.push(
      { kind: "audio", data: this.nativeAudio },
      { kind: "audio", data: this.macAudio },
      {
        kind: "trace",
        data: this.nativeTrace.map((event) => ({ event: "note", frame: event.frame })),
      },
    );
  },
);
Then("the project does not depend on a developer workstation path", function () {
  assert.ok(!this.songPackage.includes(root));
  assert.ok(!this.songPackage.includes(this.emptyTarget.directory));
  assert.equal(this.nativeIdentity.physicalOperations, 0);
  const descriptor = JSON.parse(this.songPackage);
  assert.ok(
    descriptor.project.samples.every(
      (sample) => Object.keys(sample).sort().join(",") === "assetHash,id,name",
    ),
  );
  assert.equal(descriptor.assets.length, 1);
});
