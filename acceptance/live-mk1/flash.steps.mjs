import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { fastbootArgs, readIdentity, runFlash, UNLOCK } from "../../tools/live-mk1/flash.mjs";
import { inspectWithConnectionDiagnostics } from "../../tools/live-mk1/installer/connection-diagnostics.mjs";
import { createController } from "../../tools/live-mk1/installer/controller.mjs";
import { windowsUsbRepairAction } from "../../tools/live-mk1/installer/host.mjs";
import { stockInstallFixture } from "../../tools/live-mk1/installer/stock-test-fixture.mjs";
import {
  FASTBOOT_INTERFACE,
  repairWindowsUsb,
} from "../../tools/live-mk1/installer/windows-usb.mjs";
import { stockInstallReceipt } from "../../tools/live-mk1/stock-install-report.mjs";

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

Then(
  "an administrator prompt launch failure is distinguished from cancellation without exposing private Windows details",
  async function () {
    const codes = [];
    for (const [code, nativeCode, explanation] of [
      ["XMP_UAC_LAUNCH_FAILED", 2, /could not open the administrator approval/],
      ["XMP_UAC_CANCELLED", 1223, /approval was cancelled/],
    ]) {
      let launches = 0;
      const c = createController({
        platform: "win32",
        pick: async () => null,
        execute: () =>
          windowsUsbRepairAction(
            "/synthetic/resources",
            ["winusb-repair", "a".repeat(64), "b".repeat(64)],
            {
              platform: "win32",
              execute: async () => {
                launches++;
                throw Object.assign(Error("C:\\Users\\PRIVATE\\SERIAL-SECRET"), {
                  stderr: `XMP_WINDOWS_USB_ERROR ${JSON.stringify({ code, nativeCode })}`,
                });
              },
            },
          ),
      });
      await assert.rejects(c.action({ action: "repair-windows-usb", ownerConfirmed: true }), {
        code,
      });
      assert.match(c.view().message, explanation);
      assert.doesNotMatch(c.view().message, /PRIVATE|SERIAL-SECRET/);
      assert.equal(c.view().preview, null);
      assert.equal(launches, 1);
      await assert.rejects(c.action({ action: "write" }), /Prepare the USB key/);
      codes.push(code);
    }
    this.evidence.windowsElevationFailure = {
      synthetic: true,
      codes,
      automaticRetry: false,
      flashPreview: false,
    };
  },
);

Then(
  "a confirmed Windows connection repair preserves existing interfaces and never enables an MPC write",
  async function () {
    const stateDirectory = this.state();
    const sha = (b) => createHash("sha256").update(b).digest("hex");
    const report = stockInstallFixture({ serial: "SYNTHETIC-LIVE" }).report;
    writeFileSync(
      join(stateDirectory, "hardware-observation.json"),
      JSON.stringify(stockInstallReceipt(report)),
    );
    writeFileSync(join(stateDirectory, "stock-install-verification.txt"), report);
    writeFileSync(
      join(stateDirectory, "stock-device-identity.json"),
      JSON.stringify({ version: 1, serialHashes: [sha("SYNTHETIC-LIVE")] }),
    );
    const preserved = "{12345678-1234-1234-1234-123456789abc}";
    const makePlan = (values, needsRepair) => {
      const before = {
        deviceKey: sha("synthetic PnP entry"),
        plural: { kind: "MultiString", values },
        singular: { kind: "absent", values: [] },
      };
      return { before, fingerprint: sha(JSON.stringify(before)), needsRepair };
    };
    const before = makePlan([preserved], true);
    const calls = [];
    const invoke = async (args) => {
      calls.push(args[0]);
      if (args[0] === "winusb-plan") return before;
      assert.equal(args[0], "winusb-repair");
      const backup = JSON.parse(
        readFileSync(
          join(stateDirectory, "windows-usb-backups", `${before.fingerprint}.json`),
          "utf8",
        ),
      );
      assert.deepEqual(backup.before, before.before);
      return makePlan([preserved, FASTBOOT_INTERFACE], false);
    };
    const c = createController({
      platform: "win32",
      pick: async () => null,
      execute: async (request) => {
        assert.equal(request.task, "repair-windows-usb");
        return repairWindowsUsb({
          stateDirectory,
          invoke,
          platform: "win32",
          ownerConfirmed: request.ownerConfirmed,
        });
      },
    });
    await assert.rejects(c.action({ action: "repair-windows-usb" }), /Confirm/);
    assert.deepEqual(calls, []);
    await c.action({ action: "repair-windows-usb", ownerConfirmed: true });
    assert.deepEqual(calls, ["winusb-plan", "winusb-repair"]);
    assert.equal(c.view().preview, null);
    await assert.rejects(c.action({ action: "write" }), /Prepare the USB key/);
    this.evidence.windowsUsbRepair = {
      synthetic: true,
      backedUp: true,
      existingInterfacesPreserved: true,
      flashPreview: false,
      actions: calls,
    };
  },
);

Then(
  "an MPCLive entry without a Windows driver is diagnosed without enabling a write",
  async function () {
    const sim = simulated(live, 0);
    const controller = createController({
      initialSelection: { loader: "/synthetic/loader" },
      pick: async () => null,
      execute: () =>
        inspectWithConnectionDiagnostics(() => readIdentity(sim.fastboot), {
          platform: "win32",
          readMetadata: async () => [
            { name: "MPCLive", usbId: "VID_1234&PID_5678", service: "", problemCode: 28 },
          ],
        }),
    });
    await assert.rejects(controller.action({ action: "inspect" }), /driver is missing/);
    assert.equal(controller.view().preview, null);
    assert.deepEqual(sim.calls, [["devices"]]);
    this.evidence.windowsMissingDriver = { diagnosed: true, preview: false, commands: sim.calls };
  },
);

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
