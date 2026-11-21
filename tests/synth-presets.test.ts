import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoProject, expandSong, type Project } from "../packages/core/src/index.ts";
import {
  PRESETS_PER_PAGE,
  SynthPatchSchema,
  synthPresetPages,
  synthPresets,
} from "../packages/core/src/instrument-schema.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { machines } from "../packages/core/src/machines.ts";

// The synth's 32 presets (four pages of eight) and the controls the later
// pages use: resonance, the filter envelope, a detuned second oscillator and
// glide (rack.hpp). The engine itself is C++, here as WebAssembly.
const root = join(import.meta.dirname, "..");

function synthProject(state: Record<string, unknown>): Project {
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
  track.machine.state = { ...state };
  return p;
}
// Notes on track 1: [note, velocity, start frame, gate frames].
function render(state: Record<string, unknown>, notes: number[][], frames = 24000) {
  const rack = new VoiceRack(prepareInstruments(synthProject(state)), 48000);
  const out = new Float32Array(frames),
    left = new Float32Array(128),
    right = new Float32Array(128);
  let id = 1;
  for (let at = 0; at < frames; at += 128) {
    for (const [note, velocity, start, gate] of notes)
      if ((start ?? 0) >= at && (start ?? 0) < at + 128)
        rack.noteOn(id++, 0, 1, note ?? 48, velocity ?? 1, gate ?? 12000);
    rack.process(left, right, 128);
    out.set(left.subarray(0, Math.min(128, frames - at)), at);
  }
  return out;
}
const peak = (pcm: Float32Array) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
// Brightness: how much of the signal is in its sample-to-sample changes.
function brightness(pcm: Float32Array) {
  let d = 0,
    e = 0;
  for (let i = 1; i < pcm.length; i++) {
    d += ((pcm[i] ?? 0) - (pcm[i - 1] ?? 0)) ** 2;
    e += (pcm[i] ?? 0) ** 2;
  }
  return d / Math.max(e, 1e-12);
}
// The level of one frequency (Goertzel).
function level(pcm: Float32Array, hz: number) {
  const w = (2 * Math.PI * hz) / 48000,
    c = 2 * Math.cos(w);
  let a = 0,
    b = 0;
  for (const x of pcm) [a, b] = [x + c * a - b, a];
  return Math.sqrt(a * a + b * b - c * a * b) / pcm.length;
}
// Upward zero crossings per second: the pitch of a simple wave.
function pitch(pcm: Float32Array) {
  let n = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] ?? 0) < 0 && (pcm[i] ?? 0) >= 0) n++;
  return (n * 48000) / pcm.length;
}

describe("the synth's presets", () => {
  it("are four pages of eight valid, distinct patches", () => {
    expect(synthPresets).toHaveLength(synthPresetPages.length * PRESETS_PER_PAGE);
    expect(synthPresetPages).toEqual([
      "Classic",
      "Pop & rock",
      "Electronic & dance",
      "House & acid",
    ]);
    expect(new Set(synthPresets.map((p) => p.name)).size).toBe(synthPresets.length);
    for (const preset of synthPresets) expect(() => SynthPatchSchema.parse(preset)).not.toThrow();
    // The Classic page is the original eight, unchanged.
    expect(synthPresets.slice(0, 8).map((p) => p.name)).toEqual([
      "Warm bass",
      "Soft key",
      "Bright lead",
      "Pluck",
      "Soft pad",
      "Sub bass",
      "Organ",
      "Brass",
    ]);
    expect(synthPresets.slice(0, 8).every((p) => Object.keys(p).length === 7)).toBe(true);
    expect(synthPresets.slice(8).every((p) => Object.keys(p).length === 12)).toBe(true);
  });

  it("all play, near one another's loudness, without clipping", () => {
    const peaks: number[] = [];
    for (const preset of synthPresets) {
      // A held note long enough for the slowest attack, then a softer one.
      const pcm = render(
        preset,
        [
          [36, 1, 0, 30000],
          [43, 0.6, 32000, 4000],
        ],
        40000,
      );
      peaks.push(peak(pcm));
      expect(peak(pcm), preset.name).toBeGreaterThan(0.02);
      expect(peak(pcm), preset.name).toBeLessThan(0.9);
      expect(
        pcm.every((v) => Number.isFinite(v)),
        preset.name,
      ).toBe(true);
    }
    if (process.env.XMP_PRESET_PEAKS)
      console.log(
        synthPresets.map((p, i) => `${p.name}: ${(peaks[i] ?? 0).toFixed(3)}`).join("\n"),
      );
    // Within about 12 dB of one another.
    expect(Math.max(...peaks) / Math.min(...peaks)).toBeLessThan(4);
  }, 60000);
});

describe("the synth's later controls", () => {
  const base = synthPresets[0] as Record<string, unknown>;
  it("change nothing at their defaults, so older projects sound the same", () => {
    const notes = [
      [45, 0.8, 0, 8000],
      [52, 0.5, 4000, 8000],
    ];
    const before = render(base, notes),
      after = render(
        { ...base, resonance: 0, "env-amount": 0, "env-decay": 0.3, detune: 0, glide: 0 },
        notes,
      );
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  it("resonance rings at the cutoff", () => {
    const state = { ...base, oscillator: "saw", cutoff: 1200, sustain: 1 };
    const plain = render(state, [[36, 1, 0, 20000]]).subarray(4000, 20000),
      ringing = render({ ...state, resonance: 0.9 }, [[36, 1, 0, 20000]]).subarray(4000, 20000);
    // Relative to the fundamental (65 Hz), the cutoff's neighbourhood is far louder.
    const ratio = (pcm: Float32Array) =>
      Math.max(level(pcm, 1177), level(pcm, 1243), level(pcm, 1112)) / level(pcm, 65.4);
    expect(ratio(ringing)).toBeGreaterThan(ratio(plain) * 4);
  });

  it("the filter envelope opens the sound at the attack, further for harder hits", () => {
    const state = { ...base, cutoff: 300, sustain: 1, "env-amount": 4, "env-decay": 0.1 };
    const hard = render(state, [[36, 1, 0, 20000]]),
      soft = render(state, [[36, 0.2, 0, 20000]]);
    const early = (pcm: Float32Array) => brightness(pcm.subarray(200, 2000));
    expect(early(hard)).toBeGreaterThan(brightness(hard.subarray(14000, 20000)) * 3);
    expect(early(hard)).toBeGreaterThan(early(soft) * 1.5);
  });

  it("detune beats a second oscillator against the first", () => {
    const state = { ...base, oscillator: "sine", cutoff: 16000, sustain: 1 };
    const one = render(state, [[69, 1, 0, 24000]]),
      two = render({ ...state, detune: 50 }, [[69, 1, 0, 24000]]);
    // 440 Hz and 452.9 Hz: the level swells and falls about 13 times a second.
    const envelope = (pcm: Float32Array) => {
      const blocks: number[] = [];
      for (let at = 2400; at + 480 <= 24000; at += 480)
        blocks.push(peak(pcm.subarray(at, at + 480)));
      return Math.max(...blocks) - Math.min(...blocks);
    };
    expect(envelope(one)).toBeLessThan(0.01);
    expect(envelope(two)).toBeGreaterThan(0.1);
  });

  it("glide slides a note from the track's previous note", () => {
    const state = { ...base, oscillator: "sine", cutoff: 16000, sustain: 1, glide: 0.2 };
    const pcm = render(state, [
      [45, 1, 0, 12000],
      [69, 1, 12000, 12000],
    ]);
    // 110 Hz to 440 Hz: the first 20 ms of the new note are still low; after 300 ms it has arrived.
    expect(pitch(pcm.subarray(12100, 13060))).toBeLessThan(250);
    expect(pitch(pcm.subarray(20000, 24000))).toBeGreaterThan(400);
    const straight = render({ ...state, glide: 0 }, [
      [45, 1, 0, 12000],
      [69, 1, 12000, 12000],
    ]);
    expect(pitch(straight.subarray(12100, 13060))).toBeGreaterThan(400);
  });
});

const haveCompiler = spawnSync("c++", ["--version"]).status === 0;
describe.skipIf(!haveCompiler)("the Live's presets", () => {
  it("write exactly what the browser's presets hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "xmp-presets-"));
    const project = synthProject(synthPresets[0] as Record<string, unknown>);
    writeFileSync(join(dir, "project.json"), JSON.stringify(project));
    writeFileSync(
      join(dir, "presets.cpp"),
      `#include "xmp/live_edit.hpp"
#include <cstdio>
#include <fstream>
#include <sstream>
int main(int, char** argv) {
  std::ifstream in(argv[1]);
  std::stringstream text;
  text << in.rdbuf();
  const std::string s = text.str();
  auto parsed = xmp::json::parse(s.data(), s.size());
  if (!parsed.ok) return 2;
  for (int i = 0; i < xmp::synth::kPresets; ++i) {
    xmp::json::Value doc = parsed.value;
    xmp::live::edit::History history;
    std::string why;
    if (!xmp::live::edit::set_preset(doc, 1, i, history, why)) return std::fprintf(stderr, "%s\\n", why.c_str()), 3;
    const auto& track = doc.get("tracks")->items()[1];
    std::printf("%s\\n", xmp::json::stringify(*track.get("machine")->get("state")).c_str());
  }
}`,
    );
    const binary = join(dir, "presets");
    execFileSync("c++", [
      "-std=c++20",
      "-O1",
      `-I${join(root, "native/include")}`,
      join(dir, "presets.cpp"),
      "-o",
      binary,
    ]);
    const lines = execFileSync(binary, [join(dir, "project.json")], { encoding: "utf8" })
      .trim()
      .split("\n");
    expect(lines).toEqual(synthPresets.map((p) => JSON.stringify(p)));
  }, 120000);
});
