import type { Project } from "@xmp/core";
import {
  decodeMidi,
  editMix,
  encodeMidi,
  exchangePlan,
  importMidiClip,
  parameterValue,
  setParameter,
} from "../../../packages/core/src/edits.ts";
import { VirtualMidiRoute, virtualClock } from "../../../packages/core/src/midi.ts";
import { mixEffects } from "../../../packages/core/src/mix.ts";
import {
  createEffect,
  type EffectKind,
  EffectSchema,
  effectDefaults,
} from "../../../packages/core/src/mix-schema.ts";
import { exportWave } from "../../../packages/core/src/wave-export.ts";
import { logError } from "./error-log.ts";

interface Host {
  project(): Project;
  track(): string;
  scene(): string;
  clip(): string;
  revision(): number;
  edit(change: (p: Project) => Project): void;
  status(message: string): void;
  playing(): boolean;
  download(data: BlobPart, type: string, name: string): void;
}
export function installMixPanel(host: Host) {
  const container = document.getElementById("mix-detail");
  if (!container) throw new Error("Missing mix panel");
  container.innerHTML = `<button id="mix-enable" data-primary>Enable stereo mixing</button><p class="small">Two inserts per track · two stereo returns · equal-power pan · virtual MIDI only</p><div id="mix-controls" hidden><div class="mix-strips" id="mix-strips"></div><div class="mix-editor"><label>Effect location <select id="fx-location" data-primary><option value="track">Selected track</option><option value="0">Send return A</option><option value="1">Send return B</option></select></label><label>Slot <select id="fx-slot"><option value="0">Insert 1</option><option value="1">Insert 2</option></select></label><label>Effect <select id="fx-kind">${Object.keys(
    effectDefaults,
  )
    .map((k) => `<option>${k}</option>`)
    .join(
      "",
    )}</select></label><button id="fx-install" data-primary>Set effect</button><button id="fx-remove">Remove effect</button><div id="fx-params"></div><div class="compact-row"><button id="fx-save">Save preset</button><button id="fx-open">Open preset</button><input id="fx-file" type="file" accept=".json" hidden><button id="fx-rhythm">Rhythmic filter / delay preset</button></div><p class="small">Bypass fades over 10 ms while effect history continues. Stop releases notes and lets tails decay. Graph replacement clears its history.</p></div><div class="mix-clock"><label>Change at bar <input id="tempo-bar" type="number" min="2" max="4096" value="2"></label><label>BPM <input id="tempo-next" type="number" min="30" max="300" value="120"></label><button id="tempo-add">Set tempo change</button><button id="tempo-clear">Clear tempo map</button><p id="tempo-map" class="small"></p></div></div><div class="master-meter"><label>Output left <meter id="mix-meter-left" min="0" max="1" value="0"></meter></label><label>Output right <meter id="mix-meter-right" min="0" max="1" value="0"></meter></label><output id="mix-meter-status">No audio measurement yet</output></div><div class="exchange-controls"><button id="export-song-wav" data-primary>Export song WAV</button><button id="export-scene-midi" data-primary>Export scene MIDI</button><button id="export-song-midi">Export song MIDI</button><button id="midi-open">Import MIDI clip</button><input id="midi-file" type="file" accept=".mid,.midi" hidden><label id="midi-track-label" hidden>File track <select id="midi-track"></select></label><button id="midi-keep" hidden>Replace selected clip with MIDI</button><button id="midi-virtual">Test virtual MIDI clock</button></div><p class="small">Downloads are prepared completely before being requested; your browser chooses a new destination. Song export needs a finite chain ending in Stop. MIDI carries notes and tempos; sounds and effects travel in the project.</p>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`Missing ${id}`);
    return e as T;
  };
  const attempt = async (fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      host.status(logError("Mix action rejected", e));
    }
  };
  let bound = "",
    midi: { bytes: Uint8Array; revision: number; track: string; clip: string } | undefined;
  const prefix = () =>
    el<HTMLSelectElement>("fx-location").value === "track"
      ? `track.${host.track()}`
      : `return.${el<HTMLSelectElement>("fx-location").value}`;
  const selected = () => {
    const p = host.project(),
      location = el<HTMLSelectElement>("fx-location").value,
      slot = Number(el<HTMLSelectElement>("fx-slot").value);
    const chain =
      location === "track"
        ? p.mix?.tracks[host.track()]?.inserts
        : p.mix?.returns[Number(location)];
    return { chain, slot, effect: chain?.[slot] };
  };
  const setEffect = (kind: EffectKind, preset?: unknown) => {
    if (host.playing()) throw new Error("Stop playback before replacing an effect graph");
    const location = el<HTMLSelectElement>("fx-location").value,
      slot = Number(el<HTMLSelectElement>("fx-slot").value);
    host.edit((p) =>
      editMix(p, (mix) => {
        mix.tracks[host.track()] ??= { pan: 0.5, sends: [0, 0], inserts: [] };
        const strip = mix.tracks[host.track()];
        if (!strip) throw new Error("Selected track unavailable");
        const chain = location === "track" ? strip.inserts : mix.returns[Number(location)];
        if (!chain || slot > chain.length) throw new Error("Fill insert 1 before insert 2");
        let number = 0;
        while (mixEffects(mix).some((e) => e.effect.id === `fx-${number}`)) number++;
        const effect = preset ? EffectSchema.parse(preset) : createEffect(kind, `fx-${number}`);
        effect.id = `fx-${number}`;
        const old = chain[slot];
        if (old)
          p.parameters = p.parameters.filter(
            (v) => !v.id.startsWith(`${prefix()}.insert.${old.id}.`),
          );
        chain[slot] = effect;
      }),
    );
  };
  el("mix-enable").onclick = () =>
    attempt(() => {
      if (host.playing()) throw new Error("Stop playback before enabling stereo mixing");
      host.edit((p) => editMix(p, () => {}));
    });
  el("fx-install").onclick = () =>
    attempt(() => setEffect(el<HTMLSelectElement>("fx-kind").value as EffectKind));
  el("fx-remove").onclick = () =>
    attempt(() => {
      if (host.playing()) throw new Error("Stop playback before replacing an effect graph");
      const location = el<HTMLSelectElement>("fx-location").value,
        { slot } = selected();
      host.edit((p) =>
        editMix(p, (mix) => {
          const chain =
            location === "track"
              ? mix.tracks[host.track()]?.inserts
              : mix.returns[Number(location)];
          const old = chain?.[slot];
          if (old) {
            chain?.splice(slot, 1);
            p.parameters = p.parameters.filter(
              (v) => !v.id.startsWith(`${prefix()}.insert.${old.id}.`),
            );
          }
        }),
      );
    });
  for (const id of ["fx-location", "fx-slot"])
    el(id).onchange = () => {
      bound = "";
      draw();
    };
  el("fx-rhythm").onclick = () =>
    attempt(() => {
      const kind = el<HTMLSelectElement>("fx-kind").value;
      if (kind !== "filter" && kind !== "delay")
        throw new Error("Choose filter or delay for the rhythmic preset");
      const effect = createEffect(kind, "preset");
      effect.sync = {
        division: kind === "filter" ? 1 : 2,
        sequence: [0.25, 0.8, 0.4, 0.65],
        phase: "transport",
        loss: "hold-last-tempo",
      };
      setEffect(kind, effect);
    });
  el("fx-save").onclick = () =>
    attempt(() => {
      const { effect } = selected();
      if (!effect) throw new Error("Choose an installed effect");
      const saved = structuredClone(effect),
        base = `${prefix()}.insert.${effect.id}`;
      for (const key of Object.keys(saved.params))
        saved.params[key] = parameterValue(host.project(), `${base}.${key}`);
      saved.bypass = parameterValue(host.project(), `${base}.bypass`) >= 0.5;
      host.download(JSON.stringify(saved, null, 2), "application/json", "effect-preset.json");
    });
  el("fx-open").onclick = () => el<HTMLInputElement>("fx-file").click();
  el<HTMLInputElement>("fx-file").onchange = async () => {
    const input = el<HTMLInputElement>("fx-file"),
      file = input.files?.[0],
      revision = host.revision();
    if (!file) return;
    try {
      if (file.size > 8192) throw new Error("Preset exceeds 8 KiB");
      const effect = EffectSchema.parse(JSON.parse(await file.text()));
      if (host.revision() !== revision) throw new Error("Project changed; reopen preset");
      attempt(() => setEffect(effect.kind, effect));
    } catch (e) {
      host.status(logError("Invalid preset", e));
    } finally {
      input.value = "";
    }
  };
  el("tempo-add").onclick = () =>
    attempt(() => {
      if (host.playing())
        throw new Error("Stop playback before editing the acknowledged tempo map");
      const step = (Number(el<HTMLInputElement>("tempo-bar").value) - 1) * 16,
        bpm = Number(el<HTMLInputElement>("tempo-next").value);
      host.edit((p) =>
        editMix(p, (m) => {
          m.tempos = [...m.tempos.filter((t) => t.step !== step), { step, bpm }].sort(
            (a, b) => a.step - b.step,
          );
        }),
      );
    });
  el("tempo-clear").onclick = () =>
    attempt(() => {
      if (host.playing()) throw new Error("Stop playback before editing tempo map");
      host.edit((p) =>
        editMix(p, (m) => {
          m.tempos = [];
        }),
      );
    });
  for (const [id, mode, format] of [
    ["export-song-wav", "song", "wav"],
    ["export-scene-midi", "scene", "mid"],
    ["export-song-midi", "song", "mid"],
  ] as const)
    el(id).onclick = () =>
      attempt(async () => {
        const project = structuredClone(host.project());
        const button = el<HTMLButtonElement>(id);
        if (format === "wav") {
          button.disabled = true;
          host.status("Rendering song WAV…");
          try {
            const chunks: BlobPart[] = [];
            for await (const chunk of exportWave(project, mode, host.scene())) chunks.push(chunk);
            host.download(new Blob(chunks, { type: "audio/wav" }), "audio/wav", `${mode}.wav`);
          } finally {
            button.disabled = false;
          }
        } else {
          const plan = exchangePlan(project, mode, host.scene());
          const bytes = encodeMidi(plan.document);
          host.download(bytes.slice().buffer, "audio/midi", `${mode}.mid`);
        }
        host.status(`${mode} ${format.toUpperCase()} download requested`);
      });
  el("midi-open").onclick = () => el<HTMLInputElement>("midi-file").click();
  el<HTMLInputElement>("midi-file").onchange = async () => {
    const input = el<HTMLInputElement>("midi-file"),
      file = input.files?.[0];
    if (!file) return;
    const target = { revision: host.revision(), track: host.track(), clip: host.clip() };
    try {
      if (file.size > 1048576) throw new Error("MIDI exceeds 1 MiB");
      const bytes = new Uint8Array(await file.arrayBuffer()),
        decoded = decodeMidi(bytes);
      if (host.revision() !== target.revision) throw new Error("Project changed; reopen MIDI");
      const tracks = [...new Set(decoded.notes.map((n) => n.track))];
      if (!tracks.length) throw new Error("MIDI has no supported notes");
      midi = { bytes, ...target };
      el("midi-track").innerHTML = tracks
        .map((t) => `<option value="${t}">File track ${t + 1}</option>`)
        .join("");
      el("midi-track-label").hidden = el("midi-keep").hidden = false;
      host.status(
        `MIDI staged; ${decoded.notes.length} notes, ${decoded.ignoredEvents} unsupported events omitted. Replace explicitly to apply notes and tempo map.`,
      );
    } catch (e) {
      host.status(logError("Invalid MIDI", e));
    } finally {
      input.value = "";
    }
  };
  el("midi-keep").onclick = () =>
    attempt(() => {
      if (!midi) return;
      if (
        host.playing() ||
        host.revision() !== midi.revision ||
        host.track() !== midi.track ||
        host.clip() !== midi.clip
      )
        throw new Error("Stop playback and reopen MIDI for the current clip before replacing");
      host.edit((p) =>
        importMidiClip(
          p,
          midi?.bytes ?? new Uint8Array(),
          Number(el<HTMLSelectElement>("midi-track").value),
          host.track(),
          host.clip(),
        ),
      );
      midi = undefined;
      el("midi-track-label").hidden = el("midi-keep").hidden = true;
    });
  el("midi-virtual").onclick = () =>
    attempt(() => {
      const route = new VirtualMidiRoute();
      route.select(
        { kind: "virtual", id: "fixture-input", generation: 1, connected: true },
        { kind: "virtual", id: "fixture-output", generation: 1, connected: true },
      );
      const packets = virtualClock(host.project(), 32, route);
      host.status(
        `Virtual MIDI: ${packets.filter((p) => p.bytes[0] === 0xf8).length} clock pulses; Start/Stop captured. Physical output unavailable.`,
      );
    });
  function draw() {
    const p = host.project();
    el("mix-enable").hidden = !!p.mix;
    el("mix-controls").hidden = !p.mix;
    const key = JSON.stringify([host.track(), p.mix, selected().slot, prefix()]);
    if (key !== bound) {
      bound = key;
      el("mix-strips").innerHTML = ["pan", "send.0", "send.1"]
        .map(
          (key, i) =>
            `<label>${["Pan", "Send A", "Send B"][i]} <input data-primary type="range" min="0" max="1" step="0.01" data-track="${host.track()}" data-parameter="track.${host.track()}.${key}" aria-label="${["Pan", "Send A", "Send B"][i]}"></label>`,
        )
        .join("");
      const { effect } = selected();
      el("fx-params").innerHTML = effect
        ? `<h3>${effect.kind}</h3>${[...Object.keys(effect.params), "bypass"].map((key) => `<label>${key} <input type="range" min="0" max="1" step="0.01" data-track="${host.track()}" data-parameter="${prefix()}.insert.${effect.id}.${key}" aria-label="Effect ${key}"></label>`).join("")}`
        : "<p>Empty insert</p>";
      for (const input of container?.querySelectorAll<HTMLInputElement>("[data-parameter]") ?? [])
        input.oninput = () =>
          attempt(() =>
            host.edit((p) => setParameter(p, input.dataset.parameter ?? "", Number(input.value))),
          );
    }
    if (p.mix)
      for (const input of container?.querySelectorAll<HTMLInputElement>("[data-parameter]") ?? [])
        input.value = String(parameterValue(p, input.dataset.parameter ?? ""));
    el("tempo-map").textContent =
      `${p.bpm} BPM initially${p.mix?.tempos.map((t) => ` · bar ${t.step / 16 + 1}: ${t.bpm}`).join("") ?? ""}`;
  }
  return {
    draw,
    meter(m: { left: number; right: number; rms: number; clipped: number }) {
      el<HTMLMeterElement>("mix-meter-left").value = m.left;
      el<HTMLMeterElement>("mix-meter-right").value = m.right;
      el("mix-meter-status").textContent =
        `L ${m.left.toFixed(3)} · R ${m.right.toFixed(3)} · RMS ${m.rms.toFixed(3)}${m.clipped ? ` · clipped ${m.clipped} frames` : ""}`;
    },
  };
}
