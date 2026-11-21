import { acousticProfile } from "../../packages/core/src/acoustic.ts";
import { createDemoProject, parseProject } from "../../packages/core/src/index.ts";
import { labLimits } from "../../packages/lab/src/contracts.ts";
import { measurementProfile } from "../../packages/lab/src/measurements.ts";
import { developmentGraph, engineProfile } from "./engine-target.mjs";
import { grooveOracle } from "./groove-fixture.mjs";
import { instrumentOracle } from "./instrument-fixture.mjs";
import { mixOracle } from "./mix-fixture.mjs";
import { performanceOracle } from "./performance-fixture.mjs";
import { sdkOracle } from "./sdk-fixture.mjs";
import { eightTrackFixture } from "./song-fixture.mjs";
import { sha256 } from "./workspace.mjs";
// An independent oracle: a half-scale impulse exactly at frame 24000.
export const musicalFixture = Object.freeze({
  version: 1,
  sampleRate: 48000,
  frames: 48000,
  eventFrame: 24000,
  pcm: Object.freeze([0.5, 0, 0, 0]),
  expectedPeak: 24000,
});
const projectText = JSON.stringify(createDemoProject());
export const projectFixtureHash = sha256(projectText);
export const fixtureHash = sha256(
  JSON.stringify({
    musicalFixture,
    labOracle: {
      version: 1,
      labLimits,
      measurementProfile,
      controlSurface: [16, 4, 800, 480],
      physical: false,
    },
    acousticProfile,
    instrumentOracle,
    performanceOracle,
    mixOracle,
    sdkOracle,
    sequencerOracle: {
      version: 1,
      repeatVelocities: [0.2, 0.8, 0.4],
      repeatFrames: [0, 6000, 12000],
      nativeGrooveFrames: [0, 6000, 12000, 18000, 96000, 104000, 108000, 116000, 192000, 198000],
      voices: 32,
      microtimingLimit: 0.49,
      controlGrid: 0.25,
      sequenceVersion: 1,
    },
    grooveOracle,
    engineProfile,
    engineGraph: developmentGraph(),
    loopbackOracle: { synthetic: true, trials: 1000, delayFrames: 480, sampleRate: 48000 },
    projectFixtureHash,
    projectStageFixture: eightTrackFixture(),
    projectStageOracle: {
      frames: 96000,
      eventFrames: [0, 6000, 12000, 18000, 24000, 30000, 36000, 42000, 72000],
      pcm: [9830, 8192, 8192, 8192, 8192, 8192, 8192, 8192, 4915],
    },
  }),
);
export function freshProject() {
  return parseProject(projectText);
}
export function firstNonzero(wav) {
  if (
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.readUInt16LE(22) !== 2 ||
    wav.readUInt32LE(24) !== 48000
  )
    throw new Error("Expected stereo 48 kHz PCM WAV");
  for (let offset = 44; offset < wav.length; offset += 4)
    if (wav.readInt16LE(offset) !== 0 || wav.readInt16LE(offset + 2) !== 0)
      return (offset - 44) / 4;
  return null;
}

export function assertMusicalCapture(wav) {
  if (
    wav.length !== 44 + musicalFixture.frames * 4 ||
    firstNonzero(wav) !== musicalFixture.expectedPeak
  )
    throw new Error("Audio timing or length differs from independent impulse oracle");
  for (let frame = 0; frame < musicalFixture.frames; frame++) {
    const expected = frame === 24000 ? 16384 : 0;
    for (let channel = 0; channel < 2; channel++)
      if (Math.abs(wav.readInt16LE(44 + frame * 4 + channel * 2) - expected) > 2)
        throw new Error(`PCM mismatch at frame ${frame}, channel ${channel}`);
  }
}
