import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { root, scenarioWorkspace } from "../../acceptance/lib/workspace.mjs";
import { reviewTarget } from "../../packages/lab/src/readiness.ts";
import { createBench } from "./bench.mjs";

const mode = process.argv[2];
if (!["review", "demo"].includes(mode) || process.argv.length > (mode === "review" ? 4 : 3))
  throw new Error("Select review [owned dossier file] or demo; no physical device flags");
if (mode === "review") {
  const input = process.argv[3];
  let path = resolve(root, "hardware/target.example.json");
  if (input) {
    path = resolve(root, input);
    if (!path.startsWith(`${root}reports/`) && !path.startsWith(`${root}artifacts/`))
      throw new Error("Use an owned reports/artifacts dossier; no device or mounted-volume paths");
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 65536 ||
      !realpathSync(path).startsWith(`${realpathSync(root)}/`)
    )
      throw new Error("Regular bounded workspace dossier required");
  }
  const report = reviewTarget(JSON.parse(readFileSync(path, "utf8")));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.readyForDeviceSpecificReview ? 0 : 2;
} else {
  const workspace = scenarioWorkspace();
  let bench;
  try {
    bench = await createBench(workspace);
    const client = await bench.connect();
    await bench.load(client);
    const started = await client.request({ op: "action", action: "start" });
    const render = await client.request({ op: "render", fixtureId: "fixture-one" });
    const disconnectedAt = (await bench.engine.client.snapshot()).frame;
    await bench.disconnect(client);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const continued = await bench.engine.client.snapshot();
    const reconnected = await bench.connect();
    const results = await reconnected.request({ op: "results" });
    const final = await bench.finish();
    const audioAfterDisconnect = final.capture
      .subarray(44 + (disconnectedAt + 256) * 4)
      .some((b) => b !== 0);
    if (
      !continued.running ||
      continued.frame <= started.frame ||
      !render.peak ||
      !audioAfterDisconnect ||
      final.native.auditFaults !== 0
    )
      throw new Error("Host lab journey failed");
    const output = resolve(root, "reports/lab-demo");
    mkdirSync(output, { recursive: true });
    copyFileSync(workspace.path("engine-capture.wav"), resolve(output, "capture.wav"));
    const report = {
      profile: final.profile,
      buildHash: final.buildHash,
      fixtureHash: final.fixtureHash,
      started,
      continued: { running: continued.running, frame: continued.frame },
      render,
      audioAfterDisconnect,
      reconnectSessionChanged: client.session !== reconnected.session,
      results,
      native: final.native,
      nativeBinaryHash: final.nativeBinaryHash,
      physicalDeviceOperations: [],
      hardwareQualified: false,
      phaseQualified: false,
    };
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (bench) await bench.finish();
    workspace.close();
  }
}
