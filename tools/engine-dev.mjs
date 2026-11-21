import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  EngineClient,
  operations,
  projectGraph,
  startEngineHost,
} from "../acceptance/lib/engine-target.mjs";
import {
  ownedScenarioDirectory,
  root,
  scenarioWorkspace,
  writeJson,
} from "../acceptance/lib/workspace.mjs";
import { MAX_SONG_BYTES } from "../packages/core/src/index.ts";
import { openProject } from "../packages/core/src/project-io.ts";

if (process.argv.length > 2)
  throw new Error("No device, backend or deployment flags are supported");
const reportDirectory = resolve(root, "reports/engine");
mkdirSync(reportDirectory, { recursive: true });
const manifestFile = resolve(reportDirectory, "session.json");
let client, manifest, host;
if (existsSync(manifestFile)) {
  try {
    const previous = JSON.parse(readFileSync(manifestFile, "utf8"));
    ownedScenarioDirectory(previous.directory);
    const candidate = await EngineClient.connect(resolve(previous.directory, "engine.sock"));
    if ((await candidate.snapshot()).projectHash !== previous.projectHash) {
      candidate.close();
      throw new Error("Project identity mismatch");
    }
    client = candidate;
    manifest = previous;
  } catch {}
}
if (!client) {
  const workspace = scenarioWorkspace();
  const projectFile = resolve(root, "artifacts/engine-project.xmp.json");
  let graph;
  if (existsSync(projectFile)) {
    if (statSync(projectFile).size > MAX_SONG_BYTES)
      throw new Error("Project exceeds import budget");
    const project = await openProject(readFileSync(projectFile, "utf8"));
    graph = await projectGraph(project, project.scenes[0].id);
  }
  host = await startEngineHost(workspace, { graph, seconds: 60 });
  client = host.client;
  manifest = {
    directory: workspace.directory,
    pid: host.child.pid,
    projectHash: host.graph.projectHash,
    profile: host.identity.profile,
    physicalAudio: false,
    capture: "engine-capture.wav",
    maximumSessionSeconds: 60,
  };
  writeJson(manifestFile, manifest);
}
const state = await client.snapshot();
const project = await client.project(state);
console.log(`Native engine ${manifest.pid} · 48 kHz / 256 frames · software capture only`);
console.log(
  `Project: ${project.project?.name ?? project.profileId} · generation ${state.generation}`,
);
console.log(
  "Commands: play, stop, tempo 90, swing 66.66666666666667, state, quit (disconnect), shutdown. The host survives client exit until its 60-second capture limit.",
);
console.log(`Evidence: ${manifest.directory}`);
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY,
});
let commandChain = Promise.resolve();
terminal.on("line", (line) => {
  commandChain = commandChain.then(async () => {
    try {
      const [name, value] = line.trim().split(/\s+/);
      let result;
      if (name === "play") result = await client.request(operations.start);
      else if (name === "stop") result = await client.request(operations.stop);
      else if (name === "swing") {
        const percent = Number(value);
        if (!Number.isFinite(percent) || percent < 50 || percent > 75)
          throw new Error("Swing must be 50..75 percent");
        const current = await client.snapshot();
        result = await client.request(operations.groove, {
          timestamp: (Math.floor(current.tick / 3840) + 1) * 3840,
          a: 1,
          value: (percent - 50) / 50,
        });
      } else if (name === "tempo") {
        const tempo = Number(value);
        if (!Number.isFinite(tempo) || tempo < 30 || tempo > 300)
          throw new Error("Tempo must be 30..300 BPM");
        const current = await client.snapshot();
        const boundary = (Math.floor(current.tick / 3840) + 1) * 3840;
        result = await client.request(operations.tempo, { timestamp: boundary, value: tempo });
      } else if (name === "state") result = await client.snapshot();
      else if (name === "shutdown") {
        await client.request(operations.stop);
        result = await client.request(operations.shutdown);
        terminal.close();
      } else if (name === "quit") {
        terminal.close();
        return;
      } else throw new Error("Use play, stop, tempo <BPM>, state, quit or shutdown");
      const { data: _data, ...state } = result;
      console.log(JSON.stringify(state));
    } catch (error) {
      console.error(error.message);
    }
  });
});
terminal.on("close", () => {
  client.close();
  if (host) {
    host.child.stdout.destroy();
    host.child.stderr.destroy();
    host.child.unref();
  }
});
