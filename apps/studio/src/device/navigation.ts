import type { ControlPage } from "../../../../packages/core/src/control-actions.ts";
export type DevicePage = ControlPage;
export const menuPages: { page: DevicePage; name: string }[] = [
  { page: "play", name: "Play machine" },
  { page: "steps", name: "Step editor" },
  { page: "sample", name: "Sample" },
  { page: "sound", name: "Sound" },
  { page: "clips", name: "Clips" },
  { page: "song", name: "Song chain" },
  { page: "mix", name: "Mixer" },
  { page: "library", name: "Browse" },
  { page: "project", name: "Project" },
];
export const menuPad = (pad: number) =>
  pad >= 12 ? pad - 12 : pad >= 8 ? 4 + pad - 8 : pad === 0 ? 8 : -1;
export const panelButtons = [
  "bank-a",
  "bank-b",
  "bank-c",
  "bank-d",
  "note-repeat",
  "full-level",
  "16-level",
  "erase",
  "q-link",
  "shift",
  "menu",
  "main",
  "undo",
  "copy",
  "plus",
  "tap",
  "rec",
  "overdub",
  "stop",
  "play",
  "play-start",
  "minus",
] as const;
export type PanelButton = (typeof panelButtons)[number];
export interface DeviceNavigation {
  page: DevicePage;
  previous: DevicePage;
  bank: number;
  cursor: number;
  pad: number;
  qPage: number;
  shift: boolean;
}
export const initialNavigation = (): DeviceNavigation => ({
  page: "clips",
  previous: "clips",
  bank: 0,
  cursor: 12,
  pad: 0,
  qPage: 0,
  shift: false,
});
export function slotCoordinates(bank: number, pad: number) {
  if (
    !Number.isInteger(bank) ||
    bank < 0 ||
    bank > 7 ||
    !Number.isInteger(pad) ||
    pad < 0 ||
    pad > 15
  )
    throw new Error("Invalid panel coordinates");
  return {
    track: Math.floor(bank / 4) * 4 + (pad % 4),
    scene: (bank % 4) * 4 + 3 - Math.floor(pad / 4),
  };
}
export const padOrder = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
