import type { Project } from "@xmp/core";
import {
  chopSampleToKit,
  decodeSampleWav,
  encodeWav,
  installSample,
  manualSlices,
  renderInstrumentScene,
  setMidiDestination,
} from "../../../packages/core/src/edits.ts";
import {
  PRESETS_PER_PAGE,
  SynthPatchSchema,
  synthPresetPages,
  synthPresets,
} from "../../../packages/core/src/instrument-schema.ts";
import { editedPcm, inputCapabilities } from "../../../packages/core/src/instruments.ts";
import { machines } from "../../../packages/core/src/machines.ts";
import { trackPads } from "../../../packages/core/src/pads.ts";

import { recordingPlan, TakeRecorder } from "../../../packages/core/src/recording.ts";
import { logError } from "./error-log.ts";
import { midiRoutingView } from "./midi-routing-view.ts";

interface Host {
  project: () => Project;
  track: () => string;
  selectTrack: (id: string) => void;
  pad: () => number;
  scene: () => string;
  revision: () => number;
  edit: (change: (project: Project) => Project) => void;
  status: (text: string) => void;
  panic: () => void;
}
const escapeText = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
export function installInstrumentPanel(host: Host) {
  const localMicAvailable =
    import.meta.env.DEV &&
    ["127.0.0.1", "localhost"].includes(location.hostname) &&
    location.port === "5173";
  const panel = document.getElementById("instrument-panel");
  if (!panel) throw new Error("Missing instrument panel");
  panel.innerHTML = `<div class="panel-head"><div><div class="eyebrow">TRACK MACHINE</div><h2>Sounds, machines & recording</h2></div><button id="panic">Panic · release notes</button></div>
  <label>Track <select id="instrument-track" aria-label="Track for instruments"></select></label><div class="instrument-columns"><div><label>Machine <select id="machine-type" aria-label="Track machine"></select></label><p id="machine-state" class="small"></p><p id="midi-preview" class="small">No MIDI events · physical routing disabled</p><div id="machine-parameters"></div>
  <label>Project sound <select id="sample-browser" aria-label="Project sound"></select></label><label>Pad mode <select id="pad-mode" aria-label="Pad playback mode"><option value="one-shot">One shot</option><option value="gate">Gate</option><option value="loop">Loop</option><option value="chromatic">Chromatic</option></select></label>
  <div class="compact-row"><label>Root note <input id="root-note" type="number" min="0" max="127" value="60"></label><label>Choke group <input id="choke-group" type="number" min="0" max="8" value="0"></label><label>Pad 1 note <input id="play-note" type="number" min="0" max="112" value="48"></label><label>Play strength <input id="play-strength" type="number" min="1" max="100" value="80"></label></div>
  <p class="small">Keyboard and pointer: fixed play strength. Pressure and slide sensors unavailable.</p></div>
  <div><div id="synth-controls"><label>Preset <select id="synth-preset" aria-label="Synth preset"><option value="">Custom</option>${synthPresetPages
    .map(
      (page, g) =>
        `<optgroup label="${page}">${synthPresets
          .slice(g * PRESETS_PER_PAGE, (g + 1) * PRESETS_PER_PAGE)
          .map((p, i) => `<option value="${g * PRESETS_PER_PAGE + i}">${p.name}</option>`)
          .join("")}</optgroup>`,
    )
    .join(
      "",
    )}</select></label><label>Wave <select id="oscillator" aria-label="Synth waveform"><option>sine</option><option>saw</option><option>square</option></select></label><button id="save-patch">Save patch</button><button id="open-patch">Open patch</button><input id="patch-file" type="file" accept=".json" hidden></div>
  <div class="sample-editor"><svg id="waveform" viewBox="0 0 400 100" role="img" aria-label="Original sample waveform and selected range"></svg><p id="waveform-info" class="small"></p>
  <div class="compact-row"><label>Start frame <input id="wave-start" type="number" min="0" value="0"></label><label>End frame <input id="wave-end" type="number" min="1" value="1"></label></div><div class="compact-row"><label>Reverse <input id="reverse" type="checkbox"></label><label>Normalize <input id="normalize" type="checkbox"></label><button id="crop">Crop to selected frames</button></div>
  <label>Manual slice boundaries (frames)<input id="slice-boundaries" type="text" placeholder="0, 1200, 2400, 3600, 4800"></label><button id="manual-slices">Assign slices to successive pads</button><button id="chop-drum-kit">Chop to drum kit</button></div>
  <div class="compact-row"><label>Selected step note <input id="step-note" type="number" min="0" max="127" value="60"></label><label>Length (steps)<input id="step-duration" type="number" min="0.0625" max="64" step="0.0625" value="1"></label><button id="apply-note">Apply note & length</button></div>
  </div></div>
  <div class="record-panel"><h3>Record a two-bar take</h3><div class="compact-row"><label>Input <select id="record-source" aria-label="Recording source"><option value="wav">WAV test input</option><option value="mac" ${localMicAvailable ? "" : "disabled"}>Built-in MacBook microphone${localMicAvailable ? "" : " · local Mac only"}</option></select></label><button id="choose-input">Choose WAV input</button><input id="record-file" type="file" accept=".wav" hidden><label><input type="checkbox" id="monitor-levels"> Monitor input levels</label><button id="arm-record">Arm</button><button id="start-record" disabled>Start recording</button><button id="keep-take" disabled>Keep take on selected pad</button><button id="resample">Resample two bars of master</button></div><meter id="input-meter" min="0" max="1" value="0" aria-label="Input peak level"></meter><p id="record-status" role="status">Not armed · no input is open</p><p class="small">Monitoring shows input levels. Microphone audio is never sent back to the speakers. Takes stay local and require Keep take before changing your project.</p></div>`;
  function el<T extends HTMLElement = HTMLElement>(id: string) {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing ${id}`);
    return value as T;
  }
  const number = (id: string) => Number(el<HTMLInputElement>(id).value);
  const say = (message: string) => {
    el("record-status").textContent = message;
  };
  let input: { pcm: Float32Array; sampleRate: number } | undefined,
    take: { pcm: Float32Array; sampleRate: number; partial?: boolean } | undefined;
  let armed:
    | { revision: number; pad: number; source: string; rate: number; frames: number }
    | undefined;
  let recording = false;
  const run = (action: () => void) => {
    try {
      action();
    } catch (error) {
      host.status(logError("Instrument operation failed", error));
    }
  };
  function playback() {
    run(() =>
      host.edit((project) => {
        const pad = trackPads(project, host.track())[host.pad()];
        if (pad)
          pad.playback = {
            mode: el<HTMLSelectElement>("pad-mode").value as "one-shot",
            rootNote: number("root-note"),
            chokeGroup: number("choke-group"),
          };
        return project;
      }),
    );
  }
  for (const id of ["pad-mode", "root-note", "choke-group"]) el(id).onchange = playback;
  el("instrument-track").onchange = () =>
    host.selectTrack(el<HTMLSelectElement>("instrument-track").value);
  el("machine-type").onchange = () =>
    run(() => {
      const machine = machines.instantiate(el<HTMLSelectElement>("machine-type").value);
      host.edit((project) => {
        const track = project.tracks.find((t) => t.id === host.track());
        if (track) track.machine = machine;
        return project;
      });
    });
  for (const id of ["reverse", "normalize"])
    el(id).onchange = () =>
      run(() =>
        host.edit((project) => {
          const pad = trackPads(project, host.track())[host.pad()];
          if (pad)
            pad.edit = {
              reverse: el<HTMLInputElement>("reverse").checked,
              normalize: el<HTMLInputElement>("normalize").checked,
            };
          return project;
        }),
      );
  el("crop").onclick = () =>
    run(() => {
      const start = number("wave-start"),
        end = number("wave-end");
      host.edit((project) => {
        const pad = trackPads(project, host.track())[host.pad()];
        // A crop plays one sound: the pad's own, without its velocity layers.
        if (pad) {
          pad.slice = { start, end };
          delete pad.layers;
        }
        return project;
      });
    });
  el("manual-slices").onclick = () =>
    run(() =>
      host.edit((project) =>
        manualSlices(
          project,
          host.pad(),
          el<HTMLInputElement>("slice-boundaries")
            .value.split(",")
            .map((v) => Number(v.trim())),
          host.track(),
        ),
      ),
    );
  el("chop-drum-kit").onclick = () =>
    run(() => {
      const project = host.project(),
        pad = trackPads(project, host.track())[host.pad()];
      const asset = project.samples.find((s) => s.id === pad?.sampleId);
      if (!asset) throw new Error("Sample unavailable");
      const points = el<HTMLInputElement>("slice-boundaries")
        .value.split(",")
        .map((v) => Number(v.trim()));
      host.edit((p) =>
        chopSampleToKit(p, host.track(), asset.name, asset.sampleRate, asset.pcm, points),
      );
      say("Chopped to this track’s drum kit · Undo restores");
    });
  el("sample-browser").onchange = () =>
    run(() =>
      host.edit((project) => {
        const pad = trackPads(project, host.track())[host.pad()];
        if (pad) {
          pad.sampleId = el<HTMLSelectElement>("sample-browser").value;
          delete pad.slice;
          delete pad.edit;
          delete pad.layers;
        }
        return project;
      }),
    );
  el("apply-note").onclick = () =>
    run(() =>
      host.edit((project) => {
        const track = project.tracks.find((t) => t.id === host.track()),
          scene = project.scenes.find((s) => s.id === host.scene()),
          clip = track?.clips.find((c) => c.id === scene?.clips[track.id]);
        const selected = Number(
            document.querySelector<HTMLElement>(".step.editing")?.dataset.step ?? 0,
          ),
          event = clip?.steps.find((e) => e.pad === host.pad() && e.step === selected);
        if (!event) throw new Error("Select an active step first");
        event.note = number("step-note");
        event.duration = number("step-duration");
        return project;
      }),
    );
  el("panic").onclick = () => {
    host.panic();
    host.status("All notes released");
  };
  el("synth-preset").onchange = () =>
    run(() => {
      const patch = synthPresets[number("synth-preset")];
      if (!patch) return;
      host.edit((project) => {
        const track = project.tracks.find((t) => t.id === host.track());
        if (track)
          track.machine = { id: "xmp.subtractive", base: "audio", version: 1, state: { ...patch } };
        return project;
      });
    });
  el("oscillator").onchange = () =>
    run(() =>
      host.edit((project) => {
        const track = project.tracks.find((t) => t.id === host.track());
        if (track?.machine?.id === "xmp.subtractive")
          track.machine.state.oscillator = el<HTMLSelectElement>("oscillator").value;
        return project;
      }),
    );
  function download(data: BlobPart, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([data], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  el("save-patch").onclick = () =>
    run(() => {
      const patch = SynthPatchSchema.parse(
        host.project().tracks.find((t) => t.id === host.track())?.machine?.state,
      );
      download(
        JSON.stringify({ format: "xmp-synth-patch", version: 1, patch }),
        "synth-patch.json",
        "application/json",
      );
    });
  el("open-patch").onclick = () => el<HTMLInputElement>("patch-file").click();
  el<HTMLInputElement>("patch-file").onchange = async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const revision = host.revision(),
      trackId = host.track();
    try {
      if (file.size > 32768) throw new Error("Patch exceeds 32 KiB");
      const value = JSON.parse(await file.text());
      if (value.format !== "xmp-synth-patch" || value.version !== 1)
        throw new Error("Unsupported patch");
      const patch = SynthPatchSchema.parse(value.patch);
      if (host.revision() !== revision) throw new Error("Project changed during patch import");
      host.edit((project) => {
        const track = project.tracks.find((t) => t.id === trackId);
        if (track)
          track.machine = { id: "xmp.subtractive", base: "audio", version: 1, state: patch };
        return project;
      });
    } catch (error) {
      host.status(String(error));
    } finally {
      (event.target as HTMLInputElement).value = "";
    }
  };
  el("choose-input").onclick = () => el<HTMLInputElement>("record-file").click();
  el<HTMLInputElement>("record-file").onchange = async (event) => {
    try {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        if (file.size > 4 * 1024 * 1024) throw new Error("Input exceeds 4 MiB");
        input = decodeSampleWav(new Uint8Array(await file.arrayBuffer()));
        armed = undefined;
        el<HTMLButtonElement>("start-record").disabled = true;
        say(`WAV selected · ${input.pcm.length} frames at ${input.sampleRate} Hz`);
      }
    } catch (error) {
      say(String(error));
    }
  };
  el("record-source").onchange = () => {
    armed = undefined;
    el<HTMLButtonElement>("start-record").disabled = true;
    say("Source changed · arm again");
  };
  const json = async (path: string, options?: RequestInit) => {
    const r = await fetch(`${import.meta.env.BASE_URL}api/recording/${path}`, options);
    const value = await r.json();
    if (!r.ok) throw new Error(value.error ?? "Recorder unavailable");
    return value;
  };
  el("arm-record").onclick = async () => {
    try {
      if (recording) throw new Error("Recording is active");
      if (!el<HTMLInputElement>("monitor-levels").checked)
        throw new Error("Enable input level monitoring first");
      const source = el<HTMLSelectElement>("record-source").value;
      const rate = source === "mac" ? (await json("input")).sampleRate : input?.sampleRate;
      if (!rate) throw new Error("Choose a WAV input first");
      const plan = recordingPlan(host.project(), rate, host.pad());
      armed = { revision: host.revision(), pad: host.pad(), source, rate, frames: plan.frames };
      el<HTMLButtonElement>("start-record").disabled = false;
      say(`Armed · ${plan.frames} frames · press Start recording`);
    } catch (error) {
      say(String(error));
    }
  };
  el("start-record").onclick = async () => {
    try {
      if (!armed || recording) throw new Error("Arm before recording");
      if (armed.revision !== host.revision() || armed.pad !== host.pad())
        throw new Error("Project or destination changed; arm again");
      recording = true;
      el<HTMLButtonElement>("start-record").disabled = true;
      el<HTMLButtonElement>("keep-take").disabled = true;
      take = undefined;
      const recorder = new TakeRecorder();
      recorder.arm({ frames: armed.frames, sampleRate: armed.rate, budget: armed.frames });
      recorder.start();
      if (armed.source === "wav") {
        const pcm = input?.pcm;
        if (!pcm) throw new Error("No WAV input");
        for (let i = 0; i < pcm.length && recorder.state === "recording"; i += 256)
          recorder.push(pcm.subarray(i, i + 256));
        if (recorder.state === "recording") recorder.interrupt("Input ended before two bars");
        take = {
          pcm: recorder.take,
          sampleRate: recorder.sampleRate,
          partial: recorder.state === "interrupted",
        };
        (el("input-meter") as HTMLMeterElement).value = recorder.peak;
      } else {
        const response = await json("start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bpm: host.project().bpm }),
        });
        say("Recording built-in microphone · two bars…");
        for (let polls = 0; polls < 160; polls++) {
          const state = await json(`status?id=${response.id}`);
          (el("input-meter") as HTMLMeterElement).value = state.peak ?? 0;
          if (state.state !== "recording") {
            if (!state.hasTake) throw new Error(state.reason ?? "No recoverable microphone take");
            const r = await fetch(
              `${import.meta.env.BASE_URL}api/recording/take?id=${response.id}`,
            );
            if (!r.ok) throw new Error("Could not retrieve local take");
            take = {
              ...decodeSampleWav(new Uint8Array(await r.arrayBuffer())),
              partial: state.state !== "recorded",
            };
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!take)
          throw new Error("Recorder did not finish; any partial take remains in local reports");
      }
      el<HTMLButtonElement>("keep-take").disabled = false;
      say(
        `${take.partial ? "Interrupted — recoverable" : "Complete"} take: ${take.pcm.length} frames. Keep take to change the project.`,
      );
    } catch (error) {
      say(String(error));
    } finally {
      recording = false;
    }
  };
  el("keep-take").onclick = () =>
    run(() => {
      if (!take || !armed) throw new Error("No take to keep");
      if (host.revision() !== armed.revision)
        throw new Error(
          "Project changed while recording. Download the take and choose its destination again.",
        );
      host.edit((project) =>
        installSample(
          project,
          armed?.pad ?? host.pad(),
          take?.partial ? "Recovered take" : "Recorded take",
          take?.sampleRate ?? 48000,
          take?.pcm ?? new Float32Array(),
          host.track(),
        ),
      );
      el<HTMLButtonElement>("keep-take").disabled = true;
      say("Take kept · Undo restores the previous sound");
    });
  const downloadTake = document.createElement("button");
  downloadTake.id = "download-take";
  downloadTake.textContent = "Download take";
  downloadTake.onclick = () =>
    run(() => {
      if (!take) throw new Error("No recoverable take");
      download(encodeWav([take.pcm], take.sampleRate), "take.wav", "audio/wav");
    });
  el("record-status").after(downloadTake);
  el("resample").onclick = () =>
    run(() => {
      const project = host.project(),
        plan = recordingPlan(project, 48000, host.pad(), host.track()),
        rendered = renderInstrumentScene(project, host.scene(), 32);
      if (rendered.pcm.length !== plan.frames) throw new Error("Resample length mismatch");
      host.edit((next) =>
        installSample(next, host.pad(), "Resampled master", 48000, rendered.pcm, host.track()),
      );
      say("Two bars of the internal master captured · Undo restores the previous sound");
    });
  return {
    capabilities: inputCapabilities,
    draw() {
      const project = host.project(),
        track = project.tracks.find((t) => t.id === host.track()),
        pad = trackPads(project, host.track())[host.pad()],
        sample = project.samples.find((s) => s.id === pad?.sampleId);
      if (!track || !pad || !sample) return;
      el("instrument-track").innerHTML = project.tracks
        .map((t, i) => `<option value="${t.id}">${i + 1}. ${escapeText(t.name)}</option>`)
        .join("");
      el<HTMLSelectElement>("instrument-track").value = track.id;
      const selected = track.machine?.id ?? "xmp.sampler",
        definition = machines.get(track.machine);
      el("machine-type").innerHTML =
        machines
          .list()
          .map((m) => `<option value="${m.id}">${escapeText(m.name)} · ${m.base}</option>`)
          .join("") +
        (definition
          ? ""
          : `<option value="${escapeText(selected)}">Missing: ${escapeText(selected)}</option>`);
      el<HTMLSelectElement>("machine-type").value = selected;
      el("machine-state").textContent = definition
        ? `${definition.capabilities.join(" · ")}${definition.base === "midi" ? " · internal routing available for the built-in MIDI machine; physical output disabled" : ""}`
        : "Machine unavailable — saved state retained; no sound fallback";
      el("machine-parameters").innerHTML =
        (definition?.parameters ?? [])
          .map(
            (p) =>
              `<label>${escapeText(p.name)} (${escapeText(p.unit)}) <input data-machine-param="${p.id}" aria-label="Machine ${escapeText(p.name)}" type="number" min="${p.min}" max="${p.max}" step="any" value="${Number(track.machine?.state[p.id] ?? p.defaultValue)}"></label>`,
          )
          .join("") + midiRoutingView(project, track.id, "midi-destination");
      const destination = document.getElementById("midi-destination") as HTMLSelectElement | null;
      if (destination)
        destination.onchange = () =>
          run(() =>
            host.edit((next) => setMidiDestination(next, track.id, destination.value || undefined)),
          );
      for (const control of el("machine-parameters").querySelectorAll<HTMLInputElement>("input")) {
        control.dataset.parameter = `track.${track.id}.machine.${track.machine?.id}.v${track.machine?.version}.${control.dataset.machineParam}`;
        control.dataset.track = track.id;
        control.onchange = () =>
          run(() =>
            host.edit((next) => {
              const current = next.tracks.find((t) => t.id === track.id);
              if (current?.machine)
                current.machine.state[control.dataset.machineParam ?? ""] = Number(control.value);
              return next;
            }),
          );
      }
      el("synth-controls").hidden = selected !== "xmp.subtractive";
      const sampleMachine = selected === "xmp.sampler";
      for (const id of ["sample-browser", "pad-mode", "root-note", "choke-group"]) {
        const label = el(id).closest<HTMLElement>("label");
        if (label) label.hidden = !sampleMachine;
      }
      const waveformColumn = el("waveform").parentElement;
      if (waveformColumn) waveformColumn.hidden = !sampleMachine;
      if (selected === "xmp.subtractive") {
        el<HTMLSelectElement>("oscillator").value = String(track.machine?.state.oscillator);
        el<HTMLSelectElement>("synth-preset").value = String(
          synthPresets.findIndex((p) => JSON.stringify(p) === JSON.stringify(track.machine?.state)),
        );
      }
      el("sample-browser").innerHTML = project.samples
        .map((s) => `<option value="${s.id}">${escapeText(s.name)}</option>`)
        .join("");
      el<HTMLSelectElement>("sample-browser").value = pad.sampleId;
      el<HTMLSelectElement>("pad-mode").value = pad.playback?.mode ?? "one-shot";
      el<HTMLInputElement>("root-note").value = String(pad.playback?.rootNote ?? 60);
      el<HTMLInputElement>("choke-group").value = String(pad.playback?.chokeGroup ?? 0);
      el<HTMLInputElement>("reverse").checked = pad.edit?.reverse ?? false;
      el<HTMLInputElement>("normalize").checked = pad.edit?.normalize ?? false;
      const start = pad.slice?.start ?? 0,
        end = pad.slice?.end ?? sample.pcm.length;
      const points = Array.from({ length: 160 }, (_, i) => {
        const at = Math.min(sample.pcm.length - 1, Math.floor((i / 159) * sample.pcm.length));
        return `${(i / 159) * 400},${50 - (sample.pcm[at] ?? 0) * 45}`;
      }).join(" ");
      el<HTMLInputElement>("wave-start").value = String(start);
      el<HTMLInputElement>("wave-end").value = String(end);
      el("midi-preview").hidden = definition?.base !== "midi";
      el("waveform").innerHTML =
        `<rect x="0" y="0" width="400" height="100" fill="#0a1511"/><rect x="${(start / sample.pcm.length) * 400}" y="0" width="${((end - start) / sample.pcm.length) * 400}" height="100" fill="#1b382c"/><polyline points="${points}" fill="none" stroke="#f2d685" stroke-width="1.5"/>`;
      el("waveform-info").textContent =
        `Original ${sample.pcm.length} frames · selected ${start}–${end} · ${editedPcm(project, host.pad(), host.track()).length} playable frames`;
    },
  };
}
