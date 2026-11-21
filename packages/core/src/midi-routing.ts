import { type Project, ProjectSchema } from "./index.ts";
import { MidiStateSchema, machines, type TrackMachine } from "./machines.ts";

interface RoutedTrack {
  id: string;
  machine?: TrackMachine;
}
export function midiDestinations<T extends RoutedTrack>(tracks: readonly T[], source: RoutedTrack) {
  if (machines.get(source.machine)?.id !== "xmp.midi") return [];
  return tracks.filter(
    (target) =>
      target.id !== source.id &&
      ["xmp.sampler", "xmp.subtractive"].includes(machines.get(target.machine)?.id ?? ""),
  );
}
export function midiDestination<T extends RoutedTrack>(tracks: readonly T[], source: RoutedTrack) {
  if (machines.get(source.machine)?.id !== "xmp.midi") return undefined;
  const { destination } = MidiStateSchema.parse(source.machine?.state);
  return midiDestinations(tracks, source).find((target) => target.id === destination);
}
export function setMidiDestination(
  project: Project,
  sourceId: string,
  destination?: string,
): Project {
  const next = ProjectSchema.parse(project);
  const source = next.tracks.find((track) => track.id === sourceId);
  if (!source?.machine || machines.get(source.machine)?.id !== "xmp.midi")
    throw new Error("Choose a built-in MIDI source track");
  if (
    destination !== undefined &&
    !midiDestinations(next.tracks, source).some((t) => t.id === destination)
  )
    throw new Error("Choose another track with the built-in synth or sampler");
  if (destination === undefined) delete source.machine.state.destination;
  else source.machine.state.destination = destination;
  return ProjectSchema.parse(next);
}
