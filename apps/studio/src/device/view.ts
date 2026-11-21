import { machineChosen } from "@xmp/core";
import xmpLogo from "../../../../brand/xmp/assets/svg/xmp-orbit.svg?url";
import { machines } from "../../../../packages/core/src/machines.ts";
import { padNote, rootPitch } from "../../../../packages/core/src/pad-scale.ts";
import { trackPads } from "../../../../packages/core/src/pads.ts";
import { cc0Kits, originalKits } from "../bundled-drum-kits.ts";
import { midiRoutingView } from "../midi-routing-view.ts";
import { defaultSongFileView, songFileOptions } from "../song-file-view.ts";
import type { SongFileView } from "../song-files.ts";
import type { DeviceController } from "./controller.ts";
import { menuPad, menuPages, type PanelButton, padOrder, slotCoordinates } from "./navigation.ts";
import { workbenchContent, workbenchOverlay, workbenchQlinks } from "./workbench-view.ts";

export const html = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const action = (id: string, label: string, attributes = "") =>
  `<button data-action="${id}" ${attributes}>${label}</button>`;
function front(id: PanelButton, label: string, sub = "", on = false) {
  return `<button class="front-key ${on ? "lit" : ""}" data-panel="${id}" aria-label="${html(label)}" aria-pressed="${on}"><strong>${label}</strong>${sub ? `<small>${sub}</small>` : ""}</button>`;
}
export const qlinks = workbenchQlinks;
export function padLabel(c: DeviceController, pad: number) {
  if (c.nav.page === "menu") return menuPages[menuPad(pad)]?.name ?? "";
  // The machine choice: pads 1-4 (also while changing a track's machine).
  if (c.workbench.machinePicker || (c.nav.page === "sound" && !machineChosen(c.track)))
    return ["Kit", "Sampler", "Synth", "MIDI"][pad] ?? "";
  if (c.nav.page === "clips") {
    const at = slotCoordinates(c.nav.bank, pad),
      t = c.project.tracks[at.track],
      s = c.project.scenes[at.scene];
    if (!t || !s) return "Unavailable";
    return t.clips.find((clip) => clip.id === s.clips[t.id])?.name ?? "Stop / empty";
  }
  if (c.nav.page === "scenes") return c.project.scenes[pad]?.name ?? "";
  if (["track", "mix", "mute"].includes(c.nav.page)) return c.project.tracks[pad]?.name ?? "";
  if (c.nav.page === "steps")
    return `Step ${Math.floor(c.step / 16) * 16 + padOrder.indexOf(pad) + 1}`;
  return soundLabel(c, pad);
}
export function soundLabel(c: DeviceController, pad: number) {
  if (c.workbench.pitched) {
    const note = padNote(pad, c.octave, c.scale, rootPitch(c.root));
    return `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][note % 12]}${Math.floor(note / 12) - 1}`;
  }
  return trackPads(c.project, c.track.id)[pad]?.name ?? "";
}
function content(c: DeviceController, files: SongFileView) {
  const p = c.project;
  const improved = workbenchContent(c);
  if (improved !== undefined) return improved;
  switch (c.nav.page) {
    case "clips": {
      const top = slotCoordinates(c.nav.bank, 12);
      return `<div class="screen-toolbar"><span>Bank ${"ABCDEFGH"[c.nav.bank]} · tracks ${top.track + 1}–${top.track + 4} · scenes ${top.scene + 1}–${top.scene + 4}</span>${action("edit-clip", c.clip ? "Edit focused clip" : "Create focused clip")}</div><div class="clip-head">${Array.from({ length: 4 }, (_, i) => `<span>${html(p.tracks[top.track + i]?.name ?? "Unavailable")}</span>`).join("")}</div><div class="clip-matrix">${padOrder
        .map((pad) => {
          const at = slotCoordinates(c.nav.bank, pad),
            track = p.tracks[at.track],
            scene = p.scenes[at.scene],
            clip = track?.clips.find((clip) => clip.id === scene?.clips[track.id]);
          return `<button data-slot="${pad}" class="clip-cell ${c.nav.cursor === pad ? "focused" : ""} ${clip ? "filled" : "empty"}" ${!track || !scene ? "disabled" : ""}><span>PAD ${pad + 1} · ${html(scene?.name)}</span><strong>${html(clip?.name ?? "Stop / empty")}</strong><small>${clip ? `${clip.length / 4} beats · ${clip.steps.length + (clip.sequence?.notes.length ?? 0)} notes` : "Press encoder to create"}</small></button>`;
        })
        .join("")}</div>`;
    }
    case "menu":
      return `<h2>Go to a page</h2><div class="mode-grid">${menuPages.map((item, i) => action(`page:${item.page}`, `<small>PAD ${i + 1}</small><strong>${item.name}</strong>`, `class="${c.menuCursor === i ? "focused" : ""}"`)).join("")}</div>`;
    case "play":
      return `<div class="screen-toolbar"><h2>${html(c.track.name)} · ${html(machines.get(c.track.machine)?.name ?? c.track.machine?.id ?? "Unavailable machine")}</h2>${action("page:steps", "Edit pattern")}</div><div class="sound-matrix">${padOrder.map((pad) => `<button data-sound="${pad}" class="${c.nav.pad === pad ? "focused" : ""}"><small>PAD ${pad + 1}</small><strong>${html(soundLabel(c, pad))}</strong></button>`).join("")}</div><p class="screen-note">Browser: fixed velocity, no pressure. ${c.record ? "Additive recording armed / active. STOP commits captured hits." : "16 LEVEL opens Steps; REC → PLAY START captures a pass; OVER DUB adds to a playing clip."}</p>`;
    case "steps":
      return `<div class="screen-toolbar"><h2>${html(c.clip?.name ?? "New loop")} · pad ${c.nav.pad + 1}: ${html(soundLabel(c, c.nav.pad))}</h2><label>Sound <select id="device-sound">${trackPads(
        p,
        c.trackId,
      )
        .map(
          (_pad, i) =>
            `<option value="${i}" ${c.nav.pad === i ? "selected" : ""}>${i + 1} ${html(soundLabel(c, i))}</option>`,
        )
        .join(
          "",
        )}</select></label><label>Length <input id="device-length" type="number" min="1" max="1024" step="1" value="${c.clip?.length ?? 16}"></label></div>${!c.clip ? action("create-clip", "Create 16-step clip") : ""}<div class="device-steps">${Array.from(
        { length: 16 },
        (_, i) => {
          const step = Math.floor(c.step / 16) * 16 + i,
            active = c.clip?.steps.some((s) => s.step === step && s.pad === c.nav.pad);
          return `<button data-step="${step}" aria-label="Step ${step + 1}" aria-pressed="${Boolean(active)}" ${step >= (c.clip?.length ?? 16) ? "disabled" : ""}><span>${step + 1}</span><i>${active ? "ON" : "·"}</i></button>`;
        },
      ).join(
        "",
      )}</div><p class="screen-note">A–D select sixteen-step pages. A lit step plays the selected sound. UNDO restores edits.</p>`;
    case "track":
      return `<div class="screen-toolbar"><h2>Track & machine</h2><label>Track <select id="device-track">${p.tracks.map((t) => `<option value="${t.id}" ${t.id === c.trackId ? "selected" : ""}>${html(t.name)}</option>`).join("")}</select></label></div><label class="machine-select">Machine <select id="device-machine">${!machines.get(c.track.machine) ? `<option selected disabled>${html(c.track.machine?.id)} · unavailable</option>` : ""}${machines
        .list()
        .map(
          (m) =>
            `<option value="${m.id}" ${m.id === (c.track.machine?.id ?? "xmp.sampler") ? "selected" : ""}>${html(m.name)} · ${m.base}</option>`,
        )
        .join(
          "",
        )}</select></label>${midiRoutingView(p, c.trackId, "device-midi-destination")}<div class="track-picker">${p.tracks.map((t, i) => `<button data-track="${t.id}" class="${t.id === c.trackId ? "focused" : ""}"><small>PAD ${i + 1} · ${html(t.machine?.base ?? "audio")}</small><strong>${html(t.name)}</strong><span>${html(t.machine?.id ?? "xmp.sampler")}</span></button>`).join("")}</div><div class="screen-toolbar"><span>${c.track.pads ? "This track plays its own kit of 16 pads" : "This track plays the shared kit"}</span>${action("own-kit", c.track.pads ? "Use the shared kit" : "Give this track its own kit")}</div><p class="screen-note">Machine metadata supplies Q-Link parameter pages. Missing machines retain state and stay silent. Sounds and kits you load go to this track's own kit when it has one, else to the shared kit.</p>`;
    case "library": {
      const list = c.samples,
        start = Math.floor(c.libraryCursor / 6) * 6;
      return `<div class="screen-toolbar"><h2>Library · ${list.length} sounds</h2>${action("folder", "Choose Mac folder")}</div><div class="library-tools"><input id="device-search" aria-label="Search sample library" placeholder="Search every indexed folder…" value="${html(c.query)}"><label>Target pad <select id="device-sound">${trackPads(
        p,
        c.trackId,
      )
        .map(
          (pad, i) =>
            `<option value="${i}" ${c.nav.pad === i ? "selected" : ""}>${i + 1} ${html(pad.name)}</option>`,
        )
        .join("")}</select></label></div><div class="library-list">${
        list
          .slice(start, start + 6)
          .map(
            (item, i) =>
              `<button data-library="${start + i}" class="${start + i === c.libraryCursor ? "focused" : ""}"><strong>${html(item.name)}</strong><span>${html(item.folder)}</span><small>${Math.ceil(item.bytes / 1024)} KiB</small></button>`,
          )
          .join("") || "<p>No matching WAV files.</p>"
      }</div><div class="library-actions">${action("preview", "Audition · SHIFT + PLAY", c.busy ? "disabled" : "")}${action("assign", `Load to pad ${c.nav.pad + 1}`, c.busy || !list.length ? "disabled" : "")}<label>Kit <select id="device-kit"><option value="">Choose a kit…</option>${originalKits.map((k) => `<option value="${k.id}">${html(k.name)}</option>`).join("")}${cc0Kits.map((k) => `<option value="${k.id}">${html(k.name)}</option>`).join("")}</select></label></div><p class="screen-note">Library ≠ project pool. Mac folder WAVs are read on demand, kept available for this session, and never modified. Native device-volume browsing is planned.</p>`;
    }
    case "song":
      return `<div class="screen-toolbar"><h2>Song chain</h2><label>Scene <select id="device-scene">${p.scenes.map((s) => `<option value="${s.id}" ${s.id === c.sceneId ? "selected" : ""}>${html(s.name)}</option>`).join("")}</select></label>${action("add-scene", "Add scene")}</div><ol class="song-chain">${p.performance?.chain.map((part, i) => `<li><span>${i + 1}</span><strong>${html(p.scenes.find((s) => s.id === part.sceneId)?.name)}</strong><span>${part.repeats}×</span>${action(`remove-part:${part.id}`, "Remove")}</li>`).join("") || "<li>Add scenes to turn your loops into a song.</li>"}</ol><p class="screen-note">PLAY START starts the chain. PLAY also starts from the beginning in this preview. Clip and scene changes quantize to one bar. Detailed arrangement remains in Advanced Studio.</p>`;
    case "scenes":
      return `<h2>Launch a complete scene</h2><div class="sound-matrix">${padOrder.map((i) => `<button data-scene="${i}" class="${p.scenes[i]?.id === c.sceneId ? "focused" : ""}"><small>PAD ${i + 1}</small><strong>${html(p.scenes[i]?.name)}</strong></button>`).join("")}</div>`;
    case "mix":
    case "mute":
      return `<h2>${c.nav.page === "mix" ? "Track mixer" : "Track mutes"}</h2><div class="track-picker">${p.tracks.map((t, i) => `<button data-${c.nav.page === "mute" ? "mute" : "track"}="${t.id}" class="${t.id === c.trackId ? "focused" : ""}"><small>PAD ${i + 1}</small><strong>${html(t.name)}</strong><span>${t.muted ? "MUTED" : `${Math.round(t.volume * 100)}%`}</span></button>`).join("")}</div><p class="screen-note">Q-Link 1 controls the selected track's level. Q-Link 2 controls the master. These views share stable track identities.</p>`;
    case "project":
      return `<h2>${html(p.name)}</h2><div class="project-tools">${action("save", "Save portable project")}${action("open", c.projectOpenFailed ? "Choose another file" : "Open project")}${action("bounce", "Export current scene WAV")}${action("new", "New empty song")}</div>${songFileOptions(files)}<details class="legacy-project"><summary>Legacy format</summary>${action("save-legacy", "Save legacy copy")}</details><p class="screen-note">Autosave stays on this browser and origin. Save a portable copy before switching computers. Opening a project is undoable; starting a new song requires confirmation. No device or hardware connection is opened.</p>`;
  }
}
export function renderScreen(c: DeviceController, files: SongFileView = defaultSongFileView) {
  if (c.nav.page === "sample" && c.sampler)
    return '<main class="screen-content" data-page="sample" style="position:absolute;inset:0;padding:0;grid-area:1 / 1 / -1 / -1;width:1280px;height:800px"><canvas id="native-sampler" width="1280" height="800" aria-label="Native Sample touchscreen" style="position:absolute;inset:0;touch-action:none"></canvas><div id="native-sampler-controls" style="position:absolute;inset:0;pointer-events:none"></div></main>';
  const q = qlinks(c);
  return `<header class="screen-header">
    <img class="screen-logo" src="${xmpLogo}" width="88" height="34" alt="XMP">
    <div class="screen-identity"><button data-action="rename:project" class="project-name" title="${html(c.project.name)}">${html(c.project.name)}</button><strong>${html(c.nav.page.toUpperCase())} <button data-action="rename:track" title="${html(c.track.name)}">${html(c.track.name)}</button></strong></div>
    <small id="device-save-state" data-dirty="${c.session.dirty}" data-error="${!!c.session.error}">${html(c.saveStatus)}</small>
    <button data-action="menu-page" aria-label="Open pages">☰</button>
    <div class="device-time" id="device-clock">01 : 01</div><button data-value-key="tempo" data-value="${c.project.bpm}" data-min="30" data-max="300" data-increment="1" data-reset="112" data-unit=" BPM" aria-label="Edit Tempo">${c.project.bpm} BPM</button><span id="device-audio-state">${c.audio.playing ? "PLAYING" : "STOPPED"}</span><button data-action="help" aria-label="Current controls">?</button>
  </header><main class="screen-content" data-page="${c.nav.page}">${content(c, files)}</main><div class="screen-status" role="status">${html(c.nav.shift || c.workbench.shiftHelp ? "Shift + pads: choose sound/note · A–D: tracks 5–8 · Undo: redo · Menu: Browse" : c.message)}</div><footer class="screen-qlinks">${q.map((p, i) => `<button class="q-value" data-value-key="${html(p.key)}" data-value="${"raw" in p ? p.raw : p.unit === " steps" ? p.value * 16 : p.value * 100}" data-min="${p.min}" data-max="${p.max}" data-increment="${p.step}" data-reset="${"reset" in p ? p.reset : "raw" in p ? p.raw : p.unit === " steps" ? p.value * 16 : p.value * 100}" data-unit="${p.unit}" aria-label="Edit ${html(p.name)}" ${!p.key ? "disabled" : ""}><small>Q${i + 1} · ${c.nav.page === "steps" ? ["STEP", "NEW HITS", "TRACK", "SOUND"][c.nav.qPage] : c.nav.qPage % 2 ? "SOUND" : "TRACK"}</small><span>${html(p.name)}</span><strong>${html(p.display)}</strong></button>`).join("")}</footer>${workbenchOverlay(c)}`;
}
function renderLiveMk1Panel(c: DeviceController, screen: string) {
  const q = qlinks(c);
  const qPage = c.nav.qPage % (c.nav.page === "steps" ? 4 : 2);
  const banks = ["A", "B", "C", "D"]
    .map((bank, index) =>
      front(
        `bank-${bank.toLowerCase()}` as PanelButton,
        bank,
        "EFGH"[index],
        c.project.tracks.findIndex((track) => track.id === c.trackId) % 4 === index,
      ),
    )
    .join("");
  const pads = padOrder
    .map((pad) => {
      const selected =
        c.nav.page === "play" ? c.nav.pad === pad : c.nav.page === "clips" && c.nav.cursor === pad;
      const label = html(padLabel(c, pad));
      return `<button data-pad="${pad}" class="device-pad ${selected ? "selected" : ""}" aria-label="Pad ${pad + 1}: ${label}" title="${label}"><small>${pad + 1}</small><strong>${label}</strong></button>`;
    })
    .join("");
  const knobs = q
    .map(
      (parameter, index) =>
        `<label class="virtual-knob"><span>Q${index + 1}</span><input data-q="${index}" aria-label="Q-Link ${index + 1}: ${html(parameter.name)}" type="range" min="0" max="1" step="${c.nav.qPage === 0 && index === 3 ? 1 / 270 : 0.01}" value="${parameter.value}" ${parameter.name === "Unassigned" ? "disabled" : ""}><small>${html(parameter.name)}</small></label>`,
    )
    .join("");
  return `<div class="device-face" data-panel-profile="live-mk1">
    <section class="device-left">
      <div class="bank-keys">${banks}</div>
      <div class="performance-keys">
        ${front("note-repeat", "NOTE REPEAT", "FILL")}
        ${front("full-level", "FULL LEVEL", "HALF LEVEL", c.fullLevel)}
        ${front("16-level", "16 LEVEL")}
        ${front("erase", "ERASE")}
      </div>
      <div class="device-pad-grid">${pads}</div>
    </section>
    <section class="device-center">
      <div class="device-display-bezel">
        <div class="device-screen-frame">
          <div id="device-screen" data-logical-width="1280" data-logical-height="800">${screen}</div>
        </div>
      </div>
      <div class="device-controls" role="group" aria-label="Transport and shortcuts">
        ${front("shift", "SHIFT", c.nav.shift ? "NEXT CONTROL" : "", c.nav.shift)}
        ${front("menu", "MENU", "BROWSE")}
        ${front("main", "MAIN", "PLAY")}
        ${front("undo", "UNDO", "REDO")}
        ${front("copy", "COPY", "DELETE")}
        ${front("plus", "+")}
        ${front("tap", "TAP")}
        ${front("rec", "REC", "", c.record)}
        ${front("overdub", "OVER DUB", "", c.overdub)}
        ${front("stop", "STOP")}
        ${front("play", "PLAY", "", c.audio.playing)}
        ${front("play-start", "PLAY START")}
        ${front("minus", "−")}
      </div>
    </section>
    <aside class="device-right">
      <div class="q-link-panel">
        ${front("q-link", "Q-LINK", `PAGE ${qPage + 1}`)}
        <div class="q-link-leds" role="img" aria-label="Q-Link page ${qPage + 1}">
          ${Array.from({ length: 4 }, (_, index) => `<span class="${index === qPage ? "lit" : ""}" aria-hidden="true"></span>`).join("")}
        </div>
      </div>
      <div class="q-link-knobs">${knobs}</div>
      <div class="data-dial">
        <button data-action="dial-left" aria-label="Turn data dial counterclockwise">−</button>
        <button data-action="enter" aria-label="Press data dial">ENTER</button>
        <button data-action="dial-right" aria-label="Turn data dial clockwise">+</button>
      </div>
      <small>DATA DIAL</small>
    </aside>
  </div>`;
}

export function renderDevice(c: DeviceController, files: SongFileView = defaultSongFileView) {
  const base = import.meta.env.BASE_URL;
  const layout = document.body.classList.contains("show-hardware")
    ? "Show screen view"
    : "Show hardware layout";
  return `<header class="device-hostbar">
    <a class="device-logo" href="${base}" aria-label="XMP Device home"><img src="${xmpLogo}" width="1130" height="436" alt=""><span>DEVICE</span></a>
    <span>MPC Live Mk1 control profile · browser workflow preview</span>
    <nav>
      <button data-action="toggle-layout">${layout}</button>
      <a target="_blank" rel="noopener" href="${base}manual/#workspace">Workflow & button map</a>
      <a target="_blank" rel="noopener" href="${base}manual/">Manual</a>
      ${c.nav.page === "sample" ? '<button data-action="choose-take">Import WAV take</button>' : ""}
      <a id="advanced-studio" href="${base}?view=studio">Advanced Studio ↗</a>
    </nav>
  </header>
  <div class="device-chassis">
    ${renderLiveMk1Panel(c, renderScreen(c, files))}
    <footer class="device-hostnote">
      <span>Click SHIFT, then another control · keyboard Shift also works · pads: 1–4 / Q–R / A–F / Z–V</span>
      <span>No hardware connection · fixed browser velocity · <a target="_blank" rel="noopener" href="${base}manual/#limits">Prototype limits</a></span>
    </footer>
  </div>
  <input id="device-take-file" type="file" accept=".wav,audio/wav" hidden>
  <input id="device-folder" type="file" webkitdirectory multiple hidden>
  <input id="device-project-file" type="file" accept=".xmpsong,.json,.xmp.json" hidden>`;
}
