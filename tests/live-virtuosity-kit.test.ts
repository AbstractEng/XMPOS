import { describe, expect, it } from "vitest";
import {
  folderName,
  MIXES,
  mixDown,
  onMic,
  PADS,
  pickLayers,
  retune,
  shape,
  wav24,
} from "../tools/live-mk1/virtuosity-kit.mjs";

// The Virtuosity Drums converter for the Live's sampler track (CC0 samples,
// downloaded at build time, never committed).
describe("Virtuosity Drums kit for the sampler track", () => {
  it("thins 36 velocity layers to 8, soft to loud, keeping both ends", () => {
    const paths = Array.from(
      { length: 36 },
      (_, i) => `Samples/lofi/snare/lofi_snare_center_vl${i + 1}.flac`,
    );
    const layers = pickLayers(paths, "snare/snare_center");
    expect(layers.map((l) => l.vl)).toEqual([1, 6, 11, 16, 21, 26, 31, 36]);
  });

  it("groups round-robin takes inside a layer and ignores other articulations", () => {
    const paths = [
      "Samples/lofi/hh/lofi_hh_closed_vl2_rr2.flac",
      "Samples/lofi/hh/lofi_hh_closed_vl2_rr1.flac",
      "Samples/lofi/hh/lofi_hh_closed_vl1_rr1.flac",
      "Samples/lofi/hh/lofi_hh_closed_half_vl1_rr1.flac",
      "Samples/lofi/hh/lofi_hh_open_vl1_rr1.flac",
      "Samples/mid/hh/lofi_hh_closed_vl1_rr1.flac",
    ];
    const layers = pickLayers(paths, "hh/hh_closed");
    expect(layers.map((l) => [l.vl, l.takes.map((t) => t.rr)])).toEqual([
      [1, [1]],
      [2, [1, 2]],
    ]);
  });

  it("lays out 16 pads with the hi-hat in one choke group, as the loader expects", () => {
    expect(PADS.map((p) => p.pad)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(PADS.map(folderName)[2]).toBe("03 closed hat_c1");
    expect(PADS.map(folderName)[0]).toBe("01 kick");
    expect(PADS.filter((p) => p.choke).map((p) => p.name)).toEqual([
      "closed hat",
      "open hat",
      "pedal hat",
      "half hat",
    ]);
  });

  it("trims silence, caps length with a fade, and writes 24-bit mono WAV", () => {
    const s = new Float32Array(48000 * 3).fill(0.5);
    s.fill(0, 48000 * 2);
    expect(shape(s, 5).length).toBe(96000);
    const capped = shape(Float32Array.from(s), 1);
    expect(capped.length).toBe(48000);
    expect(capped[capped.length - 1]).toBe(0);
    const w = wav24(Float32Array.from([0.5, -0.5]), 1);
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.readUInt16LE(22)).toBe(1); // mono
    expect(w.readUInt16LE(34)).toBe(24);
    expect(w.readIntLE(44, 3)).toBe(4194304);
  });

  it("mixes the same take from each mic: close kick, snare, overheads and some room", () => {
    expect(MIXES.studio).toEqual({ kickmic: 1, snaremic: 1, oh: 1, room: 0.3 });
    expect(onMic("Samples/kickmic/kick/kickmic_kick_snoff_vl4_rr1.flac", "kickmic", "oh")).toBe(
      "Samples/oh/kick/oh_kick_snoff_vl4_rr1.flac",
    );
    const mixed = mixDown([
      [Float32Array.from([1, 1, 1]), 1],
      [Float32Array.from([1, 1]), 0.5],
    ]);
    expect([...mixed]).toEqual([1.5, 1.5, 1]);
  });

  it("tunes the kick down 3 semitones (longer, lower)", () => {
    expect(PADS[0]?.tune).toBe(-3);
    const tone = Float32Array.from({ length: 4800 }, (_, i) =>
      Math.sin((2 * Math.PI * 100 * i) / 48000),
    );
    const low = retune(tone, -3);
    expect(low.length).toBeGreaterThan(5700);
    expect(low.length).toBeLessThan(5715);
  });
});
