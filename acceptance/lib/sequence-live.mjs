import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareInstruments } from "../../packages/core/src/instruments.ts";
import { groovePosition, parameterFrame, timeline } from "../../packages/core/src/sequencer.ts";
import { root } from "./workspace.mjs";
// Execute the production bundled processor with virtual output buffers, never AudioContext or a device.
export async function workletCapture(project, scene, steps, compiled) {
  const names = ["AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame"],
    old = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
  let Constructor;
  const messages = [];
  try {
    globalThis.AudioWorkletProcessor = class {
      port = { onmessage: () => {}, postMessage: (value) => messages.push(value) };
    };
    globalThis.sampleRate = 48000;
    globalThis.currentFrame = 0;
    globalThis.registerProcessor = (_name, value) => {
      Constructor = value;
    };
    const path = readdirSync(resolve(root, "dist/assets")).find((n) =>
      /^instrument-worklet-.*\.js$/.test(n),
    );
    assert.ok(path, "Build the production worklet first");
    await import(`${pathToFileURL(resolve(root, "dist/assets", path))}?probe=${Math.random()}`);
    assert.ok(Constructor);
    const processor = new Constructor(),
      send = (data) => processor.port.onmessage({ data });
    send({ op: "project", palette: prepareInstruments(project) });
    send({ op: "observe", enabled: true });
    let commands;
    if (compiled) {
      let nextId = 1;
      commands = compiled.commands.map((c) =>
        c.kind === "on"
          ? {
              op: "on",
              frame: c.frame,
              id: nextId++,
              pad: c.note.pad,
              track: project.tracks.findIndex((t) => t.id === c.note.trackId),
              note: c.note.note,
              velocity: c.note.velocity,
              duration: c.note.durationFrames,
            }
          : {
              op: c.kind,
              frame: c.frame,
              ...(c.tracks ? { tracks: c.tracks } : {}),
              ...(c.kind === "clock" ? { position: c.position, bpm: c.bpm } : {}),
              ...(c.values ? { values: c.values } : {}),
            },
      );
    } else {
      const notes = timeline(project, scene, 0, steps);
      commands = notes.map((n, i) => ({
        op: "on",
        frame: n.frame,
        id: i + 1,
        pad: n.pad,
        track: project.tracks.findIndex((t) => t.id === n.trackId),
        note: n.note,
        velocity: n.velocity,
        duration: n.durationFrames,
      }));
      for (let position = 0; position < steps; position += 0.25)
        commands.push({
          op: "parameters",
          frame: Math.round(
            ((groovePosition(position, project.swing) * 60) / project.bpm / 4) * 48000,
          ),
          values: parameterFrame(project, scene, position),
        });
      commands.sort((a, b) => a.frame - b.frame || (a.op === "parameters" ? -1 : 1));
    }
    let next = 0;
    const frames = compiled
        ? compiled.pcm.length
        : Math.round(((steps * 60) / project.bpm / 4) * 48000),
      pcm = new Float32Array(frames),
      rightPcm = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 128) {
      globalThis.currentFrame = frame;
      while (commands[next]?.frame < frame + 128) send(commands[next++]);
      const left = new Float32Array(Math.min(128, frames - frame)),
        right = new Float32Array(left.length);
      processor.process([], [[left, right]]);
      pcm.set(left, frame);
      rightPcm.set(right, frame);
    }
    send({ op: "panic" });
    assert.ok(!messages.some((m) => m.error), JSON.stringify(messages.filter((m) => m.error)));
    return {
      pcm,
      rightPcm,
      meters: messages.filter((m) => m.meter).map((m) => m.meter),
      notes: messages.filter((m) => m.noteTrace).map((m) => m.noteTrace),
    };
  } finally {
    names.forEach((name, i) => {
      if (old[i]) Object.defineProperty(globalThis, name, old[i]);
      else delete globalThis[name];
    });
  }
}
