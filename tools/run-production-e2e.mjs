import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { preview } from "vite";
import { buildIdentity, root, writeJson } from "../acceptance/lib/workspace.mjs";
import { preflightTarget } from "../acceptance/target-policy.mjs";

const mode = process.argv[2] ?? "production";
if (
  process.argv.length > 3 ||
  !["production", "manual", "songs", "machines", "legacy"].includes(mode)
)
  throw new Error("Select production or manual local browser regression; no target flags");
preflightTarget({ profile: "standalone" });
const base = join(root, `reports/acceptance/${mode}-e2e`);
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "run-"));
const metadata = {
  kind: `built-browser-${mode}-e2e`,
  sourceHash: buildIdentity(),
  startedAt: new Date().toISOString(),
  physicalAudioOutput: false,
  hardwareQualified: false,
  exitCode: 1,
};
let server;
try {
  const build = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
    cwd: root,
    stdio: "inherit",
    timeout: 120000,
  });
  if (build.status !== 0) throw new Error("Production browser build failed");
  server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Loopback server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  if (mode === "production") {
    // The shipped Device uses the C++ canvas. The former DOM bindings remain
    // available as the explicit legacy profile, not as evidence for this UI.
    const cmake = existsSync(join(root, ".venv/bin/cmake"))
      ? join(root, ".venv/bin/cmake")
      : "cmake";
    const native = existsSync(join(root, "build/native/CMakeCache.txt"))
      ? spawnSync(
          cmake,
          ["--build", "build/native", "--target", "xmp_live_project_workflow_test"],
          { cwd: root, stdio: "inherit", timeout: 120000 },
        )
      : spawnSync(process.execPath, ["tools/native.mjs", "test"], {
          cwd: root,
          stdio: "inherit",
          timeout: 300000,
        });
    if (native.status !== 0) throw new Error("Native touchscreen fixture build failed");
    for (const script of [
      "acceptance/browser/native-device.mjs",
      "acceptance/browser/native-sampler.mjs",
    ]) {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          cwd: root,
          stdio: "inherit",
          timeout: 300000,
          env: { ...process.env, XMP_DEVICE_ORIGIN: origin },
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
      if (code !== 0) throw new Error(`Shared Device browser regression failed: ${script}`);
    }
    metadata.coverage = [
      "86 shared native/browser project actions and 17 pixel comparisons",
      "7 factory kits and 32 synth presets",
      "5 browser input, looping and chopping journeys",
      "mobile manual navigation, search and videos",
    ];
  }
  metadata.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/@cucumber/cucumber/bin/cucumber.js",
        "--profile",
        mode === "songs"
          ? "songE2e"
          : mode === "manual" || mode === "production"
            ? "manualE2e"
            : mode === "machines"
              ? "machinesE2e"
              : "productionE2e",
        "--format",
        "progress",
        "--format",
        `json:${directory}/cucumber.json`,
        "--format",
        `junit:${directory}/cucumber.xml`,
        "--format",
        `html:${directory}/cucumber.html`,
      ],
      {
        cwd: root,
        stdio: "inherit",
        timeout: 900000,
        env: { ...process.env, XMP_E2E_ORIGIN: origin, XMP_E2E_REPORT: directory },
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  metadata.error = error.message;
  console.error(error);
} finally {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  metadata.finishedAt = new Date().toISOString();
  metadata.sourceUnchanged = metadata.sourceHash === buildIdentity();
  if (!metadata.sourceUnchanged) metadata.exitCode = 1;
  writeJson(join(directory, "run-metadata.json"), metadata);
  writeJson(join(base, "latest.json"), { directory });
  process.exitCode = metadata.exitCode;
}
