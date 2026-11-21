import type { Project } from "./index.ts";
import { MAX_LOOP_PROJECT_FRAMES, MAX_LOOP_SAMPLE_FRAMES } from "./input.ts";

/** Opt in only when needed; never replace opaque state from a newer profile. */
export function withSampleProfile(project: Project): Project {
  const total = project.samples.reduce((n, sample) => n + sample.pcm.length, 0);
  const largest = Math.max(...project.samples.map((s) => s.pcm.length));
  if (total > MAX_LOOP_PROJECT_FRAMES || largest > MAX_LOOP_SAMPLE_FRAMES)
    throw new Error("Sampler memory budget exceeded");
  if (total <= 2000000 && largest <= 480000) return project;
  const existing = project.extensions?.["xmp.extended-samples"];
  if (existing && (existing.version !== 1 || Object.keys(existing.data).length))
    throw new Error("A newer sample profile must be preserved; use a supporting XMP build");
  return {
    ...project,
    extensions: {
      ...project.extensions,
      "xmp.extended-samples": { version: 1, required: true, data: {} },
    },
  };
}
