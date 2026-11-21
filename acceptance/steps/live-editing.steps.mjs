import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AfterAll, Then, When } from "@cucumber/cucumber";
import { root } from "../lib/workspace.mjs";

let directory;
let binary;
AfterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
When("the live editing case {string} is exercised in the shared Device host", function (scenario) {
  assert.ok(
    [
      "machine",
      "continuity",
      "effect",
      "bars",
      "length",
      "tempo",
      "tap",
      "fader",
      "lights",
      "summaries",
      "song-play",
      "playing-range",
      "effect-controls",
      "keyboard-naming",
      "take-editor",
    ].includes(scenario),
  );
  if (!binary) {
    directory = mkdtempSync(join(tmpdir(), "xmp-live-editing-"));
    binary = join(directory, "live-editing");
    const built = spawnSync(
      "c++",
      [
        "-std=c++17",
        "-O1",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-I${join(root, "native/include")}`,
        `-I${join(root, "build/fonts")}`,
        join(root, "native/tests/live_changes_test.cpp"),
        "-o",
        binary,
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(built.status, 0, built.stderr);
  }
  this.liveEditingResult = spawnSync(binary, [scenario], { encoding: "utf8", timeout: 30000 });
});
Then("the host verifies {string} without restarting playback", function (behavior) {
  assert.equal(
    this.liveEditingResult.status,
    0,
    `${behavior}\n${this.liveEditingResult.stdout}\n${this.liveEditingResult.stderr}`,
  );
});
