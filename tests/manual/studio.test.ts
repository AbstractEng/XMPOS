// @vitest-environment happy-dom
// The manual's Advanced Studio instructions, performed in order through the
// Studio interface (?view=studio): its view tabs, buttons, fields and file inputs.
// Audio output is a recording stand-in; no AudioContext, microphone or MIDI device
// is opened.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Project } from "@xmp/core";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { encodeMidi, loadCore } from "../../packages/core/src/edits.ts";
import { studioLists } from "./lists.ts";
import { manualJourney } from "./steps.ts";

const mock = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  audio: {
    playing: false,
    state: "off",
    sampleRate: 48000,
    lateSteps: 0,
    position: 0,
    clockAnchor: 0,
    midiTrace: [] as unknown[],
    queuedLaunch: undefined as string | undefined,
    performanceSnapshot: undefined as unknown,
    setProject: vi.fn(),
    enable: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    panic: vi.fn(),
    noteOff: vi.fn(),
    trigger: vi.fn(),
    queueScene: vi.fn(),
    queueClip: vi.fn(),
    cancelLaunch: vi.fn(),
    performanceControl: vi.fn(),
    automate: vi.fn(),
    clearAutomation: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock("../../apps/studio/src/storage.ts", () => ({
  loadProjectState: async () => ({}),
  saveProject: mock.save,
}));
vi.mock("../../apps/studio/src/audio.ts", () => ({
  StudioAudio: vi.fn(function AudioMock() {
    return mock.audio;
  }),
  renderScene: vi.fn(),
}));

const media = resolve(import.meta.dirname, "../../apps/studio/public/manual-media");
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const click = async (id: string) => {
  el(id).click();
  await settle();
};
const set = async (id: string, value: string, type = "change") => {
  el<HTMLInputElement>(id).value = value;
  el(id).dispatchEvent(new Event(type, { bubbles: true }));
  await settle();
};
const check = async (id: string, on = true) => {
  el<HTMLInputElement>(id).checked = on;
  el(id).dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
};
const view = async (name: string) => {
  document.querySelector<HTMLButtonElement>(`[data-view="${name}"]`)?.click();
  await settle();
};
const files = async (id: string, list: unknown[]) => {
  Object.defineProperty(el(id), "files", { configurable: true, value: list });
  el(id).dispatchEvent(new Event("change", { bubbles: true }));
  await settle(12);
};
const project = () => {
  if (!mock.project) throw new Error("No project");
  return mock.project;
};
const snapshot = () => JSON.stringify(project());
const status = () => el("status").textContent ?? "";
const wav = () => {
  const bytes = readFileSync(`${media}/sound-swap/Handclap.wav`);
  return new File([bytes], "Handclap.wav", { type: "audio/wav" });
};
const selectedTrack = () => {
  const id = document.querySelector<HTMLButtonElement>(
    "[data-track].active, [data-track][aria-pressed='true']",
  )?.dataset.track;
  return project().tracks.find((t) => t.id === id) ?? project().tracks[0];
};

beforeAll(async () => {
  mock.audio.setProject.mockImplementation((p: Project) => {
    mock.project = p;
  });
  mock.audio.queueScene.mockImplementation((id: string) => {
    mock.audio.queuedLaunch = id;
  });
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      throw new Error("Device output forbidden in manual tests");
    }),
  );
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(new Error("No microphone"))) },
  });
  vi.stubGlobal(
    "showOpenFilePicker",
    vi.fn(() => {
      throw new Error("No physical files opened by test");
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  await loadCore();
  await import("../../apps/studio/src/main.ts");
  await settle(20);
}, 60000);
afterAll(() => vi.unstubAllGlobals());

const journey = manualJourney(studioLists);
journey.coverage();
const { step: does } = journey;

// ---- Sounds: import, trim and slice ----
journey.list("sounds › Import, trim and slice");
does(
  "Step 1",
  "Select a pad and use Pattern → Import WAV, or choose an existing Project sound in Sounds.",
  async () => {
    await view("pattern");
    document.querySelector<HTMLElement>('#pads [data-pad="1"], [data-pad="1"]')?.click();
    await settle();
    el("import"); // Pattern → Import WAV, beside the selected sound
    await view("sounds");
    const browser = el<HTMLSelectElement>("sample-browser");
    const other = [...browser.options].find((o) => o.value && o.value !== browser.value);
    if (!other) throw new Error("No other project sound");
    await set("sample-browser", other.value);
    expect(project().pads.some((p) => p.sampleId === other.value)).toBe(true);
  },
);
does(
  "Step 2",
  "Set Start frame and End frame in the waveform editor. Use Crop to selected frames, Reverse or Normalize to shape playback. These edits preserve the original sample data and support Undo.",
  async () => {
    const samples = JSON.stringify(project().samples);
    const before = snapshot();
    await set("wave-start", "10");
    await set("wave-end", "200");
    await click("crop");
    expect(project().pads.some((p) => p.slice?.start === 10 && p.slice.end === 200)).toBe(true);
    await check("reverse");
    await check("normalize");
    expect(project().pads.some((p) => p.edit?.reverse && p.edit.normalize)).toBe(true);
    expect(JSON.stringify(project().samples)).toBe(samples);
    for (let i = 0; i < 3; i++) await click("undo");
    expect(snapshot()).toBe(before);
  },
);
does(
  "Step 3",
  "For multiple slices, enter increasing frame boundaries such as 0, 1200, 2400, 3600 and click Assign slices to successive pads. Each range uses the same original asset.",
  async () => {
    await set("slice-boundaries", "0, 1200, 2400, 3600", "input");
    await click("manual-slices");
    const sliced = project().pads.filter((p) => p.slice);
    expect(sliced.map((p) => [p.slice?.start, p.slice?.end])).toEqual([
      [0, 1200],
      [1200, 2400],
      [2400, 3600],
    ]);
    expect(new Set(sliced.map((p) => p.sampleId)).size).toBe(1);
    await click("undo");
  },
);

// ---- Patterns: polyphonic note entry ----
journey.list("patterns › Polyphonic note entry");
// The notes of the Pattern chosen in Notes, groove & automation.
const clipNotes = () =>
  project()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === el<HTMLSelectElement>("seq-clip").value)?.sequence?.notes ?? [];
does("Step 1", "In Pattern → Notes, groove & automation, choose a Pattern.", async () => {
  await view("pattern");
  const notes = [...document.querySelectorAll("summary, h2, h3")].find((h) =>
    /Notes, groove/.test(h.textContent ?? ""),
  );
  expect(notes).toBeDefined();
  const clip = el<HTMLSelectElement>("seq-clip");
  await set("seq-clip", clip.options[1]?.value ?? clip.value);
  expect(clip.value).toBe(clip.options[1]?.value ?? clip.value);
});
does(
  "Step 2",
  "Enter a zero-based Position, comma-separated MIDI notes and a Note length measured in sixteenth steps. For example, position 0, notes 48, 55, 60, length 4.",
  async () => {
    await set("seq-position", "0", "input");
    await set("seq-pitches", "48, 55, 60", "input");
    await set("seq-length", "4", "input");
    expect(el<HTMLInputElement>("seq-pitches").value).toBe("48, 55, 60");
  },
);
does(
  "Step 3",
  "Click Add chord on selected pad. Select rows in the note list to delete, quantize, restore played timing, or apply length and expression.",
  async () => {
    const before = clipNotes().length;
    await click("seq-add");
    const chord = clipNotes().slice(before);
    expect(chord.map((n) => [n.note, n.position, n.duration])).toEqual([
      [48, 0, 4],
      [55, 0, 4],
      [60, 0, 4],
    ]);
    const rows = [...document.querySelectorAll<HTMLInputElement>("[data-note]")];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const id of ["seq-delete", "seq-quantize", "seq-restore", "seq-expression"]) el(id);
    const row = rows.at(-1);
    if (!row) throw new Error("No note row");
    row.checked = true;
    row.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await click("seq-delete");
    expect(clipNotes().length).toBe(before + 2);
    await click("undo");
    expect(clipNotes().length).toBe(before + 3);
  },
);

// ---- Patterns: record a note pass ----
journey.list("patterns › Record a note pass");
let notesBeforePass = 0;
const pad = () => {
  const button = document.querySelector<HTMLElement>("#pads [data-pad]");
  if (!button) throw new Error("No pads");
  return button;
};
does(
  "Step 1",
  "Choose the destination track and Pattern, then click Record note pass. This starts transport if stopped; during playback it overdubs the remaining current clip cycle.",
  async () => {
    notesBeforePass = clipNotes().length;
    mock.audio.playing = false;
    mock.audio.start.mockClear();
    await click("seq-record");
    expect(mock.audio.start).toHaveBeenCalled();
    mock.audio.playing = true;
  },
);
does(
  "Step 2",
  "Play pads or mapped computer keys. Optional Clocked note repeat uses the selected division and Repeat velocity.",
  async () => {
    for (const at of [1.1, 5.2]) {
      mock.audio.position = at;
      pad().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await settle();
      mock.audio.position = at + 1;
      pad().dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      await settle();
    }
    el<HTMLInputElement>("seq-repeat");
    el<HTMLInputElement>("seq-repeat-velocity");
    expect(clipNotes().length).toBe(notesBeforePass); // still a draft
  },
);
does("Step 3", "Click Finish note pass or Stop. The pass becomes one undoable edit.", async () => {
  await click("seq-finish");
  mock.audio.playing = false;
  expect(clipNotes().length).toBe(notesBeforePass + 2);
  await click("undo");
  expect(clipNotes().length).toBe(notesBeforePass);
  await click("redo");
  expect(clipNotes().length).toBe(notesBeforePass + 2);
});
does(
  "Step 4",
  "Select recorded note rows, choose a Quantize grid and use Quantize selected. Restore played timing returns to the captured timing rather than compounding previous corrections.",
  async () => {
    const rows = [...document.querySelectorAll<HTMLInputElement>("[data-note]")];
    for (const row of rows) {
      row.checked = true;
      row.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await settle();
    await set("seq-grid", "1");
    const played = clipNotes().map((n) => n.original?.position ?? n.position);
    await click("seq-quantize");
    expect(clipNotes().every((n) => Number.isInteger(n.position))).toBe(true);
    await click("seq-quantize");
    await click("seq-restore");
    expect(clipNotes().map((n) => n.position)).toEqual(played);
  },
);

// ---- Perform: launch clips independently ----
journey.list("perform › Launch clips independently");
does("Step 1", "Stop and open Perform. Opening it turns on the performance preview.", async () => {
  mock.audio.playing = false;
  await view("perform");
  expect(project().performance).toBeDefined();
  const enable = el<HTMLButtonElement>("perf-enable");
  expect(enable.hidden || enable.disabled).toBe(true); // nothing left to click
});
does(
  "Step 2",
  "Choose Track and Clip, then Queue clip. Other tracks keep their position. Stop track at next bar stops only that owner.",
  async () => {
    mock.audio.playing = true;
    const track = el<HTMLSelectElement>("perf-track");
    const clip = el<HTMLSelectElement>("perf-clip");
    await set("perf-track", track.options[0]?.value ?? "");
    await set("perf-clip", clip.options[1]?.value ?? clip.value);
    mock.audio.queueClip.mockClear();
    await click("perf-queue-clip");
    expect(mock.audio.queueClip).toHaveBeenCalledWith(track.value, clip.value);
    expect(mock.audio.queueClip).toHaveBeenCalledTimes(1);
    await click("perf-stop-track");
    expect(mock.audio.queueClip).toHaveBeenLastCalledWith(track.value, null);
  },
);
does(
  "Step 3",
  "Cancel queued launch removes an uncommitted intent. The preview schedules ahead by about 100 ms, so a boundary already sent to the engine cannot be canceled retroactively.",
  async () => {
    mock.audio.cancelLaunch.mockClear();
    await click("perf-cancel");
    expect(mock.audio.cancelLaunch).toHaveBeenCalled();
    mock.audio.playing = false;
  },
);

// ---- Perform: build a finite song ----
journey.list("perform › Build a finite song");
const chain = () => project().performance?.chain ?? [];
does("Step 1", "Choose a Scene and click Add scene to chain for each song part.", async () => {
  const scenes = el<HTMLSelectElement>("perf-scene");
  for (const n of [0, 1, 0]) {
    await set("perf-scene", scenes.options[n]?.value ?? "");
    await click("perf-add-occurrence");
  }
  expect(
    chain()
      .slice(-3)
      .map((b) => b.sceneId),
  ).toEqual([project().scenes[0]?.id, project().scenes[1]?.id, project().scenes[0]?.id]);
});
does(
  "Step 2",
  "Set each occurrence’s Repeats; use Move up or Remove to edit the order.",
  async () => {
    const last = chain().at(-1);
    const repeats = document.querySelector<HTMLInputElement>(
      `[data-occurrence="${last?.id}"][data-field="repeats"], [data-repeats="${last?.id}"]`,
    );
    if (!repeats) throw new Error("No Repeats field");
    repeats.value = "2";
    repeats.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(chain().at(-1)?.repeats).toBe(2);
    const order = chain().map((b) => b.id);
    const up = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
      /Move up/.test(b.textContent ?? ""),
    );
    up.at(-1)?.click();
    await settle();
    expect(chain().map((b) => b.id)).not.toEqual(order);
    const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) =>
        /^Remove$/.test(b.textContent?.trim() ?? "") &&
        b.closest("#perf-chain, .perf-chain, ol, table"),
    );
    remove.at(-1)?.click();
    await settle();
    expect(chain().length).toBe(order.length - 1);
  },
);
does(
  "Step 3",
  "Set Song end → Stop for finite export, or Loop for continued performance.",
  async () => {
    await set("perf-end", "loop");
    expect(project().performance?.end).toBe("loop");
    await set("perf-end", "stop");
    expect(project().performance?.end).toBe("stop");
  },
);
does(
  "Step 4",
  "Play song starts at the beginning. Resume saved position uses the saved occurrence and offset.",
  async () => {
    mock.audio.start.mockClear();
    await click("perf-play-song");
    expect(mock.audio.start).toHaveBeenCalled();
    const [, mode, resume] = mock.audio.start.mock.calls.at(-1) ?? [];
    expect(mode).toBe("song");
    expect(resume).toBeFalsy();
    mock.audio.playing = false;
    mock.audio.start.mockClear();
    const resumeButton = el<HTMLButtonElement>("perf-resume");
    if (!resumeButton.disabled) {
      await click("perf-resume");
      expect(mock.audio.start.mock.calls.at(-1)?.[2]).toBe(true);
    } else expect(resumeButton.textContent).toMatch(/Resume saved position/);
  },
);

// ---- Mix: mixing & effects ----
journey.list("mix › Mixing & effects");
const drums = () => project().tracks[0]?.id ?? "drums";
does(
  "Step 1",
  "Stop playback and open Mix. Opening it turns on stereo mixing as one undoable change, so older projects keep their sound until you open Mix.",
  async () => {
    mock.audio.playing = false;
    const tracks = JSON.stringify(project().tracks);
    expect(project().mix).toBeUndefined();
    await view("mix");
    expect(project().mix).toBeDefined();
    expect(JSON.stringify(project().tracks)).toBe(tracks); // the sound is unchanged
    // One undoable change: UNDO (from another view) takes it back; Mix turns it on again.
    await view("play");
    await click("undo");
    expect(project().mix).toBeUndefined();
    await view("mix");
    expect(project().mix).toBeDefined();
  },
);
does(
  "Step 2",
  "Select a track. Set Track gain, the existing Gain effect, pan and sends A/B. Both shared returns feed master.",
  async () => {
    const param = (name: string) =>
      document.querySelector<HTMLInputElement>(`[data-parameter="track.${drums()}.${name}"]`);
    for (const [name, value] of [
      ["pan", "0.3"],
      ["send.0", "0.4"],
      ["send.1", "0.2"],
    ] as const) {
      const input = param(name);
      if (!input) throw new Error(`No ${name}`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      expect(
        project().parameters.find((p) => p.id === `track.${drums()}.${name}`)?.base,
      ).toBeCloseTo(Number(value), 5);
    }
    el("track-gain");
    expect(project().mix?.returns.length ?? 2).toBe(2);
  },
);
does(
  "Step 3",
  "Choose Effect location, Slot and Effect, then Set effect. Fill Insert 1 before Insert 2. Graph changes require Stop.",
  async () => {
    await set("fx-slot", "0");
    await set("fx-kind", "delay");
    await click("fx-install");
    expect(project().mix?.tracks[drums()]?.inserts[0]?.kind).toBe("delay");
    mock.audio.playing = true;
    await set("fx-kind", "filter");
    await click("fx-install");
    expect(status()).toMatch(/Stop playback/);
    mock.audio.playing = false;
    el("fx-location");
  },
);
does(
  "Step 4",
  "Adjust effect controls, bypass, or use Save preset/Open preset. Rhythmic filter / delay preset supplies an original clocked starting point for those effects.",
  async () => {
    const insert = project().mix?.tracks[drums()]?.inserts[0];
    const wet = document.querySelector<HTMLInputElement>(`[data-parameter$=".${insert?.id}.wet"]`);
    if (!wet) throw new Error("No effect control");
    wet.value = "0.6";
    wet.dispatchEvent(new Event("input", { bubbles: true }));
    wet.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(project().parameters.find((p) => p.id.endsWith(`.${insert?.id}.wet`))?.base).toBe(0.6);
    for (const id of ["fx-save", "fx-open"]) el(id);
    for (const kind of ["filter", "delay"]) {
      await set("fx-kind", kind);
      await click("fx-rhythm");
      const effect = project().mix?.tracks[drums()]?.inserts.find((i) => i.kind === kind);
      expect(effect?.sync).toBeDefined(); // clocked to the tempo
    }
  },
);

// ---- Recording & resampling ----
journey.list("recording › Recording & resampling");
does(
  "Step 1",
  "Select the destination pad. For WAV input, click Choose WAV input and select a supported file.",
  async () => {
    await view("sounds");
    el("choose-input");
    await files("record-file", [wav()]);
    expect(el("record-status").textContent).toMatch(/Handclap|WAV|Arm/i);
  },
);
does(
  "Step 2",
  "Enable Monitor input levels and click Arm. Arming validates the take; it does not start a microphone stream.",
  async () => {
    await check("monitor-levels");
    await click("arm-record");
    expect(el<HTMLButtonElement>("start-record").disabled).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  },
);
does(
  "Step 3",
  "Click Start recording. Allow macOS microphone access if requested. The microphone path uses the built-in input only; its meter is visual monitoring, without a speaker return.",
  async () => {
    const before = snapshot();
    await click("start-record");
    await vi.waitFor(() => expect(el<HTMLButtonElement>("keep-take").disabled).toBe(false));
    expect(snapshot()).toBe(before); // capturing alone does not replace the sound
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); // a WAV take
  },
);
does(
  "Step 4",
  "Review the result and choose Keep take on selected pad. Capturing alone does not replace the project sound. Keeping a take is undoable.",
  async () => {
    const before = snapshot();
    await click("keep-take");
    expect(snapshot()).not.toBe(before);
    const known = new Set((JSON.parse(before) as Project).samples.map((s) => s.id));
    expect(project().samples.some((s) => !known.has(s.id))).toBe(true);
    await click("undo");
    expect(snapshot()).toBe(before);
  },
);

// ---- Exchange: import a MIDI clip ----
journey.list("exchange › Import a MIDI clip");
const midi = () => {
  const bytes = encodeMidi({
    ppq: 960,
    endTick: 3840,
    ignoredEvents: 0,
    tempos: [{ tick: 0, micros: 500000 }],
    notes: [{ track: 0, channel: 0, note: 64, velocity: 100, tick: 240, duration: 480 }],
  });
  return { size: bytes.length, name: "phrase.mid", arrayBuffer: async () => bytes.slice().buffer };
};
let beforeMidi = "";
does(
  "Step 1",
  "Choose the destination track and clip, then click Import MIDI clip in Mix.",
  async () => {
    await view("mix");
    beforeMidi = snapshot();
    el("midi-open");
    await files("midi-file", [midi()]);
    expect(snapshot()).toBe(beforeMidi); // staged only
  },
);
does("Step 2", "Choose a nonempty File track from the staged file.", async () => {
  const track = el<HTMLSelectElement>("midi-track");
  expect(track.options.length).toBeGreaterThan(0);
  await set("midi-track", track.options[0]?.value ?? "0");
  expect(el("midi-keep").hidden).toBe(false);
});
does(
  "Step 3",
  "Click Replace selected clip with MIDI. This explicitly replaces its notes and the project tempo map as one undoable edit. Changing the destination or project first invalidates the staged import.",
  async () => {
    await click("midi-keep");
    expect(
      selectedTrack()
        ?.clips.flatMap((c) => c.sequence?.notes ?? [])
        .some((n) => n.note === 64),
    ).toBe(true);
    await click("undo");
    expect(snapshot()).toBe(beforeMidi);
    await files("midi-file", [midi()]);
    const pan = document.querySelector<HTMLInputElement>(`[data-parameter="track.${drums()}.pan"]`);
    if (!pan) throw new Error("No pan");
    pan.value = "0.25";
    pan.dispatchEvent(new Event("input", { bubbles: true }));
    pan.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const changed = snapshot();
    await click("midi-keep");
    expect(status()).toMatch(/reopen MIDI/);
    expect(snapshot()).toBe(changed);
  },
);
