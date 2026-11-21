import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { sealImage, signManifest, verifyEnvelope } from "../../tools/release/capsule.mjs";
import {
  capsulePolicyFixture,
  releaseEvidenceFixture,
  soakPolicyFixture,
} from "../../tools/release/fixtures.mjs";
import { releaseDecision } from "../../tools/release/gate.mjs";
import {
  evaluateSoak,
  overloadProbe,
  runSoak,
  soakMeasurementsComplete,
  soakProfile,
} from "../../tools/release/soak.mjs";
import { VmUpdateStore } from "../../tools/release/update.mjs";
import { buildIdentity, root, sha256 } from "../lib/workspace.mjs";

const digest = "a".repeat(64);
Given("the frozen sixty-second thirty-two-voice sampler development profile", () => {
  assert.equal(soakProfile.developmentSeconds, 60);
  assert.equal(soakProfile.voices, 32);
});
When(
  "the independent native engine runs with scheduled tempo edits and saved checkpoints",
  async function () {
    this.soak = await runSoak(this.workspace, 60);
    const report = { ...this.soak.report, evaluation: this.soak.evaluation };
    const path = this.workspace.path("soak-report.json");
    writeFileSync(path, JSON.stringify(report, null, 2));
    this.contributorReports = new Map([["soak-report.json", path]]);
    this.artifacts.push({ kind: "audio", data: this.soak.capture });
    const output = resolve(root, "reports/release-soak");
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(resolve(output, "capture.wav"), this.soak.capture);
  },
);
Then("duration, callback counters, memory and bounded capture evidence are measured", function () {
  const r = this.soak.report;
  assert.equal(soakMeasurementsComplete(r), true);
  assert.equal(r.native.auditFaults, 0);
  assert.equal(r.native.on, r.native.off);
  assert.ok(r.native.on > 0);
  assert.ok(this.soak.capture.length <= 44 + 96000 * 4);
  assert.equal(r.captureHash, sha256(this.soak.capture));
  assert.match(r.checkpointHash, /^[a-f0-9]{64}$/);
});
Then("every observed timing violation keeps the strict performance gate failed", function () {
  const r = this.soak.report,
    e = this.soak.evaluation;
  if (
    r.native.overruns ||
    r.native.callbackP99Ns > (256 / 48000) * 1e9 * 0.8 ||
    r.native.traceDrops ||
    r.native.queueDrops
  ) {
    assert.equal(e.developmentChecksPassed, false);
    assert.ok(e.failures.includes("Callback/event safety limit failed"));
  } else assert.equal(e.developmentChecksPassed, true);
});
Then("a short sampler run cannot qualify the eight-hour V1 workload or hardware", function () {
  assert.equal(this.soak.evaluation.samplerEightHourRunComplete, false);
  assert.equal(this.soak.evaluation.fullV1EightHourQualified, false);
  assert.equal(this.soak.evaluation.hardwareQualified, false);
});
Given("a short, incomplete or deadline-violating sampler report", function () {
  this.soakFixture = soakPolicyFixture();
});
When("it is evaluated as long-session qualification", function () {
  const good = this.soakFixture;
  this.soakFailures = [
    evaluateSoak({ ...good, requestedSeconds: 28800 }),
    evaluateSoak({ ...good, rssGrowthMiB: null }),
    evaluateSoak({ ...good, native: { ...good.native, overruns: 1 } }),
    evaluateSoak({ ...good, elapsedSeconds: 1 }),
  ];
});
Then("missing durations, measurements and strict timing violations are reported", function () {
  for (const r of this.soakFailures) {
    assert.equal(r.developmentChecksPassed, false);
    assert.ok(r.failures.length > 0);
  }
});
Then("no fabricated eight-hour or hardware pass is issued", function () {
  for (const r of this.soakFailures) {
    assert.equal(r.samplerEightHourRunComplete, false);
    assert.equal(r.fullV1EightHourQualified, false);
    assert.equal(r.hardwareQualified, false);
  }
});
Given("an owned native virtual engine at its thirty-two-voice capacity", function () {
  this.overloadOwned = true;
});
When("sixty-four additional virtual voices are requested", async function () {
  this.overload = await overloadProbe(this.workspace);
});
Then("excess demand is explicitly refused and transport stop remains available", function () {
  assert.ok(this.overload.refused >= 32);
  assert.equal(this.overload.stopped, true);
});
Then("the original project snapshot still saves with its known identity", function () {
  assert.equal(this.overload.projectHash, this.overload.savedHash);
  assert.equal(this.overload.physicalAudioQualified, false);
});

Given("an owned VM capsule-policy fixture and a pinned release signer", async function () {
  mkdirSync(resolve(root, "reports/release-policy"), { recursive: true });
  this.policyDirectory = mkdtempSync(resolve(root, "reports/release-policy/case-"));
  this.finalizers.push(() => rmSync(this.policyDirectory, { recursive: true, force: true }));
  this.policyImage = resolve(this.policyDirectory, "image");
  capsulePolicyFixture(this.policyImage, buildIdentity());
  this.keys = generateKeyPairSync("ed25519");
  this.envelope = await sealImage(this.policyImage, 2, this.keys.privateKey);
  this.goodBytes = readFileSync(resolve(this.policyImage, "kernel"));
});
When(
  "signatures, component bytes, target models or dependency versions are invalid",
  async function () {
    const output = resolve(this.policyDirectory, "uncreated-store"),
      store = new VmUpdateStore(output, this.keys.publicKey);
    const wrongKey = generateKeyPairSync("ed25519");
    const requests = [
      signManifest(this.envelope.manifest, wrongKey.privateKey),
      signManifest(
        { ...this.envelope.manifest, target: "unsupported-fixture-board" },
        this.keys.privateKey,
      ),
      signManifest(
        { ...this.envelope.manifest, compatibility: { project: 99, sdk: 2, dsp: 1 } },
        this.keys.privateKey,
      ),
    ];
    for (const bad of requests) {
      await assert.rejects(store.attempt(this.policyImage, bad));
      assert.equal(existsSync(output), false);
    }
    const corrupt = resolve(this.policyDirectory, "corrupt");
    cpSync(this.policyImage, corrupt, { recursive: true });
    writeFileSync(resolve(corrupt, "rootfs.cpio.gz"), "corrupted payload");
    await assert.rejects(store.attempt(corrupt, this.envelope), /Corrupted/);
    assert.equal(existsSync(output), false);
    assert.throws(() => verifyEnvelope(this.envelope, this.keys.publicKey, 2), /Stale/);
    this.uncreatedStore = output;
  },
);
Then("capsule preflight rejects each request before creating an update store", function () {
  assert.equal(existsSync(this.uncreatedStore), false);
});
Then("known-good source bytes remain unchanged", function () {
  assert.deepEqual(readFileSync(resolve(this.policyImage, "kernel")), this.goodBytes);
});
Given("complete current-source host and generic VM development evidence", function () {
  this.releaseEvidence = releaseEvidenceFixture(buildIdentity(), digest);
});
When("the maintainer evaluates development preview readiness", function () {
  this.decision = releaseDecision(this.releaseEvidence);
});
Then("only the supported generic VM console and recovery scope is listed", function () {
  assert.equal(this.decision.developmentPreviewReady, true);
  assert.deepEqual(this.decision.supportedHardware, []);
  assert.equal(this.decision.supportedTargets[0].profile, "p10-qemu-x86_64-v1");
});
Then(
  "physical hardware, public redistribution and full V1 performance remain pending",
  function () {
    assert.equal(this.decision.hardwareReady, false);
    assert.equal(this.decision.publicRedistributionApproved, false);
    assert.ok(this.decision.pendingReleaseGates.some((s) => s.includes("eight-hour")));
  },
);
Given("development evidence names another source or image build", function () {
  this.releaseEvidence = releaseEvidenceFixture(buildIdentity(), digest);
  this.releaseEvidence.evidence[1].imageBuildId = "b".repeat(64);
  this.releaseEvidence.evidence[2].sourceHash = "c".repeat(64);
});
Then("development readiness fails with the mismatched evidence", function () {
  assert.equal(this.decision.developmentPreviewReady, false);
  assert.ok(this.decision.missingDevelopmentEvidence.length >= 2);
});
Then("no hardware or public release is authorized", function () {
  assert.equal(this.decision.hardwareReady, false);
  assert.equal(this.decision.publicRedistributionApproved, false);
});
Given(
  "all simulator tests pass but the Live Mk1 hardware lane is missing or inconclusive",
  function () {
    this.releaseEvidence = releaseEvidenceFixture(buildIdentity(), digest);
  },
);
When("the maintainer requests a hardware-ready V1 release", function () {
  this.decision = releaseDecision(this.releaseEvidence);
});
Then("release qualification fails with the missing hardware evidence", function () {
  assert.equal(this.decision.hardwareReady, false);
  assert.ok(this.decision.pendingReleaseGates.some((s) => s.includes("Live Mk1")));
});
Then("an explicitly labeled desktop preview may be evaluated separately", function () {
  assert.equal(this.decision.developmentPreviewReady, true);
  assert.ok(this.decision.supportedTargets[0].scope.includes("Generic VM console"));
});
