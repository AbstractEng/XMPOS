import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { cc0Kits, loadBundledDrumKit } from "../../apps/studio/src/bundled-drum-kits.ts";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { applyDrumKit, drumKitFromWavs } from "../../packages/core/src/drum-kits.ts";
import { createDemoProject, encodeWav } from "../../packages/core/src/index.ts";
import { prepareInstruments, VoiceRack } from "../../packages/core/src/instruments.ts";
import { ProjectSession } from "../../packages/core/src/session.ts";
import { command, root } from "../lib/workspace.mjs";

const wav = (name) => ({
  name,
  bytes: new Uint8Array(
    encodeWav(
      [
        Float32Array.from(
          { length: 2400 },
          (_, i) => 0.5 * Math.exp(-i / 250) * Math.sin(i * 0.12),
        ),
      ],
      48000,
    ),
  ),
});

Given("the original demo song and committed CC0 kit catalog", function () {
  this.drumOriginal = createDemoProject();
  this.drumSession = new ProjectSession(this.drumOriginal, true);
  assert.equal(cc0Kits.length, 3);
});
When("the musician loads bundled CC0 kit {string}", async function (id) {
  this.cc0Entry = cc0Kits.find((kit) => kit.id === id);
  assert.ok(this.cc0Entry);
  const kit = await loadBundledDrumKit(id, "/xmpos/", async (url) => {
    assert.ok(url.startsWith("/xmpos/kits/cc0/"));
    return new Response(
      new Uint8Array(
        readFileSync(resolve(root, "apps/studio/public", url.slice("/xmpos/".length))),
      ),
    );
  });
  this.drumSession.edit((p) => applyDrumKit(p, kit));
});
Then(
  "its {int} assigned pads render finite nonzero audio and its licenses are retained",
  function (count) {
    assert.equal(this.cc0Entry.files.length, count);
    for (const path of this.cc0Entry.licensePaths)
      assert.match(
        readFileSync(resolve(root, "apps/studio/public", path), "utf8"),
        /CC0 1.0 Universal/,
      );
    const palette = prepareInstruments(this.drumSession.project);
    for (let pad = 0; pad < count; pad++) {
      const rack = new VoiceRack(palette),
        left = new Float32Array(128),
        right = new Float32Array(128);
      rack.noteOn(1, pad, 0, 60, 0.8);
      let peak = 0;
      for (let block = 0; block < 40; block++) {
        rack.process(left, right);
        assert.ok(left.every(Number.isFinite));
        for (const value of left) peak = Math.max(peak, Math.abs(value));
      }
      assert.ok(peak > 0.00001, `Silent pad ${pad + 1}`);
    }
  },
);
When("CC0 integrity failures and edits during download are exercised", function () {
  this.drumUi = command(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/cc0-kits.test.ts",
      "-t",
      "refuses corrupt|keeps song edits",
    ],
    root,
  );
});
Then("the current project survives corrupt downloads and stale kit loads", function () {
  assert.match(this.drumUi, /2 passed/);
});
Given("a saved song and five named WAV one-shots in arbitrary file order", function () {
  this.drumOriginal = createDemoProject();
  this.drumSession = new ProjectSession(this.drumOriginal, true);
  this.drumFiles = [
    "Snare.wav",
    "Kick 02.wav",
    "Closed Hat.wav",
    "Kick 01.wav",
    "Open Hat.wav",
  ].map(wav);
});
When("the musician loads those sounds as a single drum kit", function () {
  this.drumSession.edit((p) => applyDrumKit(p, drumKitFromWavs("Local test kit", this.drumFiles)));
});
Then("kick, snare, closed hat and open hat occupy the first four pads", function () {
  assert.deepEqual(
    this.drumSession.project.pads.slice(0, 4).map((p) => p.name),
    ["Kick 01", "Snare", "Closed Hat", "Open Hat"],
  );
});
Then("unused kit pads render silence and the kick renders nonzero finite audio", function () {
  const render = (pad) => {
    const rack = new VoiceRack(prepareInstruments(this.drumSession.project));
    const left = new Float32Array(128),
      right = new Float32Array(128);
    rack.noteOn(1, pad, 0, 60, 0.8);
    rack.process(left, right);
    return left;
  };
  const kick = render(0);
  assert.ok(kick.every(Number.isFinite));
  assert.ok(kick.some((v) => Math.abs(v) > 0.001));
  assert.ok(render(15).every((v) => v === 0));
});
Then("the patterns, scenes, tempo and track machines are unchanged", function () {
  const current = this.drumSession.project;
  for (const key of ["tracks", "scenes", "bpm", "swing", "parameters", "mix", "performance"])
    assert.deepEqual(current[key], this.drumOriginal[key]);
});
Then(
  "a portable project retains the kit and one Undo restores the original pad bank",
  async function () {
    assert.deepEqual(
      await importPortable(await exportPortable(this.drumSession.project)),
      this.drumSession.project,
    );
    assert.equal(this.drumSession.historyDepth, 1);
    this.drumSession.undo();
    assert.deepEqual(this.drumSession.project, this.drumOriginal);
  },
);
When(
  /^a kit with (a corrupt WAV|seventeen sounds|excessive sample data) is submitted$/,
  function (problem) {
    assert.throws(() =>
      this.drumSession.edit((p) => {
        if (problem === "excessive sample data")
          return applyDrumKit(p, {
            name: "Oversized",
            samples: Array.from({ length: 3 }, () => ({
              name: "Long",
              sampleRate: 48000,
              pcm: Array(400000).fill(0),
            })),
          });
        const files =
          problem === "seventeen sounds"
            ? Array.from({ length: 17 }, () => wav("Kick.wav"))
            : [wav("Kick.wav"), { name: "Broken.wav", bytes: new Uint8Array(44) }];
        return applyDrumKit(p, drumKitFromWavs("Bad", files));
      }),
    );
  },
);
Then("the original song and undo history remain intact", function () {
  assert.deepEqual(this.drumSession.project, this.drumOriginal);
  assert.equal(this.drumSession.historyDepth, 0);
});
Given("isolated Studio kit controls with browser storage and audio hardware disabled", () => {});
When(
  "the musician imports a kit, reloads the library and switches to the original kit",
  function () {
    this.drumUi = command(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "tests/drum-kits.test.ts",
        "-t",
        "imports through the Studio controls",
      ],
      root,
    );
  },
);
Then(
  "the UI contract verifies persistence, pad assignment and Undo without opening a device",
  function () {
    assert.match(this.drumUi, /1 passed/);
  },
);
When("the musician edits the song during an asynchronous kit import", function () {
  this.drumUi = command(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/drum-kits.test.ts",
      "-t",
      "asynchronous WAV reading becomes stale",
    ],
    root,
  );
});
Then("the stale import cannot replace the song or add a kit to the library", function () {
  assert.match(this.drumUi, /1 passed/);
});
