import assert from "node:assert/strict";
import { test } from "node:test";
import { readIdentity } from "../flash.mjs";
import {
  inspectWithConnectionDiagnostics,
  windowsConnectionMessage,
} from "./connection-diagnostics.mjs";
import { createController } from "./controller.mjs";

const listedLive = { name: "MPCLive", usbId: "VID_1234&PID_5678", service: "", problemCode: 28 };
const emptyFastboot = (calls) => (args) => {
  calls.push(args);
  return { status: 0, output: "\r\n" };
};

test("Windows sees MPCLive but missing-driver diagnosis stops before any getvar or write", async () => {
  const calls = [];
  let metadataReads = 0;
  const execute = () =>
    inspectWithConnectionDiagnostics(() => readIdentity(emptyFastboot(calls)), {
      platform: "win32",
      readMetadata: async () => {
        metadataReads++;
        return [listedLive];
      },
    });
  const c = createController({
    initialSelection: { loader: "/synthetic/loader" },
    pick: async () => null,
    execute,
  });
  await assert.rejects(c.action({ action: "inspect" }), /driver is missing/);
  assert.match(c.view().message, /Windows lists MPCLive/);
  assert.match(c.view().message, /does not install a Windows device driver/);
  assert.equal(c.view().preview, null);
  await assert.rejects(c.action({ action: "write" }), /Prepare the USB key/);
  assert.deepEqual(calls, [["devices"]]);
  assert.equal(metadataReads, 1);
});

test("a driver problem, a healthy PnP entry and an absent entry have different guidance", () => {
  assert.match(
    windowsConnectionMessage([{ ...listedLive, service: "WinUSB", problemCode: 10 }]),
    /Windows reports a device\/driver problem/,
  );
  assert.match(
    windowsConnectionMessage([{ ...listedLive, service: "", problemCode: 43 }]),
    /Windows reports a device\/driver problem/,
  );
  for (const service of ["WinUSB", "libusbK", "vendorService"])
    assert.match(
      windowsConnectionMessage([{ ...listedLive, service, problemCode: 0 }]),
      /may not expose the interface/,
    );
  assert.match(windowsConnectionMessage([]), /does not list an MPCLive USB entry/);
  assert.match(windowsConnectionMessage([listedLive, listedLive]), /multiple MPC Live/);
  assert.match(windowsConnectionMessage([{ ...listedLive, name: "Akai Force" }]), /Disconnect it/);
});

test("PnP metadata can never turn an empty fastboot list into a successful inspection", async () => {
  const calls = [];
  await assert.rejects(
    inspectWithConnectionDiagnostics(() => readIdentity(emptyFastboot(calls)), {
      platform: "win32",
      readMetadata: async () => [{ ...listedLive, service: "WinUSB", problemCode: 0 }],
    }),
    { code: "XMP_NO_FASTBOOT_DEVICE" },
  );
  assert.deepEqual(calls, [["devices"]]);
});

test("WinUSB without the Android interface is distinguished from missing or unknown metadata", () => {
  const row = { ...listedLive, service: "WinUSB", problemCode: 0 };
  assert.match(
    windowsConnectionMessage([{ ...row, interfaceGuids: [] }]),
    /does not list the Android USB interface/,
  );
  assert.match(
    windowsConnectionMessage([
      { ...row, interfaceGuids: ["{F72FE0D4-CBCB-407D-8814-9ED673D0DD6B}"] },
    ]),
    /may not expose the interface/,
  );
  assert.match(
    windowsConnectionMessage([{ ...row, interfaceGuids: null }]),
    /may not expose the interface/,
  );
});

test("diagnostics never run after success, on another host, or for another failure", async () => {
  const readMetadata = () => {
    throw Error("must not read metadata");
  };
  const result = { identity: "synthetic" };
  assert.equal(
    await inspectWithConnectionDiagnostics(async () => result, { platform: "win32", readMetadata }),
    result,
  );
  const original = Error("image hash mismatch");
  await assert.rejects(
    inspectWithConnectionDiagnostics(
      async () => {
        throw original;
      },
      { platform: "win32", readMetadata },
    ),
    (e) => e === original,
  );
  const missing = Object.assign(Error("empty"), { code: "XMP_NO_FASTBOOT_DEVICE" });
  await assert.rejects(
    inspectWithConnectionDiagnostics(
      async () => {
        throw missing;
      },
      { platform: "darwin", readMetadata },
    ),
    (e) => e === missing,
  );
});

test("unavailable or malformed metadata preserves the original refusal without leaking serials", async () => {
  for (const readMetadata of [
    async () => {
      throw Error("private device instance SERIAL-SECRET");
    },
    async () => Array(33).fill(listedLive),
    async () => [{ ...listedLive, service: "bad\nservice" }],
    async () => [{ ...listedLive, usbId: "USB\\VID_1234&PID_5678\\SERIAL-SECRET" }],
    async () => [{ ...listedLive, interfaceGuids: ["SERIAL-SECRET"] }],
  ]) {
    const log = [];
    const original = Object.assign(Error("empty"), { code: "XMP_NO_FASTBOOT_DEVICE" });
    await assert.rejects(
      inspectWithConnectionDiagnostics(
        async () => {
          throw original;
        },
        { platform: "win32", readMetadata, log: (s) => log.push(s) },
      ),
      (e) => e === original,
    );
    assert.doesNotMatch(log.join("\n"), /SERIAL-SECRET/);
  }
});
