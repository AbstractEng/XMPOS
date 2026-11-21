import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { createController } from "./controller.mjs";
import { startInstaller } from "./server.mjs";

const identity = { serial: "FAKE", product: "az01" };
function fixture(unitPinned = false) {
  const calls = [];
  let time = 0;
  const controller = createController({
    requireUsbStage: false,
    simulation: true,
    now: () => time,
    pick: async (type) => (type === "updater" ? "/test/Updater.app" : "/test/loader"),
    execute: async (request) => {
      calls.push(request);
      return request.task === "prepare"
        ? { directory: "/prepared/loader" }
        : { identity, image: { sha256: "a".repeat(64) }, unitPinned };
    },
  });
  const inspect = async () => {
    await controller.action({ action: "loader" });
    await controller.action({ action: "inspect" });
    return controller.view().preview.token;
  };
  const write = (token, extra = {}) =>
    controller.action({
      action: "write",
      token,
      confirmation: "XMPOS",
      savedWork: true,
      baseline: true,
      ...extra,
    });
  return {
    controller,
    calls,
    inspect,
    write,
    advance: () => {
      time += 300001;
    },
  };
}
test("exact XMPOS and owner acknowledgements are mandatory", async () => {
  const f = fixture();
  const token = await f.inspect();
  for (const confirmation of ["", "xmpos", "XMPOS ", "FLASH MPC LIVE"])
    await assert.rejects(f.write(token, { confirmation }), /Type XMPOS exactly/);
  await assert.rejects(f.write(token, { baseline: false }), /stock 3.10.1/);
  await assert.rejects(f.write(token, { savedWork: false }), /saved work/);
  assert.equal(
    f.calls.some((r) => r.task === "write"),
    false,
  );
  await f.write(token);
  const request = f.calls.find((r) => r.task === "write");
  assert.deepEqual(request.expectedIdentity, identity);
  assert.equal(request.expectedImageSha256, "a".repeat(64));
  assert.equal(request.answers.flash, "XMPOS");
  await assert.rejects(f.write(token), /Preview expired or missing/);
});
test("expiry, changed selection and operation invalidate a preview", async () => {
  const expired = fixture();
  const token = await expired.inspect();
  expired.advance();
  await assert.rejects(expired.write(token), /Preview expired/);
  for (const input of [
    { action: "mode", mode: "restore" },
    { action: "loader" },
    { action: "updater" },
  ]) {
    const f = fixture();
    const old = await f.inspect();
    await f.controller.action(input);
    await assert.rejects(f.write(old), /Preview expired/);
  }
});
test("stock recovery requires an owner-selected updater and uses the same guarded write path", async () => {
  const f = fixture(true);
  await f.controller.action({ action: "mode", mode: "restore" });
  await assert.rejects(f.controller.action({ action: "inspect" }), /official 3.10.1 updater/);
  await f.controller.action({ action: "updater" });
  await f.controller.action({ action: "inspect" });
  await f.write(f.controller.view().preview.token, { identity: "" });
  assert.equal(f.calls.at(-1).operation, "restore-stock");
  assert.equal(f.calls.at(-1).source, "/test/Updater.app");
});
test("failed writes consume preview and never retry automatically", async () => {
  const calls = [];
  const controller = createController({
    requireUsbStage: false,
    pick: async () => "/test/loader",
    execute: async (request) => {
      calls.push(request);
      if (request.task === "write") throw new Error("fake cable failure");
      return { identity, image: { sha256: "a".repeat(64) }, unitPinned: true };
    },
  });
  await controller.action({ action: "loader" });
  await controller.action({ action: "inspect" });
  const input = {
    action: "write",
    token: controller.view().preview.token,
    confirmation: "XMPOS",
    baseline: true,
    savedWork: true,
  };
  await assert.rejects(controller.action(input), /fake cable failure/);
  await assert.rejects(controller.action(input), /Preview expired/);
  assert.equal(calls.filter((r) => r.task === "write").length, 1);
});
test("one active operation; USB support requires terms; unknown actions cannot become commands", async () => {
  let done;
  const c = createController({
    requireUsbStage: false,
    pick: async () => "/test/loader",
    execute: () =>
      new Promise((r) => {
        done = r;
      }),
  });
  await assert.rejects(c.action({ action: "tools" }), /terms/);
  await assert.rejects(c.action({ action: "shell", command: "echo anything" }), /Unknown/);
  const pending = c.action({ action: "loader" });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(c.action({ action: "inspect" }), /current operation/);
  done({});
  await pending;
  assert.equal(c.view().busy, false);
});
test("HTTP confines actions to loopback, exact Host, nonce and same-origin bounded JSON", async (t) => {
  const calls = [];
  const app = await startInstaller({
    html: await readFile(new URL("./index.html", import.meta.url), "utf8"),
    simulation: true,
    pick: async () => null,
    execute: async (r) => {
      calls.push(r);
      return {};
    },
  });
  t.after(() => {
    app.server.closeAllConnections();
    app.server.close();
  });
  assert.equal(app.server.address().address, "127.0.0.1");
  const page = await fetch(app.origin);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /XMPOS/);
  assert.equal((await fetch(`${app.origin}/api/state`)).status, 403);
  const headers = {
    "X-XMP-Installer": app.nonce,
    "Content-Type": "application/json",
    Origin: app.origin,
  };
  assert.equal((await fetch(`${app.origin}/api/state`, { headers })).status, 200);
  for (const change of [
    { Origin: "https://evil.example" },
    { "X-XMP-Installer": "wrong" },
    { "Content-Type": "text/plain" },
  ]) {
    assert.equal(
      (
        await fetch(`${app.origin}/api/action`, {
          method: "POST",
          headers: { ...headers, ...change },
          body: '{"action":"tools","acceptTerms":true}',
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(`${app.origin}/api/action`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "tools", padding: "x".repeat(9000) }),
      })
    ).status,
    413,
  );
  const hostStatus = await new Promise((done, fail) => {
    const req = httpRequest(app.origin, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on("error", fail);
    req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(calls.length, 0);
});

test("restores selected files without restoring a preview or contacting hardware", async () => {
  const calls = [];
  const saved = [];
  const c = createController({
    requireUsbStage: false,
    initialSelection: {
      updater: "/owner/Updater.app",
      loader: "/owner/loader",
      preview: { token: "old" },
    },
    execute: async (r) => {
      calls.push(r);
      return {};
    },
    pick: async () => "/owner/next-loader",
    rememberSelection: async (s) => saved.push(s),
  });
  assert.equal(c.view().loader, "/owner/loader");
  assert.equal(c.view().preview, null);
  assert.equal(calls.length, 0);
  await c.action({ action: "loader" });
  assert.equal(saved.at(-1).loader, "/owner/next-loader");
  const invalid = createController({
    requireUsbStage: false,
    initialSelection: { updater: "relative.app", loader: "/bad\0path" },
    execute: async () => {},
    pick: async () => null,
  });
  assert.equal(invalid.view().updater, null);
  assert.equal(invalid.view().loader, null);
});

test("install requires a USB prepared in this run; acknowledgements and refreshed selection cannot be bypassed", async () => {
  const calls = [];
  const volume = { deviceKey: "selected", mountPoint: "/test/key" };
  const c = createController({
    initialSelection: {
      updater: "/test/updater",
      loader: "/test/loader",
      usbReady: { sha256: "stale" },
    },
    pick: async () => null,
    execute: async (request, record) => {
      calls.push(request);
      switch (request.task) {
        case "prepare":
          return {
            directory: "/test/loader",
            ownerImage: { image: "/test/system.img", sha256: "b".repeat(64) },
          };
        case "list-usb":
          return [volume];
        case "select-usb":
          return { volume };
        case "prepare-usb":
          record({ phase: "Copying", current: 5, total: 10 });
          return { volume, sha256: "b".repeat(64) };
        case "inspect":
          return { identity, image: { sha256: "a".repeat(64) }, unitPinned: true };
        default:
          return {};
      }
    },
  });
  assert.equal(c.view().usbReady, null);
  await c.action({ action: "inspect" });
  await assert.rejects(c.action({ action: "write" }), /Prepare the USB key/);
  await c.action({ action: "prepare" });
  await assert.rejects(
    c.action({ action: "select-usb", deviceKey: "arbitrary" }),
    /refreshed list/,
  );
  await c.action({ action: "list-usb" });
  await c.action({ action: "select-usb", deviceKey: "selected" });
  await assert.rejects(c.action({ action: "prepare-usb" }), /Confirm the selected/);
  await c.action({ action: "prepare-usb", usbConfirmed: true });
  assert.equal(c.view().usbReady.sha256, "b".repeat(64));
  assert.equal(c.view().progress, null);
  assert.equal(calls.filter((r) => r.task === "write").length, 0);
});
