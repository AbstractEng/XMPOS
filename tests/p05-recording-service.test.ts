import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { encodeWav } from "@xmp/core";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Host-only service is executable ESM.
import { createRecordingService } from "../tools/lib/recording-service.mjs";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const inventory = () => ({
  input: {
    id: 1,
    uid: "BuiltInMicrophoneDevice",
    name: "MacBook Pro Microphone",
    builtIn: true,
    alive: true,
    sampleRate: 44100,
    inputChannels: 1,
    outputChannels: 0,
  },
});
it("refuses CI and non-built-in input before invoking a recorder", () => {
  const launch = vi.fn();
  for (const options of [
    { ci: true, platform: "darwin", inspect: inventory },
    { ci: false, platform: "linux", inspect: inventory },
    {
      ci: false,
      platform: "darwin",
      inspect: () => ({ input: { ...inventory().input, builtIn: false, name: "Akai Force" } }),
    },
  ]) {
    const service = createRecordingService({ ...options, launch });
    expect(() => service.start(120)).toThrow();
  }
  expect(launch).not.toHaveBeenCalled();
});
it("keeps one bounded native session, validates final capture identity and serves the complete take", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "xmp-record-service-"));
  paths.push(directory);
  let finish = () => {},
    takePath = "";
  const service = createRecordingService({
    platform: "darwin",
    ci: false,
    inspect: inventory,
    baseDirectory: directory,
    launch: (path: string, done: () => void) => {
      finish = done;
      takePath = path;
    },
  });
  const session = service.start(120);
  expect(session.frames).toBe(176400);
  expect(() => service.start(120)).toThrow("already active");
  expect(() => service.take(session.id)).toThrow("not finalized");
  expect(service.status(session.id).state).toBe("recording");
  expect(JSON.parse(readFileSync(resolve(takePath, "record.json"), "utf8"))).toEqual({
    frames: 176400,
  });
  const pcm = new Float32Array(176400).fill(0.1);
  writeFileSync(resolve(takePath, "capture.wav"), Buffer.from(encodeWav([pcm], 44100)));
  const report = {
    ...inventory(),
    outcome: "recorded",
    streamsStopped: true,
    inputStreamsStarted: 1,
    outputStreamsStarted: 0,
    inputFrames: 176400,
  };
  writeFileSync(resolve(takePath, "device-capture.json"), JSON.stringify(report));
  expect(service.status(session.id).state).toBe("recording");
  finish();
  expect(service.status(session.id).state).toBe("recorded");
  expect(service.take(session.id).length).toBe(44 + 176400 * 2);
  report.input.id = 999;
  writeFileSync(resolve(takePath, "device-capture.json"), JSON.stringify(report));
  expect(() => service.take(session.id)).toThrow("identity");
});
