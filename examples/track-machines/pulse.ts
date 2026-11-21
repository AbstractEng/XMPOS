import type { MachineDefinition } from "../../packages/sdk/src/index.ts";
// Original one-voice audio machine. No hardware APIs or imported executable state.
export const pulseMachine: MachineDefinition = {
  id: "example.pulse",
  automation: true,
  name: "Example pulse machine",
  base: "audio",
  version: 1,
  capabilities: ["notes", "velocity", "audio-output"],
  parameters: [
    { id: "level", name: "Level", unit: "normalized", min: 0, max: 0.5, defaultValue: 0.15 },
  ],
  defaults: { level: 0.15 },
  validate(state) {
    if (
      Object.keys(state).join() !== "level" ||
      typeof state.level !== "number" ||
      !Number.isFinite(state.level) ||
      state.level < 0 ||
      state.level > 0.5
    )
      throw new Error("Pulse level must be 0–0.5");
  },
  create({ sampleRate, state }) {
    let phase = 0,
      remaining = 0,
      increment = 0,
      gain = 0,
      velocity = 0,
      level = Number(state.level);
    return {
      noteOn(event) {
        phase = 0;
        remaining = event.durationFrames || sampleRate / 4;
        increment = (440 * 2 ** ((event.note - 69) / 12)) / sampleRate;
        velocity = event.velocity;
        gain = level * velocity;
        return true;
      },
      setParameter(id, value) {
        if (id === "level") {
          level = Math.max(0, Math.min(0.5, value));
          gain = level * velocity;
        }
      },
      noteOff() {
        remaining = 0;
      },
      panic() {
        remaining = 0;
      },
      process(output, frames) {
        for (let i = 0; i < frames; i++) {
          output[i] =
            remaining > 0 ? Math.sin(phase * 2 * Math.PI) * gain * Math.min(1, remaining / 240) : 0;
          phase = (phase + increment) % 1;
          remaining = Math.max(0, remaining - 1);
        }
      },
    };
  },
};
