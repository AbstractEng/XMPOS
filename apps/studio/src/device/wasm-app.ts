import "./style.css";
import xmpLogo from "../../../../brand/xmp/assets/svg/xmp-orbit.svg?url";
import { decodeBase64 } from "../../../../packages/core/src/engine.ts";
import { DEVICE_UI_WASM_BASE64 } from "../../../../packages/core/src/generated/xmp-device-ui-wasm.ts";
import inputWorkletUrl from "../device-input-worklet.ts?worker&url";
import {
  loadProjectCopies,
  loadProjectText,
  saveProjectCopy,
  saveProjectText,
} from "../storage.ts";

const width = 1280;
const height = 800;
const block = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxFile = 96 * 1024 * 1024;

interface DeviceExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  initialize(bytes: number): number;
  input_buffer(bytes: number): number;
  touch(phase: number, x: number, y: number): void;
  button(code: number, down: number): void;
  pad(pad: number, velocity: number): void;
  wheel(clicks: number): void;
  knob(knob: number, clicks: number): void;
  render(): number;
  audio_block(frames: number): number;
  capture_file(bytes: number): number;
  input_enable(enabled: number): void;
  input_push(frames: number): number;
  input_track(): number;
  input_monitor(): number;
  recording(): number;
  view(): number;
  text_editing(): number;
  text_input(bytes: number, key: number): void;
  menu_pending(): number;
  menu_hold_ready(): number;
  project_name(): number;
  pad_name(pad: number): number;
  message(): number;
  qlink_page(): number;
  panel_lights(): number;
  catalog_clear(): void;
  catalog_entry(id: number, kind: number, bytes: number, length: number, factory: number): void;
  catalog_refresh(): void;
  save_size(): number;
  save_bytes(): number;
  save_filename(): number;
  save_complete(ok: number): void;
}

type LibraryFile = { name: string; kind: number; bytes: Uint8Array; factory?: boolean };
const files: LibraryFile[] = [];
const base = import.meta.env.BASE_URL;
const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing device host");
let audio: AudioContext | undefined;
let nextBlock = 0;
let microphone: MediaStream | undefined;
let microphoneNode: AudioWorkletNode | undefined;
let microphoneSource: MediaStreamAudioSourceNode | undefined;
let wavInput = false;
let microphonePending: Promise<void> | undefined;
async function enableMicrophone() {
  if (microphone?.active) return;
  microphonePending ??= (async () => {
    wakeAudio();
    if (!audio || !navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone requires HTTPS or localhost");
    await audio.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    try {
      await audio.audioWorklet.addModule(inputWorkletUrl);
      const node = new AudioWorkletNode(audio, "xmp-device-input", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (!(data instanceof Float32Array)) return;
        input(new Uint8Array(data.buffer));
        if (!device.input_push(data.length)) device.input_enable(0);
        node.port.postMessage(data, [data.buffer]);
      };
      microphoneSource = audio.createMediaStreamSource(stream);
      microphoneSource.connect(node);
      node.connect(audio.destination);
      microphone = stream;
      microphoneNode = node;
      wavInput = false;
      device.input_enable(1);
      for (const track of stream.getAudioTracks())
        track.addEventListener("ended", () => {
          if (microphone !== stream) return;
          device.input_enable(0);
          hostMessage = "Microphone disconnected; previous sample kept";
        });
      hostMessage = "Microphone ready · Monitor follows the selected sampler track";
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  })().finally(() => {
    microphonePending = undefined;
  });
  return microphonePending;
}
window.addEventListener("pagehide", () => {
  device.input_enable(0);
  microphoneNode?.disconnect();
  microphoneSource?.disconnect();
  for (const track of microphone?.getTracks() ?? []) track.stop();
});

const { instance } = await WebAssembly.instantiate(decodeBase64(DEVICE_UI_WASM_BASE64), {
  wasi_snapshot_preview1: {
    clock_time_get(clock: number, _precision: bigint, output: number) {
      const time = clock === 0 ? Date.now() : performance.now();
      new DataView(device.memory.buffer).setBigUint64(output, BigInt(Math.round(time * 1e6)), true);
      return 0;
    },
  },
  xmp: {
    read_file(id: number, output: number, bytes: number) {
      const file = files[id];
      if (file?.bytes.length !== bytes) return 0;
      new Uint8Array(device.memory.buffer, output, bytes).set(file.bytes);
      return 1;
    },
  },
});
const device = instance.exports as unknown as DeviceExports;
device._initialize();

function input(bytes: Uint8Array) {
  const pointer = device.input_buffer(bytes.length);
  if (!pointer && bytes.length) throw new Error("File exceeds the device size limit");
  new Uint8Array(device.memory.buffer, pointer, bytes.length).set(bytes);
}

function string(pointer: number) {
  const bytes = new Uint8Array(device.memory.buffer, pointer);
  const end = bytes.indexOf(0);
  return decoder.decode(bytes.subarray(0, Math.max(0, end)));
}

function catalog() {
  files.sort(
    (a, b) =>
      Number(Boolean(b.factory)) - Number(Boolean(a.factory)) ||
      (a.factory && b.factory ? 0 : a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en")),
  );
  device.catalog_clear();
  for (const [id, file] of files.entries()) {
    const name = encoder.encode(file.name);
    input(name);
    device.catalog_entry(
      id,
      file.kind,
      file.bytes.length,
      name.length,
      Number(Boolean(file.factory)),
    );
  }
  device.catalog_refresh();
}

async function loadFactoryKits() {
  const root = `${base}factory-kits/`;
  const response = await fetch(`${root}index.json`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Factory kit catalog unavailable");
  const index: unknown = await response.json();
  if (!Array.isArray(index) || index.length > 16) throw new Error("Invalid factory kit catalog");
  const kits = await Promise.all(
    index.map(async (item) => {
      if (
        !/^[a-z0-9-]+\.xmpkit$/.test(item.file) ||
        typeof item.name !== "string" ||
        !Number.isInteger(item.bytes) ||
        item.bytes < 1 ||
        item.bytes > maxFile ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        throw new Error("Invalid factory kit entry");
      const result = await fetch(`${root}${item.file}`, { signal: AbortSignal.timeout(30000) });
      if (!result.ok || !result.body) throw new Error(`Factory kit unavailable: ${item.name}`);
      const reader = result.body.getReader();
      const bytes = new Uint8Array(item.bytes);
      let offset = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.length > bytes.length) {
          await reader.cancel();
          throw new Error(`Factory kit size mismatch: ${item.name}`);
        }
        bytes.set(value, offset);
        offset += value.length;
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (offset !== bytes.length || hash !== item.sha256)
        throw new Error(`Factory kit integrity check failed: ${item.name}`);
      return { name: item.name as string, kind: 2, bytes, factory: true };
    }),
  );
  files.push(...kits);
  catalog();
}

let stored = await loadProjectText();
const start = stored ? encoder.encode(stored) : undefined;
if (start) input(start);
if (!device.initialize(start?.length ?? 0)) throw new Error("Could not open saved device project");
for (const copy of await loadProjectCopies())
  files.push({ name: copy.name, kind: 3, bytes: encoder.encode(copy.text) });
catalog();

const buttons = {
  shift: [0x31, "SHIFT"],
  menu: [0x7b, "MENU"],
  main: [0x34, "MAIN", "PLAY"],
  undo: [0x43, "UNDO", "REDO"],
  copy: [0x7a, "COPY"],
  plus: [0x36, "+"],
  tap: [0x35, "TAP"],
  rec: [0x49, "REC"],
  overdub: [0x50, "OVER DUB"],
  stop: [0x51, "STOP"],
  play: [0x52, "PLAY"],
  "play-start": [0x53, "PLAY START"],
  minus: [0x37, "−"],
  "bank-a": [0x23, "A"],
  "bank-b": [0x24, "B"],
  "bank-c": [0x25, "C"],
  "bank-d": [0x26, "D"],
  "note-repeat": [0x0b, "NOTE REPEAT"],
  "full-level": [0x27, "FULL LEVEL"],
  "16-level": [0x28, "16 LEVEL"],
  erase: [0x09, "ERASE"],
  "q-link": [0, "Q-LINK"],
} as const;
type Control = keyof typeof buttons;
function key(id: Control) {
  const [, label, alternate] = buttons[id] as readonly [number, string, string?];
  return `<button class="front-key" data-panel="${id}"><strong>${label}</strong>${alternate ? `<small>${alternate}</small>` : ""}</button>`;
}
const panel = (ids: Control[]) => ids.map(key).join("");
const padOrder = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
app.innerHTML = `<header class="device-hostbar">
  <a class="device-logo" href="${base}" aria-label="XMP OS home"><img src="${xmpLogo}" width="1130" height="436" alt="XMP OS"></a>
  <nav>
    <button data-host="layout">Show screen view</button>
    <button data-host="files">Add library files</button>
    <button data-host="microphone">Enable microphone</button>
    <button data-host="capture">Choose WAV input</button>
    <button data-host="download">Download saved project</button>
    <a href="${base}manual/">Manual</a>
    <a href="${base}?view=studio">Advanced Studio</a>
  </nav>
</header>
<div class="device-chassis"><div class="chassis-nameplate" aria-hidden="true"><strong>XMP<span>OS</span></strong><span>LIVE / MK1</span></div><div class="device-face" data-panel-profile="live-mk1">
  <section class="device-left" aria-label="Pads">
    <div class="bank-keys">${panel(["bank-a", "bank-b", "bank-c", "bank-d"])}</div>
    <div class="performance-keys">${panel(["note-repeat", "full-level", "16-level", "erase"])}</div>
    <div class="device-pad-grid">${padOrder.map((i) => `<button data-pad="${i}" aria-label="Pad ${i + 1}" class="device-pad"><small>${i + 1}</small></button>`).join("")}</div>
  </section>
  <section class="device-center">
    <div class="device-display-bezel"><div class="device-screen-frame">
      <canvas id="device-screen" class="native-touchscreen" aria-label="Live Mk1 touchscreen" width="${width}" height="${height}"></canvas>
    </div></div>
    <div class="device-controls" role="group" aria-label="Transport and shortcuts">${panel(["shift", "menu", "main", "undo", "copy", "plus", "tap", "rec", "overdub", "stop", "play", "play-start", "minus"])}</div>
  </section>
  <aside class="device-right">
    <div class="q-link-panel">${key("q-link")}<div class="q-link-leds" role="img" aria-label="Q-Link page 1">${"<span></span>".repeat(4)}</div></div>
    <div class="q-link-knobs">${[0, 1, 2, 3].map((i) => `<label class="virtual-knob"><span>Q${i + 1}</span><input data-q="${i}" aria-label="Q-Link ${i + 1}" type="range" min="-64" max="64" value="0"></label>`).join("")}</div>
    <div class="data-dial">
      <button data-wheel="-1" aria-label="Turn data dial counterclockwise">−</button>
      <button data-wheel="0" data-action="enter" aria-label="Press data dial">ENTER</button>
      <button data-wheel="1" aria-label="Turn data dial clockwise">+</button>
    </div><small>DATA DIAL</small>
  </aside>
</div><footer class="device-hostnote">
  <span>Click MENU to hold it. SHIFT + MENU arms screen button pads. Keyboard pads start at 1–4.</span>
  <output id="device-host-state" aria-live="polite"></output>
</footer></div>
<input id="device-files" type="file" multiple accept=".wav,.xmpkit,.xmpsong,.json" hidden>
<input id="device-capture" type="file" accept=".wav,audio/wav" hidden>`;

const canvas = document.querySelector<HTMLCanvasElement>("canvas.native-touchscreen");
if (!canvas) throw new Error("Missing device screen");
const context = canvas.getContext("2d", { alpha: false });
if (!context) throw new Error("Could not create the device screen");
const screen = context.createImageData(width, height);
const leds = document.querySelector(".q-link-leds");
const state = document.querySelector<HTMLOutputElement>("#device-host-state");
let hostMessage = "";
let heldMenu = false;
let heldShift = false;
let saving = false;

function wakeAudio() {
  audio ??= new AudioContext({ sampleRate: 48000 });
  if (audio.state !== "running") void audio.resume().catch(() => undefined);
}

function renderAudio() {
  if (audio?.state !== "running") {
    for (let i = 0; i < 2; ++i) device.audio_block(block);
    return;
  }
  if (nextBlock < audio.currentTime) nextBlock = audio.currentTime + 0.006;
  while (nextBlock < audio.currentTime + 0.045) {
    const pointer = device.audio_block(block);
    const buffer = audio.createBuffer(2, block, 48000);
    for (let channel = 0; channel < 2; ++channel) {
      const samples = new Float32Array(device.memory.buffer, pointer + channel * block * 4, block);
      buffer.copyToChannel(samples, channel);
    }
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.start(nextBlock);
    nextBlock += buffer.duration;
  }
}

async function completeSave(bytes: number) {
  const name = string(device.save_filename());
  const data = new Uint8Array(device.memory.buffer, device.save_bytes(), bytes).slice();
  const text = decoder.decode(data);
  let result = 0;
  try {
    if (!name) {
      await saveProjectText(text);
      stored = text;
      result = 1;
    } else if (await saveProjectCopy(`${name}.xmpsong`, text)) {
      files.push({ name: `${name}.xmpsong`, kind: 3, bytes: data });
      catalog();
      result = 1;
    } else {
      result = -1;
    }
  } catch (error) {
    hostMessage = error instanceof Error ? error.message : "Could not save";
  }
  device.save_complete(result);
  saving = false;
}

function draw() {
  renderAudio();
  const pixels = device.render();
  if (pixels) {
    screen.data.set(new Uint8Array(device.memory.buffer, pixels, screen.data.length));
    context?.putImageData(screen, 0, 0);
  }
  const view = string(device.view());
  if (pixels && (view === "SOUND" || view === "PLAY")) {
    for (const pad of pads) {
      const index = Number(pad.dataset.pad);
      const name = string(device.pad_name(index));
      pad.setAttribute("aria-label", name ? `Pad ${index + 1}: ${name}` : `Pad ${index + 1}`);
    }
  }
  canvas?.setAttribute("data-page", view.toLowerCase());
  canvas?.setAttribute("data-project", string(device.project_name()));
  canvas?.setAttribute("data-message", string(device.message()));
  if (heldMenu && !device.menu_pending()) releaseMenu();
  (["menu", "shift"] as const).forEach((control) => {
    const held = control === "menu" ? heldMenu : heldShift;
    const button = document.querySelector(`[data-panel="${control}"]`);
    button?.classList.toggle("lit", held);
    button?.setAttribute("aria-pressed", String(held));
  });
  const page = device.qlink_page();
  leds?.setAttribute("aria-label", `Q-Link page ${page + 1}`);
  for (const [i, led] of Array.from(leds?.children ?? []).entries())
    led.classList.toggle("lit", i === page);
  // Native UI owns every musical light; this adapter only paints its snapshot.
  const feedbackAddress = device.panel_lights();
  const feedback = new Uint8Array(device.memory.buffer, feedbackAddress, 65);
  const order = [0x23, 0x24, 0x25, 0x26, 0x0b, 0x27, 0x28, 0x35, 0x49, 0x50, 0x51, 0x52, 0x53];
  for (const [id, [code]] of Object.entries(buttons)) {
    const index = order.indexOf(code);
    if (index < 0) continue;
    const lit = feedback[index] === 3;
    const button = document.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    button?.classList.toggle("led-on", lit);
    button?.setAttribute("data-led", lit ? "on" : "off");
    if (button)
      button.style.setProperty(
        "--key-led",
        [0x49, 0x50].includes(code) ? "#ff5550" : code === 0x52 ? "#60ed92" : "#f2b956",
      );
  }
  for (const pad of pads) {
    const offset = 17 + Number(pad.dataset.pad) * 3;
    const rgb = Array.from(feedback.subarray(offset, offset + 3), (n) =>
      Math.round((n * 255) / 127),
    );
    const lit = rgb.some((n) => n > 0);
    pad.classList.toggle("led-on", lit);
    pad.dataset.led = rgb.join(",");
    pad.style.setProperty("--pad-rgb", rgb.join(" "));
  }
  if (state && state.value !== hostMessage) state.value = hostMessage;
  const bytes = device.save_size();
  if (bytes && !saving) {
    saving = true;
    void completeSave(bytes);
  }
  requestAnimationFrame(draw);
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  wakeAudio();
});
for (const [phase, type] of ["pointerdown", "pointermove", "pointerup", "pointercancel"].entries())
  canvas.addEventListener(type, (event) => {
    const e = event as PointerEvent;
    if (phase === 1 && !canvas.hasPointerCapture(e.pointerId)) return;
    const bounds = canvas.getBoundingClientRect();
    device.touch(
      phase,
      Math.floor(((e.clientX - bounds.left) * width) / bounds.width),
      Math.floor(((e.clientY - bounds.top) * height) / bounds.height),
    );
  });

function releaseMenu() {
  heldMenu = false;
  device.button(buttons.menu[0], 0);
  if (heldShift) {
    heldShift = false;
    device.button(buttons.shift[0], 0);
  }
}

function clickControl(control: Control) {
  const [code] = buttons[control];
  if (control === "menu") {
    if (heldMenu) releaseMenu();
    else {
      heldMenu = true;
      device.button(code, 1);
    }
  } else if (control === "shift") {
    heldShift = !heldShift;
    device.button(code, Number(heldShift));
  } else {
    device.button(code, 1);
    device.button(code, 0);
    if (heldShift) {
      heldShift = false;
      device.button(buttons.shift[0], 0);
    }
  }
}

const menuButton = app.querySelector<HTMLButtonElement>('[data-panel="menu"]');
if (menuButton) {
  let menuWasHeld = false;
  menuButton.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    menuButton.setPointerCapture(event.pointerId);
    wakeAudio();
    menuWasHeld = heldMenu;
    if (!heldMenu) clickControl("menu");
  });
  menuButton.addEventListener("pointerup", (event) => {
    if (
      menuButton.hasPointerCapture(event.pointerId) &&
      heldMenu &&
      (menuWasHeld || device.menu_hold_ready())
    )
      releaseMenu();
  });
  menuButton.addEventListener("pointercancel", () => {
    if (heldMenu) releaseMenu();
  });
}

const captureInput = document.querySelector<HTMLInputElement>("#device-capture");
captureInput?.addEventListener("change", async () => {
  const file = captureInput.files?.[0];
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error("WAV input exceeds 4 MiB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    input(bytes);
    if (!device.capture_file(bytes.length)) throw new Error("Could not open WAV input");
    wavInput = true;
    microphoneNode?.disconnect();
    microphoneSource?.disconnect();
    for (const track of microphone?.getTracks() ?? []) track.stop();
    microphone = undefined;
    hostMessage = "WAV input is ready. Arm recording in Sample.";
  } catch (error) {
    hostMessage = String(error);
  } finally {
    captureInput.value = "";
  }
});
const fileInput = document.querySelector<HTMLInputElement>("#device-files");
fileInput?.addEventListener("change", async () => {
  let added = 0;
  try {
    for (const file of Array.from(fileInput.files ?? [])) {
      if (files.length >= 256) throw new Error("Browser library is full");
      const name = file.name.toLowerCase();
      const kind = name.endsWith(".wav")
        ? 1
        : /\.(xmpkit|kit\.json)$/.test(name)
          ? 2
          : /\.(xmpsong|xmp\.json)$/.test(name)
            ? 3
            : 0;
      if (!kind || file.size < 1 || file.size > (kind === 1 ? 4 * 1024 * 1024 : maxFile)) continue;
      files.push({ name: file.name, kind, bytes: new Uint8Array(await file.arrayBuffer()) });
      ++added;
    }
    hostMessage = added
      ? `${added} files added to Browse for this session`
      : "Choose WAV, XMP kit or XMP project files";
  } catch (error) {
    hostMessage = String(error);
  } finally {
    catalog();
    fileInput.value = "";
  }
});

function layout(hardware: boolean) {
  document.body.classList.toggle("show-hardware", hardware);
  const button = document.querySelector("[data-host=layout]");
  if (button) button.textContent = hardware ? "Show screen view" : "Show hardware layout";
}
layout(new URLSearchParams(location.search).get("layout") !== "screen");
app.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button || (button.dataset.panel === "menu" && event.detail !== 0)) return;
  wakeAudio();
  const { panel: control, pad, wheel, host } = button.dataset;
  if (control && control in buttons) {
    if (
      control === "rec" &&
      ["SAMPLE", "CLIPS", "SOUND"].includes(string(device.view())) &&
      device.input_track() &&
      !device.recording() &&
      !wavInput
    ) {
      try {
        await enableMicrophone();
      } catch (error) {
        hostMessage = `Microphone unavailable: ${String(error)}`;
        return;
      }
    }
    clickControl(control as Control);
  }
  if (pad !== undefined && event.detail === 0) {
    device.pad(Number(pad), 100);
    device.pad(Number(pad), 0);
  }
  if (wheel === "0") {
    device.button(0x6f, 1);
    device.button(0x6f, 0);
  } else if (wheel) device.wheel(Number(wheel));
  if (host === "layout") layout(!document.body.classList.contains("show-hardware"));
  if (host === "files") fileInput?.click();
  if (host === "microphone") {
    try {
      await enableMicrophone();
    } catch (error) {
      hostMessage = `Microphone unavailable: ${String(error)}`;
    }
  }
  if (host === "capture") captureInput?.click();
  if (host === "download") {
    try {
      const text = stored;
      if (!text) {
        hostMessage = "Save the project before downloading";
        return;
      }
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "project.xmpsong";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      hostMessage = String(error);
    }
  }
});

const pads = app.querySelectorAll<HTMLButtonElement>("[data-pad]");
for (const button of pads) {
  const pad = Number(button.dataset.pad);
  const release = () => {
    device.pad(pad, 0);
    button.classList.remove("selected");
  };
  button.addEventListener("pointerdown", (event) => {
    button.setPointerCapture(event.pointerId);
    wakeAudio();
    const velocity =
      event.pointerType !== "mouse" && event.pressure > 0
        ? Math.max(1, Math.round(event.pressure * 127))
        : 100;
    device.pad(pad, velocity);
    button.classList.add("selected");
  });
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
}

for (const control of app.querySelectorAll<HTMLInputElement>("input[data-q]")) {
  let previous = 0;
  control.addEventListener("input", () => {
    const value = Number(control.value);
    device.knob(Number(control.dataset.q), value - previous);
    previous = value;
  });
  control.addEventListener("change", () => {
    control.value = "0";
    previous = 0;
  });
}

function namingInput(text = "", key = 0) {
  const bytes = encoder.encode(text).slice(0, 4096);
  const pointer = device.input_buffer(bytes.length);
  new Uint8Array(device.memory.buffer, pointer, bytes.length).set(bytes);
  device.text_input(bytes.length, key);
}
window.addEventListener("paste", (event) => {
  if (!device.text_editing() || event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  namingInput(event.clipboardData?.getData("text/plain") ?? "");
});
window.addEventListener("compositionend", (event) => {
  if (device.text_editing()) namingInput(event.data);
});
const keyPads = "1234qwerasdfzxcv";
const keyboardPads = new Set<number>();
window.addEventListener("keydown", (event) => {
  if (device.text_editing() && !(event.target instanceof HTMLInputElement)) {
    if (event.isComposing) return;
    const shortcut = event.ctrlKey || event.metaKey;
    const key =
      shortcut && event.key.toLowerCase() === "a"
        ? 1
        : ["Backspace", "Delete"].includes(event.key)
          ? 2
          : event.key === "Enter"
            ? 3
            : event.key === "Escape"
              ? 4
              : 0;
    if (key) {
      event.preventDefault();
      namingInput("", key);
    } else if (!shortcut && !event.altKey && [...event.key].length === 1) {
      event.preventDefault();
      namingInput(event.key);
    }
    return;
  }
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat ||
    event.target instanceof HTMLInputElement
  )
    return;
  const pad = padOrder[keyPads.indexOf(event.key.toLowerCase())];
  if (pad !== undefined) {
    event.preventDefault();
    wakeAudio();
    keyboardPads.add(pad);
    device.pad(pad, 100);
  }
  if (event.key === "Shift") device.button(buttons.shift[0], 1);
});
window.addEventListener("keyup", (event) => {
  const pad = padOrder[keyPads.indexOf(event.key.toLowerCase())];
  if (pad !== undefined && keyboardPads.delete(pad)) device.pad(pad, 0);
  if (event.key === "Shift" && !heldShift) device.button(buttons.shift[0], 0);
});
window.addEventListener("blur", () => {
  for (const pad of keyboardPads) device.pad(pad, 0);
  keyboardPads.clear();
  if (!heldShift) device.button(buttons.shift[0], 0);
});

// The overlay shows the custom boot artwork while the common screen starts.
await loadFactoryKits().catch((error) => {
  hostMessage = String(error);
});
draw();
