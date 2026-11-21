import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFlash } from "../flash.mjs";
import { loadHardwareObservation } from "../hardware-observation.mjs";
import { collectStockInstallProfile, stockVerificationAddress } from "../mpc-remote.mjs";
import {
  parseStockInstallReport,
  STOCK_INSTALL_PROBE,
  stockInstallReceipt,
} from "../stock-install-report.mjs";
import { exportUnitProfile, importUnitProfile } from "./profile.mjs";
import { stockInstallFixture } from "./stock-test-fixture.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const fixture = stockInstallFixture({
  serial: "UNIT-ALPHA",
  treeSerial: "TREE-ALPHA",
  sectors: 600000,
});
async function directory(t) {
  const p = await mkdtemp(join(tmpdir(), "xmp-stock-verification-"));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}
test("fresh per-unit report measures capacity and binds both unit serial sources, without a universal size", () => {
  const facts = parseStockInstallReport(fixture.report);
  assert.equal(facts.capacityBytes, 307200000);
  assert(facts.serialHashes.includes(sha("UNIT-ALPHA")));
  assert(facts.serialHashes.includes(sha("TREE-ALPHA")));
  assert.equal(facts.mpcOsVersion, "3.10.1");
});
test("stock report refuses Force, wrong OS/SoC, USB/internal-SD root, missing/duplicate data and conflicting size", () => {
  for (const report of [
    fixture.report.replace("inmusic,acv8", "inmusic,ada2"),
    fixture.report.replace("ACV8", "FORCE"),
    fixture.report.replace("rk3288\n", "rk3288-c\n"),
    fixture.report.replace("3.10.1", "3.10.0"),
    fixture.report.replace("179:6 / /", "8:1 / /"),
    fixture.report.replace("ff0f0000", "ff0c0000"),
    fixture.report.replace("600000\n", "700000\n"),
    fixture.report.replace("TREE-ALPHA\n", "unknown\n"),
    fixture.report.replace("@@version", "@@serial\nTREE-ALPHA\n@@version"),
    fixture.report.replace("@@end", "@@unknown\n@@end"),
    fixture.report + "unexpected",
    fixture.report.replace(" - ext4 ", " - overlay "),
  ])
    assert.throws(() => parseStockInstallReport(report));
});
test("read-only collection needs explicit consent and a local owner-supplied address; never sends free-form shell", async (t) => {
  const stateDirectory = await directory(t);
  const calls = [];
  const transport = (script) => {
    calls.push(script);
    return script === STOCK_INSTALL_PROBE ? fixture.report : fixture.identity;
  };
  assert.throws(
    () => collectStockInstallProfile("192.168.1.50", { stateDirectory, transport }),
    /Confirm/,
  );
  assert.equal(calls.length, 0);
  for (const address of [
    "8.8.8.8",
    "127.0.0.1",
    "192.168.1.50;id",
    "-oProxyCommand=x",
    "192.168.1.999",
  ])
    assert.throws(() => stockVerificationAddress(address));
  const result = collectStockInstallProfile("192.168.1.50", {
    stateDirectory,
    transport,
    ownerReadOnlyConfirmed: true,
  });
  assert.equal(result.capacityBytes, 307200000);
  assert.equal(result.hardwareReadOnly, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], STOCK_INSTALL_PROBE);
  const receipt = JSON.parse(
    await readFile(join(stateDirectory, "hardware-observation.json"), "utf8"),
  );
  assert.equal(receipt.version, 2);
  assert.equal(receipt.expectedBootloader, "0.4");
  assert.equal(receipt.probeSha256, sha(STOCK_INSTALL_PROBE));
});
test("Force is refused after identity read, before rootfs metadata; a changed unit cannot replace prior proof", async (t) => {
  const stateDirectory = await directory(t);
  let calls = 0;
  assert.throws(
    () =>
      collectStockInstallProfile("192.168.1.50", {
        stateDirectory,
        ownerReadOnlyConfirmed: true,
        transport: () => {
          calls++;
          return fixture.report.replace("acv8", "ada2");
        },
      }),
    /Force/,
  );
  assert.equal(calls, 1);
  collectStockInstallProfile("192.168.1.50", {
    stateDirectory,
    ownerReadOnlyConfirmed: true,
    transport: (s) => (s === STOCK_INSTALL_PROBE ? fixture.report : fixture.identity),
  });
  const before = await readFile(join(stateDirectory, "hardware-observation.json"));
  const other = stockInstallFixture({ serial: "UNIT-BETA", treeSerial: "TREE-BETA" });
  assert.throws(
    () =>
      collectStockInstallProfile("192.168.1.51", {
        stateDirectory,
        ownerReadOnlyConfirmed: true,
        transport: () => other.report,
      }),
    /Live recorded/,
  );
  assert.deepEqual(await readFile(join(stateDirectory, "hardware-observation.json")), before);
});
test("new stock observation survives private USB round-trip and requires the exact fastboot unit", async (t) => {
  const source = await directory(t),
    key = await directory(t),
    target = await directory(t);
  const receipt = stockInstallReceipt(fixture.report);
  await writeFile(join(source, receipt.report.file), fixture.report);
  await writeFile(join(source, "hardware-observation.json"), JSON.stringify(receipt));
  const profile = await exportUnitProfile(source);
  await mkdir(join(key, "xmp/.installer-profile"), { recursive: true });
  for (const [name, b] of Object.entries(profile))
    await writeFile(join(key, "xmp/.installer-profile", name), b);
  assert.equal(await importUnitProfile(key, target), true);
  const identity = {
    serial: "UNIT-ALPHA",
    "version-bootloader": "0.4",
    "partition-type:rootfs": "ext4",
  };
  assert.equal((await loadHardwareObservation(target, identity)).capacityBytes, 307200000);
  await assert.rejects(
    loadHardwareObservation(target, { ...identity, serial: "UNIT-BETA" }),
    /does not match/,
  );
  await writeFile(
    join(target, "fastboot-identity.json"),
    JSON.stringify({ identity: { serial: "UNIT-BETA" } }),
  );
  await assert.rejects(importUnitProfile(key, target), /different MPC/);
});
test("fresh first-install dry run works with unimplemented fastboot queries and never flashes", async (t) => {
  const state = await directory(t),
    image = await directory(t);
  const bytes = Buffer.from("synthetic verified XMP image");
  await writeFile(join(image, "rootfs.ext4"), bytes);
  await writeFile(
    join(image, "manifest.json"),
    JSON.stringify({
      format: "xmp-live-mk1-probe-image",
      output: { file: "rootfs.ext4", sha256: sha(bytes) },
    }),
  );
  const calls = [];
  const fastboot = (args) => {
    calls.push(args);
    if (args[0] === "devices") return { status: 0, output: "UNIT-ALPHA\t fastboot" };
    assert.equal(args[0], "getvar");
    if (args[1] === "version-bootloader") return { status: 0, output: "version-bootloader: 0.4" };
    if (args[1] === "partition-type:rootfs")
      return { status: 0, output: "partition-type:rootfs: ext4" };
    return { status: 0, output: "FAILED (remote: 'Variable not implemented')" };
  };
  await assert.rejects(
    runFlash({
      operation: "flash-rootfs",
      source: image,
      stateDirectory: state,
      fastboot,
      log: () => {},
    }),
    /Unsupported fastboot product/,
  );
  collectStockInstallProfile("192.168.1.50", {
    stateDirectory: state,
    ownerReadOnlyConfirmed: true,
    transport: (s) => (s === STOCK_INSTALL_PROBE ? fixture.report : fixture.identity),
  });
  const result = await runFlash({
    operation: "flash-rootfs",
    source: image,
    stateDirectory: state,
    fastboot,
    log: () => {},
  });
  assert.equal(result.rootfsCapacityBytes, 307200000);
  assert(calls.every((a) => ["devices", "getvar"].includes(a[0])));
});
