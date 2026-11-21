import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { toggleStep } from "../../packages/core/src/index.ts";
import { fixtureAdapter, openAdapter, preflightAdapter } from "../lib/adapters.mjs";
import { evaluateGate, latencyResult, recordEvidence } from "../lib/evidence.mjs";
import {
  assertMusicalCapture,
  firstNonzero,
  fixtureHash,
  freshProject,
  musicalFixture,
} from "../lib/fixtures.mjs";
import { buildIdentity, json, root, scenarioWorkspace, sha256 } from "../lib/workspace.mjs";

const screenshot = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
function attachments(wav) {
  return [
    {
      kind: "log",
      data: { event: "render", serialNumber: "PRIVATE-SERIAL", projectName: "PERSONAL-PROJECT" },
    },
    { kind: "trace", data: { event: "impulse", frame: 24000 } },
    { kind: "audio", data: wav },
    { kind: "screenshot", data: screenshot, synthetic: true },
  ];
}
function gateInput(world, records, required) {
  return {
    required,
    records,
    buildHash: world.candidate,
    fixtureHash,
    directory: world.evidenceDirectory,
  };
}
Given("two scenarios start from the same immutable project fixture", function () {
  this.first = scenarioWorkspace();
  this.second = scenarioWorkspace();
  this.additionalWorkspaces.push(this.first, this.second);
  this.original = freshProject();
  this.firstProject = freshProject();
  this.secondProject = freshProject();
});
When("the first scenario changes a pattern and the second loads its fixture", function () {
  const first = openAdapter("desktop", ["project-persistence"], this.first),
    second = openAdapter("desktop", ["project-persistence"], this.second);
  first.saveProject(toggleStep(this.firstProject, "drums", "clip-0", 5, 3));
  second.saveProject(this.secondProject);
  this.secondLoaded = second.loadProject();
  assert.notDeepEqual(first.loadProject(), this.original);
});
Then("the second scenario receives the original pattern", function () {
  assert.deepEqual(this.secondLoaded, this.original);
  assert.deepEqual(freshProject(), this.original);
});
Then("both scenarios clean up their own processes and temporary files", async function () {
  for (const workspace of [this.first, this.second]) {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd: workspace.directory,
      stdio: "ignore",
    });
    workspace.processes.add(child);
    const exit = once(child, "exit");
    workspace.close();
    await exit;
    assert.equal(existsSync(workspace.directory), false);
    assert.equal(workspace.processes.size, 0);
  }
});
Given("an expected audio capture contains a kick at sample 24000", function () {
  this.expected = musicalFixture.expectedPeak;
});
When("the target produces the kick at sample 25000", function () {
  const adapter = openAdapter("native", ["offline-render"], this.workspace);
  this.actual = adapter.render({ ...musicalFixture, eventFrame: 25000 });
  this.failure = spawnSync(
    process.execPath,
    [
      "tools/assert-capture.mjs",
      this.workspace.path("capture.wav"),
      String(this.expected),
      this.workspace.path("difference.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
});
Then("the timing assertion fails and the test process exits unsuccessfully", function () {
  assert.equal(this.failure.status, 1, this.failure.stderr);
  this.difference = json(this.workspace.path("difference.json"));
  assert.deepEqual(this.difference, {
    expectedFrame: 24000,
    actualFrame: 25000,
    deltaFrames: 1000,
    outcome: "failed",
  });
});
Then("the actual capture and timing difference remain attached to the failed report", function () {
  this.candidate = buildIdentity();
  this.evidenceDirectory = this.workspace.path("negative-evidence");
  const record = recordEvidence(
    this.evidenceDirectory,
    {
      scenarioId: "intentional-timing-failure",
      profile: "native",
      buildHash: this.candidate,
      fixtureHash,
      outcome: "failed",
    },
    [
      { kind: "audio", data: this.actual },
      { kind: "diff", data: this.difference },
    ],
  );
  assert.equal(record.outcome, "failed");
  for (const item of record.artifacts)
    assert.equal(sha256(readFileSync(resolve(this.evidenceDirectory, item.path))), item.sha256);
  this.artifacts.push(
    { kind: "audio", data: this.actual },
    { kind: "diff", data: this.difference },
  );
});
Given("the requested target is the native standalone adapter", function () {
  this.selectedProfile = "native";
});
Given("the selected scenario requires offline render and project persistence", function () {
  this.requiredCapabilities = ["offline-render", "project-persistence"];
});
Given("a hardware-only scenario requires physical pad sensor input", function () {
  this.requiredCapabilities = ["physical-pad-sensor"];
});
Given("the selected target is a desktop simulator", function () {
  this.selectedProfile = "desktop";
});
When("preflight validates the scenario requirements", function () {
  try {
    this.selected = openAdapter(this.selectedProfile, this.requiredCapabilities, this.workspace);
  } catch (error) {
    this.preflightError = error;
  }
});
Then("the native adapter is selected without any USB discovery", function () {
  assert.equal(this.preflightError, undefined);
  assert.equal(this.selected.identity.profile, "native");
  assert.equal(this.selected.identity.synthetic, false);
  this.capture = this.selected.render(musicalFixture);
  assert.equal(firstNonzero(this.capture), 24000);
  assertMusicalCapture(this.capture);
  this.selected.saveProject(freshProject());
  assert.deepEqual(this.selected.loadProject(), freshProject());
  this.artifacts.push({ kind: "audio", data: this.capture });
  assert.deepEqual(this.deviceOperations, []);
});
Then("only its declared operations are available to step definitions", function () {
  assert.deepEqual(Object.keys(this.selected).sort(), [
    "identity",
    "loadProject",
    "render",
    "saveProject",
  ]);
  assert.equal(this.selected.sendMidi, undefined);
  assert.equal(this.selected.reboot, undefined);
  assert.throws(() => preflightAdapter("usb-lab", []), /UNSUPPORTED/);
  assert.throws(() => preflightAdapter("os-vm", ["os-boot"]), /UNSUPPORTED/);
});
Then("the scenario is reported as unsupported and not passed", function () {
  assert.equal(this.preflightError?.outcome, "unsupported");
  assert.ok(this.preflightError.missing.includes("physical-pad-sensor"));
  assert.equal(this.selected, undefined);
});
Then("the runner does not replace physical input with a simulated pad event", function () {
  assert.equal(this.selected, undefined);
  assert.deepEqual(this.deviceOperations, []);
});
Given("an authorized test session with a build, fixture and target identity", function () {
  this.candidate = buildIdentity();
  this.evidenceDirectory = this.workspace.path("public-evidence");
  this.capture = openAdapter("native", ["offline-render"], this.workspace).render(musicalFixture);
  this.session = {
    scenarioId: "synthetic-evidence-contract",
    profile: "usb-lab",
    buildHash: this.candidate,
    fixtureHash,
    outcome: "passed",
    synthetic: true,
    serial: "PRIVATE-SERIAL",
    personalProject: "PERSONAL-PROJECT",
  };
});
When("an acceptance scenario completes", function () {
  this.evidence = recordEvidence(this.evidenceDirectory, this.session, attachments(this.capture));
});
Then(
  "the report records its scenario ID, target profile, build hash, fixture hash and outcome",
  function () {
    for (const key of ["scenarioId", "profile", "buildHash", "fixtureHash", "outcome"])
      assert.equal(this.evidence[key], this.session[key]);
    assert.equal(this.evidence.synthetic, true);
  },
);
Then("relevant logs, screenshots, event traces and audio capture hashes are attached", function () {
  assert.deepEqual(
    this.evidence.artifacts.map((item) => item.kind),
    ["log", "trace", "audio", "screenshot"],
  );
  for (const item of this.evidence.artifacts)
    assert.equal(sha256(readFileSync(resolve(this.evidenceDirectory, item.path))), item.sha256);
});
Then("public reports redact device identifiers and personal project data", function () {
  const publicText =
    JSON.stringify(this.evidence) +
    this.evidence.artifacts
      .filter((item) => item.kind === "log" || item.kind === "trace")
      .map((item) => readFileSync(resolve(this.evidenceDirectory, item.path), "utf8"))
      .join("");
  assert.ok(!publicText.includes("PRIVATE-SERIAL"));
  assert.ok(!publicText.includes("PERSONAL-PROJECT"));
});
Given("a scenario requires an analog round-trip latency measurement", function () {
  this.measurementRequired = true;
});
When("the loopback capture is absent or its clock calibration is invalid", function () {
  this.measurements = [
    latencyResult(null),
    latencyResult({ frames: 0, sampleRate: 48000, calibrated: false }),
  ];
});
Then("the scenario is reported as inconclusive and qualification fails", function () {
  for (const latency of this.measurements) {
    assert.equal(latency.outcome, "inconclusive");
    const result = evaluateGate({
      required: [{ scenarioId: "latency", profile: "usb-lab" }],
      records: [
        {
          scenarioId: "latency",
          profile: "usb-lab",
          outcome: "inconclusive",
          latency,
          artifacts: [],
        },
      ],
      directory: this.workspace.directory,
      buildHash: "candidate",
      fixtureHash,
    });
    assert.equal(result.complete, false);
  }
});
Then("no zero latency or default passing value is recorded", function () {
  assert.ok(this.measurements.every((item) => item.latencyMs === null));
});
Given("every substep has passing scenarios for its required target profiles", function () {
  this.candidate = buildIdentity();
  this.evidenceDirectory = this.workspace.path("gate-evidence");
  this.requiredCases = ["positive", "negative"].map((name) => ({
    scenarioId: `fixture-stage:${name}`,
    profile: "host-contract",
  }));
  this.records = this.requiredCases.map((item) =>
    recordEvidence(
      this.evidenceDirectory,
      { ...item, buildHash: this.candidate, fixtureHash, outcome: "passed" },
      [{ kind: "log", data: { event: "assertion", outcome: "passed" } }],
    ),
  );
});
Given("the stage journey has passed on the same candidate build", function () {
  const journey = { scenarioId: "fixture-stage:journey", profile: "host-contract" };
  this.requiredCases.push(journey);
  this.records.push(
    recordEvidence(
      this.evidenceDirectory,
      { ...journey, buildHash: this.candidate, fixtureHash, outcome: "passed" },
      [{ kind: "log", data: { event: "assertion", outcome: "passed" } }],
    ),
  );
});
When("the stage gate evaluates the evidence manifest", function () {
  this.gate = evaluateGate(gateInput(this, this.records, this.requiredCases));
});
Then("the stage can be marked complete with links to its reports", function () {
  assert.equal(this.gate.complete, true, JSON.stringify(this.gate.failures));
  assert.equal(this.gate.reports.length, 3);
});
Then("downstream stages receive the accepted build and interface versions", function () {
  assert.equal(this.gate.buildHash, this.candidate);
  assert.equal(this.gate.interfaceVersion, 1);
});
Given("a stage has an undefined, pending, skipped or unsupported required scenario", function () {
  this.candidate = buildIdentity();
  this.evidenceDirectory = this.workspace.path("missing-evidence");
  this.requiredCases = [{ scenarioId: "required-case", profile: "host-contract" }];
  this.badOutcomes = ["undefined", "pending", "skipped", "unsupported"];
});
When("a contributor requests stage completion or release qualification", function () {
  this.refusals = this.badOutcomes.map((outcome) =>
    evaluateGate(
      gateInput(
        this,
        [
          recordEvidence(
            this.evidenceDirectory,
            { ...this.requiredCases[0], buildHash: this.candidate, fixtureHash, outcome },
            [{ kind: "log", data: { event: "assertion", outcome } }],
          ),
        ],
        this.requiredCases,
      ),
    ),
  );
  this.refusals.push(evaluateGate(gateInput(this, [], this.requiredCases)));
});
Then("the request fails with the missing scenario and target IDs", function () {
  assert.ok(
    this.refusals.every(
      (item) =>
        !item.complete &&
        item.failures.some((message) => message.includes("required-case [host-contract]")),
    ),
  );
});
Then("syntax-only validation is not reported as implemented behavior", function () {
  assert.ok(this.refusals.every((item) => item.outcome === "blocked"));
});
Given("a versioned musical fixture and its expected audio and project results", function () {
  this.candidate = buildIdentity();
  this.matrixFixture = musicalFixture;
  this.matrixProject = freshProject();
  assert.equal(this.matrixFixture.version, 1);
  this.evidenceDirectory = this.workspace.path("matrix-evidence");
});
Given(
  "test doubles for desktop, native, OS VM and USB lab adapters advertise distinct capabilities",
  function () {
    this.targets = ["desktop", "native", "os-vm", "usb-lab"].map((profile) => {
      const workspace = scenarioWorkspace();
      this.additionalWorkspaces.push(workspace);
      return fixtureAdapter(profile, workspace, { synthetic: true });
    });
    assert.equal(
      new Set(this.targets.map((target) => JSON.stringify(target.identity.capabilities))).size,
      4,
    );
  },
);
When("the adapter-contract matrix runs with an explicit fixture target per run", function () {
  this.requiredCases = [];
  this.records = this.targets.map((target) => {
    target.saveProject(this.matrixProject);
    assert.deepEqual(target.loadProject(), this.matrixProject);
    const capture = target.render(this.matrixFixture);
    assert.equal(firstNonzero(capture), this.matrixFixture.expectedPeak);
    assertMusicalCapture(capture);
    const item = { scenarioId: "fixture-matrix:music", profile: target.identity.profile };
    this.requiredCases.push(item);
    return recordEvidence(
      this.evidenceDirectory,
      { ...item, buildHash: this.candidate, fixtureHash, outcome: "passed", synthetic: true },
      attachments(capture),
    );
  });
});
Then(
  "each fixture target produces separate assertions, captures and build identity marked as synthetic evidence",
  function () {
    assert.equal(this.records.length, 4);
    assert.equal(new Set(this.records.map((item) => item.artifacts[0].path)).size, 4);
    assert.ok(
      this.records.every(
        (item) =>
          item.synthetic && item.buildHash === this.candidate && item.artifacts.length === 4,
      ),
    );
    assert.equal(
      evaluateGate({ ...gateInput(this, this.records, this.requiredCases), allowSynthetic: true })
        .complete,
      true,
    );
  },
);
Then("a desktop result is never substituted for an OS boot or hardware result", function () {
  const result = evaluateGate({
    ...gateInput(
      this,
      this.records.filter((item) => item.profile === "desktop"),
      this.requiredCases,
    ),
    allowSynthetic: true,
  });
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((item) => item.includes("os-vm")));
  assert.equal(evaluateGate(gateInput(this, this.records, this.requiredCases)).complete, false);
});
Then("any missing required target prevents qualification", function () {
  for (const missing of this.requiredCases) {
    assert.equal(
      evaluateGate({
        ...gateInput(
          this,
          this.records.filter((item) => item.profile !== missing.profile),
          this.requiredCases,
        ),
        allowSynthetic: true,
      }).complete,
      false,
    );
  }
});
