import { decodeBase64 } from "./engine.ts";
import type { Project } from "./index.ts";

interface TouchscreenCore {
  memory: WebAssembly.Memory;
  _initialize(): void;
  du_alloc(size: number): number;
  du_free(pointer: number): void;
  du_result(): number;
  du_result_size(): number;
  du_project(text: number, size: number, track: number, pad: number): number;
  du_take_name(text: number, size: number): void;
  du_take(pcm: number, frames: number): number;
  du_recording(state: number, frames: number): void;
  du_notice(text: number, size: number): void;
  du_save(state: number): void;
  du_edit(start: number, end: number, reverse: number): void;
  du_transport(step: number, playing: number): void;
  du_touch(phase: number, x: number, y: number): void;
  du_pad(pad: number, velocity: number): void;
  du_button(button: number, down: number): void;
  du_buttons(): void;
  du_number(text: number, size: number): number;
  du_knob(knob: number, clicks: number): void;
  du_draw(): number;
  du_controls(): void;
  du_state(): void;
  du_actions(): void;
  du_preview(pad: number): number;
}
export interface TouchscreenState {
  name: string;
  message: string;
  view: string;
  track: number;
  pad: number;
  frames: number;
  sampling: boolean;
  inputTrack: boolean;
  monitor: boolean;
  bars: number;
  edit: {
    start: number;
    end: number;
    tune: number;
    level: number;
    fadeIn: number;
    fadeOut: number;
    reverse: boolean;
    slices: number;
    chopMode: number;
    boundaries: number[];
  };
}
export interface TouchscreenAction {
  value?: number;
  name?: string;
  renameKind?: number;
  kind:
    | "tempo"
    | "rename"
    | "settings"
    | "record"
    | "stop-record"
    | "keep"
    | "chop"
    | "discard"
    | "audition";
  track: number;
  pad: number;
}
export interface TouchscreenControl {
  kind?: "number";
  key?: string;
  value?: number;
  min?: number;
  max?: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
}
let module: Promise<WebAssembly.Module> | undefined;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();

/** One instance per surface: C++ owns layout, labels, gestures and sampler state. */
export class NativeTouchscreen {
  private constructor(private readonly c: TouchscreenCore) {}
  static async create() {
    module ??= import("./generated/xmp-sampler-ui-wasm.ts").then(({ DEVICE_UI_WASM_BASE64 }) =>
      WebAssembly.compile(decodeBase64(DEVICE_UI_WASM_BASE64)),
    );
    let core: TouchscreenCore | undefined;
    const instance = await WebAssembly.instantiate(await module, {
      wasi_snapshot_preview1: {
        clock_time_get: (_clock: number, _precision: bigint, out: number) => {
          if (!core) return 8;
          new DataView(core.memory.buffer).setBigUint64(out, 0n, true);
          return 0;
        },
        fd_close: () => 8,
        fd_seek: () => 8,
        fd_write: () => 8,
      },
    });
    core = instance.exports as unknown as TouchscreenCore;
    core._initialize();
    return new NativeTouchscreen(core);
  }
  private result<T>(): T {
    return JSON.parse(
      decoder.decode(
        new Uint8Array(this.c.memory.buffer, this.c.du_result(), this.c.du_result_size()),
      ),
    ) as T;
  }
  setProject(project: Project, track: number, pad: number) {
    const text = encoder.encode(
      JSON.stringify({ ...project, samples: project.samples.map((s) => ({ ...s, pcm: [] })) }),
    );
    const pointer = this.c.du_alloc(text.length);
    try {
      new Uint8Array(this.c.memory.buffer, pointer, text.length).set(text);
      if (!this.c.du_project(pointer, text.length, track, pad))
        throw new Error("Invalid touchscreen project");
    } finally {
      this.c.du_free(pointer);
    }
  }
  setTake(pcm: ArrayLike<number>, name = "Sample") {
    if (!Number.isInteger(pcm.length) || pcm.length < 0 || pcm.length > 1536000)
      throw new Error("Invalid sampler take length");
    const pointer = this.c.du_alloc(pcm.length * 4);
    try {
      new Float32Array(this.c.memory.buffer, pointer, pcm.length).set(pcm);
      if (!this.c.du_take(pointer, pcm.length)) throw new Error("Invalid sampler take");
      const text = encoder.encode(name.slice(0, 120)),
        p = this.c.du_alloc(text.length);
      try {
        new Uint8Array(this.c.memory.buffer, p, text.length).set(text);
        this.c.du_take_name(p, text.length);
      } finally {
        this.c.du_free(p);
      }
    } finally {
      this.c.du_free(pointer);
    }
  }
  recording(state: number, frames: number) {
    this.c.du_recording(state, frames);
  }
  notice(value: string) {
    const text = encoder.encode(value.slice(0, 120));
    const p = this.c.du_alloc(text.length);
    try {
      new Uint8Array(this.c.memory.buffer, p, text.length).set(text);
      this.c.du_notice(p, text.length);
    } finally {
      this.c.du_free(p);
    }
  }
  saveState(state: number) {
    this.c.du_save(state);
  }
  setEdit(start: number, end: number, reverse = false) {
    this.c.du_edit(start, end, reverse ? 1 : 0);
  }
  transport(step: number, playing: boolean) {
    this.c.du_transport(step, playing ? 1 : 0);
  }
  touch(phase: "down" | "move" | "up", x: number, y: number) {
    this.c.du_touch(["down", "move", "up"].indexOf(phase), Math.round(x), Math.round(y));
  }
  pad(pad: number, velocity = 1) {
    this.c.du_pad(pad, velocity);
  }
  button(name: string, down: boolean) {
    this.c.du_buttons();
    const normalize = (s: string) =>
      s === "+" || s === "-" ? s : s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const key = normalize(
      name === "plus"
        ? "+"
        : name === "minus"
          ? "-"
          : name === "record"
            ? "Rec"
            : name === "wheel"
              ? "data wheel"
              : name,
    );
    const button = this.result<{ id: number; name: string }[]>().find(
      (b) => normalize(b.name) === key,
    );
    if (button) this.c.du_button(button.id, down ? 1 : 0);
  }
  numberText(value: string) {
    const text = encoder.encode(value);
    if (text.length > 12) return;
    const p = this.c.du_alloc(text.length);
    try {
      new Uint8Array(this.c.memory.buffer, p, text.length).set(text);
      this.c.du_number(p, text.length);
    } finally {
      this.c.du_free(p);
    }
  }
  knob(knob: number, clicks: number) {
    this.c.du_knob(knob, clicks);
  }
  get state(): TouchscreenState {
    this.c.du_state();
    return this.result<TouchscreenState>();
  }
  actions(): TouchscreenAction[] {
    this.c.du_actions();
    return this.result<TouchscreenAction[]>();
  }
  controls(): TouchscreenControl[] {
    this.c.du_controls();
    return this.result<TouchscreenControl[]>();
  }
  preview(pad = -1): Float32Array {
    this.c.du_preview(pad);
    const { pointer, frames } = this.result<{ pointer: number; frames: number }>();
    return new Float32Array(this.c.memory.buffer, pointer, frames).slice();
  }
  paintRGBA(target: Uint8ClampedArray) {
    if (target.length !== 1280 * 800 * 4)
      throw new Error("Native touchscreen frame must be 1280 by 800");
    const pointer = this.c.du_draw();
    const source = new Uint32Array(this.c.memory.buffer, pointer, 1280 * 800);
    const destination = new Uint32Array(target.buffer, target.byteOffset, target.length / 4);
    for (let i = 0; i < source.length; ++i) {
      const pixel = source[i] ?? 0;
      destination[i] =
        0xff000000 | (pixel & 0x00ff00) | ((pixel >> 16) & 255) | ((pixel & 255) << 16);
    }
  }
}
