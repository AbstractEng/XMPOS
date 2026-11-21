import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importPortable } from "../../packages/core/src/assets.ts";
import { LocalProjectStore } from "./project-store.mjs";
import { ownedScenarioDirectory } from "./workspace.mjs";

const directory = ownedScenarioDirectory(process.argv[2]);
if (!directory?.includes("xmp-acceptance-")) throw new Error("Owned acceptance directory required");
const workspace = {
  directory,
  path: (name) => {
    if (!/^[a-z.-]+$/.test(name)) throw new Error("Invalid fixture filename");
    return resolve(directory, name);
  },
};
const project = await importPortable(readFileSync(workspace.path("candidate.xmp.json"), "utf8"));
await new LocalProjectStore(workspace).prepare(project);
// Deliberately incomplete journal; the committed file is never touched.
writeFileSync(workspace.path("pending.xmp.json"), '{"interrupted":');
process.exit(77);
