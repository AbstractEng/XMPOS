import { expandSong } from "../packages/core/src/edits.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { saveSong } from "../packages/core/src/project-io.ts";

// Detailed-editor journeys operate on an existing fixture; first-visit loading
// and starter persistence are exercised separately in web-startup-project.
export async function studioProjectSnapshot() {
  const project = expandSong(createDemoProject());
  return { project, text: await saveSong(project), recovered: false };
}
