import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyDrumKit } from "../packages/core/src/drum-kits.ts";
import { drumMachineKit, make808, make909 } from "../packages/core/src/drum-machines.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { prepareInstruments } from "../packages/core/src/instruments.ts";

// The web build's 808 and 909-style kits are the MPC Live session's kits
// (native/include/xmp/live_kits.hpp), ported: same formulas, same sounds.
const root = join(import.meta.dirname, "..");
const RATE = 48000;

function nativeKits(): Float32Array[] {
  const dir = mkdtempSync(join(tmpdir(), "xmp-kits-"));
  const source = join(dir, "kits.cpp"),
    binary = join(dir, "kits");
  writeFileSync(
    source,
    `#include "xmp/live_kits.hpp"
#include <cstdio>
#include <cstdint>
int main() {
  for (int style = 1; style <= 2; ++style)
    for (int pad = 0; pad < 16; ++pad) {
      const auto s = xmp::live::make_kit_sound(style, pad, ${RATE});
      const std::uint32_t n = static_cast<std::uint32_t>(s.size());
      std::fwrite(&n, 4, 1, stdout);
      std::fwrite(s.data(), 4, n, stdout);
    }
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
  const bytes = execFileSync(binary, { maxBuffer: 1 << 26 });
  const out: Float32Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const n = bytes.readUInt32LE(at);
    out.push(
      new Float32Array(
        bytes.buffer.slice(bytes.byteOffset + at + 4, bytes.byteOffset + at + 4 + n * 4),
      ),
    );
    at += 4 + n * 4;
  }
  return out;
}

const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

describe.skipIf(!haveCompiler)("the web's 808 and 909 kits match the Live's", () => {
  it("renders all 32 sounds the same as the device", () => {
    const native = nativeKits();
    expect(native).toHaveLength(32);
    for (let i = 0; i < 32; i++) {
      const web = i < 16 ? make808(i, RATE) : make909(i - 16, RATE);
      const device = native[i] ?? new Float32Array();
      expect(web.length, `sound ${i}`).toBe(device.length);
      let error = 0;
      for (let j = 0; j < web.length; j++)
        error = Math.max(error, Math.abs((web[j] ?? 0) - (device[j] ?? 0)));
      expect(error, `sound ${i}`).toBeLessThan(1e-3);
    }
  });
});

describe("XMP 808 and 909-style kits in the web build", () => {
  it("are 16 original, normalized sounds with the hi-hats in one choke group", () => {
    for (const style of ["808", "909"] as const) {
      const kit = drumMachineKit(style);
      expect(kit.samples).toHaveLength(16);
      for (const sample of kit.samples) {
        const peak = Math.max(...sample.pcm.map(Math.abs));
        expect(peak).toBeGreaterThan(0.99);
        expect(peak).toBeLessThanOrEqual(1);
      }
      const project = applyDrumKit(createDemoProject(), kit);
      expect(project.pads.map((p) => p.playback?.chokeGroup)).toEqual([
        0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      expect(project.pads[0]?.name).toBe("Kick");
      expect(project.samples.reduce((n, s) => n + s.pcm.length, 0)).toBeLessThan(1_000_000);
      expect(prepareInstruments(project).pads[3]?.chokeGroup).toBe(1);
    }
  });

  it("stay finite at lower sample rates (the shaker's filter once ran away)", () => {
    for (const style of ["808", "909"] as const)
      for (const rate of [44100, 32000, 24000, 16000]) {
        for (const sample of drumMachineKit(style, rate).samples)
          expect(sample.pcm.every(Number.isFinite), `${style} ${sample.name} at ${rate}`).toBe(
            true,
          );
      }
  });
});
