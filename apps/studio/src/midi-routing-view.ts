import type { Project } from "../../../packages/core/src/index.ts";
import { midiDestination, midiDestinations } from "../../../packages/core/src/midi-routing.ts";

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#39;" })[c] ?? c,
  );
export function midiRoutingView(project: Project, trackId: string, id: string) {
  const source = project.tracks.find((t) => t.id === trackId);
  if (
    source?.machine?.id !== "xmp.midi" ||
    source.machine.version !== 1 ||
    source.machine.base !== "midi"
  )
    return "";
  const saved = source.machine.state.destination;
  const target = midiDestination(project.tracks, source);
  return `<label>MIDI destination <select id="${id}" aria-label="MIDI destination"><option value="" ${saved ? "" : "selected"}>None · event preview only</option>${saved && !target ? `<option value="${escapeHtml(saved)}" selected disabled>Unavailable · ${escapeHtml(saved)}</option>` : ""}${midiDestinations(
    project.tracks,
    source,
  )
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}" ${saved === t.id ? "selected" : ""}>${escapeHtml(t.name)} · ${t.machine?.id === "xmp.subtractive" ? "Subtractive synth" : "Pad sampler"}</option>`,
    )
    .join(
      "",
    )}</select></label><p class="screen-note small">${target ? `Internal output → ${escapeHtml(target.name)}. Source and destination levels/mutes both apply. Sampler routes follow clip pad numbers; Chromatic pad mode follows note pitch.` : saved ? "Destination unavailable; this route stays silent. Choose an installed synth or sampler track." : "Choose an instrument track to hear MIDI clips. No physical MIDI port is opened."}</p>`;
}
