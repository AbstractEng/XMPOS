import { dirname } from "node:path";
import { EngineClient } from "../acceptance/lib/engine-target.mjs";
import { ownedScenarioDirectory } from "../acceptance/lib/workspace.mjs";

const socket = process.argv[2];
ownedScenarioDirectory(dirname(socket));
const client = await EngineClient.connect(socket);
console.log(JSON.stringify({ connected: true, ...(await client.snapshot()) }));
const timer = setInterval(async () => {
  try {
    await client.snapshot();
  } catch {
    clearInterval(timer);
    client.close();
    process.exitCode = 1;
  }
}, 100);
process.on("SIGTERM", () => {
  clearInterval(timer);
  client.close();
});
