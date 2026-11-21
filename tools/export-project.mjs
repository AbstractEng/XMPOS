import "../examples/track-machines/register.ts";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeMidi, exchangePlan, loadCore } from "../packages/core/src/edits.ts";
import { saveExport, saveStreamExport } from "../packages/core/src/export-sink.ts";
import { openProject } from "../packages/core/src/project-io.ts";
import { exportWave } from "../packages/core/src/wave-export.ts";
import { fileExportSink } from "./lib/export-sink.mjs";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

const args = process.argv.slice(2),
  overwrite = args.at(-1) === "--overwrite";
if (overwrite) args.pop();
const [source, destination, mode, format, scene] = args;
if (
  args.length < 4 ||
  args.length > 5 ||
  !["scene", "song"].includes(mode) ||
  !["wav", "mid"].includes(format)
)
  throw new Error(
    "Usage: npm run export -- project.xmp.json output.wav scene|song wav|mid [scene-id] [--overwrite]",
  );
if ((await stat(source)).size > 96 * 1024 * 1024) throw new Error("Song exceeds 96 MiB");
if (resolve(source) === resolve(destination))
  throw new Error("Export destination must differ from project source");
const project = await openProject(await readFile(source, "utf8"));
const sink = fileExportSink(resolve(destination), overwrite);
if (format === "mid")
  await saveExport(sink, overwrite, async () =>
    encodeMidi(exchangePlan(project, mode, scene).document),
  );
else await saveStreamExport(sink, overwrite, exportWave(project, mode, scene));
console.log(`Export committed: ${format.toUpperCase()} (${mode}); no audio or MIDI device opened`);
