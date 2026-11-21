import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Then, When } from "@cucumber/cucumber";
import { testLoaderInVm } from "../../tools/live-mk1/loader-vm.mjs";
import { buildProbeImage, EXPECTED_LOADER_CHANGES } from "../../tools/live-mk1/probe-image.mjs";

// LK19: the XMP stick loader. Needs the owner's copy of Akai's signed updater;
// runs locally only and never flashes anything.
const UPDATER = join(homedir(), "Downloads", "MPC (Gen 1) 3.10.0 Updater.app");
const updaterPath = () => process.env.XMP_MPC_UPDATER ?? UPDATER;

When("I build the stick loader image from it", { timeout: 3600000 }, async function () {
  assert.ok(existsSync(updaterPath()));
  this.loaderImage = await buildProbeImage(updaterPath(), { kind: "loader" });
  this.evidence.loaderImage = this.loaderImage.manifest;
  this.loaderVm = (await testLoaderInVm()).result;
  this.evidence.loaderVm = this.loaderVm;
});
Then("only Akai's boot script differs, and it carries the loader", function () {
  const manifest = this.loaderImage.manifest;
  assert.deepEqual(manifest.changes, EXPECTED_LOADER_CHANGES);
  assert.equal(manifest.ubootInodes.allInGroup0, true);
  assert.match(manifest.format, /^xmp-live-mk1-loader-image$/);
});
Then(
  "without a stick the loader mounts the root= partition read-only and runs its \\/sbin\\/init",
  function () {
    assert.deepEqual(this.loaderVm.noStick, {
      handedOver: true,
      mountedReadOnly: true,
      stockInitRan: true,
      rootDiskUnchanged: true,
    });
  },
);
Then(
  "with an XMP system image on the stick it starts that system and never mounts the root partition",
  function () {
    assert.deepEqual(this.loaderVm.withSystem, {
      startedXmp: true,
      xmpInitRan: true,
      neverMountedRoot: true,
      rootDiskUnchanged: true,
    });
  },
);
Then("with a stick but no XMP system it hands over to Akai's system", function () {
  assert.equal(this.loaderVm.emptyStick.noticedNoSystem, true);
  assert.equal(this.loaderVm.emptyStick.handedOver, true);
});
Then("the root disk is byte-identical after every boot", function () {
  for (const run of [this.loaderVm.noStick, this.loaderVm.withSystem, this.loaderVm.emptyStick])
    assert.equal(run.rootDiskUnchanged, true);
});
