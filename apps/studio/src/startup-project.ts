import type { Project } from "@xmp/core";
import { openProject } from "../../../packages/core/src/project-io.ts";
import demo from "./demo-night-shift.json";
import { loadProjectSnapshot, saveProjectText } from "./storage.ts";

type StartupProject = { project: Project; text: string; firstVisit: boolean; recovered: boolean };
async function savedProject(): Promise<StartupProject | undefined> {
  const saved = await loadProjectSnapshot();
  if (saved.project && saved.text !== undefined)
    return {
      project: saved.project,
      text: saved.text,
      recovered: saved.recovered,
      firstVisit: false,
    };
  return undefined;
}

// Only absence of a saved song selects the starter. Empty projects, recovered
// snapshots and future/invalid saves all keep the storage module's safeguards.
export async function loadWebStartupProject(): Promise<StartupProject> {
  const saved = await savedProject();
  if (saved) return saved;
  const response = await fetch(`${import.meta.env.BASE_URL}demo/${demo.file}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body)
    throw new Error("Could not load the Night Shift starter project. Reload to retry.");
  const bytes = new Uint8Array(demo.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > bytes.length) {
      await reader.cancel();
      throw new Error("Night Shift starter exceeds its verified size");
    }
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (offset !== demo.bytes || hash !== demo.sha256)
    throw new Error("Night Shift starter integrity check failed");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const project = await openProject(text);
  // Another tab may have saved real work while the starter was downloading.
  const arrived = await savedProject();
  if (arrived) return arrived;
  try {
    await saveProjectText(text);
  } catch (error) {
    const latest = await savedProject();
    if (latest) return latest;
    throw error;
  }
  return { project, text, recovered: false, firstVisit: true };
}
