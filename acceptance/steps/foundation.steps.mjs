import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { toggleStep } from "../../packages/core/src/index.ts";
import { openAdapter } from "../lib/adapters.mjs";
import { bootstrapChecks, cleanCheckout, startSimulator } from "../lib/contributor.mjs";
import { freshProject } from "../lib/fixtures.mjs";
import {
  licenceLedger,
  observeReference,
  requirementsBaseline,
  verifyArchive,
} from "../lib/provenance.mjs";
import { inspectToolchain } from "../lib/toolchain.mjs";
import { json, root, sha256 } from "../lib/workspace.mjs";
import { openTarget } from "../target-policy.mjs";

Given(
  "the versioned project requirements and any external specification are recorded with hashes",
  function () {
    this.baseline = requirementsBaseline();
    assert.ok(this.baseline.sources.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.equal(this.baseline.externalSpecification.status, "pending");
  },
);
When("the product baseline is approved", function () {
  assert.match(this.baseline.status, /versioned community development baseline/);
  this.approved = this.baseline;
});
Then("every V1 requirement has an ID, owner, acceptance scenario and source", function () {
  assert.equal(this.approved.requirements.length, 48);
  for (const item of this.approved.requirements) {
    assert.ok(item.id && item.owner && item.source);
    const feature = readFileSync(resolve(root, item.acceptance.feature), "utf8");
    assert.ok(feature.includes(item.acceptance.tag));
  }
});
Then("unresolved implementation choices have explicit decision records", function () {
  assert.ok(this.approved.decisions.length >= 6);
  assert.ok(
    this.approved.decisions.every((item) => item.id && item.status === "open" && item.owner),
  );
});
Given("the external specification input has not supplied a document", function () {
  this.baseline = requirementsBaseline();
  assert.equal(this.baseline.externalSpecification.sha256, null);
});
When("a contributor generates the requirements baseline", function () {
  this.generated = requirementsBaseline();
});
Then("the external specification review is recorded as pending", function () {
  assert.equal(this.generated.externalSpecification.status, "pending");
});
Then("no requirement is attributed to unseen external specification content", function () {
  assert.ok(this.generated.requirements.every((item) => !item.source.includes("External")));
});
Given("a supported host with Node 24, Python 3 and a C++17 compiler", () => {
  const result = inspectToolchain(root);
  assert.equal(result.ok, true, JSON.stringify(result));
});
When("the contributor runs the documented bootstrap and checks", { timeout: 3600000 }, function () {
  this.clean = cleanCheckout(this.workspace);
  this.checks = bootstrapChecks(this.clean.checkout);
});
Then("the lockfile dependencies and isolated native tools are installed", function () {
  for (const path of ["node_modules/.package-lock.json", ".venv/bin/cmake", ".venv/bin/ninja"])
    assert.ok(existsSync(resolve(this.clean.checkout, path)));
  assert.equal(
    sha256(readFileSync(resolve(this.clean.checkout, "package-lock.json"))),
    sha256(readFileSync(resolve(root, "package-lock.json"))),
  );
});
Then("the simulator build, unit tests and native tests exit successfully", function () {
  assert.ok(this.checks.find((item) => item.script === "check"));
  assert.ok(this.checks.find((item) => item.script === "native:test"));
  this.artifacts.push({
    kind: "log",
    data: this.checks.map((item) => ({ event: item.script, outcome: "passed" })),
  });
});
Given("a developer host with Node 20 and no C++ compiler", function () {
  this.doctorFixture = true;
});
When("the contributor runs the toolchain doctor", function () {
  this.doctorProcess = spawnSync(
    process.execPath,
    ["acceptance/lib/unsupported-doctor-fixture.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  this.doctor = JSON.parse(this.doctorProcess.stdout);
  this.probes = this.doctor.probes;
});
Then("it exits unsuccessfully with the missing prerequisites", function () {
  assert.equal(this.doctorProcess.status, 1, this.doctorProcess.stderr);
  assert.equal(this.doctor.ok, false);
  assert.ok(this.doctor.checks.some((item) => item.name === "Node 24" && !item.ok));
  assert.ok(this.doctor.checks.some((item) => item.name === "C++17 compilation" && !item.ok));
});
Then("it does not download drivers or change global system settings", function () {
  assert.ok(
    this.probes.every(
      (item) =>
        item.args.includes("--version") ||
        item.args.includes("-std=c++17") ||
        (item.bin === "openssl" && item.args.length === 1 && item.args[0] === "version"),
    ),
  );
});
Given("pinned upstream commits and official source archive hashes", async function () {
  this.pins = readFileSync(resolve(root, "references/lock.json"));
  this.npmLock = readFileSync(resolve(root, "package-lock.json"));
  const catalog = json(resolve(root, "references/official-g1-sources.json"));
  assert.ok(catalog.catalog.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  this.ledger = licenceLedger();
  assert.ok(this.ledger.references.every((item) => !item.qualifiedBuildInput));
  const downloads = catalog.downloads ?? catalog.downloaded;
  for (const item of downloads ?? []) {
    const local = resolve(root, item.localPath);
    if (existsSync(local)) {
      const result = await verifyArchive(local, item);
      assert.equal(result.status, "verified");
    }
  }
  assert.ok((downloads ?? []).length >= 8);
});
When("the update monitor detects a new relevant source revision", function () {
  this.url = "https://github.com/inmusic-software/az0x-open-source.git";
  this.observation = observeReference({ refs: { HEAD: "a".repeat(40) } }, this.url, {
    refs: { HEAD: "b".repeat(40) },
    checkedAt: "synthetic-test-observation",
  });
});
Then("it reports the source URL, changed commit and hardware or licence implications", function () {
  const change = this.observation.changes[0];
  assert.equal(change.url, this.url);
  assert.equal(change.before, "a".repeat(40));
  assert.equal(change.after, "b".repeat(40));
  assert.ok(change.hardwareImpact && change.licenceImpact && change.reviewRequired);
});
Then("the application build continues to use the previously reviewed dependencies", function () {
  assert.deepEqual(readFileSync(resolve(root, "package-lock.json")), this.npmLock);
  assert.deepEqual(readFileSync(resolve(root, "references/lock.json")), this.pins);
});
Given("a previously successful upstream reference observation", function () {
  this.previous = { refs: { HEAD: "a".repeat(40) } };
});
When("that upstream becomes unavailable or an archive hash is incorrect", async function () {
  this.failed = observeReference(this.previous, "https://example.invalid/reference", {
    error: true,
  });
  writeFileSync(this.workspace.path("bad.tar"), "corrupt");
  this.badArchive = await verifyArchive(this.workspace.path("bad.tar"), {
    sha256: "0".repeat(64),
    size: 7,
  });
});
Then("the last successful baseline is retained", function () {
  assert.deepEqual(this.failed.state.refs, this.previous.refs);
});
Then("unavailable or unverified material is excluded from qualified build inputs", function () {
  assert.equal(this.badArchive.status, "unverified");
  assert.equal(this.badArchive.qualified, false);
  assert.ok(this.failed.changes.every((item) => item.qualified === false));
});
Given("a fixture containing cached Akai Force USB metadata and a serial number", function () {
  this.inventoryFixture = [
    {
      "USB Product Name": "Akai Force",
      "USB Vendor Name": "Akai",
      idVendor: 2536,
      idProduct: 1,
      "USB Serial Number": "PRIVATE-SERIAL",
    },
  ];
});
When("the contributor selects passive inventory", function () {
  const code =
    'import json,sys;sys.path.insert(0,"tools");from usb_inventory import summarize_macos;print(json.dumps(summarize_macos(json.load(sys.stdin))))';
  const result = spawnSync("python3", ["-c", code], {
    cwd: root,
    input: JSON.stringify(this.inventoryFixture),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  this.inventory = JSON.parse(result.stdout);
});
Then("only product, manufacturer, vendor ID and product ID are reported", function () {
  assert.equal(this.inventory.length, 1);
  assert.deepEqual(Object.keys(this.inventory[0]).sort(), [
    "manufacturer",
    "product",
    "productId",
    "vendorId",
  ]);
  assert.ok(!JSON.stringify(this.inventory).includes("PRIVATE-SERIAL"));
});
Then(/^the device-I\/O audit records zero opened device handles and zero transfers$/, function () {
  assert.deepEqual(this.deviceOperations, []);
});
Given("an Akai Force is present in the target inventory", function () {
  this.force = { model: "Akai Force" };
});
When("a workflow requests deployment, reboot, MIDI output or a device command", async function () {
  this.rejections = [];
  for (const operation of ["deploy", "reboot", "midi-output", "device-command"]) {
    try {
      await openTarget({ profile: "usb-lab", device: this.force, operation }, () => {
        this.deviceOperations.push(operation);
      });
    } catch (error) {
      this.rejections.push(error);
    }
  }
});
Then("target policy rejects the request before opening a device connection", function () {
  assert.equal(this.rejections.length, 4);
  assert.ok(this.rejections.every((error) => error.message.includes("Protected Force")));
});
Then("no mode, setting, storage or firmware change is attempted", function () {
  assert.deepEqual(this.deviceOperations, []);
});
Given("a clean checkout at a recorded XMP commit", function () {
  this.clean = cleanCheckout(this.workspace);
  assert.match(this.clean.commit, /^[a-f0-9]{40}$/);
});
Given("no physical instrument is a development target", function () {
  assert.throws(() => openAdapter("usb-lab", [], this.workspace), /UNSUPPORTED/);
});
When(
  "the contributor bootstraps the pinned tools and starts the simulator",
  { timeout: 3600000 },
  async function () {
    this.checks = bootstrapChecks(this.clean.checkout);
    this.simulator = await startSimulator(this.clean.checkout, this.workspace);
  },
);
When("creates, saves and reopens a sixteen-step drum pattern", function () {
  const adapter = openAdapter("native", ["project-persistence"], this.workspace);
  this.saved = toggleStep(freshProject(), "drums", "clip-0", 5, 3);
  assert.equal(this.saved.tracks[0].clips[0].length, 16);
  adapter.saveProject(this.saved);
  this.reopened = adapter.loadProject();
});
Then("the reopened pattern and embedded samples match the saved project", function () {
  assert.deepEqual(this.reopened, this.saved);
});
Then("the native and acceptance checks produce reports for that commit", function () {
  const metadata = json(
    resolve(this.clean.checkout, "reports/acceptance/current/run-metadata.json"),
  );
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.sourceCommit, this.clean.commit);
  assert.ok(
    existsSync(resolve(this.clean.checkout, "build/native/Testing/Temporary/LastTest.log")),
  );
  assert.ok(existsSync(resolve(this.clean.checkout, "reports/acceptance/current/cucumber.xml")));
  this.artifacts.push({
    kind: "log",
    data: [{ event: `clean-commit-${this.clean.commit}`, outcome: "passed" }],
  });
  this.contributorReports = [
    ["acceptance.json", resolve(this.clean.checkout, "reports/acceptance/current/cucumber.json")],
    ["acceptance.xml", resolve(this.clean.checkout, "reports/acceptance/current/cucumber.xml")],
    [
      "run-metadata.json",
      resolve(this.clean.checkout, "reports/acceptance/current/run-metadata.json"),
    ],
    [
      "native-ctest.log",
      resolve(this.clean.checkout, "build/native/Testing/Temporary/LastTest.log"),
    ],
  ];
});
Then(/^the device-I\/O audit records zero device operations$/, function () {
  assert.deepEqual(this.deviceOperations, []);
});
