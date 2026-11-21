import type { Pad, Project } from "./index.ts";
import { supportsProjectExtension } from "./project-extensions.ts";

// Project format 7's kits: a track may hold its own 16 pads; tracks without
// one play the project's pads.
export function trackPads(project: Project, trackId: string | undefined): Pad[] {
  return project.tracks.find((t) => t.id === trackId)?.pads ?? project.pads;
}
// Whether a pad plays a sample: as its own sound or in a layer (format 8).
function padPlays(pad: Pad, sampleId: string): boolean {
  return pad.sampleId === sampleId || !!pad.layers?.some((l) => l.samples.includes(sampleId));
}
// Whether any pad, in the project's bank or a track's kit, plays a sample.
export function sampleInUse(project: Project, sampleId: string): boolean {
  // Opaque state may refer to any project-pool sound. An older editor cannot
  // infer those references and must not garbage-collect them on a sound edit.
  if (
    Object.entries(project.extensions ?? {}).some(
      ([id, e]) => !supportsProjectExtension(id, e.version),
    ) ||
    project.tracks.some(
      (track) =>
        track.machine &&
        (track.machine.version !== 1 ||
          !["xmp.sampler", "xmp.subtractive", "xmp.midi"].includes(track.machine.id)),
    )
  )
    return true;
  return (
    project.pads.some((p) => padPlays(p, sampleId)) ||
    project.tracks.some((t) => t.pads?.some((p) => padPlays(p, sampleId)))
  );
}
