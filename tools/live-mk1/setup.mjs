import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { BUILDER_LAYERS, ensureBuilder, inspectDocker } from "./container.mjs";

const [mode = "doctor", ...args] = process.argv.slice(2);
if (
  !["doctor", "build"].includes(mode) ||
  (args.length && !(mode === "build" && args.length === 1 && args[0] === "--no-cache"))
)
  throw new Error("Usage: npm run live:setup -- doctor | build [--no-cache]; no hardware options");
const status = inspectDocker();
if (!status.ready) {
  console.error(status.reason);
  process.exitCode = 1;
} else if (mode === "doctor") {
  console.log(
    JSON.stringify({ ...status, layers: BUILDER_LAYERS, hardwareAccess: false }, null, 2),
  );
} else {
  const sourceHash = buildIdentity();
  const imageId = ensureBuilder(
    { builder: BUILDER_LAYERS.at(-1) },
    { noCache: args.includes("--no-cache") },
  );
  const directory = join(root, "reports/developer-setup");
  await mkdir(directory, { recursive: true });
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during Docker setup");
  const report = {
    sourceHash,
    imageId,
    layers: BUILDER_LAYERS,
    noCache: args.includes("--no-cache"),
    hardwareAccess: false,
  };
  await writeFile(join(directory, "docker.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ ...report, report: relative(root, join(directory, "docker.json")) }),
  );
}
