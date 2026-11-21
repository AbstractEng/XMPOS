import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoProject, expandSong } from "../packages/core/src/index.ts";
import { synthPresets } from "../packages/core/src/instrument-schema.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { machines } from "../packages/core/src/machines.ts";

// The Live session's synth (XMP's engine, rack.hpp, built natively through
// live_engine.hpp) must sound like the browser's xmp.subtractive (the same
// engine as WebAssembly): same note, patch and gate rendered by both.
const root = join(import.meta.dirname, "..");
const FRAMES = 64000, // long enough for the slowest release (Soft pad, 0.9 s) to finish
  GATE = 12000,
  NOTE = 48;

function browserRender(preset: number): Float32Array {
  const p = expandSong(createDemoProject());
  p.master = 1;
  for (const track of p.tracks) {
    track.volume = 1;
    for (const clip of track.clips) {
      clip.steps = [];
      delete clip.sequence;
    }
  }
  const track = p.tracks[1];
  if (!track) throw new Error("demo project has no second track");
  track.machine = machines.instantiate("xmp.subtractive");
  track.machine.state = { ...synthPresets[preset] };
  const rack = new VoiceRack(prepareInstruments(p), 48000);
  rack.noteOn(1, 0, 1, NOTE, 1, GATE);
  const out = new Float32Array(FRAMES),
    left = new Float32Array(128),
    right = new Float32Array(128);
  for (let at = 0; at < FRAMES; at += 128) {
    rack.process(left, right, 128);
    out.set(left.subarray(0, Math.min(128, FRAMES - at)), at);
  }
  return out;
}

function nativeRender(preset: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), "xmp-synth-"));
  const source = join(dir, "render.cpp"),
    binary = join(dir, "render");
  writeFileSync(
    source,
    `#include "xmp/live_engine.hpp"
#include "xmp/live_kits.hpp"
#include <cstdio>
#include <memory>
#include <vector>
int main() {
  // The Live session's path: a kit bank (the engine always has pads) and track 0 a synth.
  xmp::live::SampleBank kit;
  kit.set_single(0, std::vector<float>(16, 0.0f));
  std::array<const xmp::live::SampleBank*, xmp::live::kBanks> banks{};
  banks[0] = &kit;
  std::array<xmp::live::LiveEngine::TrackSound, xmp::live::kLiveTracks> sounds{};
  sounds[0] = {true, xmp::live::synth_presets()[${preset}]};
  auto engine = std::make_unique<xmp::live::LiveEngine>(48000);
  if (!engine->prepare(banks, sounds)) return 1;
  engine->play_note(0, 0, ${NOTE}, 1.0f, ${GATE});
  std::vector<float> left(${FRAMES}), right(${FRAMES});
  for (int at = 0; at < ${FRAMES}; at += 256) engine->process(left.data() + at, right.data() + at, ${FRAMES} - at < 256 ? ${FRAMES} - at : 256, at);
  std::fwrite(left.data(), 4, left.size(), stdout);
}`,
  );
  execFileSync("c++", [
    "-std=c++17",
    "-O1",
    `-I${join(root, "native/include")}`,
    source,
    "-o",
    binary,
  ]);
  return new Float32Array(new Uint8Array(execFileSync(binary, { maxBuffer: 1 << 24 })).buffer);
}

const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

describe.skipIf(!haveCompiler)("device synth matches the browser synth", () => {
  for (const [index, preset] of synthPresets.entries()) {
    it(`${preset.name}: same waveform, envelope and release`, () => {
      const browser = browserRender(index),
        device = nativeRender(index);
      expect(device.length).toBe(FRAMES);
      // Best-fit gain absorbs the browser mixer stage; the shape must match.
      let dot = 0,
        energy = 0;
      for (let i = 0; i < FRAMES; i++) {
        dot += (browser[i] ?? 0) * (device[i] ?? 0);
        energy += (device[i] ?? 0) ** 2;
      }
      const gain = dot / energy;
      let error = 0,
        peak = 0;
      for (let i = 0; i < FRAMES; i++) {
        error = Math.max(error, Math.abs((browser[i] ?? 0) - gain * (device[i] ?? 0)));
        peak = Math.max(peak, Math.abs(browser[i] ?? 0));
      }
      expect(peak).toBeGreaterThan(0.01);
      expect(gain).toBeGreaterThan(0.1);
      expect(error / peak).toBeLessThan(1e-3);
      // The note ends: release finishes within the patch's release time.
      const tail = device.subarray(GATE + Math.ceil(preset.release * 48000) + 64);
      expect(tail.length).toBeGreaterThan(1000);
      expect(Math.max(...tail.map(Math.abs))).toBe(0);
    }, 30000); // Includes a native C++ compilation for this preset.
  }
});
