import { machineChosen, type Project, samplerMode } from "@xmp/core";
import { parameterRegistry, parameterValue } from "../../../../packages/core/src/edits.ts";
import {
  PRESETS_PER_PAGE,
  synthPresetPages,
  synthPresets,
} from "../../../../packages/core/src/instrument-schema.ts";
import { machines } from "../../../../packages/core/src/machines.ts";
import { effectDefaults } from "../../../../packages/core/src/mix-schema.ts";
import {
  noteName,
  padNote,
  padRoots,
  padScales,
  rootPitch,
} from "../../../../packages/core/src/pad-scale.ts";
import { trackPads } from "../../../../packages/core/src/pads.ts";
import { chainBarRanges, conditions } from "../../../../packages/core/src/workflow.ts";
import { cc0Kits, originalKits } from "../bundled-drum-kits.ts";
import { errorLog } from "../error-log.ts";
import { midiRoutingView } from "../midi-routing-view.ts";
import type { DeviceController } from "./controller.ts";
import { menuPages, padOrder, slotCoordinates } from "./navigation.ts";
import {
  button as b,
  type ChopMethod,
  chopNames,
  escapeHtml as h,
  launchTimings,
  padMachines,
  valueButton as v,
} from "./workbench.ts";

function readParameter(p: DeviceController["project"], id: string) {
  const match = /^track\.([a-zA-Z0-9_-]+)\.(pan|send\.[01])$/.exec(id);
  if (match && !p.mix?.tracks[match[1] ?? ""]) return match[2] === "pan" ? 0.5 : 0;
  return parameterValue(p, id);
}

// The names the machine picker uses: the pad sampler is a Kit, or a Sampler when
// its pads play chromatically.
function machineLabel(track: Project["tracks"][number]) {
  const machine = machines.get(track.machine);
  if (machine?.id !== "xmp.sampler") return machine?.name ?? "Unknown machine";
  return samplerMode(track) ? "Sampler" : "Kit";
}
// The error log (error-log.ts): the latest failures, newest first, kept on this browser.
function errorLogView() {
  const entries = errorLog();
  const latest = [...entries]
    .reverse()
    .slice(0, 8)
    .map(
      (e) =>
        `<li><small>${h(new Date(e.time).toLocaleString())} · ${h(e.context)}</small><span>${h(e.message)}</span></li>`,
    )
    .join("");
  return `<div class="preference-choice error-log" role="group" aria-label="Error log"><span>Error log · ${entries.length}</span>${b("error-log-copy", "Copy log", entries.length ? "" : "disabled")}${b("error-log-clear", "Clear", entries.length ? "" : "disabled")}<small>Errors are kept on this browser and, on the hosted site, sent to its server log. Copy the log into a bug report.</small>${latest ? `<ol class="error-log-entries">${latest}</ol>` : "<small>No errors recorded.</small>"}</div>`;
}
// The order a machine's controls appear in (and the dial moves through them).
const synthOrder = [
  "cutoff",
  "resonance",
  "env-amount",
  "env-decay",
  "attack",
  "decay",
  "sustain",
  "release",
  "detune",
  "glide",
];
export function soundControls(machine: ReturnType<typeof machines.get>) {
  const parameters = machine?.parameters ?? [];
  if (machine?.id !== "xmp.subtractive") return [...parameters];
  return [...parameters].sort(
    (a, b) => ((synthOrder.indexOf(a.id) + 99) % 99) - ((synthOrder.indexOf(b.id) + 99) % 99),
  );
}
export function workbenchQlinks(c: DeviceController) {
  const w = c.workbench,
    p = c.project,
    track = c.track;
  if (c.nav.page === "sample" && c.sampler) {
    const controls = c.sampler.ui.controls().filter((control) => control.key);
    return Array.from({ length: 4 }, (_, i) => ({
      name: controls[i]?.name ?? "Value",
      value: c.sampler?.qValue(i) ?? 0.5,
      raw: controls[i]?.value ?? 0,
      display: String(controls[i]?.value ?? ""),
      key: "",
      min: 0,
      max: 1,
      step: 0.01,
      unit: "",
    }));
  }
  const normalized = (id: string, name: string) => ({
    name,
    value: readParameter(p, id),
    display: `${Math.round(readParameter(p, id) * 100)}%`,
    raw: readParameter(p, id) * 100,
    key: `param:${id}`,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
  });
  if (c.nav.page === "steps" && c.nav.qPage < 2) {
    const hit = w.hit,
      fresh = c.nav.qPage === 1;
    return [
      {
        name: fresh ? "New velocity" : "Velocity",
        value: fresh ? w.velocity : (hit?.velocity ?? 0),
        display:
          hit || fresh
            ? `${Math.round((fresh ? w.velocity : (hit?.velocity ?? 0)) * 100)}%`
            : "Select hit",
        key: `${fresh ? "new" : "expression"}:velocity`,
        min: 1,
        max: 100,
        step: 1,
        unit: "%",
      },
      {
        name: fresh ? "New chance" : "Chance",
        value: fresh ? w.chance : (hit?.probability ?? 1),
        display: `${Math.round((fresh ? w.chance : (hit?.probability ?? 1)) * 100)}%`,
        key: `${fresh ? "new" : "expression"}:chance`,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      },
      {
        name: "Length",
        value: (fresh ? w.length : hit && "duration" in hit ? (hit.duration ?? 1) : 1) / 16,
        display: `${fresh ? w.length : hit && "duration" in hit ? (hit.duration ?? 1) : 1} steps`,
        key: `${fresh ? "new" : "expression"}:length`,
        min: 0.25,
        max: 16,
        step: 0.25,
        unit: " steps",
      },
      normalized(`track.${track.id}.gain`, "Track level"),
    ];
  }
  if (c.nav.page === "steps" ? c.nav.qPage === 3 : c.nav.qPage % 2 === 1) {
    const definition = machines.get(track.machine);
    const order =
      definition?.id === "xmp.subtractive"
        ? ["cutoff", "attack", "decay", "release"]
        : (definition?.parameters.map((p) => p.id) ?? []);
    return Array.from({ length: 4 }, (_, i) => {
      const item = definition?.parameters.find((p) => p.id === order[i]);
      if (!item)
        return {
          name: "Unassigned",
          value: 0,
          raw: 0,
          display: "—",
          key: "",
          min: 0,
          max: 100,
          step: 1,
          unit: "",
        };
      const field = machineValue(c, item);
      return {
        name: item.name,
        value: (field.raw - field.min) / (field.max - field.min),
        display: `${Number(field.raw.toFixed(1))}${field.unit}`,
        ...field,
      };
    });
  }
  return [
    normalized(`track.${track.id}.gain`, "Level"),
    normalized(`track.${track.id}.pan`, "Pan"),
    normalized(`track.${track.id}.send.0`, "Send A"),
    normalized(`track.${track.id}.send.1`, "Send B"),
  ];
}
function machineValue(
  c: DeviceController,
  parameter: NonNullable<ReturnType<typeof machines.get>>["parameters"][number],
) {
  const factor =
    parameter.unit === "seconds" || parameter.unit === "normalized"
      ? parameter.unit === "seconds"
        ? 1000
        : 100
      : 1;
  return {
    key: `machine:${parameter.id}`,
    raw: Number(c.track.machine?.state[parameter.id] ?? parameter.defaultValue) * factor,
    min: parameter.min * factor,
    max: parameter.max * factor,
    step: parameter.step
      ? parameter.step * factor
      : parameter.unit === "seconds"
        ? 1
        : parameter.unit === "Hz"
          ? 10
          : 1,
    unit:
      parameter.unit === "seconds"
        ? " ms"
        : parameter.unit === "normalized"
          ? "%"
          : ` ${parameter.unit}`,
    reset: parameter.defaultValue * factor,
  };
}
const scale = (c: DeviceController) =>
  `<label>Root <select id="wb-root">${padRoots.map((r, i) => `<option value="${i}" ${c.root === i ? "selected" : ""}>${r}</option>`).join("")}</select></label><label>Scale <select id="wb-scale">${padScales.map((s) => `<option value="${s.id}" ${c.scale === s.id ? "selected" : ""}>${s.name}</option>`).join("")}</select></label>${v("octave", "Octave", c.octave, -3, 3, 1, "", 0)}`;
// The synth's preset pages: Classic, Pop & rock, Electronic & dance, House & acid.
const presetPages = (c: DeviceController) =>
  `<div class="preset-pages" role="group" aria-label="Preset page">${synthPresetPages.map((name, i) => b(`preset-page:${i}`, h(name), `class="${c.workbench.presetPage === i ? "focused" : ""}" aria-pressed="${c.workbench.presetPage === i}"`)).join("")}</div>`;
function pads(c: DeviceController, presets = false) {
  const preset = (p: number) =>
    c.workbench.presetPage * PRESETS_PER_PAGE + (3 - Math.floor(p / 4)) * 4 + (p % 4);
  return `${presets ? presetPages(c) : ""}<div class="sound-matrix">${padOrder.map((p) => (presets && p >= 8 ? b(`preset:${preset(p)}`, `<small>PAD ${p + 1}</small><strong>${h(synthPresets[preset(p)]?.name)}</strong>`, `class="preset-pad ${c.track.machine?.state.name === synthPresets[preset(p)]?.name ? "focused" : ""} ${c.workbench.soundFocus === preset(p) ? "dial" : ""}"`) : `<button data-sound="${p}" class="${c.nav.pad === p ? "focused" : ""}"><small>PAD ${p + 1}</small><strong>${h(c.workbench.pitched ? noteName(padNote(p, c.octave, c.scale, rootPitch(c.root))) : trackPads(c.project, c.trackId)[p]?.name)}</strong></button>`)).join("")}</div>`;
}
export function workbenchContent(c: DeviceController): string | undefined {
  const w = c.workbench,
    p = c.project,
    track = c.track,
    hit = w.hit;
  const heading = (title: string, tools = "") =>
    `<div class="screen-toolbar"><h2>${h(title)}</h2><div class="context-actions">${tools}</div></div>`;
  // A track whose machine hasn't been chosen opens its Sound page on the choice.
  const choosing = c.nav.page === "sound" && !machineChosen(track);
  if (w.machinePicker || choosing)
    return (
      heading(
        choosing ? `Choose ${track.name}’s machine` : `Change ${track.name}’s machine`,
        choosing ? "" : b("machine-picker", "Cancel"),
      ) +
      (choosing
        ? `<p class="machine-note">This track has no machine yet. Choose one with pads 1–4 or touch.</p>`
        : "") +
      `<div class="machine-grid">${padMachines
        .map((id, i) => {
          const item =
            id === "xmp.sampler"
              ? { name: "Kit", base: "audio" }
              : id === "melodic-sampler"
                ? { name: "Sampler", base: "audio" }
                : machines.list().find((m) => m.id === id);
          return b(
            `machine:${id}`,
            `<small>PAD ${i + 1}</small><strong>${h(item?.name)}</strong><span>${h(item?.base)}</span>`,
          );
        })
        .join(
          "",
        )}</div><div class="example-machines" role="group" aria-label="Developer examples"><span>Developer examples</span>${machines
        .list()
        .filter((m) => !padMachines.some((id) => id === m.id))
        .map((m) => b(`machine:${m.id}`, h(m.name)))
        .join("")}</div>`
    );
  if (c.nav.page === "menu")
    return `<h2>Track · ${h(track.name)}</h2><div class="mode-grid">${menuPages
      .slice(0, 4)
      .map((m, i) =>
        m.page === "sample" && !c.canSample
          ? b(
              `page:${m.page}`,
              `<small>PAD ${13 + i}</small><strong>${m.name}</strong><span>Kit and Sampler tracks</span>`,
              "disabled",
            )
          : b(`page:${m.page}`, `<small>PAD ${13 + i}</small><strong>${m.name}</strong>`),
      )
      .join("")}</div><h2>Project · every track</h2><div class="mode-grid">${menuPages
      .slice(4, 8)
      .map((m, i) => b(`page:${m.page}`, `<small>PAD ${9 + i}</small><strong>${m.name}</strong>`))
      .join(
        "",
      )}</div><div class="context-actions">${b("page:project", "Project & files")}${b("page:preferences", "Preferences")}</div>`;
  if (c.nav.page === "clips") {
    const top = slotCoordinates(c.nav.bank, 12),
      first = w.overview ? 0 : top.track,
      columns = w.overview ? 8 : 4,
      group = c.nav.bank % 4;
    // The grid fills the page. The two corners scroll through the scenes, four
    // at a time (as the pads' banks do); the wheel or a swipe over the grid does too.
    const scroll = (id: string, label: string, text: string, disabled: boolean) =>
      `<button data-action="${id}" class="scene-scroll" aria-label="${label}" ${disabled ? "disabled" : ""}>${text}</button>`;
    return `<div class="clip-overview" style="--clip-columns:${columns}">${scroll("scene-prev", "Earlier scenes", `▲<small>Scenes ${top.scene + 1}–${top.scene + 4}</small>`, group === 0)}${p.tracks
      .slice(first, first + columns)
      .map((t) => `<button data-track="${t.id}">${h(t.name)}</button>`)
      .join("")}${Array.from({ length: 4 }, (_, row) => {
      const s = p.scenes[top.scene + row];
      return (
        `<button data-launch-scene="${s?.id ?? ""}" class="scene-launch" ${s ? "" : "disabled"}>${h(s?.name ?? "—")} ▷<small class="scene-queued" hidden>Queued</small></button>` +
        Array.from({ length: columns }, (_, col) => {
          const t = p.tracks[first + col],
            clip = t?.clips.find((x) => x.id === s?.clips[t.id]),
            focused = t?.id === c.trackId && s?.id === c.sceneId,
            idle = focused
              ? clip
                ? "Selected · tap to edit"
                : "Selected · tap to create"
              : clip
                ? "Ready"
                : "Empty";
          return `<button data-focus-track="${t?.id ?? ""}" data-focus-scene="${s?.id ?? ""}" data-clip-id="${clip?.id ?? ""}" ${columns === 4 ? `data-slot="${(3 - row) * 4 + col}"` : ""} class="clip-cell ${focused ? "focused" : ""} ${clip ? "filled" : "empty"}" title="${h(clip?.name ?? "")}"><small data-clip-state="${idle}">${idle}</small><strong>${h(clip?.name ?? "Record / stop")}</strong><small>${clip ? `${clip.length / 4} beats · ${clip.steps.length + (clip.sequence?.notes.length ?? 0)} notes` : "REC to record"}</small></button>`;
        }).join("")
      );
    }).join(
      "",
    )}${scroll("scene-next", "Later scenes", "▼", group === 3 || top.scene + 4 >= p.scenes.length)}${p.tracks
      .slice(first, first + columns)
      .map((t) =>
        b(`stop-track:${t.id}`, "Stop", `aria-label="Stop ${h(t.name)}" data-stop-track="${t.id}"`),
      )
      .join("")}</div>`;
  }
  if (c.nav.page === "preferences")
    return (
      heading("Preferences") +
      `<section class="preferences"><label>Launch timing <select id="wb-launch">${launchTimings
        .map(
          ([value, label]) =>
            `<option value="${value}" ${value === (p.performance?.launchQuantize ?? 16) ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select><small>When launched clips and scenes start while playing. Saved with this song.</small></label><div class="preference-choice" role="group" aria-label="Tracks in Clips"><span>Tracks in Clips</span>${b("clip-grid:4", "4 tracks", `aria-pressed="${!w.overview}"`)}${b("clip-grid:8", "8 tracks", `aria-pressed="${w.overview}"`)}<small>8 shows every track at once; 4 follows the A–D track banks.</small></div>${errorLogView()}</section>`
    );
  if (c.nav.page === "play")
    return (
      heading(
        track.name,
        `${b("machine-picker", machineChosen(track) ? `Machine: ${h(machineLabel(track))} · change` : "Choose machine")}${w.pitched ? scale(c) : b("page:sound", "Edit sound")}`,
      ) +
      pads(c) +
      `<div class="context-actions">${b("page:steps", "Edit pattern")}${v("quantize", "Record quantize", w.quantize * 100, 0, 100, 1, "%", 100)}${b("fill", "Fill")}</div>`
    );
  if (c.nav.page === "steps") {
    const start = Math.floor(c.step / 16) * 16;
    const selector = `<label>Sound <select id="device-sound">${trackPads(p, c.trackId)
      .map(
        (pad, i) =>
          `<option value="${i}" ${i === c.nav.pad ? "selected" : ""}>${h(w.pitched ? noteName(padNote(i, c.octave, c.scale, rootPitch(c.root))) : pad.name)}</option>`,
      )
      .join("")}</select></label>`;
    const toolbar = heading(
      c.clip?.name ?? "New clip",
      `${b("rename:clip", "Rename")}${b("tool:select", "Select", `aria-pressed="${w.tool === "select"}"`)}${b("tool:draw", "Draw", `aria-pressed="${w.tool === "draw"}"`)}<label>Length <input id="device-length" type="number" min="1" max="1024" step="1" value="${c.clip?.length ?? 16}"></label>`,
    );
    const drumGrid = `<div class="device-steps">${Array.from({ length: 16 }, (_, i) => {
      const step = start + i;
      const entry = c.clip?.steps.find(
        (s) =>
          s.step === step && (w.pitched ? (s.note ?? 48 + s.pad) === w.pitch : s.pad === c.nav.pad),
      );
      const sequence = c.clip?.sequence?.notes.find(
        (s) =>
          Math.floor(s.position) === step && (w.pitched ? s.note === w.pitch : s.pad === c.nav.pad),
      );
      const note = sequence ?? entry;
      return `<button data-step="${step}" class="${c.step === step ? "focused" : ""}" aria-label="Step ${step + 1}" aria-pressed="${!!note}" ${step >= (c.clip?.length ?? 16) ? "disabled" : ""}><span>${step + 1}</span><strong>${note ? `${Math.round(note.velocity * 100)}%` : "·"}</strong><small>${c.clip?.sequence?.locks.some((l) => l.position === step) ? "LOCK" : ""}</small></button>`;
    }).join("")}</div>`;
    if (w.pitch < w.rollLow) w.rollLow = w.pitch;
    else if (w.pitch > w.rollLow + 7) w.rollLow = w.pitch - 7;
    const grid = w.pitched
      ? `<div class="piano-roll" aria-label="Melodic piano roll">${Array.from(
          { length: 8 },
          (_, row) => {
            const note = w.rollLow + 7 - row;
            return (
              `<span class="piano-key ${note === w.pitch ? "selected" : ""}">${noteName(note)}</span>` +
              Array.from({ length: 16 }, (_, i) => {
                const step = start + i,
                  entry = c.clip?.steps.find(
                    (s) => s.step === step && (s.note ?? 48 + s.pad) === note,
                  ),
                  sequence = c.clip?.sequence?.notes.find(
                    (n) => n.note === note && n.position <= step && n.position + n.duration > step,
                  ),
                  hit = sequence ?? entry;
                return `<button data-roll-step="${sequence ? Math.floor(sequence.position) : step}" data-roll-note="${note}" aria-label="${noteName(note)} step ${step + 1}${hit ? " selected hit" : ""}" aria-pressed="${!!hit}" class="roll-cell ${hit ? "has-note" : ""} ${note === w.pitch && step === c.step ? "focused" : ""}" ${step >= (c.clip?.length ?? 16) ? "disabled" : ""}>${hit ? `<i style="opacity:${0.35 + hit.velocity * 0.65}"></i>` : ""}</button>`;
              }).join("")
            );
          },
        ).join("")}</div>`
      : drumGrid;
    const notes = w.pitched
      ? `<div class="note-entry"><div class="sound-matrix">${Array.from({ length: 16 }, (_, i) => `<button data-select-sound="${i}" class="${c.nav.pad === i ? "focused" : ""}" aria-label="Choose ${noteName(padNote(i, c.octave, c.scale, rootPitch(c.root)))}"><strong>${noteName(padNote(i, c.octave, c.scale, rootPitch(c.root)))}</strong></button>`).join("")}</div></div>`
      : "";
    const inspector = hit
      ? `<section class="step-inspector"><strong>Step ${c.step + 1} · ${w.pitched ? noteName(w.pitch) : h(trackPads(p, c.trackId)[c.nav.pad]?.name)}</strong>${v("expression:velocity", "Velocity", hit.velocity * 100, 1, 100, 1, "%", 80)}${v("expression:chance", "Chance", hit.probability * 100, 0, 100, 1, "%", 100)}${v("expression:length", "Length", "duration" in hit ? (hit.duration ?? 1) : 1, 0.25, 16, 0.25, " steps", 1)}<label>Condition <select id="wb-condition">${conditions.map((condition) => `<option ${"condition" in hit && hit.condition === condition ? "selected" : ""}>${condition}</option>`).join("")}</select></label>${b("lock-dialog", `Locks ${c.clip?.sequence?.locks.filter((l) => l.position === c.step).length ?? 0}`)}${b("delete-hit", "Delete hit")}</section>`
      : `<section class="step-inspector"><strong>New hits</strong>${v("new:velocity", "Velocity", w.velocity * 100, 1, 100, 1, "%", 80)}${v("new:chance", "Chance", w.chance * 100, 0, 100, 1, "%", 100)}${v("new:length", "Length", w.length, 0.25, 16, 0.25, " steps", 1)}</section>`;
    return (
      toolbar +
      `<div class="context-actions">${selector}${b("step-prev", "‹ Page")}<span>${start + 1}–${start + 16}</span>${b("step-next", "Page ›")}${v("quantize", "Record quantize", w.quantize * 100, 0, 100, 1, "%", 100)}</div>` +
      grid +
      (w.pitched
        ? ""
        : `<div class="velocity-lane" aria-label="Velocity lane">${Array.from(
            { length: 16 },
            (_, i) => {
              const n = c.clip?.steps.find((s) => s.step === start + i && s.pad === c.nav.pad);
              return `<button data-select-step="${start + i}" aria-label="Select step ${start + i + 1}"><i style="height:${Math.max(2, (n?.velocity ?? 0) * 100)}%"></i></button>`;
            },
          ).join("")}</div>`) +
      inspector +
      notes
    );
  }
  if (c.nav.page === "sound") {
    const machine = machines.get(track.machine),
      pad = trackPads(p, c.trackId)[c.nav.pad];
    // A synth's controls in the Live's order (Ui::synth_control): the oscillator
    // is the dial's first item, then these; other machines keep their own order.
    const controls =
      soundControls(machine)
        .map((parameter, i) => {
          const field = machineValue(c, parameter);
          // The dial's control on a synth's Controls tab (ENTER edits it).
          const dial =
            w.soundTab === "controls" &&
            i + (machine?.id === "xmp.subtractive" ? 1 : 0) === w.soundFocus;
          return (
            dial
              ? (html: string) => html.replace("<button ", '<button data-dial="true" ')
              : (html: string) => html
          )(
            v(
              field.key,
              parameter.name,
              field.raw,
              field.min,
              field.max,
              field.step,
              field.unit,
              field.reset,
            ),
          );
        })
        .join("") ?? "";
    const synth = machine?.id === "xmp.subtractive",
      controlsTab = synth && w.soundTab === "controls";
    // Each machine has its own Sound page: a synth's presets or controls, a MIDI
    // track's routing, a sampler's sample, a kit's sixteen pad sounds.
    const tabs = synth
      ? `${b("sound-tab:presets", "Presets", `aria-pressed="${!controlsTab}"`)}${b("sound-tab:controls", "Controls", `aria-pressed="${controlsTab}"`)}`
      : "";
    return (
      heading(
        track.name,
        `${tabs}${b("rename:track", "Rename")}${b("machine-picker", `Machine: ${h(machineLabel(track))} · change`)}`,
      ) +
      (synth
        ? controlsTab
          ? `${scale(c)}<label ${w.soundFocus === 0 ? 'data-dial="true"' : ""}>Oscillator <select id="wb-oscillator">${["sine", "saw", "square"].map((o) => `<option ${track.machine?.state.oscillator === o ? "selected" : ""}>${o}</option>`).join("")}</select></label><div class="sound-controls">${controls}</div>${pads(c)}`
          : `${scale(c)}${pads(c, true)}`
        : w.pitched
          ? `${scale(c)}${machine?.id === "xmp.sampler" || samplerMode(track) ? b("edit-sample", "Chop or edit sample") + b("replace-sample", "Replace sample") : ""}${midiRoutingView(p, c.trackId, "device-midi-destination")}<div class="sound-controls">${controls}</div>${pads(c)}`
          : `${pads(c)}<section class="step-inspector"><strong>Pad ${c.nav.pad + 1} · ${h(pad?.name)}</strong>${samplerMode(track) === "slices" ? b("edit-sample", "Chop or edit sample") : b("edit-sample", "Edit sample")}${b("replace-sample", "Replace sample")}${samplerMode(track) === "slices" ? "" : b("open-kits", "Load kit")}<span>${track.pads ? "Track’s own kit" : "Shared kit · editing creates this track’s own copy"}</span></section>`)
    );
  }
  if (c.nav.page === "sample") return "<p>Opening Sample…</p>";
  if (c.nav.page === "mix" || c.nav.page === "mute") {
    const fx =
      w.fxLocation === "track"
        ? p.mix?.tracks[track.id]?.inserts
        : p.mix?.returns[Number(w.fxLocation) as 0 | 1];
    if (w.effectsOpen)
      return `<div class="effects-editor">${heading("Effects", b("effects-close", "Back to mixer"))}<div class="context-actions"><label>Channel <select id="wb-fx-location">${[
        ["track", track.name],
        ["0", "Return A"],
        ["1", "Return B"],
      ]
        .map(
          ([id, name]) =>
            `<option value="${id}" ${w.fxLocation === id ? "selected" : ""}>${h(name)}</option>`,
        )
        .join("")}</select></label><label>Add <select id="wb-fx-kind">${Object.keys(effectDefaults)
        .map((kind) => `<option>${kind}</option>`)
        .join(
          "",
        )}</select></label>${b("fx-install", "Add effect", (fx?.length ?? 0) >= 2 ? "disabled" : "")}</div><div class="effect-list">${
        (fx ?? [])
          .map(
            (effect) =>
              `<section class="effect-strip"><h2>${h(effect.kind)}</h2>${Object.keys(effect.params)
                .map((key) =>
                  v(
                    `param:${w.fxLocation === "track" ? `track.${track.id}` : `return.${w.fxLocation}`}.insert.${effect.id}.${key}`,
                    key,
                    (effect.params[key] ?? 0) * 100,
                    0,
                    100,
                    1,
                    "%",
                    50,
                  ),
                )
                .join(
                  "",
                )}${b(`fx-bypass:${effect.id}`, effect.bypass ? "Enable" : "Bypass")}${b(`fx-remove:${effect.id}`, "Remove")}</section>`,
          )
          .join("") || "<p>No effects. Choose an effect to add to this channel.</p>"
      }</div></div>`;
    return (
      heading("Mix", v("param:master.gain", "Master", p.master * 100, 0, 100, 1, "%", 55)) +
      `<div class="mix-channels">${p.tracks.map((t) => `<section class="mix-channel ${t.id === track.id ? "focused" : ""}"><button data-track="${t.id}"><strong>${h(t.name)}</strong></button><label>Level<input data-commit-key="param:track.${t.id}.gain" aria-label="${h(t.name)} level" type="range" min="0" max="100" value="${t.volume * 100}"></label>${v(`param:track.${t.id}.gain`, "Level", t.volume * 100, 0, 100, 1, "%", 80)}${v(`param:track.${t.id}.pan`, "Pan", readParameter(p, `track.${t.id}.pan`) * 100, 0, 100, 1, "%", 50)}<div class="context-actions"><button data-mute="${t.id}" aria-label="Mute ${h(t.name)}" aria-pressed="${t.muted}">M</button>${b(`solo:${t.id}`, "S", `aria-label="Solo ${h(t.name)}" aria-pressed="${p.performance?.solos.includes(t.id) ?? false}"`)}</div></section>`).join("")}</div><section class="mix-inspector"><h2>${h(track.name)}</h2>${v(`param:track.${track.id}.send.0`, "Send A", readParameter(p, `track.${track.id}.send.0`) * 100, 0, 100, 1, "%", 0)}${v(`param:track.${track.id}.send.1`, "Send B", readParameter(p, `track.${track.id}.send.1`) * 100, 0, 100, 1, "%", 0)}${b("effects-open", "Effects & returns")}</section>`
    );
  }
  if (c.nav.page === "song")
    return (
      heading(
        "Song chain",
        `${b("capture", w.capturing ? "Finish capture" : "Capture jam")}${b("capture-mode", w.captureReplace ? "Replace chain" : "Append after block")}<label>Scene <select id="device-scene">${p.scenes.map((s) => `<option value="${s.id}" ${s.id === c.sceneId ? "selected" : ""}>${h(s.name)}</option>`).join("")}</select></label>${b("add-scene", "Append scene")}<label>End <select id="wb-song-end"><option ${p.performance?.end !== "loop" ? "selected" : ""}>stop</option><option ${p.performance?.end === "loop" ? "selected" : ""}>loop</option></select></label>`,
      ) +
      `<ol class="song-chain">${(p.performance?.chain ?? []).map((part, i) => `<li draggable="true" data-block-index="${i}" class="${w.block === i ? "focused" : ""}"><button data-action="block:${i}" class="drag-handle" aria-label="Select or drag block ${i + 1}">≡ ${i + 1}</button><select data-part-scene="${part.id}" aria-label="Block ${i + 1} scene">${p.scenes.map((s) => `<option value="${s.id}" ${part.sceneId === s.id ? "selected" : ""}>${h(s.name)}</option>`).join("")}</select><span class="block-bars">Bars ${chainBarRanges(p)[i]?.start}–${chainBarRanges(p)[i]?.end}</span>${v(`part:${part.id}`, "Repeats", part.repeats, 1, 16, 1, "×", 1)}${i ? b(`move-block:${i}:${i - 1}`, "↑", `aria-label="Move block ${i + 1} up"`) : ""}${i < (p.performance?.chain.length ?? 0) - 1 ? b(`move-block:${i}:${i + 1}`, "↓", `aria-label="Move block ${i + 1} down"`) : ""}${b(`remove-part:${part.id}`, "Remove")}</li>`).join("") || "<li>Launch scenes, then append them here to build a song.</li>"}</ol>`
    );
  if (c.nav.page === "library") {
    const list = c.samples,
      start = Math.floor(c.libraryCursor / 5) * 5;
    const tabs = `<div class="context-actions">${["samples", "kits", "projects"].map((kind) => b(`browse:${kind}`, kind[0]?.toUpperCase() + kind.slice(1), `aria-pressed="${w.browseKind === kind}"`)).join("")}</div>`;
    const header =
      heading("Browse · Library", tabs) +
      `<div class="browse-target"><strong>${w.browseKind === "projects" ? `Current song: ${h(p.name)}` : w.browseKind === "kits" ? `Load kit onto ${h(track.name)}` : `Load to ${h(track.name)} · pad ${c.nav.pad + 1}: ${h(trackPads(p, c.trackId)[c.nav.pad]?.name)}`}</strong>${w.browseKind === "projects" ? "" : b("page:sound", "Return to Sound")}</div>`;
    if (w.browseKind === "projects")
      return (
        header +
        `<section class="sample-empty"><h2>Open a portable project</h2><p>The current song remains available if opening or locating samples fails.</p>${b("open", c.projectOpenFailed ? "Choose another file" : "Choose project")}${b("save", "Save current project")}</section>`
      );
    if (w.browseKind === "kits")
      return (
        header +
        `<div class="library-list kit-list">${[...originalKits, ...cc0Kits].map((kit) => b(`load-kit:${kit.id}`, `<strong>${h(kit.name)}</strong><span>Load onto ${h(track.name)} · Undo restores</span>`)).join("")}</div>`
      );
    return (
      header +
      `<div class="library-tools"><input id="device-search" aria-label="Search sample library" placeholder="Search sounds and folders" value="${h(c.query)}">${b("folder", "Choose folder")}</div><div class="library-list">${
        list
          .slice(start, start + 5)
          .map(
            (item, i) =>
              `<button data-library="${start + i}" class="${start + i === c.libraryCursor ? "focused" : ""}"><strong>${h(item.name)}</strong><span>${h(item.folder)}</span><small>${Math.ceil(item.bytes / 1024)} KiB</small></button>`,
          )
          .join("") || "<p>No matches. Try another name or choose a WAV folder.</p>"
      }</div><div class="library-actions pinned-actions">${b("library-prev", "‹")}<span>${list.length ? start + 1 : 0}–${Math.min(start + 5, list.length)} / ${list.length}</span>${b("library-next", "›")}${b("preview", "Audition", !list.length ? "disabled" : "")}${b("assign", `Load to pad ${c.nav.pad + 1}`, !list.length || c.busy ? "disabled" : "")}</div>`
    );
  }
  return undefined;
}
export function workbenchOverlay(c: DeviceController) {
  const w = c.workbench,
    e = w.editor;
  if (e)
    return `<section class="value-dialog" role="dialog" aria-modal="true" aria-label="Edit ${h(e.name)}"><h2>${h(e.name)}</h2><label>Value (${e.min}–${e.max}${h(e.unit)})<input id="value-input" type="number" min="${e.min}" max="${e.max}" step="${e.step}" value="${e.value}" autofocus></label><div class="context-actions">${b("value-reset", "Reset")}${b("value-cancel", "Cancel")}${b("value-apply", "Apply", 'class="primary"')}</div></section>`;
  if (w.locksOpen)
    return `<section class="value-dialog" role="dialog" aria-modal="true" aria-label="Step parameter locks"><h2>Step ${c.step + 1} locks</h2><label>Parameter<select id="lock-parameter">${parameterRegistry(
      c.project,
    )
      .filter((p) => p.id.startsWith(`track.${c.trackId}.`))
      .map((p) => `<option value="${p.id}">${h(p.name)}</option>`)
      .join(
        "",
      )}</select></label><div class="context-actions">${b("add-lock", "Lock current value")}${b("clear-locks", "Clear step locks")}${b("lock-dialog", "Done")}</div></section>`;
  if (w.rename) {
    const name =
      w.rename === "project"
        ? c.project.name
        : w.rename === "track"
          ? c.track.name
          : (c.clip?.name ?? "New clip");
    return `<section class="value-dialog" role="dialog" aria-modal="true" aria-label="Rename ${w.rename}"><h2>Rename ${w.rename}</h2><input id="rename-input" maxlength="${w.rename === "project" ? 80 : 40}" value="${h(name)}" autofocus><div class="context-actions">${b("rename-cancel", "Cancel")}${b("rename-apply", "Apply")}</div></section>`;
  }
  return w.help
    ? `<section class="value-dialog" role="dialog" aria-label="Current controls"><h2>${h(c.nav.page)} controls</h2><p>Main: Clips · Shift + Main: Play · 16 Level: Steps</p><p>A–D: Tracks 1–4 · Shift + A–D: Tracks 5–8</p><p>Steps: pads toggle; Shift + pad chooses a sound/note. Touch Select inspects; Draw toggles. Q-Link cycles Step / New hits / Track / Sound.</p><p>Copy then a slot duplicates. Shift + Copy unlinks. Undo restores edits.</p>${b("help", "Close help")}</section>`
    : "";
}
