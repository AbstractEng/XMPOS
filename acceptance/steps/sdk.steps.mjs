import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { encodeWav } from "../../packages/core/src/index.ts";
import { machines } from "../../packages/core/src/machines.ts";
import {
  ExpressionTake,
  negotiateExpression,
  negotiateModule,
} from "../../packages/sdk/src/community/contract.ts";
import {
  buildPackage,
  canonical,
  digest,
  parsePackage,
} from "../../packages/sdk/src/community/package.ts";
import { CommunityProcessor, renderCommunity } from "../../packages/sdk/src/community/program.ts";
import {
  bindCommunity,
  validateCommunityProject,
} from "../../packages/sdk/src/community/project.ts";
import { openPackageStore } from "../../tools/sdk/store.mjs";
import { CommunityUiSupervisor, probeTrustedNativeFault } from "../../tools/sdk/supervisor.mjs";
import { operations, startEngineHost } from "../lib/engine-target.mjs";
import { sdkFixture, sdkOracle, sdkProject, sdkUpgrade } from "../lib/sdk-fixture.mjs";
import { buildIdentity, command, root } from "../lib/workspace.mjs";

const stateFor = (m) => Object.fromEntries(m.parameters.map((p) => [p.id, p.default]));
const run = (...args) => command(process.execPath, ["tools/sdk/cli.mjs", ...args]);
Given(
  "a package requests an unknown API, wrong architecture or undeclared device access",
  async function () {
    this.sdk = await sdkFixture();
    this.badManifests = [
      { ...this.sdk.manifest, apiVersion: 999 },
      { ...this.sdk.manifest, architecture: "linux-x64" },
      { ...this.sdk.manifest, capabilities: ["device-write"] },
      { ...this.sdk.manifest, adapter: "vst3" },
    ];
    this.sdkBefore = canonical(sdkProject());
    this.registryBefore = machines.list().map((d) => d.id);
  },
);
When("a musician tries to load it", function () {
  this.rejections = this.badManifests.map((m) => {
    assert.throws(() => negotiateModule(m));
    return true;
  });
});
Then("validation rejects it before running module code", function () {
  assert.equal(this.rejections.length, 4);
  assert.equal(sdkOracle.nativePackageLoader, false);
});
Then("the running project and existing modules remain unchanged", function () {
  assert.equal(canonical(sdkProject()), this.sdkBefore);
  assert.deepEqual(
    machines.list().map((d) => d.id),
    this.registryBefore,
  );
});
Given(
  "a supported portable manifest declares its parameter units and optional expression",
  async function () {
    this.sdk = await sdkFixture();
  },
);
When("the SDK negotiates it and the locally compiled native ABI probe runs", function () {
  this.contract = negotiateModule(this.sdk.manifest);
  this.nativeContract = JSON.parse(
    command(resolve(root, "build/native/xmp_community_contract"), []),
  );
});
Then("both contracts retain stable note ownership and reject incompatible versions", function () {
  assert.equal(this.contract.manifest.apiVersion, 2);
  assert.deepEqual(
    this.contract.manifest.parameters.map((p) => [p.id, p.unit, p.min, p.max, p.default]),
    [
      ["level", "linear", 0, 1, 0.25],
      ["cutoff", "Hz", 20, 20000, 8000],
    ],
  );
  assert.deepEqual(this.nativeContract.first, [101, 0.25, 12, 0.4]);
  assert.deepEqual(this.nativeContract.second, [102, 1, 0, 1]);
  assert.equal(this.nativeContract.dspAbi, 1);
});
Then("native, VST, CV and physical-input package adapters remain unavailable", function () {
  for (const adapter of ["trusted-native-v1", "vst3", "cv", "audio-input"])
    assert.throws(() => negotiateModule({ ...this.sdk.manifest, adapter }), /unavailable/);
  this.artifacts.push({
    kind: "trace",
    data: { ...sdkOracle, native: this.nativeContract, contract: this.contract },
  });
});
Given(
  "a virtual input and an instrument both declare per-note pressure, pitch and timbre",
  async function () {
    this.sdk = await sdkFixture();
    this.expressionTake = new ExpressionTake(
      this.sdk.manifest.capabilities,
      this.sdk.manifest.capabilities,
    );
    this.processor = new CommunityProcessor(
      this.sdk.manifest,
      this.sdk.program,
      stateFor(this.sdk.manifest),
    );
  },
);
Given("two overlapping voices have distinct stable note identities", function () {
  for (const [id, note] of [
    [101, 60],
    [102, 64],
  ]) {
    this.processor.noteOn({ id, note, velocity: 1, durationFrames: 0 });
    this.expressionTake.append({ kind: "on", id, timestamp: 0, note, velocity: 1 });
  }
  this.secondBefore = this.processor.snapshot()[1];
});
When(
  "the input changes only the first note's expression and the project records the take",
  function () {
    for (const [dimension, value] of [
      ["pressure", 0.25],
      ["pitch", 12],
      ["timbre", 0.4],
    ]) {
      this.expressionTake.append({
        kind: "expression",
        id: 101,
        timestamp: 0.125,
        dimension,
        value,
      });
      this.processor.expression(101, dimension, value);
    }
  },
);
Then("only that voice changes and the second voice retains its expression values", function () {
  assert.deepEqual(this.processor.snapshot()[1], this.secondBefore);
  assert.deepEqual(this.processor.snapshot()[0], {
    id: 101,
    note: 60,
    pressure: 0.25,
    pitch: 12,
    timbre: 0.4,
  });
  const pcm = new Float32Array(256);
  this.processor.process(pcm, 256);
  assert.ok(pcm.some((v) => v !== 0) && pcm.every(Number.isFinite));
});
Then(
  "save and reopen preserve note ownership, timestamps and supported expression dimensions",
  async function () {
    const p = await bindCommunity(sdkProject(), "drums", this.sdk.pkg);
    p.takes = [
      {
        trackId: "drums",
        source: this.sdk.manifest.capabilities,
        events: this.expressionTake.snapshot(),
      },
    ];
    const opened = await validateCommunityProject(JSON.parse(JSON.stringify(p)), [this.sdk.pkg]);
    assert.deepEqual(opened, p);
    assert.deepEqual(
      opened.takes[0].events.slice(2).map((e) => [e.id, e.timestamp, e.dimension]),
      [
        [101, 0.125, "pressure"],
        [101, 0.125, "pitch"],
        [101, 0.125, "timbre"],
      ],
    );
  },
);
Given(
  "a module accepts velocity but does not declare per-note pitch or pressure",
  async function () {
    this.sdk = await sdkFixture();
    this.sdk.manifest.capabilities = ["notes", "velocity", "audio-output"];
    this.processor = new CommunityProcessor(
      this.sdk.manifest,
      this.sdk.program,
      stateFor(this.sdk.manifest),
    );
    this.processor.noteOn({ id: 101, note: 60, velocity: 1, durationFrames: 0 });
    this.beforeExpression = this.processor.snapshot();
  },
);
When("an input requests those unsupported dimensions", function () {
  this.unavailable = negotiateExpression(["pressure", "pitch"], this.sdk.manifest.capabilities, [
    "pressure",
    "pitch",
  ]);
  for (const d of ["pressure", "pitch"])
    assert.throws(() => this.processor.expression(101, d, 0.5), /unavailable/);
});
Then("capability negotiation reports them unavailable before delivery", function () {
  assert.deepEqual(this.unavailable, { available: [], unavailable: ["pressure", "pitch"] });
});
Then(
  "existing notes keep their values without channel-wide expression leaking across voices",
  function () {
    assert.deepEqual(this.processor.snapshot(), this.beforeExpression);
  },
);
Given("a clean supported development environment", function () {
  assert.match(process.version, /^v24\./);
  this.quickstart = this.workspace.path("contributor");
  mkdirSync(this.quickstart);
  assert.deepEqual(readdirSync(this.quickstart), []);
});
When("a contributor follows the quickstart to create an instrument and an effect", function () {
  this.examples = [];
  for (const kind of ["instrument", "effect"]) {
    const folder = join(this.quickstart, kind),
      pkg = join(this.quickstart, `${kind}.xmpkg`),
      wav = join(this.quickstart, `${kind}.wav`);
    run("new", kind, `original-${kind}`, folder);
    run("build", folder, pkg);
    const result = JSON.parse(run("test", pkg));
    run("preview", pkg, wav);
    this.examples.push({ kind, folder, pkg, wav, result });
  }
});
Then(
  "both examples build, run their behavioral tests and preview without an Akai connected",
  function () {
    for (const e of this.examples) {
      assert.equal(e.result.passed, true);
      assert.equal(e.result.physicalAccess, false);
      const wav = readFileSync(e.wav);
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt32LE(24), 48000);
      assert.equal(wav.readUInt16LE(22), 2);
      assert.ok(wav.readInt16LE(44) !== 0 || wav.slice(48).some((b) => b !== 0));
    }
  },
);
Then(
  "the generated packages include manifests, licences and parameter documentation",
  async function () {
    for (const e of this.examples) {
      const pkg = await parsePackage(readFileSync(e.pkg, "utf8"));
      assert.deepEqual(
        pkg.pkg.files.map((f) => f.path).sort(),
        ["LICENSE", "PARAMETERS.md", "manifest.json", "program.json"].sort(),
      );
      assert.equal(pkg.manifest.kind, e.kind);
      this.artifacts.push({
        kind: "trace",
        data: { kind: e.kind, sha256: pkg.pkg.sha256, tests: e.result },
      });
    }
  },
);
Given("an example references a DSP library absent from its declared dependencies", function () {
  this.missing = this.workspace.path("missing");
  run("new", "instrument", "missing-example", this.missing);
  const file = join(this.missing, "program.json"),
    p = JSON.parse(readFileSync(file));
  p.requires = [{ id: "missing-dsp", version: "3.2.1" }];
  writeFileSync(file, JSON.stringify(p));
  this.global = this.workspace.path("global_modules");
  mkdirSync(this.global);
  writeFileSync(join(this.global, "missing-dsp.json"), JSON.stringify({ version: "3.2.1" }));
});
When("the contributor builds the installable package", function () {
  this.failedBuild = spawnSync(
    process.execPath,
    ["tools/sdk/cli.mjs", "build", this.missing, this.workspace.path("missing.xmpkg")],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_PATH: this.global } },
  );
});
Then("packaging fails with the unresolved dependency and its required version", function () {
  assert.notEqual(this.failedBuild.status, 0);
  assert.match(this.failedBuild.stderr, /missing-dsp@3\.2\.1/);
  assert.equal(existsSync(this.workspace.path("missing.xmpkg")), false);
});
Then("it does not silently use a globally installed copy", function () {
  assert.equal(existsSync(join(this.global, "missing-dsp.json")), true);
  assert.match(this.failedBuild.stderr, /no global fallback/);
});
Given(
  "a Mac package store contains a bound project with a known parameter state",
  async function () {
    this.sdk = await sdkFixture();
    this.store = await openPackageStore(this.workspace.path("store"), { create: true });
    let state = await this.store.install(this.sdk.pkg, 0);
    const p = await bindCommunity(sdkProject(), "drums", this.sdk.pkg);
    p.project.tracks[0].machine.state.level = 0.7;
    p.project.parameters = [
      { id: "track.drums.machine.community.fixture-tone.v1.level", base: 0.7 },
    ];
    state = await this.store.setProject(p, state.generation);
    this.storeState = state;
    this.beforeStore = canonical(state.active);
  },
);
When("a compatible package renames that parameter and the musician rolls back", async function () {
  this.upgrade = await sdkUpgrade(this.sdk);
  this.upgraded = await this.store.install(this.upgrade.pkg, this.storeState.generation);
  this.rolled = await this.store.rollback(this.upgraded.generation);
});
Then(
  "the upgrade migrates state and automation and rollback restores the exact previous snapshot",
  function () {
    assert.equal(this.upgraded.active.project.project.tracks[0].machine.state.gain, 0.7);
    assert.match(this.upgraded.active.project.project.parameters[0].id, /\.v2\.gain$/);
    assert.equal(canonical(this.rolled.active), this.beforeStore);
  },
);
Then("a stale writer or staged storage failure preserves the committed project", async function () {
  await assert.rejects(this.store.install(this.upgrade.pkg, this.storeState.generation), /Stale/);
  const before = readFileSync(join(this.store.root, "state.json"));
  await assert.rejects(
    this.store.install(this.upgrade.pkg, this.rolled.generation, async () => {
      throw new Error("ENOSPC");
    }),
    /ENOSPC/,
  );
  assert.deepEqual(readFileSync(join(this.store.root, "state.json")), before);
  assert.ok(
    !readdirSync(this.store.root).some((p) => p.endsWith(".partial") || p.includes("lock")),
  );
});
Given("an owned Mac store and an outside sentinel file exist", async function () {
  this.sdk = await sdkFixture();
  this.store = await openPackageStore(this.workspace.path("store"), { create: true });
  this.storeState = await this.store.install(this.sdk.pkg, 0);
  this.sentinel = this.workspace.path("outside-sentinel");
  writeFileSync(this.sentinel, "untouched");
  this.beforeStoreBytes = readFileSync(join(this.store.root, "state.json"));
});
When(
  "corrupt, unlicensed, incompatible and path-traversing packages request installation",
  async function () {
    const corrupt = structuredClone(this.sdk.pkg);
    corrupt.files[0].content += "corrupt";
    const escapingPackage = structuredClone(this.sdk.pkg);
    escapingPackage.files[0].path = "../outside-sentinel";
    const unlicensed = structuredClone(this.sdk.pkg);
    unlicensed.files.find((f) => f.path === "LICENSE").content = "Missing";
    for (const f of unlicensed.files) f.sha256 = await digest(f.content);
    unlicensed.sha256 = await digest(
      canonical(
        [...unlicensed.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
    );
    this.invalidCount = 0;
    for (const pkg of [corrupt, escapingPackage, unlicensed]) {
      await assert.rejects(this.store.install(pkg, this.storeState.generation));
      this.invalidCount++;
    }
    const incompatible = structuredClone(this.sdk);
    incompatible.manifest.version = "1.1.0";
    incompatible.manifest.parameters[0].max = 0.5;
    const pkg = await buildPackage(
      incompatible.manifest,
      incompatible.program,
      incompatible.license,
    );
    await assert.rejects(this.store.install(pkg, this.storeState.generation), /range\/unit/);
    this.invalidCount++;
  },
);
Then("every invalid package is rejected before committing files or executing code", function () {
  assert.equal(this.invalidCount, 4);
  assert.deepEqual(readdirSync(this.store.root), ["state.json"]);
});
Then("the outside sentinel, committed store and protected devices remain unchanged", function () {
  assert.equal(readFileSync(this.sentinel, "utf8"), "untouched");
  assert.deepEqual(readFileSync(join(this.store.root, "state.json")), this.beforeStoreBytes);
  assert.equal(this.deviceOperations.length, 0);
});
Given(
  "the community UI is a separate child and the native virtual engine is playing",
  async function () {
    this.sdk = await sdkFixture();
    this.host = await startEngineHost(this.workspace, { seconds: 15 });
    this.finalizers.push(() => this.host.finish());
    await this.host.client.request(operations.start);
    this.ui = new CommunityUiSupervisor(this.sdk.manifest, stateFor(this.sdk.manifest));
    this.finalizers.push(() => this.ui.close());
    await this.ui.open();
    this.enginePid = this.host.child.pid;
    this.uiPid = this.ui.pid;
  },
);
When("the UI acknowledges a parameter and then crashes", async function () {
  await this.ui.set("level", 0.65);
  this.ackState = this.ui.snapshot;
  this.beforeUiCrash = await this.host.client.snapshot();
  await this.ui.injectCrash();
  await this.ui.open();
  this.afterUiCrash = await this.host.client.snapshot();
});
Then(
  "the same engine process and musical clock continue with finite captured audio",
  async function () {
    assert.equal(this.host.child.pid, this.enginePid);
    assert.equal(this.host.child.exitCode, null);
    assert.equal(this.afterUiCrash.running, true);
    assert.ok(this.afterUiCrash.frame > this.beforeUiCrash.frame);
    assert.ok(this.afterUiCrash.tick > this.beforeUiCrash.tick);
    this.hostReport = await this.host.finish();
    assert.equal(this.hostReport.physicalAudio, false);
    const wav = readFileSync(this.workspace.path("engine-capture.wav"));
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.ok(wav.slice(44).some((v) => v !== 0));
    this.artifacts.push(
      { kind: "audio", data: wav },
      {
        kind: "trace",
        data: { before: this.beforeUiCrash, after: this.afterUiCrash, report: this.hostReport },
      },
    );
  },
);
Then(
  "a new UI child restores its last acknowledged state with denied writes and child creation",
  async function () {
    assert.notEqual(this.ui.pid, this.uiPid);
    assert.deepEqual(this.ui.snapshot, this.ackState);
    const path = this.workspace.path("denied-ui-write");
    assert.deepEqual(await this.ui.permissionProbe(path), { writeDenied: true, spawnDenied: true });
    assert.equal(existsSync(path), false);
    assert.equal(this.ui.faults[0].nativeHostFault, false);
  },
);
Given("a locally compiled trusted native DSP fixture runs in an isolated test host", () => {
  assert.ok(existsSync(resolve(root, "build/native/xmp_community_fault")));
});
When("its DSP callback terminates that host", async function () {
  this.hostFault = await probeTrustedNativeFault(root);
});
Then(
  "the supervisor reports a host fault with no output and no automatic note restart",
  function () {
    assert.equal(this.hostFault.kind, "native-audio-host-fault");
    assert.equal(this.hostFault.signal, "SIGKILL");
    assert.equal(this.hostFault.outputEnabled, false);
    assert.equal(this.hostFault.heldNotes, 0);
    assert.equal(this.hostFault.automaticRestart, false);
  },
);
Then("it explicitly reports that a manifest sandbox did not contain the crash", function () {
  assert.equal(this.hostFault.manifestSandboxContained, false);
  this.artifacts.push({ kind: "trace", data: this.hostFault });
});
Given("the Mac contributor creates an original declarative instrument package", async function () {
  this.sdk = await sdkFixture();
  this.sdkSource = buildIdentity();
});
When(
  "the workbench installs it, binds an XMP track and renders its recorded note take",
  async function () {
    this.store = await openPackageStore(this.workspace.path("store"), { create: true });
    const state = await this.store.install(this.sdk.pkg, 0),
      p = await bindCommunity(sdkProject(), "drums", this.sdk.pkg);
    p.project.tracks[0].machine.state.level = 0.7;
    p.takes = [
      {
        trackId: "drums",
        source: this.sdk.manifest.capabilities,
        events: [
          { kind: "on", id: 101, timestamp: 0, note: 60, velocity: 0.8 },
          { kind: "on", id: 102, timestamp: 0, note: 64, velocity: 0.7 },
          { kind: "expression", id: 101, timestamp: 0.125, dimension: "pitch", value: 7 },
          { kind: "off", id: 101, timestamp: 0.25 },
          { kind: "off", id: 102, timestamp: 0.25 },
        ],
      },
    ];
    await this.store.setProject(p, state.generation);
    const instance = p.project.tracks[0].machine;
    this.sdkPcm = renderCommunity(
      this.sdk.manifest,
      this.sdk.program,
      instance.state,
      p.takes[0].events,
      0.5,
    );
    this.expectedCommunity = p;
  },
);
Then(
  "reopening preserves the package hash, parameter values and note identities",
  async function () {
    const reopened = await openPackageStore(this.store.root),
      state = await reopened.read();
    assert.deepEqual(state.active.project, this.expectedCommunity);
    assert.equal(state.active.project.bindings[0].packageHash, this.sdk.pkg.sha256);
    assert.ok(this.sdkPcm.some((v) => v !== 0) && this.sdkPcm.every(Number.isFinite));
    this.artifacts.push(
      { kind: "audio", data: Buffer.from(encodeWav([this.sdkPcm, this.sdkPcm], 48000)) },
      {
        kind: "trace",
        data: {
          profile: sdkOracle,
          packageHash: this.sdk.pkg.sha256,
          take: state.active.project.takes,
        },
      },
    );
  },
);
Then("the host source baseline and all hardware remain unchanged", function () {
  assert.equal(buildIdentity(), this.sdkSource);
  assert.equal(this.deviceOperations.length, 0);
});
