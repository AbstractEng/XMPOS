import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { After, Before, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { bootVm, cloneVmSession, createVmSession } from "../../tools/os/vm.mjs";
import { sealImage, sha } from "../../tools/release/capsule.mjs";
import { VmUpdateStore } from "../../tools/release/update.mjs";
import { root, sha256 } from "../lib/workspace.mjs";

setDefaultTimeout(360000);
const output = process.env.XMP_RELEASE_EVIDENCE;
if (!output || !resolve(output).startsWith(`${resolve(root, "reports/acceptance")}/`))
  throw new Error("Use the release VM runner");
Before(function ({ pickle }) {
  this.id = `${pickle.uri}:${pickle.name}`;
  this.directory = mkdtempSync(resolve(output, "case-"));
  this.boots = [];
  this.captures = [];
  this.checks = {};
  this.vm = null;
});
async function boot(world, { faultInjection = false, session = world.session } = {}) {
  world.session = session ?? (await createVmSession(resolve(world.directory, "vm")));
  world.vm = await bootVm(world.session, { faultInjection });
  world.boots.push({ ...world.vm.boot, args: world.vm.args, emulator: world.vm.emulator });
  return world.vm;
}
async function stop(world, force = false) {
  const result = await world.vm.finish({ force });
  world.vm = null;
  if (!force) assert.equal(result.code, 0);
  world.captures.push({
    audio: result.audio,
    sha256: sha256(readFileSync(result.audio)),
    log: result.log,
    code: result.code,
    signal: result.signal,
    fault: force,
  });
  return result;
}
After(async function ({ result }) {
  try {
    if (this.vm) await stop(this);
  } finally {
    writeFileSync(
      resolve(this.directory, "evidence.json"),
      JSON.stringify(
        {
          scenarioId: this.id,
          outcome: result.status.toLowerCase(),
          sourceHash: process.env.XMP_BUILD_HASH,
          boots: [...this.boots, ...(this.store?.boots ?? [])],
          captures: [...this.captures, ...(this.store?.captures ?? [])],
          checks: this.checks,
          physicalDeviceOperations: [],
          hardwareQualified: false,
        },
        null,
        2,
      ),
    );
  }
});
Given("a VM snapshot contains a known committed song and a pending edit", async function () {
  await boot(this, { faultInjection: true });
  const alias = await createVmSession(this.session.session);
  await assert.rejects(bootVm(alias), /already running/);
  await assert.rejects(
    cloneVmSession(alias, resolve(this.directory, "refused-live-snapshot")),
    /stopped/,
  );
  this.checks.runningDiskAliasesRefused = true;
  await this.vm.request({ op: "rename", name: "Committed recovery fixture" });
  this.saved = await this.vm.request({ op: "save" });
  this.before = await this.vm.request({ op: "recovery-report" });
  await this.vm.request({ op: "rename", name: "New recovery generation" });
});
async function cut(world, point) {
  const checkpoint = world.vm.waitCheckpoint(point),
    saving = world.vm.request({ op: "fault-save", point }).catch((error) => error.message);
  world.checks.checkpoint = await checkpoint;
  assert.equal(world.checks.checkpoint.previousHash, world.saved.projectHash);
  const ended = await stop(world, true);
  assert.equal(ended.signal, "SIGKILL");
  await saving;
  await boot(world);
}
When("virtual power is interrupted during an atomic save and the image reboots", async function () {
  await cut(this, "pending-fsynced");
});
Then("a valid committed project or validated recovery snapshot is restored", async function () {
  this.reopened = await this.vm.request({ op: "reopen" });
  assert.equal(this.reopened.projectHash, this.saved.projectHash);
  const wav = await this.vm.request({ op: "export" });
  assert.ok(wav.peak > 0);
  this.checks.export = wav;
});
When("virtual power is interrupted after the primary directory sync", async function () {
  await cut(this, "directory-fsynced");
});
Then("the new committed generation reopens with its recorded asset hashes", async function () {
  this.reopened = await this.vm.request({ op: "reopen" });
  assert.equal(this.reopened.projectHash, this.checks.checkpoint.candidateHash);
  assert.notEqual(this.reopened.projectHash, this.saved.projectHash);
});
Then(
  "the result includes the exact injected failure point and recovered asset hashes",
  async function () {
    const state = await this.vm.request({ op: "recovery-report" });
    assert.ok(state.candidates[0].valid);
    assert.deepEqual(state.candidates[0].assets, this.before.candidates[0].assets);
    assert.ok(state.candidates[0].assets.length > 0);
    this.checks.recoveredHash = this.reopened.projectHash;
    this.checks.assetHashes = state.candidates[0].assets;
  },
);
Given("a disposable VM fixture contains corrupt project and recovery files", async function () {
  await boot(this, { faultInjection: true });
  await this.vm.request({ op: "save" });
  await this.vm.request({ op: "rename", name: "Previous snapshot fixture" });
  await this.vm.request({ op: "save" });
  this.corrupt = await this.vm.request({ op: "fault-corrupt", all: true });
  await stop(this);
});
When("the musician requests recovery", async function () {
  await boot(this);
  this.invalid = await this.vm.request({ op: "recovery-report" });
});
Then("the application reports that no candidate can be validated", async function () {
  assert.equal(this.invalid.recoveryRequired, true);
  assert.equal(this.vm.boot.playable, false);
  const status = await this.vm.request({ op: "status" });
  assert.equal(status.projectHash, null);
  assert.equal(status.tracks, 0);
  await assert.rejects(this.vm.request({ op: "save" }));
  await assert.rejects(this.vm.request({ op: "export" }));
});
Then(
  "it preserves the original files for export instead of overwriting them with an empty project",
  async function () {
    const after = await this.vm.request({ op: "recovery-report" });
    assert.deepEqual(after.candidates, this.corrupt.candidates);
    const exported = await this.vm.request({ op: "recovery-export" });
    assert.equal(exported.written, true);
    assert.equal(exported.files.length, 2);
    assert.deepEqual(
      exported.files.map((f) => f.sha256),
      after.candidates.filter((f) => f.exists).map((f) => f.sha256),
    );
    this.checks.corruptPreserved = after.candidates;
    this.checks.recoveryExport = exported;
  },
);
Given("a VM has two committed generations and a corrupt primary fixture", async function () {
  await boot(this, { faultInjection: true });
  await this.vm.request({ op: "rename", name: "Known previous generation" });
  this.previous = await this.vm.request({ op: "save" });
  await this.vm.request({ op: "rename", name: "Second generation" });
  await this.vm.request({ op: "save" });
  this.corrupt = await this.vm.request({ op: "fault-corrupt", all: false });
  await stop(this);
});
When("the owned VM cold boots into project recovery", async function () {
  await boot(this);
});
Then("it opens the validated previous generation read-only", async function () {
  const loaded = await this.vm.request({ op: "reopen" });
  assert.equal(loaded.projectHash, this.previous.projectHash);
  assert.equal(loaded.recovery.readOnly, true);
  assert.equal(loaded.recovery.selected, "project.xmp.json.previous");
  await assert.rejects(this.vm.request({ op: "save" }));
});
Then("the corrupt primary remains available for explicit recovery export", async function () {
  const report = await this.vm.request({ op: "recovery-report" });
  assert.equal(report.candidates[0].sha256, this.corrupt.candidates[0].sha256);
  this.checks.fallback = report;
  this.checks.recoveryExport = await this.vm.request({ op: "recovery-export" });
});
Given(
  "signed compatible VM images and a committed project on an owned data disk",
  async function () {
    await boot(this);
    await this.vm.request({ op: "rename", name: "VM update preserved project" });
    this.saved = await this.vm.request({ op: "save" });
    await stop(this);
    this.keys = generateKeyPairSync("ed25519");
    this.baseImage = resolve(root, "artifacts/os/p10");
    this.candidateImage = resolve(root, "artifacts/os/update-candidate");
    this.baseEnvelope = await sealImage(this.baseImage, 1, this.keys.privateKey);
    this.candidateEnvelope = await sealImage(this.candidateImage, 2, this.keys.privateKey);
    assert.notEqual(
      this.baseEnvelope.manifest.imageBuildId,
      this.candidateEnvelope.manifest.imageBuildId,
    );
    this.store = new VmUpdateStore(resolve(this.directory, "update-store"), this.keys.publicKey);
    const health = await this.store.seed(this.baseImage, this.baseEnvelope, this.session);
    assert.equal(health.projectHash, this.saved.projectHash);
    this.originalState = await this.store.state();
  },
);
When("a candidate boots with a failed UI health check", async function () {
  this.rollback = await this.store.attempt(this.candidateImage, this.candidateEnvelope, {
    startupUiFailure: true,
  });
});
Then("the known-good image pointer and data snapshot are unchanged", async function () {
  assert.equal(this.rollback.outcome, "rolled-back");
  assert.deepEqual(await this.store.state(), this.originalState);
  const active = await this.store.activeSession();
  assert.equal(sha(readFileSync(active.disk)), this.rollback.sourceDiskHash);
  await boot(this, { session: active });
  assert.equal(this.vm.boot.buildId, this.baseEnvelope.manifest.imageBuildId);
  assert.equal((await this.vm.request({ op: "reopen" })).projectHash, this.saved.projectHash);
  await stop(this);
  this.checks.rollback = this.rollback;
});
When("a VM update is interrupted after cloning and before promotion", async function () {
  await assert.rejects(
    this.store.attempt(this.candidateImage, this.candidateEnvelope, {
      interruptAfterSnapshot: true,
    }),
    /INTERRUPTED/,
  );
});
Then("reopening the transaction preserves the known-good active snapshot", async function () {
  const reopened = new VmUpdateStore(this.store.directory, this.keys.publicKey);
  this.checks.interrupted = await reopened.recoverInterrupted();
  assert.equal(this.checks.interrupted.candidatePromoted, false);
  assert.deepEqual(await reopened.state(), this.originalState);
});
When("the signed candidate passes its fixed guest musical health checks", async function () {
  this.promoted = await this.store.attempt(this.candidateImage, this.candidateEnvelope);
  assert.equal(this.promoted.outcome, "promoted");
});
Then("the candidate is promoted and reopens the same project after a cold boot", async function () {
  const state = await this.store.state();
  assert.equal(state.sequence, 2);
  await boot(this, { session: await this.store.activeSession() });
  assert.equal(this.vm.boot.buildId, this.candidateEnvelope.manifest.imageBuildId);
  assert.equal((await this.vm.request({ op: "reopen" })).projectHash, this.saved.projectHash);
  const wav = await this.vm.request({ op: "export" });
  assert.ok(wav.peak > 0);
  this.checks.updatedExport = wav;
});
Then(
  "the update receipt identifies the generic VM transaction without claiming an MPC partition layout",
  function () {
    assert.equal(this.promoted.hardwareQualified, false);
    this.checks.promoted = this.promoted;
    this.checks.updateLayout = "owned host files and cloned VM data; no MPC A/B assumption";
  },
);
