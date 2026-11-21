// CI-only host preparation and simulated device flow. Never opens hardware.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { createController } from "./controller.mjs";
import { FIRST_PROJECT } from "./first-project.mjs";

const resources = resolve(process.argv[2]),
  updater = resolve(process.argv[3]);
const workspace = await realpath(await mkdtemp(join(tmpdir(), "xmp-windows-test-")));
process.env.XMP_INSTALLER_WORKSPACE = workspace;
process.env.XMP_INSTALLER_RESOURCES = resources;
const manifest = JSON.parse(await readFile(join(resources, "bundle-manifest.json"), "utf8"));
for (const path of manifest.workspaceFiles) {
  await mkdir(dirname(join(workspace, path)), { recursive: true });
  await copyFile(join(resources, "workspace", path), join(workspace, path));
}

const requests = [];
let ticks = 0,
  progress = 0;
const timer = setInterval(() => ticks++, 10);
const execute = (request, record) =>
  new Promise((done, fail) => {
    requests.push(request.task);
    const w = new Worker(join(resources, "worker.mjs"), {
      workerData: { request, resources, workspace, simulation: true, simulationProfile: "legacy" },
    });
    let settled = false;
    w.on("message", (m) => {
      if (m.log !== undefined) {
        record(m.log);
        console.log(m.log);
      }
      if (m.progress) {
        progress++;
        record(m.progress);
      }
      if (m.error) {
        settled = true;
        fail(Error(m.error));
      }
      if (m.result !== undefined) {
        settled = true;
        done(m.result);
      }
    });
    w.on("error", fail);
    w.on("exit", (n) => {
      if (!settled) fail(Error(`worker exited ${n}`));
    });
  });
try {
  const c = createController({ simulation: true, pick: async () => updater, execute });
  await c.action({ action: "updater" });
  await c.action({ action: "prepare" });
  assert(c.view().ownerImage);
  await c.action({ action: "verify-stock", address: "192.168.1.50", stockConfirmed: true });
  await c.action({ action: "list-usb" });
  await c.action({ action: "select-usb", deviceKey: "simulation-volume" });
  await assert.rejects(c.action({ action: "prepare-usb" }), /Confirm/);
  await c.action({ action: "prepare-usb", usbConfirmed: true });
  const projectPath = join(workspace, "build/simulated-usb/xmp/project.xmpsong");
  const demo = await readFile(projectPath);
  assert.equal(createHash("sha256").update(demo).digest("hex"), FIRST_PROJECT.sha256);
  const edited = Buffer.concat([demo, Buffer.from("\n")]);
  await writeFile(projectPath, edited);
  await c.action({ action: "prepare-usb", usbConfirmed: true });
  assert.deepEqual(await readFile(projectPath), edited);
  await c.action({ action: "eject-usb" });
  await c.action({ action: "inspect" });
  await c.action({
    action: "write",
    token: c.view().preview.token,
    confirmation: "XMPOS",
    savedWork: true,
    baseline: true,
  });
  await c.action({ action: "mode", mode: "restore" });
  await c.action({ action: "inspect" });
  await c.action({
    action: "write",
    token: c.view().preview.token,
    confirmation: "XMPOS",
    savedWork: true,
    baseline: true,
  });
  assert(ticks > 20);
  assert(progress > 0);
  const result = {
    passed: true,
    hardwareContacted: false,
    physicalUsbWritten: false,
    sourceHash: manifest.sourceHash,
    requests,
    progressEvents: progress,
    eventLoopTicks: ticks,
    workspace,
    testedAt: new Date().toISOString(),
    firstBootDemoVerified: FIRST_PROJECT.name,
    existingProjectPreserved: true,
  };
  await writeFile(
    resolve(process.argv[4] || "windows-smoke.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  clearInterval(timer);
}
