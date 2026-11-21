import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importPortable } from "../../packages/core/src/assets.ts";
import { nativeSongCapture } from "./song-target.mjs";
import { ownedScenarioDirectory, root, sha256 } from "./workspace.mjs";

const directory = ownedScenarioDirectory(process.argv[2]);
if (!directory?.includes("xmp-acceptance-")) throw new Error("Owned acceptance directory required");
const workspace = {
  directory,
  path: (name) => {
    if (!/^[a-z.-]+$/.test(name)) throw new Error("Invalid fixture filename");
    return resolve(directory, name);
  },
};
const project = await importPortable(readFileSync(workspace.path("portable.xmp.json"), "utf8"));
const capture = nativeSongCapture(project, "scene-0", workspace);
writeFileSync(workspace.path("reopened.json"), JSON.stringify(project));
writeFileSync(workspace.path("event-trace.json"), JSON.stringify(capture.events));
console.log(
  JSON.stringify({
    projectVersion: project.version,
    parameterVersion: project.parameterVersion,
    nativeBinaryHash: sha256(readFileSync(resolve(root, "build/native/xmp_song_render"))),
    profile: "mac-native-offline",
    physicalOperations: 0,
  }),
);
