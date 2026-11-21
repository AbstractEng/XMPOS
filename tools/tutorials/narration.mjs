import { lessons } from "./lessons.mjs";
// Keep speech, burned-in instructions, VTT and written steps in one source.
export const narration = lessons.map((lesson) => lesson.steps.map((step) => step[4]));
