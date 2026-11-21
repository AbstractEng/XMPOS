import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { fastbootArgs, runFlash, UNLOCK } from "../../tools/live-mk1/flash.mjs";

const live = {
  product: "az01",
  "version-bootloader": "2016.05-inmusic",
  "partition-type:rootfs": "ext4",
  "partition-size:rootfs": "0x1f400000",
};
function simulated(identity, devices = 1) {
  const calls = [];
  const fastboot = (args) => {
    calls.push(args);
    if (args[0] === "devices")
      return {
        status: 0,
        output: Array.from({ length: devices }, (_, i) => `S${i}\tfastboot`).join("\n"),
      };
    if (args[0] === "getvar")
      return { status: 0, output: `${args[1]}: ${identity[args[1]] ?? ""}` };
    return { status: 0, output: "OKAY" };
  };
  return { calls, fastboot };
}
const writes = (calls) => calls.filter((c) => c[0] !== "devices" && c[0] !== "getvar");
const quiet = () => {};

Given("a simulated fastboot device in update mode", function () {
  this.imageDir = mkdtempSync(join(tmpdir(), "xmp-lk18-image-"));
  this.state = () => mkdtempSync(join(tmpdir(), "xmp-lk18-state-"));
  const bytes = Buffer.from("simulated rootfs");
  writeFileSync(join(this.imageDir, "rootfs.ext4"), bytes);
  writeFileSync(
    join(this.imageDir, "manifest.json"),
    JSON.stringify({
      format: "xmp-live-mk1-probe-image",
      output: { file: "rootfs.ext4", sha256: createHash("sha256").update(bytes).digest("hex") },
    }),
  );
});
When(
  "the flash tool is asked for a dry run, a Force, extra devices or forbidden commands",
  async function () {
    const base = { source: this.imageDir, log: quiet };
    this.dry = simulated(live);
    await runFlash({
      ...base,
      operation: "flash-rootfs",
      fastboot: this.dry.fastboot,
      stateDirectory: this.state(),
    });
    this.refusals = [];
    for (const [label, sim, operation] of [
      ["force", simulated({ ...live, product: "ada2" }), "flash-rootfs"],
      ["two devices", simulated(live, 2), "flash-rootfs"],
      ["no device", simulated(live, 0), "status"],
    ]) {
      try {
        await runFlash({
          ...base,
          operation,
          fastboot: sim.fastboot,
          dryRun: false,
          stateDirectory: this.state(),
          answers: { flash: "XMPOS" },
        });
        this.refusals.push({ label, refused: false, writes: writes(sim.calls) });
      } catch (error) {
        this.refusals.push({
          label,
          refused: true,
          message: error.message,
          writes: writes(sim.calls),
        });
      }
    }
    this.forbidden = ["erase", "format", "flash-bootloader", "oem format", "getvar:serialno"].map(
      (step) => {
        try {
          fastbootArgs(step);
          return false;
        } catch {
          return true;
        }
      },
    );
    this.evidence.refusals = this.refusals;
  },
);
Then("the dry run sends no write and every other request is refused before any write", function () {
  assert.deepEqual(writes(this.dry.calls), []);
  for (const refusal of this.refusals) {
    assert.equal(refusal.refused, true, refusal.label);
    assert.deepEqual(refusal.writes, [], refusal.label);
  }
  assert.ok(this.forbidden.every(Boolean));
});
Then(
  "a confirmed flash sends exactly the unlock, the rootfs image and a reboot",
  async function () {
    const sim = simulated(live);
    await runFlash({
      operation: "flash-rootfs",
      source: this.imageDir,
      dryRun: false,
      fastboot: sim.fastboot,
      log: quiet,
      stateDirectory: this.state(),
      answers: { flash: "XMPOS" },
    });
    assert.deepEqual(writes(sim.calls), [
      ["oem", UNLOCK],
      ["flash", "rootfs", join(this.imageDir, "rootfs.ext4")],
      ["reboot"],
    ]);
  },
);
