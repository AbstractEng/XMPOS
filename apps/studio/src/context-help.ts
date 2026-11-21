import type { ControlBookmark, ControlFocus } from "./control-focus.ts";

const topics = {
  performance: [
    "Launch and arrange a song",
    "Enable the performance preview, then queue a scene or a clip for the next bar. Cancel removes an uncommitted launch. Empty slots stop their track; independent clip launches preserve other playheads. Build a chain with stable occurrences and repeat counts. Mute and solo release sources while the shared delay tail continues. Record performance controls as a separate undoable pass.",
  ],
  sequencer: [
    "Record and shape a pattern",
    "Add a chord on the selected pad or record a note pass. Select note rows before quantizing, restoring played timing, or applying length and expression. Locks last one step; automation, macros and LFOs supply the underlying value. Touch writes while you move the control, latch continues until Finish, and write replaces the whole recorded interval. Stop finalizes the pass and releases notes. Download captured pass preserves a draft after a concurrent edit.",
  ],
  instruments: [
    "Choose a track machine",
    "Each track has an audio or MIDI machine. Choose sampler or synth, shape its sound, and save the project to keep its settings. Custom machine definitions can add new types. Missing machines keep their saved state. Arm a selected recording input, press Start, then Keep take; microphone monitoring shows levels without speaker feedback.",
  ],
  overview: [
    "Make your first beat",
    "Choose a pad, then click steps to build a pattern. Enable audio and press Play to hear it. Launch a scene for another part, then save your project. Focus a control and press F1 for help with that part of the instrument.",
  ],
  transport: [
    "Play and stop",
    "Play starts the selected scene. Space plays or stops when you are outside a text field or button. Tempo is in beats per minute. In this preview, changing tempo restarts playback; swing changes wait for the next bar without restarting; changing scenes waits for the next bar.",
  ],
  swing: [
    "Give the beat a swing",
    "50% is straight timing. Triplet divides each pair of sixteenths into an exact 2:1 rhythm, displayed as 66.7%. Higher values delay the second hit further, up to 75%. The bar length stays the same. Velocity controls how strongly a note plays; swing changes its timing.",
  ],
  pads: [
    "Play and choose a sound",
    "Click a pad to hear and select it. The keys shown on the pads also play them when focus is outside a field or button. The pattern editor shows the selected sound. Computer keys use a fixed playing strength; edit individual note velocities for dynamics.",
  ],
  pattern: [
    "Build a pattern",
    "Choose a track and pad, then click a step to add or remove a hit. Shift-click an active step to select it without removing it. Set its velocity and probability below. Undo restores the previous edit. Use Notes & automation to add polyphonic chords or record and edit a note pass.",
  ],
  expression: [
    "Shape each hit",
    "Shift-click an active step first. Velocity changes how strongly it plays. Probability changes how often it plays; 100% always plays and 0% never plays. Probability is repeatable for the same project seed and loop position.",
  ],
  samples: [
    "Choose the part of a sound",
    "Import a WAV for the selected pad. Set start and end frames, then apply the slice. A frame is one point in the recording; start must come before end. Slicing keeps the original sound, and Undo restores the previous slice.",
  ],
  scenes: [
    "Move between song parts",
    "Each scene chooses a pattern on each track. During playback, a new scene waits for the next bar and its clips start at their first step. A queued scene is marked QUEUED. When stopped, selecting a scene prepares it for Play.",
  ],
  mixer: [
    "Balance and export",
    "Track gain and mute affect the selected track. Enable stereo mixing to set pan and two sends, add two inserts per track, and edit shared return effects. Stop lets tails decay. Bypass fades while effect history continues. Export a scene or finite song as WAV or MIDI. MIDI import waits for Replace and supports Undo. The MIDI clock test uses virtual fixtures only.",
  ],
  projects: [
    "Keep your work",
    "Edits save on this computer automatically. Save project downloads a portable copy with the sounds included. Open project restores that copy. Undo and Redo move through recent edits. Download a copy before clearing browser storage.",
  ],
} as const;
type Topic = keyof typeof topics;

// Help receives only DOM access: it cannot edit a project or call the audio engine.
export function installContextHelp(doc: Document, focus?: ControlFocus) {
  let bookmark: ControlBookmark | undefined;
  const button = doc.getElementById("help");
  const panel = doc.getElementById("context-help");
  const closeButton = doc.getElementById("help-close");
  const title = doc.getElementById("help-title");
  const body = doc.getElementById("help-body");
  if (!button || !panel || !closeButton || !title || !body)
    throw new Error("Missing contextual help controls");
  let topic: Topic = "overview";
  let lastControl: HTMLElement | undefined;
  let returnFocus: HTMLElement | undefined;
  doc.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement;
    if (panel.contains(target) || target === button) return;
    const key = target.closest<HTMLElement>("[data-help]")?.dataset.help;
    if (key && Object.hasOwn(topics, key)) {
      topic = key as Topic;
      lastControl = target;
    }
  });
  const open = () => {
    if (!panel.hidden) return;
    returnFocus = lastControl ?? button;
    bookmark = focus?.capture(returnFocus);
    [title.textContent, body.textContent] = topics[topic];
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    closeButton.focus();
  };
  const close = () => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focus && bookmark) focus.restore(bookmark);
    else (returnFocus?.isConnected ? returnFocus : button).focus();
  };
  button.onclick = () => (panel.hidden ? open() : close());
  closeButton.onclick = close;
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "F1" && doc.getElementById("error-dialog")?.hidden === false) return;
      if (event.key === "F1" || (event.key === "Escape" && !panel.hidden)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "F1") open();
        else close();
      }
    },
    true,
  );
}
