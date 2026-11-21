import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { runParityVm } from "../../tools/sdk/run-parity-vm.mjs";
import { buildIdentity, root } from "../lib/workspace.mjs";

setDefaultTimeout(1200000);
Given("the frozen generic VM profile excludes networking, host shares and USB passthrough", () => {
  const profile = JSON.parse(readFileSync(join(root, "os/profile.json")));
  for (const key of ["network", "hostShares", "usbPassthrough"]) assert.equal(profile[key], false);
});
When("the five SDK fixtures run in the host and in both guest backends", async function () {
  this.parity = await runParityVm();
});
Then(
  "all fifteen comparisons pass with current source, image and native binary identities",
  function () {
    const r = this.parity.report;
    assert.equal(r.passed, true);
    assert.equal(r.sourceHash, buildIdentity());
    assert.equal(r.boot.buildId, r.buildId);
    assert.equal(r.results.length, 15);
    assert.ok(r.results.every((c) => c.passed));
    assert.ok(r.results.filter((c) => c.backend === "vm-native").length === 5);
  },
);
Then("malformed guest plans are rejected and physical qualification remains pending", function () {
  assert.equal(this.parity.report.invalidPlanRejected, true);
  assert.equal(this.parity.report.projectPreserved, true);
  assert.ok(this.parity.report.maximumGuestResponseBytes <= 4096);
  assert.equal(this.parity.report.hardwareQualified, false);
  assert.equal(this.parity.report.physicalAccess, false);
});
