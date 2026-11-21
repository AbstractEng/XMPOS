import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { After, Before, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { osFixtureOracle, osFixtureProject } from "../../os/guest/shared.ts";
import { exportPortable } from "../../packages/core/src/assets.ts";
import { buildImage } from "../../tools/os/build.mjs";
import { releaseGate, vmQualification } from "../../tools/os/policy.mjs";
import { bootVm, createVmSession, imageIdentity } from "../../tools/os/vm.mjs";
import { root, sha256 } from "../lib/workspace.mjs";

setDefaultTimeout(240000);
const output = process.env.XMP_OS_EVIDENCE;
if (!output || !resolve(output).startsWith(`${resolve(root, "reports")}/`))
  throw new Error("Run through npm run bdd:p10");

Before(function ({ pickle }) {
  this.id = `${pickle.uri}:${pickle.name}`;
  this.directory = mkdtempSync(resolve(output, "case-"));
  this.boots = [];
  this.captures = [];
  this.vm = null;
});
async function boot(world, options = {}) {
  world.session ??= await createVmSession(resolve(world.directory, "vm"));
  world.vm = await bootVm(world.session, options);
  world.boots.push({ ...world.vm.boot, emulator: world.vm.emulator, args: world.vm.args });
  return world.vm;
}
async function stop(world) {
  const result = await world.vm.finish();
  world.vm = null;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  world.captures.push({
    log: result.log,
    audio: result.audio,
    audioHash: sha256(readFileSync(result.audio)),
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
          profile: this.boots.length ? "os-vm" : "host-image-policy",
          booted: this.boots,
          physicalDeviceOperations: [],
          physicalQualification: false,
          captures: this.captures,
          checks: this.checks ?? {},
        },
        null,
        2,
      ),
    );
  }
});

Given("the candidate XMP image is booted on the generic supported VM board", async function () {
  await boot(this);
});
Given("the development server, network and host application services are unavailable", function () {
  assert.deepEqual(this.vm.boot.networkInterfaces, ["lo"]);
  assert.equal(this.vm.boot.hostShares, false);
  assert.equal(this.vm.boot.controlListeners, 0);
  assert.ok(this.vm.args.includes("-nodefaults"));
  assert.ok(this.vm.args.includes("-nic"));
  assert.equal(this.vm.args[this.vm.args.indexOf("-nic") + 1], "none");
  assert.ok(
    !this.vm.args.some((a) => /usb-host|hostfwd|virtfs|fsdev|coreaudio|host_device/.test(a)),
  );
});
When(
  "a musician creates a beat, adds a synth, arranges scenes and saves the song",
  async function () {
    for (const op of ["beat", "synth", "arrange"]) await this.vm.request({ op });
    this.saved = await this.vm.request({ op: "save" });
    this.exported = await this.vm.request({ op: "export" });
    assert.equal(this.saved.flushed, true);
    assert.equal(this.exported.synth, true);
    assert.equal(this.exported.notes, 12);
  },
);
When("cleanly shuts down and reboots the VM", async function () {
  await stop(this);
  await boot(this);
});
Then(
  "the song reopens and exports valid non-silent audio from inside the image",
  async function () {
    const reopened = await this.vm.request({ op: "reopen" });
    assert.equal(reopened.projectHash, this.saved.projectHash);
    const rendered = await this.vm.request({ op: "export" });
    assert.equal(rendered.sha256, this.exported.sha256);
    assert.ok(rendered.peak > 0);
    const header = Buffer.from(rendered.header, "base64");
    assert.equal(header.toString("ascii", 0, 4), "RIFF");
    assert.equal(header.readUInt32LE(24), 48000);
    assert.equal(header.readUInt16LE(22), 2);
    assert.equal(rendered.bytes, 44 + rendered.frames * 4);
    this.checks = {
      savedHash: this.saved.projectHash,
      export: rendered,
      coldRebootPersisted: true,
    };
  },
);
Then("the booted build hash and virtual-device profile are recorded", function () {
  for (const b of this.boots) {
    assert.equal(b.buildId, this.session.manifest.buildId);
    assert.equal(b.profile, this.session.profile.id);
    assert.match(b.board, /Standard PC/);
  }
});

Given("the distribution recipes, toolchain, sources and asset hashes are pinned", function () {
  const lock = JSON.parse(readFileSync(resolve(root, "os/inputs.lock.json")));
  assert.ok(lock.packages.length > 30);
  for (const c of [lock.base, ...lock.packages]) assert.match(c.sha256, /^[a-f0-9]{64}$/);
  this.current = readFileSync(resolve(root, "build/os-app/guest.mjs"));
});
When("two clean qualified builders produce the same target image", function () {
  // Two fresh assembly and bundler processes on this declared host profile.
  // Source compilation of Alpine packages and cross-host toolchain reproducibility remain out of scope.
  buildImage(resolve(this.directory, "builder-a"));
  buildImage(resolve(this.directory, "builder-b"));
});
Then(
  "the reproducible artifact hashes match under the documented reproducibility scope",
  function () {
    const a = JSON.parse(readFileSync(resolve(this.directory, "builder-a/manifest.json")));
    const b = JSON.parse(readFileSync(resolve(this.directory, "builder-b/manifest.json")));
    for (const key of [
      "buildId",
      "appSha256",
      "kernelSha256",
      "initramfsSha256",
      "uncompressedInitramfsSha256",
    ])
      assert.equal(a[key], b[key]);
    assert.match(a.scope, /assembly/);
    this.checks = { reproducible: true, scope: a.scope, hashes: a };
  },
);
Then("the source manifest, SBOM and development notice ledger accompany the artifact", function () {
  for (const dir of ["builder-a", "builder-b"])
    for (const name of ["sources.json", "sbom.json", "THIRD-PARTY-NOTICES.txt"])
      assert.ok(readFileSync(resolve(this.directory, dir, name)).length > 0);
  const manifest = JSON.parse(readFileSync(resolve(this.directory, "builder-a/manifest.json")));
  assert.equal(manifest.publicRedistributionApproved, false);
});
Given("an image requires a vendor component without reviewed redistribution terms", function () {
  this.components = [{ id: "vendor-firmware", license: "unknown", vendorPayload: true }];
});
When("a public distributable image is requested", function () {
  try {
    releaseGate(this.components, { publicImage: true });
  } catch (error) {
    this.blocked = error;
  }
});
Then("the public-image gate fails with the component and provenance gap", function () {
  assert.match(this.blocked?.message ?? "", /vendor-firmware/);
  const requested = spawnSync(process.execPath, ["tools/os/build.mjs", "--public"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(requested.status, 0);
  assert.match(requested.stderr, /source\/notices review pending/);
  const lock = JSON.parse(readFileSync(resolve(root, "os/inputs.lock.json")));
  assert.throws(
    () => releaseGate(lock.packages, { publicImage: true }),
    /source\/notices review pending/,
  );
});
Then("no proprietary application or firmware payload is silently added to the release", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "artifacts/os/p10/manifest.json")));
  releaseGate(manifest.sbom);
  assert.equal(manifest.publicRedistributionApproved, false);
});

Given("the OS has separate engine, UI and persistent-data services", async function () {
  await boot(this);
});
When("it boots and later receives a clean shutdown request", async function () {
  this.shutdown = await stop(this);
});
Then("the engine is ready before the UI reports playable status", function () {
  const b = this.boots[0];
  assert.notEqual(b.enginePid, b.uiPid);
  assert.deepEqual(
    b.services.map((e) => e.event),
    ["storage-ready", "engine-ready", "ui-ready"],
  );
  assert.ok(b.services[1].at <= b.services[2].at);
});
Then("saves are flushed before the persistent-data volume is closed", function () {
  const log = this.shutdown.log;
  assert.ok(log.includes('XMPBOOT {"event":"storage-closed"}'));
  assert.ok(
    log.lastIndexOf('XMPBOOT {"event":"saves-flushed"}') <
      log.lastIndexOf('XMPBOOT {"event":"storage-closed"}'),
  );
});
Given("the UI repeatedly fails during startup on a disposable VM data volume", async function () {
  await boot(this);
  this.saved = await this.vm.request({ op: "save" });
  await stop(this);
  await boot(this, { startupUiFailure: true });
});
When("its restart budget is exhausted", function () {
  assert.equal(this.vm.boot.restarts, 4);
});
Then("the supervisor exposes a bounded diagnostic recovery state", async function () {
  assert.equal(this.vm.boot.recovery, true);
  assert.equal(this.vm.boot.playable, false);
  const d = await this.vm.request({ op: "diagnostics" });
  assert.ok(d.errors.includes("UI_RESTART_BUDGET"));
  assert.ok(d.services.length <= 64);
});
Then("the project volume remains recoverable without an endless restart loop", async function () {
  await stop(this);
  await boot(this);
  const p = await this.vm.request({ op: "reopen" });
  assert.equal(p.projectHash, this.saved.projectHash);
  assert.equal(this.vm.boot.recovery, undefined);
});

Given("QEMU boots the candidate image with virtual audio and controls", async function () {
  await boot(this);
});
When("the OS acceptance adapter runs the shared project and render fixtures", async function () {
  this.fixture = await this.vm.request({ op: "fixture" });
});
Then(
  "the assertions execute inside the booted image rather than on the host simulator",
  function () {
    const f = this.fixture;
    assert.equal(f.assertedInsideGuest, true);
    assert.deepEqual(f.oracle, osFixtureOracle);
    assert.equal(f.frames, 96000);
    assert.equal(f.firstNonzeroFrame, 24000);
    assert.equal(f.peak, 16384);
    assert.equal(Buffer.from(f.aroundPeak, "base64").readInt16LE(0), 16384);
    this.checks = { guestFixture: f, hostRenderUsed: false };
  },
);
Then("captures identify the emulated board and virtual devices", function () {
  assert.equal(this.vm.boot.profile, "p10-qemu-x86_64-v1");
  assert.match(this.vm.boot.kernel, /^6\./);
  assert.match(this.vm.boot.board, /Standard PC/);
});
Given("the generic VM passes every virtual-audio and control scenario", async function () {
  this.identity = await imageIdentity(resolve(root, "artifacts/os/p10"));
});
When("a qualification report is generated", function () {
  this.qualification = vmQualification({
    passed: true,
    buildId: this.identity.manifest.buildId,
    profile: this.identity.manifest.profile,
  });
});
Then(
  "Live Mk1 pads, internal codec, battery, USB mode and boot recovery remain unqualified",
  function () {
    assert.equal(this.qualification.mpcDriversQualified, false);
    assert.equal(this.qualification.physicalAudioQualified, false);
    assert.equal(this.qualification.phaseQualified, false);
  },
);
Then("the report lists the required physical-device evidence separately", function () {
  assert.deepEqual(this.qualification.requiredPhysicalEvidence, [
    "Live Mk1 pads",
    "internal codec",
    "battery",
    "USB mode",
    "boot recovery",
  ]);
  this.checks = this.qualification;
});

Given(
  "the standalone development image contains its own sounds and required runtime packages",
  async function () {
    await boot(this);
  },
);
Given("its optional lab agent is disabled by default", function () {
  assert.equal(this.vm.boot.labAgentEnabled, false);
});
When("the OS starts without network or USB connections", function () {
  assert.deepEqual(this.vm.boot.networkInterfaces, ["lo"]);
  assert.ok(!this.vm.args.some((a) => /usb-host|virtfs|fsdev/.test(a)));
});
Then("a musician can create, save and export a song using local resources", async function () {
  await this.vm.request({ op: "beat" });
  await this.vm.request({ op: "save" });
  const e = await this.vm.request({ op: "export" });
  assert.ok(e.peak > 0);
  this.checks = { offlineExport: e };
});
Then("no lab control listener is started", function () {
  assert.equal(this.vm.boot.controlListeners, 0);
});
Given(
  "the image has a crash log and a project containing personal audio and identifiers",
  async function () {
    await boot(this);
    const project = osFixtureProject();
    project.name = "PRIVATE_PROJECT_CANARY";
    project.samples[0].name = "PRIVATE_AUDIO_CANARY";
    project.samples[0].pcm = [0.314159, 0.271828];
    await this.vm.request({ op: "load-project", text: await exportPortable(project) });
    await this.vm.request({ op: "save" });
    await assert.rejects(
      this.vm.request({
        op: "status",
        token: "PRIVATE_CREDENTIAL_CANARY",
        serial: "PRIVATE_DEVICE_CANARY",
      }),
    );
    await this.vm.request({ op: "crash-ui" });
  },
);
When("the musician exports a diagnostic bundle", async function () {
  this.diagnostics = await this.vm.request({ op: "diagnostics" });
});
Then("it contains build, service and error evidence with documented redaction", function () {
  const d = this.diagnostics;
  assert.equal(d.build.buildId, this.session.manifest.buildId);
  assert.ok(d.services.some((e) => e.event === "ui-crashed"));
  assert.ok(d.errors.includes("COMMAND_REJECTED"));
});
Then("personal audio, credentials and raw device identifiers are excluded by default", function () {
  assert.doesNotMatch(
    JSON.stringify(this.diagnostics),
    /PRIVATE_|0\.314159|0\.271828|token|serial/,
  );
  assert.ok(Object.values(this.diagnostics.redaction).every((v) => v === false));
  this.checks = { diagnostics: this.diagnostics };
});

Given(
  "the offline OS boots with its original default kit and a qualified virtual audio path",
  async function () {
    await boot(this);
  },
);
When(
  "the engine reports ready and the musician taps a pad and starts a recording pass",
  async function () {
    this.pad = await this.vm.request({ op: "pad", pad: 0 });
    this.record = await this.vm.request({ op: "record" });
    this.status = await this.vm.request({ op: "status" });
    this.shutdown = await stop(this);
  },
);
Then(
  "audible pad feedback and the recording metronome require no sound assignment or editor navigation",
  function () {
    assert.equal(this.pad.played, true);
    assert.ok(this.pad.sourcePeak > 0);
    assert.equal(this.record.metronome, true);
    const wav = readFileSync(this.shutdown.audio);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(24), 48000);
    assert.equal(wav.readUInt16LE(22), 2);
    let nonzero = 0;
    for (let i = 44; i + 1 < wav.length; i += 2) if (wav.readInt16LE(i)) nonzero++;
    assert.ok(nonzero > 500);
    this.checks = {
      pad: this.pad,
      record: this.record,
      nonzeroSamples: nonzero,
      virtualAudioOnly: true,
    };
  },
);
Then("no network login, development server or module installation is required", function () {
  assert.deepEqual(this.boots[0].networkInterfaces, ["lo"]);
  assert.equal(this.boots[0].hostShares, false);
});
Then(
  "boot-to-ready time and the first-beat action trace are recorded against the frozen target profile",
  function () {
    assert.ok(this.boots[0].bootReadySeconds <= 60);
    assert.ok(this.status.services.some((e) => e.event === "first-pad"));
    assert.ok(this.status.services.some((e) => e.event === "record-metronome"));
    this.checks.bootReadySeconds = this.boots[0].bootReadySeconds;
    this.checks.actionTrace = this.status.services;
  },
);
