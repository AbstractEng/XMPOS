import { z } from "zod";

// Instrument commands, independent of keyboard, browser, or physical panel.
export const ControlPageSchema = z.enum([
  "clips",
  "play",
  "steps",
  "sound",
  "sample",
  "track",
  "library",
  "scenes",
  "song",
  "mix",
  "mute",
  "project",
  "preferences",
  "menu",
]);
export type ControlPage = z.infer<typeof ControlPageSchema>;
export const ControlActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), page: ControlPageSchema }),
  z.object({ type: z.literal("menu") }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("activate") }),
  z.object({ type: z.literal("shift") }),
  z.object({ type: z.literal("bank"), index: z.number().int().min(0).max(7) }),
  z.object({
    type: z.literal("pad"),
    index: z.number().int().min(0).max(15),
    edit: z.boolean().default(false),
  }),
  z.object({ type: z.literal("focus"), delta: z.number().int().min(-16).max(16) }),
  z.object({ type: z.literal("parameter-page"), delta: z.union([z.literal(-1), z.literal(1)]) }),
  z.object({
    type: z.literal("parameter"),
    index: z.number().int().min(0).max(3),
    value: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal("play"), restart: z.boolean().default(false) }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("record"), overdub: z.boolean().default(false) }),
  z.object({ type: z.literal("history"), redo: z.boolean().default(false) }),
  z.object({ type: z.literal("copy") }),
  z.object({ type: z.literal("delete") }),
  z.object({ type: z.literal("erase") }),
  z.object({ type: z.literal("full-level") }),
  z.object({ type: z.literal("16-level") }),
  z.object({ type: z.literal("note-repeat") }),
  z.object({ type: z.literal("tap") }),
  z.object({ type: z.literal("audition") }),
]);
export type ControlAction = z.input<typeof ControlActionSchema>;
