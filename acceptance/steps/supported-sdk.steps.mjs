import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { compareParity, parityFixtures, referenceParity } from "../../packages/sdk/src/parity.ts";
import { checkSdkDelivery } from "../../tools/sdk/check-delivery.mjs";
import { packSdk } from "../../tools/sdk/pack.mjs";
import { decodeResult } from "../../tools/sdk/parity-host.mjs";
import { root } from "../lib/workspace.mjs";

Given(
  "a new contributor installs the supported SDK tarball in an isolated directory",
  async function () {
    this.sdkDistribution = await packSdk(this.workspace.path("distribution"));
    this.sdkDirectory = this.workspace.path("contributor");
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        this.workspace.path("empty-cache"),
        "--prefix",
        this.sdkDirectory,
        this.sdkDistribution.tarball,
      ],
      {
        encoding: "utf8",
        timeout: 120000,
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    );
    this.sdkBin = join(this.sdkDirectory, "node_modules/@xmp/sdk/dist/cli.mjs");
    this.sdkRun = (...args) =>
      JSON.parse(
        execFileSync(process.execPath, [this.sdkBin, ...args], {
          cwd: this.sdkDirectory,
          encoding: "utf8",
          timeout: 120000,
        }),
      );
    this.sdkSentinel = this.workspace.path("outside.txt");
    writeFileSync(this.sdkSentinel, "Keep outside work");
  },
);
When("the contributor checks the SDK doctor, compatibility and TypeScript API", function () {
  this.sdkDoctor = this.sdkRun("doctor");
  this.sdkVersion = this.sdkRun("version");
  writeFileSync(
    join(this.sdkDirectory, "consumer.mts"),
    'import { SDK_API_VERSION, type MachineNote } from "@xmp/sdk";\nconst api: 2 = SDK_API_VERSION;\n// @ts-expect-error incompatible API literal\nconst incompatible: 3 = SDK_API_VERSION;\nfunction note(n:MachineNote):number { return n.id; }\nvoid api;void incompatible;void note;\n',
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.mts",
    ],
    { cwd: this.sdkDirectory, encoding: "utf8", timeout: 120000 },
  );
});
Then(
  "the installed SDK works without repository sources, workspace links or registry access",
  function () {
    assert.equal(this.sdkDoctor.ready, true);
    assert.equal(
      lstatSync(join(this.sdkDirectory, "node_modules/@xmp/sdk")).isSymbolicLink(),
      false,
    );
    assert.equal(existsSync(join(this.sdkDirectory, "packages/core/src")), false);
    assert.ok(
      existsSync(join(this.sdkDirectory, "node_modules/@xmp/sdk/types/sdk/src/index.d.ts")),
    );
  },
);
Then("it reports module API 2 and DSP ABI 1 with no hardware access", function () {
  assert.equal(this.sdkVersion.moduleApi, 2);
  assert.equal(this.sdkVersion.dspAbi, 1);
  assert.equal(this.sdkDoctor.hardwareAccess, false);
  assert.equal(this.sdkVersion.projectVersion, 8);
});

When("the contributor uses only the bundled manuals and examples", function () {
  const installed = join(this.sdkDirectory, "node_modules/@xmp/sdk");
  this.sdkDocuments = checkSdkDelivery(installed);
  for (const kind of ["tone", "filter"]) {
    const example = join(installed, `examples/community-${kind}`);
    this.sdkRun("build", example, `${kind}.xmpkg`);
    this.sdkRun("test", `${kind}.xmpkg`);
    assert.equal(this.sdkRun("parity", `${kind}.xmpkg`, `${kind}-parity`).passed, true);
  }
  execFileSync(process.execPath, [join(installed, "examples/sdk-ui/render.mjs"), "ui.html"], {
    cwd: this.sdkDirectory,
    timeout: 120000,
  });
  const html = readFileSync(join(this.sdkDirectory, "ui.html"), "utf8");
  assert.match(html, /<audio controls/);
  assert.match(html, /Download the rendered tone/);
  const payload = /data:audio\/wav;base64,([A-Za-z0-9+/=]+)/.exec(html);
  assert.ok(payload);
  const wav = Buffer.from(payload[1], "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.ok(wav.subarray(44).some((v) => v !== 0));
  const second = spawnSync(
    process.execPath,
    [join(installed, "examples/sdk-ui/render.mjs"), "ui.html"],
    { cwd: this.sdkDirectory },
  );
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(join(this.sdkDirectory, "ui.html"), "utf8"), html);
  const customized = join(this.sdkDirectory, "my-sound-card.mjs");
  writeFileSync(
    customized,
    readFileSync(join(installed, "examples/sdk-ui/render.mjs"), "utf8").replaceAll(
      "My XMP instrument",
      "My custom sound card",
    ),
  );
  execFileSync(process.execPath, [customized, "custom-ui.html"], {
    cwd: this.sdkDirectory,
    timeout: 120000,
  });
  assert.match(
    readFileSync(join(this.sdkDirectory, "custom-ui.html"), "utf8"),
    /<h1>My custom sound card<\/h1>/,
  );
  this.sdkRun("store-init", "version-store");
  this.sdkRun("install", "version-store", "tone.xmpkg");
  this.sdkRun("bind", "version-store", "tone.xmpkg");
  const store = JSON.parse(
    readFileSync(join(this.sdkDirectory, "version-store/state.json"), "utf8"),
  );
  assert.equal(store.active.project.project.version, this.sdkVersion.projectVersion);
});
Then(
  "every installed documentation link resolves and the instrument effect and UI examples work offline",
  function () {
    assert.ok(this.sdkDocuments.documents >= 8);
    assert.ok(this.sdkDocuments.localLinks > 10);
    assert.equal(this.deviceOperations.length, 0);
  },
);
When("the contributor scaffolds, builds, tests and previews an {string}", function (kind) {
  this.sdkKind = kind;
  this.sdkRun("new", kind, "original-example", "example");
  this.sdkRun("build", "example", "example.xmpkg");
  this.sdkRun("test", "example.xmpkg");
  this.sdkRun("preview", "example.xmpkg", "preview.wav");
});
When("the contributor compares that package with the compiled native renderer", function () {
  this.sdkComparison = this.sdkRun("parity", "example.xmpkg", "package-parity");
});
Then("the preview has finite nonzero audio and the native package parity passes", function () {
  const wav = readFileSync(join(this.sdkDirectory, "preview.wav"));
  let peak = 0;
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  assert.ok(peak > 0);
  assert.equal(this.sdkComparison.passed, true);
  const report = JSON.parse(readFileSync(join(this.sdkDirectory, "package-parity/report.json")));
  assert.equal(report.results[0].eventsMatch, true);
  assert.equal(report.results[0].voicesMatch, true);
});
Then("existing destinations and an outside sentinel remain unchanged", function () {
  const before = readFileSync(join(this.sdkDirectory, "preview.wav"));
  const failed = spawnSync(
    process.execPath,
    [this.sdkBin, "preview", "example.xmpkg", "preview.wav"],
    { cwd: this.sdkDirectory, encoding: "utf8" },
  );
  assert.notEqual(failed.status, 0);
  assert.deepEqual(readFileSync(join(this.sdkDirectory, "preview.wav")), before);
  assert.equal(readFileSync(this.sdkSentinel, "utf8"), "Keep outside work");
});
When("the contributor runs the five native conformance fixtures", function () {
  this.sdkRun("conformance", "conformance");
  this.sdkReport = JSON.parse(readFileSync(join(this.sdkDirectory, "conformance/report.json")));
});
Then(
  "independent timing, impulse and voice-limit oracles pass with matching event acknowledgements",
  function () {
    assert.equal(this.sdkReport.passed, true);
    assert.equal(this.sdkReport.results.length, 5);
    for (const r of this.sdkReport.results) {
      assert.equal(r.eventsMatch, true);
      assert.equal(r.voicesMatch, true);
      assert.equal(r.activeVoices, 0);
    }
    const voices = this.sdkReport.results.find((r) => r.id === "voice-exhaustion");
    assert.equal(voices.trace[32].accepted, false);
    assert.equal(
      this.sdkReport.results.find((r) => r.id === "swung-note-boundaries").trace[0].frame,
      7440,
    );
  },
);
Then(
  "the report retains numerical errors and leaves real-time and hardware qualification false",
  function () {
    for (const r of this.sdkReport.results) {
      assert.ok(r.maximumAbsoluteError <= 0.000002);
      assert.ok(r.rmsError <= 0.0000002);
      assert.equal(r.realtimeQualified, false);
      assert.equal(r.hardwareQualified, false);
      assert.equal(r.nativeMusicalSequencerQualified, false);
    }
  },
);
Given("a valid reference and compiled native conformance capture", async function () {
  this.sdkDistribution = await packSdk(this.workspace.path("distribution"));
  const cli = join(this.workspace.path("distribution"), "package/dist/cli.mjs");
  execFileSync(process.execPath, [cli, "conformance", this.workspace.path("conformance")], {
    encoding: "utf8",
    timeout: 120000,
  });
  this.parityReference = referenceParity(parityFixtures()[0].plan);
  this.parityCapture = decodeResult(
    readFileSync(join(this.workspace.path("conformance"), "sine-note-release.result")),
  );
});
When("one event moves by one frame, PCM is altered, or a voice remains active", function () {
  const ref = this.parityReference,
    native = this.parityCapture;
  assert.equal(compareParity(ref, native).passed, true);
  const moved = structuredClone(native);
  moved.trace[0].frame++;
  const audible = structuredClone(native);
  audible.pcm[100] += 0.01;
  this.parityFailures = [
    compareParity(ref, moved),
    compareParity(ref, audible),
    compareParity(ref, { ...native, activeVoices: 1 }),
  ];
});
Then("each mismatch fails parity without changing the fixed tolerance profile", function () {
  assert.ok(this.parityFailures.every((r) => !r.passed));
  assert.equal(this.parityFailures[0].eventsMatch, false);
  assert.equal(this.parityFailures[0].maximumAbsoluteError, 0);
});
When("an incompatible package or physical target flag is submitted", function () {
  this.sdkRun("new", "instrument", "original-example", "example");
  const manifestPath = join(this.sdkDirectory, "example/module.json"),
    manifest = JSON.parse(readFileSync(manifestPath));
  manifest.apiVersion = 999;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  this.sdkRejected = [];
  for (const args of [
    ["build", "example", "invalid.xmpkg"],
    ["doctor", "--target", "force"],
    ["conformance", "--usb", "force"],
  ])
    this.sdkRejected.push(
      spawnSync(process.execPath, [this.sdkBin, ...args], {
        cwd: this.sdkDirectory,
        encoding: "utf8",
      }).status,
    );
});
Then(
  "the SDK rejects it before creating a native render or overwriting existing files",
  function () {
    assert.ok(this.sdkRejected.every((status) => status !== 0));
    assert.equal(existsSync(join(this.sdkDirectory, "invalid.xmpkg")), false);
    assert.equal(readFileSync(this.sdkSentinel, "utf8"), "Keep outside work");
  },
);
Then("the Force and all physical adapters remain unopened", function () {
  assert.equal(this.deviceOperations.length, 0);
});

When("the maintainer rebuilds the same SDK source in a second fresh directory", async function () {
  this.sdkRebuilt = await packSdk(this.workspace.path("second-distribution"));
});
Then("the two SDK tarballs and their source identities match", function () {
  assert.equal(this.sdkRebuilt.sha256, this.sdkDistribution.sha256);
  assert.equal(this.sdkRebuilt.sourceHash, this.sdkDistribution.sourceHash);
});
