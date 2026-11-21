import type { MachineDefinition } from "../../packages/sdk/src/index.ts";
// Virtual MIDI transformation; host decides whether a separately authorized route exists.
export const transposeMachine: MachineDefinition = {
  id: "example.transpose",
  automation: true,
  name: "Example MIDI transpose",
  base: "midi",
  version: 1,
  capabilities: ["notes", "velocity", "midi-output"],
  parameters: [
    {
      id: "semitones",
      name: "Transpose",
      unit: "semitones",
      step: 1,
      min: -24,
      max: 24,
      defaultValue: 12,
    },
  ],
  defaults: { semitones: 12 },
  validate(state) {
    if (
      !Number.isInteger(state.semitones) ||
      Number(state.semitones) < -24 ||
      Number(state.semitones) > 24 ||
      Object.keys(state).length !== 1
    )
      throw new Error("Invalid transpose interval");
  },
  create({ emitMidi, state }) {
    const voices = Array.from({ length: 32 }, () => ({ id: -1, note: 0, left: 0, active: false }));
    const off = (id: number) => {
      for (const v of voices)
        if (v.active && v.id === id) {
          emitMidi({ kind: "off", id: v.id, note: v.note, velocity: 0, channel: 1 });
          v.active = false;
        }
    };
    return {
      noteOn(event) {
        off(event.id);
        const v = voices.find((v) => !v.active);
        if (!v) return false;
        Object.assign(v, {
          id: event.id,
          note: Math.max(0, Math.min(127, event.note + Number(state.semitones))),
          left: event.durationFrames || -1,
          active: true,
        });
        emitMidi({ kind: "on", id: event.id, note: v.note, velocity: event.velocity, channel: 1 });
        return true;
      },
      setParameter(id, value) {
        if (id === "semitones") state.semitones = Math.round(Math.max(-24, Math.min(24, value)));
      },
      noteOff: off,
      panic() {
        for (const v of voices) if (v.active) off(v.id);
      },
      process(_output, frames) {
        for (const v of voices)
          if (v.active && v.left > 0) {
            v.left -= frames;
            if (v.left <= 0) off(v.id);
          }
      },
    };
  },
};
