// The MPC Live Mk1's own controls for the Device view (phase 3). Active only
// when the page is opened with ?hardware=live-mk1 by the Live's app service
// (os/guest/live.ts). Events arrive over a same-origin WebSocket from that
// service, which gets them from xmp-live-input; the page itself has no MIDI,
// USB or HID access and never sends anything to the hardware.
import type { DeviceController } from "./controller.ts";
import { type PanelButton, panelButtons } from "./navigation.ts";
import { qlinks } from "./view.ts";

export type HardwareEvent =
  | { t: "pad"; index: number; velocity: number; down: boolean }
  | { t: "button"; name: string; down: boolean }
  | { t: "dial"; delta: number }
  | { t: "knob"; knob: number; delta: number };

// Bounded validation: anything else is ignored.
export function parseHardwareEvent(text: string): HardwareEvent | undefined {
  if (text.length > 256) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  if (
    e.t === "pad" &&
    int(e.index, 0, 15) &&
    int(e.velocity, 0, 127) &&
    typeof e.down === "boolean"
  )
    return { t: "pad", index: e.index as number, velocity: e.velocity as number, down: e.down };
  if (
    e.t === "button" &&
    typeof e.name === "string" &&
    (panelButtons as readonly string[]).includes(e.name)
  )
    return typeof e.down === "boolean" ? { t: "button", name: e.name, down: e.down } : undefined;
  if (e.t === "dial" && int(e.delta, -63, 63)) return { t: "dial", delta: e.delta as number };
  if (e.t === "knob" && int(e.knob, 1, 4) && int(e.delta, -63, 63))
    return { t: "knob", knob: e.knob as number, delta: e.delta as number };
  return undefined;
}

export interface HardwareTarget {
  button(name: PanelButton, shift: boolean): unknown;
  dispatch(
    action:
      | { type: "pad"; index: number; edit?: boolean }
      | { type: "focus"; delta: number }
      | { type: "parameter"; index: number; value: number },
  ): unknown;
  // Current value (0..1) of Q-Link parameter 0..3 on the shown page.
  qlinkValue?(index: number): number | undefined;
}

// A failed action is reported in the page console (the device log on the Live),
// never silently dropped.
function report(result: unknown, what: string) {
  if (result && typeof (result as Promise<unknown>).catch === "function")
    (result as Promise<unknown>).catch((error: unknown) =>
      console.error(
        `hardware ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}

// Applies one event; returns a short description for diagnostics.
export function applyHardwareEvent(
  target: HardwareTarget,
  e: HardwareEvent,
  state: { shift: boolean },
): string {
  switch (e.t) {
    case "button":
      if (e.name === "shift") {
        state.shift = e.down;
        return `shift ${e.down ? "held" : "released"}`;
      }
      if (!e.down) return "";
      report(target.button(e.name as PanelButton, state.shift), `button ${e.name}`);
      return `button ${e.name}`;
    case "pad":
      if (!e.down) return "";
      report(
        target.dispatch({ type: "pad", index: e.index, edit: state.shift }),
        `pad ${e.index + 1}`,
      );
      return `pad ${e.index + 1}`;
    case "dial":
      for (let i = 0; i < Math.min(16, Math.abs(e.delta)); i++)
        void target.dispatch({ type: "focus", delta: Math.sign(e.delta) });
      return `dial ${e.delta}`;
    case "knob": {
      // The Live's Q-Link knobs are relative encoders: 1% of the range per click.
      const index = e.knob - 1;
      const current = target.qlinkValue?.(index);
      if (current === undefined || !Number.isFinite(current)) return "";
      const value = Math.min(1, Math.max(0, current + e.delta * 0.01));
      report(target.dispatch({ type: "parameter", index, value }), `knob ${e.knob}`);
      return `knob ${e.knob} ${value.toFixed(2)}`;
    }
    default:
      return "";
  }
}

export function connectHardware(c: DeviceController) {
  if (new URLSearchParams(location.search).get("hardware") !== "live-mk1") return;
  // On the Live the physical controls are real: show only the instrument screen,
  // full-screen at its native 1280x800 (style.css, .hardware-live-mk1).
  document.body.classList.add("hardware-live-mk1");
  const state = { shift: false };
  // The page's errors go to the Live's device log (short text frames).
  let current: WebSocket | undefined;
  const send = (text: string) => {
    if (current?.readyState === WebSocket.OPEN) current.send(text.slice(0, 120));
  };
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    send(`error ${args.map(String).join(" ")}`);
  };
  window.addEventListener("error", (e) => send(`uncaught ${e.message}`));
  window.addEventListener("unhandledrejection", (e) =>
    send(`unhandled ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`),
  );
  const target: HardwareTarget = {
    button: (name, shift) => c.button(name, shift),
    dispatch: (action) => c.dispatch(action),
    qlinkValue: (index) => qlinks(c)[index]?.value,
  };
  const open = () => {
    const socket = new WebSocket(`ws://${location.host}/hardware`);
    current = socket;
    socket.onmessage = (message) => {
      const event = typeof message.data === "string" ? parseHardwareEvent(message.data) : undefined;
      if (event) applyHardwareEvent(target, event, state);
    };
    socket.onclose = () => setTimeout(open, 1000);
  };
  open();
}
