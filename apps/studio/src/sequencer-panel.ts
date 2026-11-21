import type { Project } from "@xmp/core";
import {
  appendNotes,
  duplicateClip,
  editSequence,
  parameterFrame,
  parameterRegistry,
  quantizeNotes,
} from "../../../packages/core/src/edits.ts";
import type { SequenceNote } from "../../../packages/core/src/sequence-schema.ts";
import {
  type AutomationMode,
  AutomationTake,
  clipFor,
  groovePosition,
  NoteRepeat,
  NoteTake,
} from "../../../packages/core/src/sequencer.ts";
import type { StudioAudio } from "./audio.ts";

interface Host {
  project: () => Project;
  track: () => string;
  clip: () => string;
  pad: () => number;
  scene: () => string;
  revision: () => number;
  edit: (change: (p: Project) => Project) => void;
  status: (text: string) => void;
  audio: StudioAudio;
}
export function installSequencerPanel(host: Host) {
  const root = document.getElementById("sequencer-panel");
  if (!root) throw new Error("Missing sequencer panel");
  root.innerHTML = `<div class="panel-head"><div><div class="eyebrow">PATTERN & EXPRESSION</div><h2>Notes, groove & automation</h2></div><label><input id="seq-fill" type="checkbox"> Fill held</label></div>
  <div class="instrument-columns"><div><label>Pattern <select id="seq-clip" aria-label="Sequencer pattern"></select></label><button id="seq-copy">Duplicate pattern</button>
  <div class="sequence-entry"><label>Position (steps, zero based) <input id="seq-position" type="number" min="0" max="63.999" step="0.01" value="0"></label><label>MIDI notes (comma separated) <input id="seq-pitches" value="48, 55, 60"></label><label>Note length (steps) <input id="seq-length" type="number" min="0.0011" max="64" step="0.25" value="1"></label><button id="seq-add">Add chord on selected pad</button></div>
  <div class="sequence-actions"><label>Quantize grid <select id="seq-grid"><option value="1">Sixteenth</option><option value="0.5">Thirty-second</option><option value="0.25">Sixty-fourth</option><option value="2">Eighth</option></select></label><button id="seq-quantize">Quantize selected</button><button id="seq-restore">Restore played timing</button><button id="seq-delete">Delete selected notes</button></div>
  <label>Microtiming (steps) <input id="seq-micro" type="number" min="-0.49" max="0.49" step="0.01" value="0"></label><label>Note probability <input id="seq-probability" type="number" min="0" max="1" step="0.01" value="1"></label><label>Trigger condition <select id="seq-condition"><option>always</option><option>first</option><option>not-first</option><option>fill</option><option>not-fill</option><option>every-2</option><option>every-4</option></select></label><button id="seq-expression">Apply length & expression to selected</button>
  <p class="small">Select note rows to edit. Played timestamps and velocity survive quantization. Microtiming clamps inside each clip; shortening a clip releases current voices.</p>
  <div class="note-list" id="seq-notes" aria-label="Recorded notes"></div>
  <button id="seq-record">Record note pass</button><button id="seq-finish" disabled>Finish note pass</button>
  <label><input id="seq-repeat" type="checkbox"> Clocked note repeat</label><label>Repeat division <select id="seq-repeat-grid"><option value="1">Sixteenth</option><option value="0.5">Thirty-second</option><option value="0.25">Sixty-fourth</option></select></label><label>Repeat velocity <input id="seq-repeat-velocity" type="number" min="0" max="1" step="0.05" value="0.6"></label>
  <p class="small">Mac keys/pointer provide fixed velocity; pressure unavailable. Repeats follow the clock and skip missed ticks after a UI stall. Release, blur or stop cancels held repeats.</p></div>
  <div><label>Parameter <select id="seq-parameter" aria-label="Sequencer parameter"></select></label><label>Normalized value <input id="seq-value" aria-label="Automation value" type="range" min="0" max="1" step="0.001" value="0.5"></label><output id="seq-value-text">0.500</output>
  <button id="seq-lock">Lock at entered step</button><button id="seq-unlock">Remove lock at entered step</button>
  <div class="sequence-entry"><label>Modulation type <select id="seq-mod-kind"><option value="macro">Macro</option><option value="lfo">LFO</option></select></label><label>Offset amount <input id="seq-mod-amount" type="number" min="-1" max="1" step="0.05" value="0.1"></label><label>LFO cycles per clip <input id="seq-mod-cycles" type="number" min="0.0625" max="16" step="0.25" value="1"></label><button id="seq-mod-add">Set modulation source</button><button id="seq-mod-remove">Remove modulation source</button></div>
  <label>Automation mode <select id="seq-auto-mode"><option value="touch">Touch</option><option value="latch">Latch</option><option value="write">Write</option></select></label><button id="seq-auto-record">Record automation pass</button><button id="seq-auto-finish" disabled>Finish automation pass</button>
  <svg id="seq-lane" role="img" aria-label="Selected automation lane" viewBox="0 0 400 100"></svg><p id="seq-summary" class="small"></p>
  <button id="seq-download-pass" disabled>Download captured pass</button>
  <p id="seq-status" role="status">No recording armed · virtual controls only</p></div></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing ${id}`);
    return value as T;
  };
  const value = (id: string) => Number(el<HTMLInputElement>(id).value),
    text = (id: string) => el<HTMLInputElement>(id).value;
  const selected = new Set<string>();
  let selectionContext = "";
  let counter = 0;
  const say = (message: string) => {
    el("seq-status").textContent = message;
    host.status(message);
  };
  const run = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      say(String(error));
    }
  };
  const clip = () => clipFor(host.project(), host.track(), host.clip());
  const edit = (change: Parameters<typeof editSequence>[3]) =>
    host.edit((p) => editSequence(p, host.track(), host.clip(), change));
  let notePass:
    | {
        take: NoteTake;
        revision: number;
        track: string;
        clip: string;
        start: number;
        length: number;
        repeats: SequenceNote[];
      }
    | undefined;
  let autoPass:
    | {
        take: AutomationTake;
        revision: number;
        track: string;
        clip: string;
        start: number;
        length: number;
      }
    | undefined;
  const repeats = new Map<number, { repeat: NoteRepeat; track: string }>();
  let captured: unknown;
  const retain = (value: unknown) => {
    captured = value;
    el<HTMLButtonElement>("seq-download-pass").disabled = false;
  };
  el("seq-download-pass").onclick = () => {
    if (!captured) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ format: "xmp-sequence-draft", version: 1, data: captured })], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "sequence-pass.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const finishNotes = () =>
    run(() => {
      const pass = notePass;
      if (!pass) return;
      notePass = undefined;
      repeats.clear();
      el<HTMLButtonElement>("seq-finish").disabled = true;
      el<HTMLButtonElement>("seq-record").disabled = false;
      const seconds =
        (Math.min(pass.length, Math.max(0, host.audio.position - pass.start)) * 60) /
        host.project().bpm /
        4;
      const notes = [...pass.take.finish(seconds), ...pass.repeats];
      retain({ kind: "notes", track: pass.track, clip: pass.clip, notes });
      if (pass.revision !== host.revision())
        throw new Error(
          "Project changed during note pass; use Download captured pass to keep the draft",
        );
      if (notes.length) host.edit((p) => appendNotes(p, pass.track, pass.clip, notes));
      say(`${notes.length} notes committed as one undoable pass`);
    });
  const finishAutomation = () =>
    run(() => {
      const pass = autoPass;
      if (!pass) return;
      autoPass = undefined;
      el<HTMLButtonElement>("seq-auto-finish").disabled = true;
      el<HTMLButtonElement>("seq-auto-record").disabled = false;
      host.audio.clearAutomation();
      const lane = pass.take.stop(
        Math.min(pass.length, Math.max(0, host.audio.position - pass.start)),
      );
      retain({ kind: "automation", track: pass.track, clip: pass.clip, lane });
      if (pass.revision !== host.revision())
        throw new Error(
          "Project changed during automation; use Download captured pass to keep the draft",
        );
      host.edit((p) =>
        editSequence(p, pass.track, pass.clip, (s) => {
          s.lanes = s.lanes.filter((l) => l.parameter !== lane.parameter);
          s.lanes.push(lane);
        }),
      );
      say("Automation finalized · Undo restores the previous lane · write mode disarmed");
    });
  el("seq-add").onclick = () =>
    run(() => {
      const pitches = text("seq-pitches")
        .split(",")
        .map((n) => Number(n.trim()));
      if (pitches.length < 1 || pitches.length > 16) throw new Error("Enter 1–16 MIDI notes");
      const used = new Set(clip().sequence?.notes.map((n) => n.id));
      const notes = pitches.map((note) => {
        let id: string;
        do {
          id = `entry-${counter++}`;
        } while (used.has(id));
        return {
          id,
          pad: host.pad(),
          note,
          position: value("seq-position"),
          duration: value("seq-length"),
          velocity: 0.8,
          probability: 1,
          microtiming: 0,
          condition: "always" as const,
        };
      });
      host.edit((p) => appendNotes(p, host.track(), host.clip(), notes));
      say("Chord added · select its note rows to edit");
    });
  el("seq-copy").onclick = () =>
    run(() => {
      host.edit((p) => {
        const next = duplicateClip(p, host.track(), host.clip()),
          track = next.tracks.find((t) => t.id === host.track()),
          scene = next.scenes.find((s) => s.id === host.scene());
        const copied = track?.clips.at(-1);
        if (scene && copied) scene.clips[host.track()] = copied.id;
        return next;
      });
      say("Pattern copied and selected");
    });
  el("seq-clip").onchange = () =>
    run(() => {
      const id = text("seq-clip");
      host.audio.panic();
      host.edit((p) => {
        const scene = p.scenes.find((s) => s.id === host.scene());
        if (scene) scene.clips[host.track()] = id;
        return p;
      });
    });
  for (const [id, restore] of [
    ["seq-quantize", false],
    ["seq-restore", true],
  ] as const)
    el(id).onclick = () =>
      run(() => {
        if (!selected.size) throw new Error("Select notes first");
        host.edit((p) =>
          quantizeNotes(p, host.track(), host.clip(), [...selected], value("seq-grid"), restore),
        );
        say(restore ? "Played timing restored" : "Only selected notes quantized");
      });
  el("seq-delete").onclick = () =>
    run(() => {
      host.audio.panic();
      edit((s) => {
        s.notes = s.notes.filter((n) => !selected.has(n.id));
      });
      selected.clear();
    });
  el("seq-expression").onclick = () =>
    run(() =>
      edit((s) => {
        for (const n of s.notes)
          if (selected.has(n.id)) {
            n.duration = value("seq-length");
            n.microtiming = value("seq-micro");
            n.probability = value("seq-probability");
            n.condition = text("seq-condition") as SequenceNote["condition"];
          }
      }),
    );
  el("seq-notes").onchange = (event) => {
    const input = event.target as HTMLInputElement;
    const id = input.dataset.note;
    if (id) {
      if (input.checked) selected.add(id);
      else selected.delete(id);
    }
  };
  el("seq-fill").onchange = () => {
    host.audio.fill = el<HTMLInputElement>("seq-fill").checked;
  };
  el("seq-record").onclick = async () => {
    try {
      if (notePass || autoPass) throw new Error("Finish the active pass first");
      const c = clip();
      await host.audio.enable();
      notePass = {
        take: new NoteTake(c.length, host.project().bpm, `take-${Date.now().toString(36)}`),
        revision: host.revision(),
        track: host.track(),
        clip: host.clip(),
        start: host.audio.playing ? Math.floor(host.audio.position / c.length) * c.length : 0,
        length: c.length,
        repeats: [],
      };
      el<HTMLButtonElement>("seq-record").disabled = true;
      el<HTMLButtonElement>("seq-finish").disabled = false;
      if (!host.audio.playing) host.audio.start(host.scene());
      say("Recording one note pass · play pads, then Finish or Stop");
    } catch (error) {
      say(String(error));
    }
  };
  el("seq-finish").onclick = finishNotes;
  el("seq-lock").onclick = () =>
    run(() =>
      edit((s) => {
        const parameter = text("seq-parameter"),
          position = Math.floor(value("seq-position"));
        s.locks = s.locks.filter((l) => l.parameter !== parameter || l.position !== position);
        s.locks.push({ parameter, position, value: value("seq-value") });
      }),
    );
  el("seq-unlock").onclick = () =>
    run(() =>
      edit((s) => {
        s.locks = s.locks.filter(
          (l) =>
            l.parameter !== text("seq-parameter") ||
            l.position !== Math.floor(value("seq-position")),
        );
      }),
    );
  el("seq-mod-add").onclick = () =>
    run(() =>
      edit((s) => {
        const kind = text("seq-mod-kind") as "macro" | "lfo",
          id = `panel-${kind}`;
        s.modulations = s.modulations.filter((m) => m.id !== id);
        s.modulations.push({
          id,
          kind,
          parameter: text("seq-parameter"),
          amount: value("seq-mod-amount"),
          cycles: value("seq-mod-cycles"),
          phase: 0,
        });
      }),
    );
  el("seq-mod-remove").onclick = () =>
    run(() =>
      edit((s) => {
        s.modulations = s.modulations.filter((m) => m.id !== `panel-${text("seq-mod-kind")}`);
      }),
    );
  el("seq-auto-record").onclick = async () => {
    try {
      if (autoPass || notePass) throw new Error("Finish the active pass first");
      const c = clip(),
        parameter = text("seq-parameter");
      await host.audio.enable();
      autoPass = {
        take: new AutomationTake(
          c.sequence?.lanes.find((l) => l.parameter === parameter) ?? {
            parameter,
            points: [
              {
                position: 0,
                value: parameterFrame(host.project(), host.scene(), 0)[parameter] ?? 0.5,
              },
            ],
          },
          text("seq-auto-mode") as AutomationMode,
          host.audio.playing ? host.audio.position % c.length : 0,
        ),
        revision: host.revision(),
        track: host.track(),
        clip: host.clip(),
        start: host.audio.playing ? Math.floor(host.audio.position / c.length) * c.length : 0,
        length: c.length,
      };
      el<HTMLButtonElement>("seq-auto-finish").disabled = false;
      el<HTMLButtonElement>("seq-auto-record").disabled = true;
      if (!host.audio.playing) host.audio.start(host.scene());
      if (autoPass.take.mode === "write")
        host.audio.automate(
          { [parameter]: autoPass.take.heldValue ?? value("seq-value") },
          parameter,
        );
      say(`Recording ${autoPass.take.mode} automation · move Normalized value`);
    } catch (error) {
      say(String(error));
    }
  };
  el("seq-auto-finish").onclick = finishAutomation;
  el("seq-value").oninput = () =>
    run(() => {
      const v = value("seq-value");
      el("seq-value-text").textContent = v.toFixed(3);
      if (autoPass) {
        autoPass.take.touch(
          Math.min(autoPass.length, Math.max(0, host.audio.position - autoPass.start)),
          v,
        );
        host.audio.automate(
          {
            ...parameterFrame(host.project(), host.scene(), host.audio.position),
            [autoPass.take.original.parameter]: v,
          },
          autoPass.take.original.parameter,
        );
      }
    });
  const releaseAutomation = () =>
    run(() => {
      if (autoPass?.take.mode === "touch") host.audio.clearAutomation();
      if (autoPass)
        autoPass.take.release(
          Math.min(autoPass.length, Math.max(0, host.audio.position - autoPass.start)),
        );
    });
  el("seq-value").onpointerup = releaseAutomation;
  el("seq-value").onkeyup = releaseAutomation;
  el("seq-parameter").onchange = () => {
    el<HTMLInputElement>("seq-value").value = String(
      parameterFrame(host.project(), host.scene(), host.audio.position)[text("seq-parameter")] ??
        0.5,
    );
    draw();
  };
  function draw() {
    try {
      const c = clip(),
        track = host.project().tracks.find((t) => t.id === host.track());
      if (!track) return;
      const context = `${track.id}:${c.id}`;
      if (context !== selectionContext) {
        selected.clear();
        selectionContext = context;
      }
      el("seq-clip").innerHTML = track.clips
        .map((c) => `<option value="${c.id}"></option>`)
        .join("");
      for (const option of el<HTMLSelectElement>("seq-clip").options)
        option.textContent = track.clips.find((c) => c.id === option.value)?.name ?? "Pattern";
      el<HTMLSelectElement>("seq-clip").value = c.id;
      const param = el<HTMLSelectElement>("seq-parameter"),
        current = param.value;
      param.innerHTML = "";
      for (const p of parameterRegistry(host.project()).filter(
        (p) =>
          p.id === "master.gain" ||
          p.id.startsWith("return.") ||
          p.id.startsWith(`track.${host.track()}.`),
      )) {
        const option = document.createElement("option");
        option.value = p.id;
        option.textContent = p.name;
        param.append(option);
      }
      if ([...param.options].some((o) => o.value === current)) param.value = current;
      el("seq-notes").innerHTML =
        (c.sequence?.notes ?? [])
          .map(
            (n) =>
              `<label class="note-row"><input type="checkbox" data-note="${n.id}" ${selected.has(n.id) ? "checked" : ""}> ${n.note} · step ${n.position.toFixed(3)} · length ${n.duration.toFixed(3)} · velocity ${n.velocity.toFixed(2)}${n.original ? ` · played ${n.original.position.toFixed(3)}` : ""}</label>`,
          )
          .join("") || "No recorded notes yet. Existing pad steps remain in the pattern above.";
      const seq = c.sequence,
        lane = seq?.lanes.find((l) => l.parameter === param.value);
      el("seq-summary").textContent =
        `${seq?.notes.length ?? 0} notes · ${seq?.locks.length ?? 0} locks · ${seq?.modulations.length ?? 0} modulation sources · ${seq?.lanes.length ?? 0} lanes`;
      const points =
        lane?.points
          .map((p) => `${(p.position / c.length) * 400},${100 - p.value * 100}`)
          .join(" ") ?? "";
      el("seq-lane").innerHTML =
        `<rect width="400" height="100" fill="#0a1511"/><polyline points="${points}" fill="none" stroke="#f2d685" stroke-width="2"/>`;
    } catch {
      el("seq-summary").textContent = "Create a pattern in this scene first";
    }
  }
  return {
    draw,
    finishNotes,
    finishAutomation,
    noteOn(pad: number, note: number, velocity: number) {
      if (el<HTMLInputElement>("seq-repeat").checked && host.audio.playing) {
        const repeat = new NoteRepeat(false, value("seq-repeat-grid"));
        repeat.hold(note, pad, value("seq-repeat-velocity"), host.audio.position);
        repeats.set(pad, { repeat, track: host.track() });
        return true;
      }
      run(() => {
        if (notePass)
          notePass.take.on(
            String(pad),
            pad,
            note,
            velocity,
            (Math.max(0, host.audio.position - notePass.start) * 60) / host.project().bpm / 4,
          );
      });
      return false;
    },
    noteOff(pad: number) {
      repeats.get(pad)?.repeat.release();
      repeats.delete(pad);
      run(() => {
        if (notePass)
          notePass.take.off(
            String(pad),
            (Math.max(0, host.audio.position - notePass.start) * 60) / host.project().bpm / 4,
          );
      });
    },
    tick(position: number, at: number) {
      for (const held of repeats.values()) {
        held.repeat.skipTo(position);
        for (const n of held.repeat.ticks(position + 1)) {
          const time =
            at +
            ((groovePosition(n.position, host.project().swing) -
              groovePosition(position, host.project().swing)) *
              60) /
              host.project().bpm /
              4;
          host.audio.trigger(
            n.pad,
            n.velocity,
            time,
            held.track,
            n.note,
            Math.round(
              ((n.duration * 60) / host.project().bpm / 4) * (host.audio.sampleRate || 48000),
            ),
          );
          if (notePass) {
            const local = n.position - notePass.start;
            if (local >= 0 && local < notePass.length)
              notePass.repeats.push({
                ...n,
                id: `repeat-${counter++}`,
                position: local,
                duration: Math.min(n.duration, notePass.length - local),
                original: {
                  position: local,
                  duration: n.duration,
                  velocity: n.velocity,
                  timestamp: (local * 60) / host.project().bpm / 4,
                },
              });
          }
        }
      }
    },
    observe(_position: number) {
      const position = host.audio.position;
      if (notePass && position >= notePass.start + notePass.length) finishNotes();
      if (autoPass && position >= autoPass.start + autoPass.length) finishAutomation();
    },
    stop() {
      repeats.clear();
      finishNotes();
      finishAutomation();
    },
  };
}
