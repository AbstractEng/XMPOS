// A Sampler's take (the Live's xmp::live::edit::keep_sampler): the whole sample
// played across the pads as notes (keys), or chopped at `points` into slices on
// pads 1..n. Sets the machine's mode. Other tracks are untouched.
import { chopBoundaries, cleanChop } from "./chop.ts";
import { installSample, manualSlices, ownKit } from "./edits.ts";
import type { Project } from "./index.ts";

export function keepSamplerTake(
  project: Project,
  trackId: string,
  name: string,
  rate: number,
  pcm: Float32Array,
  points: readonly number[],
  slices: boolean,
): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error("No track here");
  if (!pcm.length) throw new Error("Nothing recorded");
  if (track.machine && track.machine.id !== "xmp.sampler") throw new Error("Not a Sampler track");
  let next = installSample(ownKit(project, trackId), 0, name, rate, pcm, trackId);
  const starts = slices ? cleanChop(points, pcm.length) : [0];
  if (slices && starts.length > 1)
    next = manualSlices(next, 0, chopBoundaries(starts, pcm.length), trackId);
  const t = next.tracks.find((x) => x.id === trackId);
  const source = t?.pads?.[0];
  if (!t?.pads || !source) throw new Error("Sampler take not kept");
  t.pads = t.pads.map((pad, i) => {
    // Keys: every pad is the whole sample; slices: pads past the last slice too.
    const out = !slices || i >= starts.length ? { ...structuredClone(source), id: pad.id } : pad;
    if (slices && i >= starts.length) delete out.slice;
    out.playback = { mode: slices ? "one-shot" : "chromatic", rootNote: 48, chokeGroup: 0 };
    return out;
  });
  t.machine = {
    id: "xmp.sampler",
    base: "audio",
    version: 1,
    state: { mode: slices ? "slices" : "keys" },
  };
  return next;
}
