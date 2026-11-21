// XMP's 808-style and 909-style kits, synthesized from formulas in the manner
// of classic analog drum machines (tuned sines with pitch drops, a metallic
// six-square cluster through filters, noise bursts). No recordings or samples
// of any instrument are used; the names describe a style only.
//
// A port of the MPC Live session's kits (native/include/xmp/live_kits.hpp);
// tests/drum-machines.test.ts renders both and compares them.
import type { DrumKit } from "./drum-kits.ts";

const PI = Math.PI;

class Noise {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return (this.state >>> 8) / 8388608 - 1;
  }
}

// Two-pole state-variable filter (Chamberlin).
class Svf {
  low = 0;
  band = 0;
  f: number;
  q: number;
  constructor(hz: number, resonance: number, rate: number) {
    this.q = 1 / resonance;
    // The Chamberlin filter is stable only while f < sqrt(4 + q²) − q; past it
    // (a bright, low-resonance band at a low rate) it runs away to NaN.
    const stable = 0.999 * (Math.sqrt(4 + this.q * this.q) - this.q);
    this.f = Math.min(2 * Math.sin((PI * Math.min(hz, rate / 6)) / rate), stable);
  }
  high(input: number) {
    this.low += this.f * this.band;
    const h = input - this.low - this.q * this.band;
    this.band += this.f * h;
    return h;
  }
  bandpass(input: number) {
    this.high(input);
    return this.band;
  }
}

const f32 = (n: number) => Math.fround(n);
const frames = (seconds: number, rate: number) => Math.floor(seconds * rate);

function finish(s: Float32Array) {
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < s.length; i++) s[i] = f32((s[i] ?? 0) / peak);
  const fade = Math.min(s.length, 96);
  for (let i = 0; i < fade; i++) {
    const at = s.length - 1 - i;
    s[at] = f32((s[at] ?? 0) * f32(i / fade));
  }
  return s;
}

function swept(
  rate: number,
  seconds: number,
  start: number,
  end: number,
  drop: number,
  decay: number,
  click = 0,
  seed = 1,
) {
  const s = new Float32Array(frames(seconds, rate));
  const noise = new Noise(seed);
  let phase = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / rate;
    phase += (2 * PI * (end + (start - end) * Math.exp(-t / drop))) / rate;
    let v = Math.sin(phase) * Math.exp(-t / decay);
    if (click > 0 && t < 0.004) v += click * noise.next() * (1 - t / 0.004);
    s[i] = v;
  }
  return s;
}

const SQUARES = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
function metallic(rate: number, seconds: number, decay: number, band: number, scale: number) {
  const s = new Float32Array(frames(seconds, rate));
  const phase = SQUARES.map(() => 0);
  const bp = new Svf(band, 2.0, rate),
    hp = new Svf(band * 0.8, 0.7, rate);
  for (let i = 0; i < s.length; i++) {
    let sum = 0;
    for (let k = 0; k < SQUARES.length; k++) {
      phase[k] = ((phase[k] ?? 0) + ((SQUARES[k] ?? 0) * scale) / rate) % 1;
      sum += (phase[k] ?? 0) < 0.5 ? 1 : -1;
    }
    s[i] = hp.high(bp.bandpass(sum / 6)) * Math.exp(-(i / rate) / decay);
  }
  return s;
}

function noiseHit(
  rate: number,
  seconds: number,
  decay: number,
  band: number,
  resonance: number,
  seed: number,
  high = false,
) {
  const s = new Float32Array(frames(seconds, rate));
  const noise = new Noise(seed),
    filter = new Svf(band, resonance, rate);
  for (let i = 0; i < s.length; i++) {
    const n = noise.next();
    s[i] = (high ? filter.high(n) : filter.bandpass(n)) * Math.exp(-(i / rate) / decay);
  }
  return s;
}

function clap(rate: number, tail: number, seed: number, band: number) {
  const s = new Float32Array(frames(0.04 + tail * 4, rate));
  const noise = new Noise(seed),
    filter = new Svf(band, 1.5, rate);
  for (let i = 0; i < s.length; i++) {
    const t = i / rate;
    const env = t < 0.03 ? Math.exp(-(t % 0.01) * 400) : Math.exp(-(t - 0.03) / tail);
    s[i] = filter.bandpass(noise.next()) * env;
  }
  return s;
}

function mix(a: Float32Array, b: Float32Array, gainB: number) {
  const out = new Float32Array(Math.max(a.length, b.length));
  out.set(a);
  for (let i = 0; i < b.length; i++) out[i] = f32((out[i] ?? 0) + f32(gainB * (b[i] ?? 0)));
  return out;
}

function saturate(s: Float32Array, drive: number) {
  return s.map((v) => Math.tanh(drive * v) / Math.tanh(drive));
}

function cowbell(rate: number) {
  const c = new Float32Array(frames(0.5, rate));
  const bp = new Svf(2600, 3.0, rate);
  let a = 0,
    b = 0;
  for (let i = 0; i < c.length; i++) {
    a = (a + 540 / rate) % 1;
    b = (b + 800 / rate) % 1;
    const t = i / rate,
      env = t < 0.02 ? Math.exp(-t / 0.01) : 0.5 * Math.exp(-(t - 0.02) / 0.15);
    c[i] = bp.bandpass((a < 0.5 ? 1 : -1) + (b < 0.5 ? 1 : -1)) * env;
  }
  return c;
}

/** 808-style: round, boomy and soft-edged. Pad 0 is pad 1. */
export function make808(pad: number, r: number): Float32Array {
  // biome-ignore format: one line per pad, as in live_kits.hpp
  const s = (() => {
    switch (pad) {
      case 0: return swept(r, 1.2, 110, 49, 0.02, 0.45);
      case 1: return mix(mix(swept(r, 0.3, 238, 180, 0.03, 0.08), swept(r, 0.3, 476, 330, 0.03, 0.05), 0.6), noiseHit(r, 0.3, 0.07, 5000, 0.8, 11, true), 0.9);
      case 2: return metallic(r, 0.12, 0.025, 8500, 1.0);
      case 3: return metallic(r, 0.8, 0.22, 8500, 1.0);
      case 4: return clap(r, 0.09, 21, 1100);
      case 5: return mix(swept(r, 0.05, 1700, 1600, 0.01, 0.006), noiseHit(r, 0.05, 0.004, 3000, 3, 31), 0.4);
      case 6: return swept(r, 0.6, 120, 85, 0.06, 0.2);
      case 7: return swept(r, 0.5, 220, 160, 0.06, 0.16);
      case 8: return cowbell(r);
      case 9: return metallic(r, 2.0, 0.6, 7000, 0.9);
      case 10: return swept(r, 0.08, 2500, 2500, 1, 0.015);
      case 11: return noiseHit(r, 0.08, 0.02, 9000, 0.7, 41, true);
      case 12: return swept(r, 0.4, 190, 165, 0.02, 0.12);
      case 13: return swept(r, 0.35, 300, 260, 0.02, 0.1);
      case 14: return swept(r, 0.3, 420, 370, 0.02, 0.08);
      default: return swept(r, 2.0, 90, 41, 0.03, 0.9);
    }
  })();
  return finish(s);
}

/** 909-style: punchy and bright, with a click on the kick and noisy snares. */
export function make909(pad: number, r: number): Float32Array {
  // biome-ignore format: one line per pad, as in live_kits.hpp
  const s = (() => {
    switch (pad) {
      case 0: return saturate(swept(r, 0.6, 330, 52, 0.012, 0.22, 0.5, 51), 2.0);
      case 1: return mix(swept(r, 0.3, 300, 190, 0.02, 0.06), noiseHit(r, 0.3, 0.12, 7000, 0.7, 61, true), 1.2);
      case 2: return mix(metallic(r, 0.1, 0.02, 9500, 1.2), noiseHit(r, 0.1, 0.02, 10000, 0.7, 71, true), 0.5);
      case 3: return mix(metallic(r, 0.7, 0.18, 9500, 1.2), noiseHit(r, 0.7, 0.16, 10000, 0.7, 81, true), 0.5);
      case 4: return clap(r, 0.12, 91, 1300);
      case 5: return mix(swept(r, 0.06, 1800, 1700, 0.01, 0.008), noiseHit(r, 0.06, 0.01, 4000, 2, 101), 0.7);
      case 6: return mix(swept(r, 0.5, 160, 90, 0.04, 0.16), noiseHit(r, 0.5, 0.02, 2000, 1, 111), 0.15);
      case 7: return mix(swept(r, 0.4, 280, 170, 0.04, 0.12), noiseHit(r, 0.4, 0.02, 3000, 1, 121), 0.15);
      case 8: return metallic(r, 1.5, 0.45, 6000, 1.4);
      case 9: return mix(metallic(r, 2.0, 0.7, 7500, 1.1), noiseHit(r, 2.0, 0.6, 9000, 0.7, 131, true), 0.6);
      case 10: return mix(swept(r, 0.45, 210, 125, 0.04, 0.14), noiseHit(r, 0.45, 0.02, 2500, 1, 141), 0.15);
      case 11: return saturate(swept(r, 0.5, 400, 55, 0.008, 0.15, 0.8, 151), 4.0);
      case 12: return mix(swept(r, 0.6, 120, 70, 0.05, 0.2), noiseHit(r, 0.6, 0.02, 1500, 1, 161), 0.15);
      case 13: return mix(swept(r, 0.25, 330, 220, 0.02, 0.05), noiseHit(r, 0.25, 0.09, 8000, 0.7, 171, true), 1.6);
      case 14: return noiseHit(r, 0.12, 0.03, 7000, 0.6, 181, true);
      default: return saturate(swept(r, 1.6, 250, 45, 0.015, 0.7, 0.4, 191), 1.5);
    }
  })();
  return finish(s);
}

// biome-ignore format: two rows of eight, as on the pads
export const DRUM_MACHINE_PADS = {
  "808": [
    "Kick", "Snare", "Closed hat", "Open hat", "Clap", "Rimshot", "Low tom", "High tom",
    "Cowbell", "Cymbal", "Clave", "Maracas", "Low conga", "Mid conga", "High conga", "Long kick",
  ],
  "909": [
    "Kick", "Snare", "Closed hat", "Open hat", "Clap", "Rimshot", "Low tom", "High tom",
    "Ride", "Crash", "Mid tom", "Hard kick", "Low tom 2", "Snare 2", "Shaker", "Long kick",
  ],
} as const;

/** A whole 16-pad kit at `rate`, the closed hat choking the open hat. */
export function drumMachineKit(style: "808" | "909", rate = 48000): DrumKit {
  const make = style === "808" ? make808 : make909;
  return {
    name: `XMP ${style} style`,
    samples: DRUM_MACHINE_PADS[style].map((name, pad) => ({
      name,
      sampleRate: rate,
      pcm: Array.from(make(pad, rate)),
      ...(pad === 2 || pad === 3 ? { choke: 1 } : {}),
    })),
  };
}
