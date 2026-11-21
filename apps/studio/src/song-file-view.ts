import type { SongFileView } from "./song-files.ts";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
export const defaultSongFileView: SongFileView = { packageSamples: true, missing: [] };
export function songFileOptions(view: SongFileView) {
  return `<section class="song-file-options" aria-label="Song file options"><label><input id="song-package-samples" type="checkbox" ${view.packageSamples ? "checked" : ""}> Package samples with song</label><p>${view.packageSamples ? "Self-contained .xmpsong file. Project samples are included once; your full library stays on this computer." : "Smaller .xmpsong file. Other browsers and devices need matching samples in their local library."}</p>${view.missing.length ? `<p role="alert">Missing samples: ${view.missing.map((s) => escapeHtml(s.name)).join(", ")}. Your current song stays open.</p><button id="song-relink" data-action="relink-song">Locate missing samples (WAV)</button>` : ""}<input id="song-missing-files" type="file" accept=".wav,audio/wav,audio/x-wav" multiple hidden></section>`;
}
