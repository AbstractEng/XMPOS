import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import {
  adapterReadiness,
  normalizeControl,
  requiredServices,
} from "../../packages/lab/src/adapters.ts";
import { analyzeHardwareEvidence } from "../../packages/lab/src/measurements.ts";
import { reviewTarget } from "../../packages/lab/src/readiness.ts";
import { createBench } from "../../tools/lab/bench.mjs";
import { auditResearch } from "../../tools/lab/catalog.mjs";
import { root, sha256 } from "../lib/workspace.mjs";
import { openTarget } from "../target-policy.mjs";

const sha = "a".repeat(64),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyDossier = () => JSON.parse(readFileSync(resolve(root, "hardware/target.example.json")));
function completeDossier() {
  const d = {
    ...emptyDossier(),
    alias: "fixture-original",
    model: "Akai MPC Live Mk1",
    firmware: "fixture-version",
    board: "fixture-board",
    buildHash: sha,
    bootTier: "independent-xmp-image",
  };
  d.evidence = ["stock-observation", "boot", "recovery", "usb-topology", "owner-authorization"].map(
    (kind, index) => ({
      id: `receipt-${index}`,
      kind,
      model: d.model,
      firmware: d.firmware,
      alias: d.alias,
      status: "reviewed",
      sha256: sha,
      board: d.board,
      buildHash: d.buildHash,
    }),
  );
  return d;
}
async function bench(world) {
  world.bench = await createBench(world.workspace);
  world.finalizers.push(async () => {
    const result = await world.bench.finish();
    assert.equal(result.hardwareQualified, false);
    assert.equal(result.physicalDeviceOperations.length, 0);
    if (world.disconnectedAt !== undefined) {
      assert.ok(
        result.capture.subarray(44 + (world.disconnectedAt + 256) * 4).some((b) => b !== 0),
        "Native PCM must continue after control disconnect",
      );
      world.labChecks = { ...world.labChecks, audioAfterDisconnect: true };
    }
    const report = {
      profile: result.profile,
      buildHash: result.buildHash,
      fixtureHash: result.fixtureHash,
      native: result.native,
      nativeBinaryHash: result.nativeBinaryHash,
      captureHash: result.captureHash,
      hardwareQualified: false,
      physicalDeviceOperations: [],
      checks: world.labChecks ?? {},
    };
    const path = world.workspace.path("lab-report.json");
    writeFileSync(path, JSON.stringify(report, null, 2));
    world.contributorReports = new Map([["lab-report.json", path]]);
    world.artifacts.push({ kind: "audio", data: result.capture });
  });
}
async function authenticated(world, playing = false) {
  await bench(world);
  world.lab = await world.bench.connect();
  await world.bench.load(world.lab);
  if (playing) world.started = await world.lab.request({ op: "action", action: "start" });
}
Given("an isolated host lab bench with a real native virtual-audio engine", async function () {
  await bench(this);
});
When(
  "the host authenticates the simulator and stages the approved eight-track fixture",
  async function () {
    this.lab = await this.bench.connect();
    this.loaded = await this.bench.load(this.lab);
    this.render = await this.lab.request({ op: "render", fixtureId: "fixture-one" });
    assert.ok(this.render.peak > 0);
    assert.equal(this.render.frames, 96000);
  },
);
When("starts playback and disconnects the lab control session", async function () {
  this.started = await this.lab.request({ op: "action", action: "start" });
  this.disconnectedAt = (await this.bench.engine.client.snapshot()).frame;
  await this.bench.disconnect(this.lab);
  await pause(750);
});
Then("native playback and its project identity continue independently", async function () {
  const state = await this.bench.engine.client.snapshot();
  assert.ok(state.running);
  assert.ok(state.frame > this.started.frame);
  assert.equal(state.projectHash, this.loaded.projectHash);
  await assert.rejects(this.lab.request({ op: "action", action: "stop" }), /closed/);
  this.labChecks = {
    continuedFrame: state.frame,
    projectHash: state.projectHash,
    independentNativeProcess: true,
  };
});
Then("a fresh authenticated session retrieves the same fixture results", async function () {
  const next = await this.bench.connect();
  assert.notEqual(next.session, this.lab.session);
  const results = await next.request({ op: "results" });
  assert.equal(results.render.sha256, this.render.sha256);
  const status = await next.request({ op: "status" });
  assert.equal(status.fixtures, 0);
  assert.equal(status.loaded, null);
  this.labChecks.freshSession = true;
  this.labChecks.fixtureNamespacePurged = true;
});
Then("every report leaves physical hardware qualification pending", function () {
  assert.equal(this.render.physicalAudioQualified, false);
  assert.deepEqual(this.bench.physicalDeviceOperations, []);
});

Given("the pinned official and community hardware research catalog", async function () {
  this.research = await auditResearch();
});
When("a new Live Mk1 bring-up dossier is reviewed without stock observations", function () {
  this.review = reviewTarget(emptyDossier());
});
Then(
  "firmware, board, boot, recovery, USB and owner evidence remain explicit prerequisites",
  function () {
    for (const key of [
      "stock firmware observation",
      "unit-specific board evidence",
      "boot",
      "recovery",
      "usb-topology",
      "owner-authorization",
    ])
      assert.ok(this.review.missing.includes(key));
  },
);
Then("neither upstream board defaults nor source archives authorize device access", function () {
  assert.equal(this.research.metadataPinned, true);
  assert.equal(this.research.exactUnitEvidence, false);
  assert.equal(this.review.deviceAccessAuthorized, false);
  assert.equal(this.review.activeAdapterAvailable, false);
});
Given("a complete synthetic exact-unit review dossier", function () {
  this.dossier = completeDossier();
  assert.equal(reviewTarget(this.dossier).readyForDeviceSpecificReview, true);
});
When("a boot receipt is rebound to another firmware and alias", function () {
  this.dossier.evidence.find((e) => e.kind === "boot").firmware = "other-version";
  this.dossier.evidence.find((e) => e.kind === "boot").alias = "replacement";
});
Then("that receipt cannot satisfy the target prerequisites", function () {
  assert.ok(reviewTarget(this.dossier).missing.includes("boot"));
});
Then("even a complete dossier cannot enable a physical adapter", async function () {
  const report = reviewTarget(completeDossier());
  assert.equal(report.deviceAccessAuthorized, false);
  await assert.rejects(
    openTarget(
      { profile: "usb-lab", device: { model: "Akai MPC Live Mk1" }, review: report },
      () => {
        this.transportCalls = (this.transportCalls ?? 0) + 1;
      },
    ),
  );
});
Given("a stock device has no verified XMP boot or USB test transport", function () {
  this.review = reviewTarget(emptyDossier());
});
When("the host requests a hardware qualification session", async function () {
  await assert.rejects(
    openTarget(
      { profile: "usb-lab", device: { model: "Akai MPC Live Mk1" }, review: this.review },
      () => {
        this.transportCalls = (this.transportCalls ?? 0) + 1;
      },
    ),
  );
});
Then("it reports the missing capability and does not open a command session", function () {
  assert.ok(this.review.missing.includes("boot"));
  assert.ok(this.review.missing.includes("usb-topology"));
  assert.equal(this.transportCalls ?? 0, 0);
});
Then(
  "it does not enable SSH, USB gadget mode, rooting or a firmware update as a fallback",
  function () {
    assert.equal(this.review.activeAdapterAvailable, false);
    assert.equal(this.review.deviceAccessAuthorized, false);
    assert.equal(this.deviceOperations.length, 0);
  },
);

Given("versioned host fixtures for pads, touch, encoders, transport and battery", function () {
  this.controls = [];
});
When("every pad velocity and the touch surface corners are normalized", function () {
  for (let pad = 0; pad < 16; pad++)
    for (const velocity of [0, 1, 64, 127])
      this.controls.push(normalizeControl({ kind: "pad", pad, velocity, atUs: 100 + pad }));
  this.controls.push(
    normalizeControl({ kind: "touch", contact: 0, x: 0, y: 0, width: 800, height: 480, atUs: 200 }),
  );
  this.controls.push(
    normalizeControl({
      kind: "touch",
      contact: 0,
      x: 799,
      y: 479,
      width: 800,
      height: 480,
      atUs: 201,
    }),
  );
  for (const input of [
    { kind: "encoder", encoder: 3, delta: -1, atUs: 202 },
    { kind: "transport", action: "record", atUs: 203 },
    { kind: "battery", percent: 23, charging: false, atUs: 204 },
  ])
    this.controls.push(normalizeControl(input));
});
Then("the normalized values follow the declared bounds and preserve event timestamps", function () {
  assert.equal(this.controls[0].atUs, 100);
  assert.equal(this.controls[3].velocity, 1);
  assert.deepEqual(
    this.controls.slice(64, 66).map((e) => [e.x, e.y]),
    [
      [0, 0],
      [1, 1],
    ],
  );
  assert.equal(this.controls.at(-1).percent, 23);
});
Then("control events retain simulator provenance without inferred sensor dimensions", function () {
  for (const e of this.controls) {
    assert.equal(e.source, "host-fixture");
    assert.equal(e.physicalQualified, false);
    assert.equal(e.pressure, undefined);
  }
});
Given("host adapter reports omit internal audio and battery", function () {
  this.services = requiredServices
    .filter((id) => !["internal-audio", "battery"].includes(id))
    .map((id) => ({ id, version: "fixture-1", state: "simulated" }));
});
When("adapter readiness is evaluated", function () {
  this.readiness = adapterReadiness(this.services);
});
Then("the model enters safe recovery and names both missing services", function () {
  assert.equal(this.readiness.mode, "safe-recovery");
  assert.deepEqual(this.readiness.missing, ["internal-audio", "battery"]);
});
Then("simulator readings and unsupported pressure cannot qualify hardware", function () {
  assert.equal(this.readiness.physicalQualified, false);
  assert.equal(this.readiness.pressureQualified, false);
  assert.throws(() =>
    normalizeControl({ kind: "pad", pad: 0, velocity: 127, atUs: 1, pressure: 0.7 }),
  );
});

When(
  "a fresh TLS session binds the host, simulator, build and approved fixture",
  async function () {
    this.lab = await this.bench.connect();
  },
);
Then("its identity proof is bound to the fresh channel and session lifetime", async function () {
  const a = this.lab.attestation;
  assert.equal(a.buildHash, this.bench.grant.buildHash);
  assert.equal(a.fixtureHash, this.bench.grant.fixtureHash);
  assert.ok(a.expiresAt > Date.now());
  assert.equal(a.bootTier, "host-simulator");
  assert.equal(this.lab.socket.getProtocol(), "TLSv1.3");
  const old = this.lab;
  await this.bench.disconnect(old);
  this.lab = await this.bench.connect();
  assert.notEqual(this.lab.session, old.session);
  assert.notEqual(this.lab.attestation.proof, old.attestation.proof);
});
Then(
  "only granted typed operations and disposable fixture identifiers are accepted",
  async function () {
    await this.bench.load(this.lab);
    await assert.rejects(this.lab.request({ op: "shell", command: "anything" }), /not granted/);
    await assert.rejects(this.lab.request({ op: "status", path: "/dev/disk0" }), /REJECTED/);
    const status = await this.lab.request({ op: "status" });
    assert.equal(status.fixtures, 1);
    assert.equal(status.hardwareQualified, false);
  },
);
Given("an authenticated host lab session with an approved fixture", async function () {
  await authenticated(this);
});
When("a fixture hash, destination identifier or command shape is tampered with", async function () {
  for (const command of [
    { op: "stage", fixtureId: "fixture-two", sha256: sha256("tampered"), text: this.bench.text },
    {
      op: "stage",
      fixtureId: "../projects",
      sha256: this.bench.grant.fixtureHash,
      text: this.bench.text,
    },
    { op: "action", action: "reboot" },
    {
      op: "stage",
      fixtureId: "fixture-large",
      sha256: this.bench.grant.fixtureHash,
      text: "x".repeat(262145),
    },
  ])
    await assert.rejects(this.lab.request(command), /REJECTED/);
});
Then("the agent rejects each request without staging or dispatching it", async function () {
  const status = await this.lab.request({ op: "status" });
  assert.equal(status.fixtures, 1);
  assert.equal(status.engine.revision, 0);
});
When("an accepted control frame is replayed", async function () {
  const closed = once(this.lab.socket, "close");
  this.lab.socket.write(this.lab.lastFrame);
  await closed;
});
Then("the session closes and its pending commands cannot cross a reconnect", async function () {
  assert.equal(this.lab.closed, true);
  assert.equal(this.lab.pending.size, 0);
  await assert.rejects(this.lab.request({ op: "action", action: "start" }), /closed/);
  assert.equal((await this.bench.engine.client.snapshot()).running, false);
});
Given(
  "preflight receives a Force identity or an expired or mismatched target authorization",
  function () {
    this.preflights = [
      { model: "Akai Force", allow: true, vendorId: "09e8" },
      { model: "Akai MPC Live Mk1", expired: true },
      { model: "unknown", buildHash: "mismatch" },
    ];
  },
);
When("a USB lab session is requested", async function () {
  for (const device of this.preflights)
    await assert.rejects(
      openTarget({ profile: "usb-lab", device, allow: true }, () => {
        this.transportCalls = (this.transportCalls ?? 0) + 1;
      }),
    );
});
Then("policy rejects it before attempting a USB handshake or opening device handles", function () {
  assert.equal(this.transportCalls ?? 0, 0);
});
Then("neither a generic allow flag nor a matching vendor ID can bypass the rejection", function () {
  assert.ok(this.preflights[0].allow);
  assert.equal(this.deviceOperations.length, 0);
});

Given("an authenticated host lab session playing the approved fixture", async function () {
  await authenticated(this, true);
});
When("the host lab agent process exits", async function () {
  const child = [...this.bench.workspace.processes].find((p) => p !== this.bench.engine.child);
  assert.ok(child);
  this.disconnectedAt = (await this.bench.engine.client.snapshot()).frame;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await pause(750);
});
Then("the independent native engine keeps advancing with the same project", async function () {
  const state = await this.bench.engine.client.snapshot();
  assert.ok(state.running);
  assert.ok(state.frame > this.started.frame);
  assert.equal(state.projectHash, this.bench.grant.fixtureHash);
  this.labChecks = {
    survivedAgentExit: true,
    beforeFrame: this.started.frame,
    afterFrame: state.frame,
  };
});
Then("its virtual capture contains audio without claiming physical output", async function () {
  const result = await this.bench.finish();
  assert.equal(result.native.auditFaults, 0);
  assert.equal(result.native.physicalAudio, false);
  assert.ok(result.capture.subarray(44).some((b) => b !== 0));
});
When(
  "a different simulator certificate replaces the original at the same socket address",
  async function () {
    await this.bench.replacePeer();
  },
);
Then("the pinned host rejects the new peer before test commands are enabled", async function () {
  await assert.rejects(this.bench.connect(), /authentication/);
});
Then("old commands are neither replayed nor redirected to the replacement", async function () {
  await assert.rejects(this.lab.request({ op: "action", action: "stop" }), /closed/);
  const state = await this.bench.engine.client.snapshot();
  assert.ok(state.running);
  assert.equal(state.revision, this.started.revision);
});
Given("independent metric fixtures include passing, failing and missing captures", function () {
  const series = {
    source: "simulator",
    clock: "independent-capture",
    calibrationHash: sha,
    valuesMs: Array(1000).fill(12),
  };
  this.measurements = {
    analog: series,
    control: { ...series },
    midi: { ...series, clock: "control-rtt", valuesMs: Array(10000).fill(0.5) },
  };
});
When("analog, control and MIDI distributions are evaluated separately", function () {
  this.measurementReport = analyzeHardwareEvidence(this.measurements);
});
Then("missing or control-round-trip evidence remains inconclusive rather than zero", function () {
  assert.equal(this.measurementReport.results[0].withinBudget, true);
  assert.equal(this.measurementReport.results[1].withinBudget, false);
  assert.equal(this.measurementReport.results[2].outcome, "inconclusive");
  assert.equal(this.measurementReport.results[2].p95Ms, null);
  assert.equal(analyzeHardwareEvidence({}).results[0].p95Ms, null);
});
Then("passing simulator distributions leave formal physical qualification pending", function () {
  assert.equal(this.measurementReport.hardwareQualified, false);
  assert.equal(this.measurementReport.formalLoopbackQualified, false);
});

When("another trusted-CA client certificate attempts to authenticate", async function () {
  const w = this.workspace;
  const cert = readFileSync(w.path("host.pem")),
    key = readFileSync(w.path("host.key"));
  try {
    copyFileSync(w.path("host-b.pem"), w.path("host.pem"));
    copyFileSync(w.path("host-b.key"), w.path("host.key"));
    await assert.rejects(
      this.bench.connect({ ...this.bench.grant, hostPin: this.bench.pins["host-b"] }),
      /authentication/,
    );
  } finally {
    writeFileSync(w.path("host.pem"), cert);
    writeFileSync(w.path("host.key"), key, { mode: 0o600 });
  }
});
Then("the agent refuses the unapproved host identity without engine actions", async function () {
  const state = await this.bench.engine.client.snapshot();
  assert.equal(state.revision, 0);
  assert.equal(state.running, false);
});
Then(
  "expired grants and mismatched build identities cannot open a lab command session",
  async function () {
    await assert.rejects(
      this.bench.connect({ ...this.bench.grant, expiresAt: Date.now() - 1 }),
      /Expired/,
    );
    await assert.rejects(
      this.bench.connect({ ...this.bench.grant, buildHash: sha }),
      /authentication/,
    );
    assert.equal((await this.bench.engine.client.snapshot()).revision, 0);
  },
);
