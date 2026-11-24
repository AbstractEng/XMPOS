import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stockInstallReceipt } from "../stock-install-report.mjs";
import { createController } from "./controller.mjs";
import { stockInstallFixture } from "./stock-test-fixture.mjs";
import { FASTBOOT_INTERFACE, repairWindowsUsb, validateUsbRepairPlan } from "./windows-usb.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const otherGuid = "{12345678-1234-1234-1234-123456789abc}";
const plan = (plural = [], singular = []) => {
  const before = {
    deviceKey: sha("synthetic Windows PnP ID"),
    plural: { kind: plural.length ? "MultiString" : "absent", values: plural },
    singular: { kind: singular.length ? "String" : "absent", values: singular },
  };
  return {
    fingerprint: sha(JSON.stringify(before)),
    before,
    needsRepair: ![...plural, ...singular].some((g) => g.toLowerCase() === FASTBOOT_INTERFACE),
  };
};
async function fixture(t) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "xmp-winusb-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const report = stockInstallFixture({ serial: "TEST-LIVE", treeSerial: "TEST-TREE" }).report;
  await writeFile(
    join(stateDirectory, "hardware-observation.json"),
    JSON.stringify(stockInstallReceipt(report)),
  );
  await writeFile(join(stateDirectory, "stock-install-verification.txt"), report);
  await writeFile(
    join(stateDirectory, "stock-device-identity.json"),
    JSON.stringify({ version: 1, serialHashes: [sha("TEST-LIVE"), sha("TEST-TREE")] }),
  );
  return { stateDirectory, platform: "win32", ownerConfirmed: true };
}

test("repair requires confirmation, Windows, and a hash-verified per-unit stock profile before any helper call", async (t) => {
  const options = await fixture(t);
  const invoke = () => assert.fail("must not invoke helper");
  await assert.rejects(repairWindowsUsb({ ...options, invoke, ownerConfirmed: false }), /Confirm/);
  await assert.rejects(
    repairWindowsUsb({ ...options, invoke, platform: "darwin" }),
    /Windows only/,
  );
  await writeFile(
    join(options.stateDirectory, "stock-device-identity.json"),
    JSON.stringify({ version: 1, serialHashes: [sha("ANOTHER-LIVE")] }),
  );
  await assert.rejects(repairWindowsUsb({ ...options, invoke }), /pin does not match/);
  await writeFile(
    join(options.stateDirectory, "stock-install-verification.txt"),
    "tampered report",
  );
  await assert.rejects(repairWindowsUsb({ ...options, invoke }), /hash changed/);
});

test("preview is read-only and successful repair backs up original values before elevation, preserving both GUID forms", async (t) => {
  const options = await fixture(t);
  const before = plan([otherGuid], [otherGuid]);
  const calls = [];
  const invoke = async (args) => {
    calls.push(args[0]);
    assert.equal(args[1], [sha("TEST-LIVE"), sha("TEST-TREE")].join(","));
    if (args[0] === "winusb-plan") return before;
    assert.equal(args[0], "winusb-repair");
    assert.equal(args[2], before.fingerprint);
    const backup = JSON.parse(
      await readFile(
        join(options.stateDirectory, "windows-usb-backups", `${before.fingerprint}.json`),
      ),
    );
    assert.deepEqual(backup.before, before.before);
    return plan([otherGuid, FASTBOOT_INTERFACE], [otherGuid]);
  };
  assert.deepEqual(
    await repairWindowsUsb({ ...options, invoke, previewOnly: true, ownerConfirmed: false }),
    before,
  );
  assert(!(await readdir(options.stateDirectory)).includes("windows-usb-backups"));
  const result = await repairWindowsUsb({ ...options, invoke });
  assert.equal(result.changed, true);
  assert.equal(result.reconnectRequired, true);
  assert.deepEqual(calls, ["winusb-plan", "winusb-plan", "winusb-repair"]);
});

test("existing plural or singular fastboot GUID is a no-op and never requests elevation", async (t) => {
  const options = await fixture(t);
  for (const existing of [
    plan([FASTBOOT_INTERFACE]),
    plan([], [FASTBOOT_INTERFACE.toUpperCase()]),
  ]) {
    const calls = [];
    const result = await repairWindowsUsb({
      ...options,
      invoke: async (args) => {
        calls.push(args[0]);
        return existing;
      },
    });
    assert.deepEqual(result, { changed: false, reconnectRequired: false });
    assert.deepEqual(calls, ["winusb-plan"]);
  }
});

test("cancelled elevation, changed device and altered GUIDs cannot report a successful repair", async (t) => {
  const options = await fixture(t);
  for (const after of [
    null,
    plan(),
    plan([FASTBOOT_INTERFACE]),
    { ...plan(), fingerprint: sha("changed") },
  ]) {
    await assert.rejects(
      repairWindowsUsb({
        ...options,
        invoke: async (args) => {
          if (args[0] === "winusb-plan") return plan([otherGuid]);
          if (!after) throw Error("UAC cancelled");
          return after;
        },
      }),
    );
  }
});

test("malformed registry values and a symlink backup are refused before elevation", async (t) => {
  for (const change of [
    (p) => {
      p.before.plural.kind = "DWord";
    },
    (p) => {
      p.before.plural.values = ["not a GUID"];
    },
    (p) => {
      p.before.plural.values = Array(33).fill(otherGuid);
    },
    (p) => {
      p.before.deviceKey = "private-device-path";
    },
  ]) {
    const p = plan();
    change(p);
    assert.throws(() => validateUsbRepairPlan(p));
  }
  const options = await fixture(t);
  const before = plan();
  const target = join(options.stateDirectory, "backup-target");
  await writeFile(target, "preserve");
  try {
    await symlink(target, join(options.stateDirectory, "windows-usb-backups"));
  } catch (e) {
    if (process.platform === "win32" && e.code === "EPERM") {
      t.skip("Windows symlink requires privileges");
      return;
    }
    throw e;
  }
  await assert.rejects(
    repairWindowsUsb({
      ...options,
      invoke: async (args) => {
        assert.equal(args[0], "winusb-plan");
        return before;
      },
    }),
  );
  assert.equal(await readFile(target, "utf8"), "preserve");
});

test("installer repair is explicit, unavailable in simulation, and never authorizes a flash", async () => {
  const tasks = [];
  const controller = createController({
    platform: "win32",
    pick: async () => null,
    execute: async (request) => {
      tasks.push(request);
      return { reconnectRequired: true };
    },
  });
  await assert.rejects(controller.action({ action: "repair-windows-usb" }), /Confirm/);
  await controller.action({ action: "repair-windows-usb", ownerConfirmed: true });
  assert.deepEqual(tasks, [{ task: "repair-windows-usb", ownerConfirmed: true }]);
  assert.equal(controller.view().preview, null);
  assert.match(controller.view().message, /Disconnect and reconnect/);
  await assert.rejects(controller.action({ action: "write" }), /Prepare the USB key/);
  const simulated = createController({
    platform: "win32",
    simulation: true,
    execute: () => assert.fail(),
    pick: async () => null,
  });
  await assert.rejects(
    simulated.action({ action: "repair-windows-usb", ownerConfirmed: true }),
    /unavailable/,
  );
});
