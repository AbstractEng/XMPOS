import type { ControlAction, ControlPage } from "../../../../packages/core/src/control-actions.ts";
import type { PanelButton } from "./navigation.ts";

// A software mapping only: no USB identifiers, device handles, or output protocols.
export const liveMk1 = {
  id: "mpc-live-mk1",
  screen: { width: 1280, height: 800 },
  resolve(button: PanelButton, shift: boolean, page: ControlPage): ControlAction {
    if (button.startsWith("bank-"))
      return { type: "bank", index: "abcd".indexOf(button.slice(-1)) + (shift ? 4 : 0) };
    switch (button) {
      case "main":
        return { type: "navigate", page: shift ? "play" : "clips" };
      case "menu":
        return shift ? { type: "navigate", page: "library" } : { type: "menu" };
      case "q-link":
        return { type: "parameter-page", delta: shift ? -1 : 1 };
      case "undo":
        return { type: "history", redo: shift };
      case "copy":
        return { type: shift ? "delete" : "copy" };
      case "play":
        return shift && page === "library" ? { type: "audition" } : { type: "play" };
      case "play-start":
        return { type: "play", restart: true };
      case "rec":
        return { type: "record" };
      case "overdub":
        return { type: "record", overdub: true };
      case "plus":
        return { type: "focus", delta: 1 };
      case "minus":
        return { type: "focus", delta: -1 };
      case "shift":
      case "stop":
      case "erase":
      case "tap":
      case "full-level":
      case "16-level":
      case "note-repeat":
        return { type: button };
      default:
        throw new Error("Unknown Live Mk1 button");
    }
  },
};
