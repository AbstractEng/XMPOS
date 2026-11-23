import { MAX_SONG_BYTES, type Project } from "@xmp/core";
import xmpLogo from "../../../brand/xmp/assets/svg/xmp-orbit.svg?url";
import { faderToGain, gainLabel, gainToFader } from "../../../packages/core/src/fader.ts";
import { padNote } from "../../../packages/core/src/pad-scale.ts";
import { trackPads } from "../../../packages/core/src/pads.ts";
import { saveBundle } from "../../../packages/core/src/project-io.ts";
import { installInlineValues } from "./inline-values.ts";
import { songFileOptions } from "./song-file-view.ts";
import { SongFiles } from "./song-files.ts";
import { APP_VERSION } from "./version.ts";

import "./song-files.css";
import {
  swingFromPercent,
  swingLabel,
  swingPercent,
  TRIPLET_SWING,
} from "../../../packages/core/src/groove.ts";

import { ProjectSession } from "../../../packages/core/src/session.ts";
import { exportWave } from "../../../packages/core/src/wave-export.ts";
import { StudioAudio } from "./audio.ts";

import { installContextHelp } from "./context-help.ts";

import { installControlFocus, installErrorRecovery } from "./control-focus.ts";

import { installDrumKitPanel } from "./drum-kit-panel.ts";

import { installInstrumentPanel } from "./instrument-panel.ts";

import { installMixPanel } from "./mix-panel.ts";

import { parameterDisplay } from "./parameter-view.ts";

import { installPerformancePanel } from "./performance-panel.ts";

import { sampleThumbnail } from "./sample-thumbnail.ts";

import { installSequencerPanel } from "./sequencer-panel.ts";
import { loadWebStartupProject } from "./startup-project.ts";
import { saveProject } from "./storage.ts";

import { installViews } from "./views.ts";

import "./style.css";
import "./graphics.css";
import {
  decodeSampleWav,
  expandSong,
  installSample,
  loadCore,
  parameterRegistry,
  parameterValue,
  resizeClip,
  setParameter,
  toggleStep,
} from "../../../packages/core/src/edits.ts";
import { logError } from "./error-log.ts";
import { usage } from "./usage.ts";

// The C++ project core (WebAssembly) does every edit; it loads before the first.
await loadCore();
const startup = await loadWebStartupProject();

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing app root");
root.innerHTML = `
  <header class="topbar"><a class="brand" href="${import.meta.env.BASE_URL}" aria-label="XMP Studio home"><img src="${xmpLogo}" width="1130" height="436" alt=""><span>STUDIO</span></a><div class="preview">XMP OS <b>${APP_VERSION}</b></div><div class="connection"><i></i> Desktop simulator</div><a id="device-view" href="${import.meta.env.BASE_URL}" class="manual-link">Device view</a><a href="${import.meta.env.BASE_URL}manual/" target="_blank" rel="noopener" class="manual-link">User manual ↗</a><button id="help" aria-expanded="false" aria-controls="context-help">Help · F1</button></header>
  <main>
    <section class="projectbar"><div><div class="eyebrow">YOUR INSTRUMENT STARTS HERE</div><h1 id="project-title">First light</h1><p>A small groovebox. An open foundation.</p></div><div class="project-actions" data-help="projects"><a href="#sequencer-panel" class="instrument-link">Notes & automation ↓</a><a href="#instrument-panel" class="instrument-link">Instruments & recording ↓</a><button id="undo" disabled>Undo</button><button id="redo" disabled>Redo</button><button id="open">Open project</button><div id="song-file-options"></div><button id="save">Save project</button><button id="save-legacy">Save legacy copy</button></div></section>
    <section class="transport" aria-label="Transport" data-help="transport"><div class="transport-buttons"><button class="play primary" id="play">▶ Play</button><button id="stop" aria-label="Stop playback">■ Stop</button></div><label class="tempo">TEMPO <input id="bpm" type="number" min="30" max="300" value="112" aria-label="Tempo in BPM"><span>BPM</span></label><div class="swing-controls" data-help="swing"><label class="swing">SWING <input id="swing" type="range" min="50" max="75" step="0.1" value="50" aria-label="Swing percentage"><output id="swing-value">50% · Straight</output></label><div class="swing-presets"><button id="swing-straight">Straight</button><button id="swing-triplet">Triplet</button></div></div><div class="position" id="position">01 : 01</div><button id="enable">Enable audio</button></section>
    <nav id="view-nav" class="view-nav" aria-label="Studio views"><div class="view-tabs" role="tablist" aria-label="Studio views"><button data-view="play" role="tab" data-primary>Play</button><button data-view="sounds" role="tab" data-primary>Sounds</button><button data-view="pattern" role="tab" data-primary>Pattern</button><button data-view="perform" role="tab" data-primary>Perform</button><button data-view="mix" role="tab" data-primary>Mix</button><button data-view="all" role="tab">All panels</button></div><div class="encoder-controls"><button id="encoder-minus" aria-label="Virtual encoder decrease">−</button><span id="encoder-target">Focus a parameter</span><button id="encoder-plus" aria-label="Virtual encoder increase">+</button></div></nav>
    <section class="track-strip" aria-label="Tracks" data-help="pattern"><div class="track-heading"><div class="eyebrow">TRACKS</div><button id="expand">Add tracks & scenes</button></div><div id="tracks" class="tracks"></div></section>
    <div class="workspace"><section class="panel pads-panel" data-help="pads" aria-labelledby="pads-title"><div class="panel-head"><div><div class="eyebrow">INSTRUMENT 01</div><h2 id="pads-title">Pad sampler</h2></div><div id="kit-tools"></div></div><div id="pads" class="pad-grid"></div><div class="pad-footer"><span>Click a pad to play & select</span><span>KEYS 1–4 · Q–R · A–F · Z–V</span></div></section>
    <section class="panel sequence-panel" data-help="pattern" aria-labelledby="sequence-title"><div class="panel-head"><div><div class="eyebrow">PATTERN EDITOR</div><h2 id="sequence-title">Kick</h2></div><label class="length-label">STEPS <input id="length" aria-label="Pattern length" type="number" min="1" max="1024" step="1" value="16"></label></div><div class="sequence-tools"><span id="clip-name">Foundation</span><button id="create-clip" hidden>Create pattern</button><button id="clear">Clear pad pattern</button></div><div class="step-grid" id="steps"></div><div class="step-hint">Click to toggle · Shift-click an active step to edit velocity and probability</div><div class="expression" data-help="expression"><label>VELOCITY <input id="velocity" type="range" min="1" max="100" value="80" aria-label="Step velocity"><output id="velocity-value">80%</output></label><label>PROBABILITY <input id="probability" type="range" min="0" max="100" value="100" aria-label="Step probability"><output id="probability-value">100%</output></label></div><div class="sample-row" data-help="samples"><div><div class="eyebrow">SELECTED SOUND</div><strong id="sample-name">Kick</strong></div><button id="import">Import WAV</button></div><div class="slice-controls" data-help="samples"><label>START FRAME <input id="slice-start" type="number" min="0" value="0" aria-label="Slice start frame"></label><label>END FRAME <input id="slice-end" type="number" min="1" value="1" aria-label="Slice end frame"></label><button id="slice-apply">Apply slice</button></div><p class="small">Original demo sounds included. Shared samples are stored once in portable projects.</p></section></div>
    <section id="performance-panel" class="panel instrument-panel" data-help="performance"></section>
    <section id="sequencer-panel" class="panel instrument-panel" data-help="sequencer"></section>
    <section id="instrument-panel" class="panel instrument-panel" data-help="instruments"></section>
    <div class="bottom-workspace"><section class="panel scenes-panel" data-help="scenes"><div class="panel-head"><div><div class="eyebrow">PERFORMANCE</div><h2>Scenes</h2></div><span class="small">Launch on the next bar</span></div><div class="scenes" id="scenes"></div></section><section class="panel mixer" data-help="mixer"><div class="panel-head"><div><div class="eyebrow">OUTPUT</div><h2>Mix & bounce</h2></div><button id="mute" aria-pressed="false">Mute drums</button></div><label class="master">MASTER <input id="master" type="range" min="0" max="100" value="55" aria-label="Master volume"><output id="master-value">55%</output></label><label class="master">TRACK GAIN <input id="track-gain" type="range" min="0" max="100" value="80" aria-label="Track gain"><output id="track-gain-value">80%</output></label><label class="master">GAIN EFFECT <input id="effect-gain" type="range" min="0" max="100" value="50" aria-label="Effect gain"><output id="effect-gain-value">50%</output></label><button id="export" class="bounce">↓ Export scene as WAV</button><div id="mix-detail"></div></section></div>
    <footer><span id="status" role="status" aria-live="polite">Loading local project…</span><span id="audio-status">Audio off</span><span>Local projects · No hardware connection</span></footer>
  </main><section id="error-dialog" class="error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="error-title" aria-describedby="error-message" hidden><h2 id="error-title">Could not complete that action</h2><p id="error-message"></p><button id="error-close">Dismiss error</button></section><section id="context-help" class="context-help" data-help-panel role="dialog" aria-modal="false" aria-labelledby="help-title" aria-describedby="help-body" hidden><div class="help-heading"><span class="eyebrow">AT YOUR FINGERTIPS</span><button id="help-close" aria-label="Close help">Close · Esc</button></div><h2 id="help-title"></h2><p id="help-body"></p><p class="small">Focus a control, then press F1. Your pattern stays as you left it.</p></section><input type="file" id="project-file" accept=".xmpsong,.json,.xmp.json" hidden><input type="file" id="sample-file" accept=".wav,audio/wav,audio/x-wav" hidden>
`;
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element ${id}`);
  return el as T;
}
const session = new ProjectSession(startup.project, true);
const songFiles = new SongFiles(session);
let project = session.project;
let selectedTrackId = project.tracks[0]?.id ?? "drums";
let sceneId = project.scenes[0]?.id ?? "scene-0";
let selectedPad = 0;
let selectedStep = 0;
let stepDrawMode = false;
let queuedScene: string | undefined;
let saveTimer: ReturnType<typeof setTimeout>;
let saveChain = Promise.resolve();
const audio = new StudioAudio();
window.setInterval(() => usage.state("studio", audio.playing, audio.recording), 500);
const controlFocus = installControlFocus(document, status);
const errorRecovery = installErrorRecovery(document, controlFocus);
const keyRows = ["1234", "qwer", "asdf", "zxcv"];
const padOrder = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
const keys = keyRows.join("");
function status(message: string) {
  element("status").textContent = message;
}
function currentClip() {
  const scene = project.scenes.find((scene) => scene.id === sceneId);
  const track = project.tracks.find((track) => track.id === selectedTrackId);
  const clip = track?.clips.find((clip) => clip.id === scene?.clips[track.id]);
  if (!track) throw new Error("No selected track");
  return {
    track,
    clip: clip ?? {
      id: "empty-slot",
      name: "Empty slot — create a pattern to edit",
      length: 16 as const,
      steps: [],
    },
    missing: !clip,
  };
}
function mutate(change: (next: Project) => Project | undefined) {
  try {
    if (session.edit(change)) refreshProject();
  } catch (error) {
    status(logError("Edit rejected", error));
    draw();
  }
}
function refreshProject() {
  project = session.project;
  if (!project.tracks.some((t) => t.id === selectedTrackId))
    selectedTrackId = project.tracks[0]?.id ?? "";
  audio.setProject(project);
  draw();
  autosave();
}
function autosave() {
  clearTimeout(saveTimer);
  const saveRevision = session.revision;
  const savingSession = session;
  status(savingSession.dirty ? "Unsaved changes" : "Saved on this computer");
  saveTimer = setTimeout(() => {
    saveChain = saveChain
      .catch(() => {})
      .then(() => savingSession.save({ save: saveProject }))
      .then(() => {
        if (session === savingSession && session.revision === saveRevision)
          status(session.dirty ? "Unsaved changes" : "Saved on this computer");
      })
      .catch(() => {
        if (session === savingSession)
          status(session.error ?? "Local save failed — download a portable copy");
      });
  }, 400);
}
function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
let mixPanel: ReturnType<typeof installMixPanel> | undefined;
let performancePanel: ReturnType<typeof installPerformancePanel> | undefined;
let sequencerPanel: ReturnType<typeof installSequencerPanel> | undefined;
let instrumentPanel: ReturnType<typeof installInstrumentPanel> | undefined;
function draw() {
  if (root) {
    root.dataset.projectRevision = String(session.revision);
    root.dataset.undoDepth = String(session.historyDepth);
    root.dataset.redoDepth = String(session.redoDepth);
  }
  const { track, clip, missing } = currentClip();
  element<HTMLButtonElement>("create-clip").hidden = !missing;
  for (const control of ["clear", "length"]) element<HTMLButtonElement>(control).disabled = missing;
  element<HTMLButtonElement>("expand").disabled =
    project.tracks.length === 8 && project.scenes.length === 16;
  element("project-title").textContent = project.name;
  element("tracks").innerHTML = project.tracks
    .map(
      (track, index) =>
        `<button data-primary data-track="${track.id}" class="track ${track.id === selectedTrackId ? "selected" : ""}" aria-pressed="${track.id === selectedTrackId}"><small>${String(index + 1).padStart(2, "0")}</small> ${escapeHtml(track.name)}${track.muted ? " · MUTED" : ""}</button>`,
    )
    .join("");
  for (const [control, id] of [
    ["track-gain", `track.${track.id}.gain`],
    ["effect-gain", `track.${track.id}.effect.gain`],
  ] as const) {
    const value = parameterDisplay(project, id);
    element<HTMLInputElement>(control).value = String(
      (control === "track-gain" ? gainToFader(value.value) : value.value) * 100,
    );
    element(`${control}-value`).textContent =
      control === "track-gain" ? gainLabel(value.value) : value.text;
  }
  element<HTMLInputElement>("bpm").value = String(project.bpm);
  element<HTMLInputElement>("swing").value = String(swingPercent(project.swing));
  element("swing-value").textContent = swingLabel(project.swing);
  element<HTMLInputElement>("master").value = String(
    gainToFader(parameterValue(project, "master.gain")) * 100,
  );
  element("master-value").textContent = gainLabel(parameterValue(project, "master.gain"));
  element("pads").innerHTML = padOrder
    .map(
      (pad, index) =>
        `<button class="pad ${pad === selectedPad ? "selected" : ""}" data-pad="${pad}" data-pad-bank="${Math.floor(pad / 4)}" aria-label="Play pad ${pad + 1} ${escapeHtml(trackPads(project, selectedTrackId)[pad]?.name ?? "")}" aria-pressed="${pad === selectedPad}"><span class="pad-index">${String(pad + 1).padStart(2, "0")}</span><svg class="pad-waveform" viewBox="0 0 128 28" aria-hidden="true" focusable="false"><path d="${sampleThumbnail(project.samples.find((sample) => sample.id === trackPads(project, selectedTrackId)[pad]?.sampleId)?.pcm ?? [])}"/></svg><strong>${escapeHtml(trackPads(project, selectedTrackId)[pad]?.name ?? "")}</strong><span class="pad-key">${keys[index]?.toUpperCase()}</span></button>`,
    )
    .join("");
  element("sequence-title").textContent =
    trackPads(project, selectedTrackId)[selectedPad]?.name ?? "Pad";
  element("clip-name").textContent = clip.name;
  element<HTMLSelectElement>("length").value = String(clip.length);
  element("steps").innerHTML = Array.from({ length: clip.length }, (_, step) => {
    const active = clip.steps.some((event) => event.pad === selectedPad && event.step === step);
    return `<button data-primary class="step ${active ? "active" : ""} ${step === selectedStep ? "editing" : ""}" data-step="${step}" aria-label="Step ${step + 1}" aria-pressed="${active}"><span>${String(step + 1).padStart(2, "0")}</span><i></i></button>`;
  }).join("");
  const event = clip.steps.find(
    (event) => event.pad === selectedPad && event.step === selectedStep,
  );
  for (const prop of ["velocity", "probability"] as const) {
    element<HTMLInputElement>(prop).disabled = !event;
    element<HTMLInputElement>(prop).value = String(
      (event?.[prop] ?? (prop === "velocity" ? 0.8 : 1)) * 100,
    );
    element(`${prop}-value`).textContent =
      `${Math.round((event?.[prop] ?? (prop === "velocity" ? 0.8 : 1)) * 100)}%`;
  }
  const sample = project.samples.find(
    (sample) => sample.id === trackPads(project, selectedTrackId)[selectedPad]?.sampleId,
  );
  element("sample-name").textContent = sample?.name ?? "Unknown sample";
  const pad = trackPads(project, selectedTrackId)[selectedPad];
  element<HTMLInputElement>("slice-start").value = String(pad?.slice?.start ?? 0);
  element<HTMLInputElement>("slice-end").value = String(pad?.slice?.end ?? sample?.pcm.length ?? 1);
  element("scenes").innerHTML = project.scenes
    .map(
      (scene, i) =>
        `<button data-scene="${scene.id}" class="scene ${scene.id === sceneId ? "selected" : ""} ${scene.id === queuedScene ? "queued" : ""}" aria-pressed="${scene.id === sceneId}"><small>${String(i + 1).padStart(2, "0")}</small><strong>${escapeHtml(scene.name)}</strong><span>${scene.id === queuedScene ? "QUEUED" : scene.id === sceneId ? "SELECTED" : "LAUNCH"}</span></button>`,
    )
    .join("");
  element("mute").setAttribute("aria-pressed", String(track.muted));
  element("mute").textContent = track.muted ? "Unmute track" : "Mute track";
  element<HTMLButtonElement>("undo").disabled = !session.canUndo;
  element<HTMLButtonElement>("redo").disabled = !session.canRedo;
  element<HTMLInputElement>("track-gain").dataset.parameter = `track.${track.id}.gain`;
  element<HTMLInputElement>("track-gain").dataset.track = track.id;
  element<HTMLInputElement>("effect-gain").dataset.parameter = `track.${track.id}.effect.gain`;
  element<HTMLInputElement>("effect-gain").dataset.track = track.id;
  element<HTMLInputElement>("master").dataset.parameter = "master.gain";
  mixPanel?.draw();
  instrumentPanel?.draw();
  performancePanel?.draw();
  sequencerPanel?.draw();
  updateTransport();
}
function updateTransport() {
  element("play").textContent = audio.playing ? "▶ Playing" : "▶ Play";
  element("play").setAttribute("aria-pressed", String(audio.playing));
  element("audio-status").textContent =
    audio.state === "running"
      ? `${audio.sampleRate / 1000} kHz · ${audio.lateSteps} missed steps`
      : "Audio off";
  element("enable").textContent = audio.state === "running" ? "Audio enabled" : "Enable audio";
}
audio.onMidi = () => {
  const event = audio.midiTrace.at(-1);
  if (event)
    element("midi-preview").textContent =
      `Virtual MIDI ${event.kind} · note ${event.note} · channel ${event.channel} · no physical output`;
};
audio.onState = updateTransport;
audio.onStep = (absolute, scene) => {
  if (absolute >= 0) sequencerPanel?.observe(absolute);
  if (absolute >= 0 && scene !== sceneId) {
    sceneId = scene;
    queuedScene = undefined;
    selectedStep = 0;
    draw();
  }
  const length = currentClip().clip.length;
  for (const button of element("steps").querySelectorAll<HTMLElement>("[data-step]"))
    button.classList.toggle(
      "playhead",
      absolute >= 0 &&
        Number(button.dataset.step) ===
          (audio.performanceSnapshot
            ? audio.performanceSnapshot.step -
              (audio.performanceSnapshot.anchors[selectedTrackId] ?? 0)
            : absolute) %
            length,
    );
  element("position").textContent =
    absolute < 0
      ? "01 : 01"
      : `${String(Math.floor(absolute / 16) + 1).padStart(2, "0")} : ${String((absolute % 16) + 1).padStart(2, "0")}`;
  updateTransport();
};
const heldVoices = new Map<number, number>();
const pressedPads = new Set<number>();
async function playPad(pad: number, held = false) {
  try {
    await audio.enable();
    if (held && !pressedPads.has(pad)) return;
    selectedPad = pad;
    const note = padNote(pad, 0, "major", Number(element<HTMLInputElement>("play-note").value));
    const strength = Number(element<HTMLInputElement>("play-strength").value) / 100;
    if (sequencerPanel?.noteOn(pad, note, strength)) {
      selectedPad = pad;
      draw();
      return;
    }
    const id = audio.trigger(
      pad,
      Number(element<HTMLInputElement>("play-strength").value) / 100,
      undefined,
      selectedTrackId,
      padNote(pad, 0, "major", Number(element<HTMLInputElement>("play-note").value)),
      held ? 0 : Math.round(audio.sampleRate * 0.5),
    );
    if (id !== undefined) heldVoices.set(pad, id);
    draw();
  } catch {
    status("Audio could not start. Check your browser audio permissions.");
  }
}
function releasePad(pad: number) {
  sequencerPanel?.noteOff(pad);
  pressedPads.delete(pad);
  const id = heldVoices.get(pad);
  if (id !== undefined) audio.noteOff(id);
  heldVoices.delete(pad);
}
element("pads").onpointerdown = (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-pad]");
  if (button) {
    const pad = Number(button.dataset.pad);
    pressedPads.add(pad);
    void playPad(pad, true);
  }
};
window.addEventListener("pointerup", () => {
  for (const pad of [...pressedPads]) releasePad(pad);
});
window.addEventListener("pointercancel", () => {
  for (const pad of [...pressedPads]) releasePad(pad);
});
element("pads").onclick = (event) => {
  if (event.detail === 0) {
    const button = (event.target as Element).closest<HTMLElement>("[data-pad]");
    if (button) void playPad(Number(button.dataset.pad));
  }
};
element("steps").onclick = (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-step]");
  if (!button || currentClip().missing) return;
  selectedStep = Number(button.dataset.step);
  if (
    event.shiftKey ||
    (!stepDrawMode &&
      currentClip().clip.steps.some((s) => s.step === selectedStep && s.pad === selectedPad))
  ) {
    draw();
    return;
  }
  const { track, clip } = currentClip();
  mutate((next) => toggleStep(next, track.id, clip.id, selectedPad, selectedStep));
};
element("scenes").onclick = (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-scene]");
  const scene = button?.dataset.scene;
  if (!scene) return;
  audio.queueScene(scene);
  if (audio.playing) queuedScene = scene;
  else {
    sceneId = scene;
    selectedStep = 0;
  }
  draw();
};
element("enable").onclick = () => {
  void audio
    .enable()
    .then(updateTransport)
    .catch(() => status("Audio could not start"));
};
element("play").onclick = () => {
  void audio
    .enable()
    .then(() => {
      audio.start(sceneId, project.performance?.chain.length ? "song" : "scene");
      updateTransport();
    })
    .catch(() => status("Audio could not start"));
};
element("stop").onclick = () => {
  audio.stop();
  queuedScene = undefined;
  draw();
};
element("expand").onclick = () => mutate((next) => expandSong(next));
element("create-clip").onclick = () =>
  mutate((next) => {
    const track = next.tracks.find((track) => track.id === selectedTrackId),
      scene = next.scenes.find((scene) => scene.id === sceneId);
    if (!track || !scene || scene.clips[track.id]) return undefined;
    if (track.clips.length === 16)
      throw new Error(
        "This track already contains sixteen clips. Open a project with a free clip slot.",
      );
    let number = 0;
    while (track.clips.some((clip) => clip.id === `new-clip-${number}`)) number++;
    const clip = { id: `new-clip-${number}`, name: scene.name, length: 16 as const, steps: [] };
    track.clips.push(clip);
    scene.clips[track.id] = clip.id;
    return next;
  });
element("tracks").onclick = (event) => {
  const id = (event.target as Element).closest<HTMLElement>("[data-track]")?.dataset.track;
  if (id) {
    selectedTrackId = id;
    selectedStep = 0;
    draw();
  }
};
element("slice-apply").onclick = () =>
  mutate((next) => {
    const pad = trackPads(next, selectedTrackId)[selectedPad];
    if (pad) {
      pad.slice = {
        start: Number(element<HTMLInputElement>("slice-start").value),
        end: Number(element<HTMLInputElement>("slice-end").value),
      };
      delete pad.layers; // a slice plays one sound
    }
    return next;
  });
for (const [control, suffix] of [
  ["track-gain", "gain"],
  ["effect-gain", "effect.gain"],
] as const)
  element<HTMLInputElement>(control).oninput = (event) =>
    mutate((next) =>
      setParameter(
        next,
        `track.${selectedTrackId}.${suffix}`,
        control === "track-gain"
          ? faderToGain(Number((event.target as HTMLInputElement).value) / 100)
          : Number((event.target as HTMLInputElement).value) / 100,
      ),
    );
element("undo").onclick = () => {
  if (session.undo()) refreshProject();
};
element("redo").onclick = () => {
  if (session.redo()) refreshProject();
};
element<HTMLInputElement>("bpm").onchange = (event) => {
  const bpm = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(bpm) && bpm >= 30 && bpm <= 300) mutate((next) => ({ ...next, bpm }));
  else {
    draw();
    status("Tempo must be between 30 and 300 BPM");
  }
};
for (const prop of ["swing", "master"] as const)
  element<HTMLInputElement>(prop)[prop === "master" ? "oninput" : "onchange"] = (event) =>
    mutate((next) =>
      prop === "master"
        ? setParameter(
            next,
            "master.gain",
            faderToGain(Number((event.target as HTMLInputElement).value) / 100),
          )
        : { ...next, swing: swingFromPercent(Number((event.target as HTMLInputElement).value)) },
    );
element("swing-straight").onclick = () => mutate((next) => ({ ...next, swing: 0 }));
element("swing-triplet").onclick = () => mutate((next) => ({ ...next, swing: TRIPLET_SWING }));
for (const prop of ["velocity", "probability"] as const)
  element<HTMLInputElement>(prop).oninput = (event) => {
    const value = Number((event.target as HTMLInputElement).value) / 100;
    const { track, clip } = currentClip();
    mutate((next) => {
      const target = next.tracks
        .find((item) => item.id === track.id)
        ?.clips.find((item) => item.id === clip.id)
        ?.steps.find((item) => item.pad === selectedPad && item.step === selectedStep);
      if (target) target[prop] = value;
      return next;
    });
  };
element<HTMLSelectElement>("length").onchange = (event) => {
  const { track, clip } = currentClip();
  const length = Number((event.target as HTMLSelectElement).value);
  if (!Number.isInteger(length) || length < 1 || length > 1024) {
    draw();
    return;
  }
  mutate((next) => resizeClip(next, track.id, clip.id, length));
  selectedStep = Math.min(selectedStep, length - 1);
};
element("clear").onclick = () => {
  audio.panic();
  const { track, clip } = currentClip();
  mutate((next) => {
    const target = next.tracks
      .find((item) => item.id === track.id)
      ?.clips.find((item) => item.id === clip.id);
    if (target) {
      target.steps = target.steps.filter((event) => event.pad !== selectedPad);
      if (target.sequence)
        target.sequence.notes = target.sequence.notes.filter((n) => n.pad !== selectedPad);
    }
    return next;
  });
};
element("mute").onclick = () =>
  mutate((next) => {
    const track = next.tracks.find((track) => track.id === selectedTrackId);
    if (track) track.muted = !track.muted;
    return next;
  });
function download(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
element("save").onclick = async () => {
  try {
    download(await songFiles.save(), "application/json", "project.xmpsong");
    status("Portable project download requested");
  } catch (error) {
    status(`Could not package project: ${logError("invalid project", error)}`);
  }
};
element("save-legacy").onclick = async () => {
  try {
    download(await saveBundle(project), "application/json", "project.xmp.json");
    status("Legacy project downloaded · samples included");
  } catch (error) {
    status(logError("Could not save legacy copy", error));
  }
};
element("open").onclick = () => element<HTMLInputElement>("project-file").click();
element<HTMLInputElement>("project-file").onchange = async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_SONG_BYTES) throw new Error("Song exceeds 96 MiB");
    await songFiles.open(await file.text());
    audio.stop();
    queuedScene = undefined;
    project = session.project;
    sceneId = project.scenes[0]?.id ?? "scene-0";
    selectedTrackId = project.tracks[0]?.id ?? "drums";
    selectedStep = 0;
    refreshProject();
  } catch (error) {
    const message = `Could not open project: ${logError("invalid file", error)}`;
    status(message);
    if (!songFiles.missing.length) errorRecovery.show(message);
  } finally {
    drawSongFiles();
    input.value = "";
  }
};
element("import").onclick = () => element<HTMLInputElement>("sample-file").click();
element<HTMLInputElement>("sample-file").onchange = async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const revision = session.revision,
    pad = selectedPad,
    trackId = selectedTrackId;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("WAV must be under 16 MiB");
    const decoded = decodeSampleWav(new Uint8Array(await file.arrayBuffer()));
    if (session.revision !== revision)
      throw new Error("Project changed while importing sound; retry");
    mutate((next) => installSample(next, pad, file.name, decoded.sampleRate, decoded.pcm, trackId));
  } catch (error) {
    const message = `Could not import sample: ${logError("invalid WAV", error)}`;
    status(message);
    errorRecovery.show(message);
  } finally {
    input.value = "";
  }
};
element<HTMLButtonElement>("export").onclick = async () => {
  const button = element<HTMLButtonElement>("export");
  button.disabled = true;
  try {
    status("Rendering selected scene…");
    const chunks: BlobPart[] = [];
    for await (const bytes of exportWave(structuredClone(project), "scene", sceneId))
      chunks.push(bytes);
    download(new Blob(chunks, { type: "audio/wav" }), "audio/wav", "scene.wav");
    status("Scene WAV download requested");
  } catch (error) {
    status(`Scene export failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
};
installDrumKitPanel(document, {
  project: () => project,
  revision: () => session.revision,
  mutate,
  track: () => selectedTrackId,
});
instrumentPanel = installInstrumentPanel({
  project: () => project,
  track: () => selectedTrackId,
  selectTrack: (id) => {
    selectedTrackId = id;
    selectedStep = 0;
    draw();
  },
  pad: () => selectedPad,
  scene: () => sceneId,
  revision: () => session.revision,
  edit: (change) => mutate(change),
  status,
  panic: () => audio.panic(),
});
sequencerPanel = installSequencerPanel({
  project: () => project,
  track: () => selectedTrackId,
  clip: () => currentClip().clip.id,
  pad: () => selectedPad,
  scene: () => sceneId,
  revision: () => session.revision,
  edit: (change) => mutate(change),
  status,
  audio,
});
audio.onSchedule = (_position, at, absolute) => sequencerPanel?.tick(absolute, at);
audio.onStop = () => {
  sequencerPanel?.stop();
  performancePanel?.onStop();
};
performancePanel = installPerformancePanel({
  project: () => project,
  track: () => selectedTrackId,
  scene: () => sceneId,
  selectTrack: (id) => {
    selectedTrackId = id;
    selectedStep = 0;
    draw();
  },
  revision: () => session.revision,
  edit: (change) => mutate(change),
  status,
  audio,
  cancelScene: () => {
    queuedScene = undefined;
    draw();
  },
});
audio.onPerformance = () => performancePanel?.updateState();
mixPanel = installMixPanel({
  project: () => project,
  track: () => selectedTrackId,
  scene: () => sceneId,
  clip: () => currentClip().clip.id,
  revision: () => session.revision,
  edit: (change) => mutate(change),
  status,
  playing: () => audio.playing,
  download,
});
audio.onMeter = (meter) => mixPanel?.meter(meter);
const studioViews = installViews(document);
installInlineValues(document);
const stepNoteControls = document.getElementById("apply-note")?.closest(".compact-row");
if (stepNoteControls) document.getElementById("sequencer-panel")?.append(stepNoteControls);
const recordingTask = document.querySelector("#instrument-panel .record-panel");
if (recordingTask) {
  const details = document.createElement("details");
  details.className = "recording-task";
  const summary = document.createElement("summary");
  summary.textContent = "Record or import a take";
  details.append(summary);
  recordingTask.before(details);
  details.append(recordingTask);
}
const patternTools = document.createElement("div");
patternTools.className = "sequence-tools";
patternTools.innerHTML =
  '<button id="step-select-tool" aria-pressed="true">Select</button><button id="step-draw-tool" aria-pressed="false">Draw</button><button id="step-delete-hit">Delete selected hit</button>';
element("steps").before(patternTools);
const patternImport = element("import");
element("clear").before(patternImport);
element("step-select-tool").onclick = () => {
  stepDrawMode = false;
  element("step-select-tool").setAttribute("aria-pressed", "true");
  element("step-draw-tool").setAttribute("aria-pressed", "false");
};
element("step-draw-tool").onclick = () => {
  stepDrawMode = true;
  element("step-select-tool").setAttribute("aria-pressed", "false");
  element("step-draw-tool").setAttribute("aria-pressed", "true");
};
element("step-delete-hit").onclick = () => {
  const { track, clip } = currentClip();
  if (clip.steps.some((s) => s.step === selectedStep && s.pad === selectedPad))
    mutate((p) => toggleStep(p, track.id, clip.id, selectedPad, selectedStep));
};
const hint = document.querySelector(".step-hint");
if (hint)
  hint.textContent =
    "Select a hit to inspect it; Draw toggles hits. Delete removes the selected hit.";
const clipDetails = document.getElementById("perf-grid")?.closest("details");
if (clipDetails) {
  clipDetails.open = true;
  document
    .getElementById("performance-panel")
    ?.insertBefore(clipDetails, document.getElementById("perf-state"));
}
// Keep advanced editors reachable without displacing the current musical surface.
const foldBody = (root: HTMLElement | null, title: string, keep: Element[] = []) => {
  if (!root) return;
  const body = document.createElement("details"),
    summary = document.createElement("summary");
  body.className = "workspace-details";
  summary.textContent = title;
  body.append(summary);
  for (const child of [...root.children])
    if (!child.classList.contains("panel-head") && !keep.includes(child)) body.append(child);
  root.append(body);
};
foldBody(document.getElementById("sequencer-panel"), "Notes, expression, locks & automation");
foldBody(document.getElementById("performance-panel"), "Song chain, routing & macros", [
  ...document.querySelectorAll("#perf-actions, #perf-state"),
  ...(clipDetails ? [clipDetails] : []),
]);
const scenePanel = document.querySelector<HTMLElement>(".scenes-panel");
foldBody(scenePanel, "Launch complete scenes");
const prepareWorkspace = () => {
  if (studioViews.current() === "perform") {
    const enable = document.getElementById("perf-enable") as HTMLButtonElement | null;
    if (enable && !enable.disabled && !enable.hidden) enable.click();
  }
  if (studioViews.current() === "mix") {
    const enable = document.getElementById("mix-enable") as HTMLButtonElement | null;
    if (enable && !enable.disabled && !enable.hidden) enable.click();
  }
};
document.getElementById("view-nav")?.addEventListener("click", (event) => {
  if ((event.target as Element).closest("[data-view]")) prepareWorkspace();
});
prepareWorkspace();
for (const id of [
  "enable",
  "play",
  "stop",
  "length",
  "clear",
  "import",
  "sample-browser",
  "machine-type",
  "master",
  "mute",
  "track-gain",
])
  element(id).setAttribute("data-primary", "");
const turnEncoder = (delta: number) => {
  controlFocus.turn(delta, (id, change) =>
    mutate((p) =>
      setParameter(
        p,
        id,
        Math.max(
          0,
          Math.min(
            1,
            parameterValue(p, id) +
              change *
                (parameterRegistry(p).find((parameter) => parameter.id === id)?.step ?? 0.01),
          ),
        ),
      ),
    ),
  );
  element("encoder-target").textContent = controlFocus.parameter() ?? "Focus a parameter";
};
element("encoder-minus").onclick = () => turnEncoder(-1);
element("encoder-plus").onclick = () => turnEncoder(1);
document.addEventListener("focusin", () => {
  element("encoder-target").textContent = controlFocus.parameter() ?? "Focus a parameter";
});
installContextHelp(document, controlFocus);
window.addEventListener("keydown", (event) => {
  if (
    (event.target as HTMLElement).closest?.("[data-help-panel]") ||
    event.repeat ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    /INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY/.test((event.target as HTMLElement).tagName)
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    element(audio.playing ? "stop" : "play").click();
    return;
  }
  const index = keys.indexOf(event.key.toLowerCase());
  const pad = padOrder[index];
  if (index >= 0 && pad !== undefined) {
    event.preventDefault();
    pressedPads.add(pad);
    void playPad(pad, true);
  }
});
window.addEventListener("keyup", (event) => {
  const index = keys.indexOf(event.key.toLowerCase()),
    pad = padOrder[index];
  if (pad !== undefined) releasePad(pad);
});
window.addEventListener("blur", () => {
  sequencerPanel?.stop();
  audio.panic?.();
  heldVoices.clear();
  pressedPads.clear();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && audio.playing) {
    audio.stop();
    queuedScene = undefined;
    draw();
    status("Playback stopped while the tab is hidden");
  }
});
status(
  startup.recovered
    ? "Recovered previous valid save; current damaged snapshot was retained"
    : startup.firstVisit
      ? "Night Shift ready · press Play to hear the song"
      : "Restored local project",
);
audio.setProject(project);
draw();
drawSongFiles();

// Finish active passes and flush the current edit before leaving the detail editor.
element("device-view").onclick = async (event) => {
  event.preventDefault();
  audio.stop();
  clearTimeout(saveTimer);
  try {
    await session.save({ save: saveProject });
    location.assign(import.meta.env.BASE_URL);
  } catch (error) {
    status(logError("Save failed; keep a portable copy before switching views", error));
  }
};

function drawSongFiles() {
  const target = document.getElementById("song-file-options");
  if (!target) return;
  target.innerHTML = songFileOptions(songFiles);
  element<HTMLInputElement>("song-package-samples").onchange = (e) => {
    songFiles.packageSamples = (e.target as HTMLInputElement).checked;
    drawSongFiles();
  };
  const relink = document.getElementById("song-relink");
  if (relink) relink.onclick = () => element<HTMLInputElement>("song-missing-files").click();
  element<HTMLInputElement>("song-missing-files").onchange = async (e) => {
    try {
      await songFiles.relink(Array.from((e.target as HTMLInputElement).files ?? []));
      audio.stop();
      project = session.project;
      sceneId = project.scenes[0]?.id ?? "scene-0";
      selectedTrackId = project.tracks[0]?.id ?? "drums";
      refreshProject();
      status("Project opened · samples located");
    } catch (error) {
      status(logError("Could not locate samples", error));
    } finally {
      drawSongFiles();
    }
  };
}
