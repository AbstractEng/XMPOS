import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { emulator } from "../os/vm.mjs";
import { kernelLock } from "./board.mjs";
import { bridgeCommand, openBridge } from "./bridge.mjs";
import { runContainer } from "./container.mjs";
import { runQemu } from "./probe-vm.mjs";
import { prune } from "./prune-artifacts.mjs";
import { evaluateSessionResult } from "./session-checks.mjs";

// Runs the XMP stick loader and the session system image on a Live-like QEMU
// machine built from os/live-mk1/hardware.json:
//   - the Live's 4 cores, 2 GiB and isolcpus=2-3, booted with a device tree
//     whose root compatible is "inmusic,acv8", so the Live's own board rule
//     applies (the emulator kernel is the official az01 source);
//   - the exact Live session binary (same file as in system.img);
//   - the Live twin, which presents the controller (09e8:003b, two raw MIDI
//     ports), the audio card (09e8:203b, 6 outputs at 44.1 kHz) and an
//     ILI2116-range touchscreen as USB gadgets on the kernel's virtual USB host,
//     plays a controller script, answers the identity request, records every
//     byte the session sends and records all six outputs;
//   - an 800x1280 virtio GPU screenshotted over QMP;
//   - the stick on USB mass storage (sda1, as on the Live).
// The audio card is QEMU's usb-audio with the Live card's USB ID and name (XMP's QEMU
// patch), recorded to a WAV on the Mac; dummy_hcd has no isochronous endpoints, so
// it cannot be a gadget. Two runs, both ended with QEMU's power button (gpio-keys KEY_POWER):
//   pads: pads, a button and a knob on the Private port, eight pads at once;
//   seq:  phase 2 by touch; the recording must show exact sixteenths.
// The stand-in internal disk must stay byte-identical.

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const PEAK_LIMIT = 0.25118864;
export const hardware = () =>
  JSON.parse(readFileSync(join(root, "os/live-mk1/hardware.json"), "utf8"));

// Canvas (1280x800 landscape) to the touchscreen's raw units, the inverse of
// the session's mapping: rotation 270 puts canvas (x, y) at framebuffer
// (y, 1279 - x); raw axes scale onto the framebuffer's 800 columns and 1280 rows.
export function canvasToRaw(x, y, hw = hardware()) {
  const { xres, yres } = hw.display.framebuffer;
  const [, xmax] = hw.display.touch.x;
  const [, ymax] = hw.display.touch.y;
  const fx = y,
    fy = yres - 1 - x;
  return [Math.ceil((fx * (xmax + 1)) / xres), Math.ceil((fy * (ymax + 1)) / yres)];
}
// Canvas pixel to framebuffer pixel (rotation 270).
export const canvasToFb = (x, y, hw = hardware()) => [y, hw.display.framebuffer.yres - 1 - x];

// Twin script: "<s> [p1] <hex>..." to the controller's Public (or Private) port,
// "<s> touch <rawx> <rawy>". Times count from the session's start.
export const PAD_SCRIPT = `# after start-up the Live's controller sends on the Private port (p1)
2.0 p1 99 25 7F
2.2 p1 89 25 00
# pad 16 soft, running status for the off
2.5 p1 99 35 30
2.7 p1 35 00
# aftertouch, a button on channel 1, a knob
2.8 p1 A9 35 20
2.9 p1 90 09 7F 90 09 00
3.0 p1 B0 10 41
# eight pads at once at full velocity: the limiter must hold -12 dBFS
4.0 p1 99 25 7F 24 7F 2A 7F 52 7F 28 7F 26 7F 2E 7F 2C 7F
5.0 p1 89 25 00 24 00 2A 00 52 00 28 00 26 00 2E 00 2C 00
`;

// The device's real layout (live_sequencer.hpp), printed by a tiny program
// compiled from the same header, so scripts and screenshot checks use exactly
// the coordinates the session draws and hit-tests.
let cachedLayout = null;
export function deviceLayout() {
  if (cachedLayout) return cachedLayout;
  const dir = mkdtempSync(join(tmpdir(), "xmp-layout-"));
  const source = join(dir, "layout.cpp"),
    binary = join(dir, "layout");
  writeFileSync(
    source,
    `#include "xmp/live_sequencer.hpp"
#include <cstdio>
using namespace xmp::live;
static void r(const char* sep, Rect x) { std::printf("%s{\\"x\\":%d,\\"y\\":%d,\\"w\\":%d,\\"h\\":%d}", sep, x.x, x.y, x.w, x.h); }
int main() {
  const int W = 1280, H = 800;
  std::printf("{\\"pads\\":[");
  for (int i = 0; i < 16; ++i) r(i ? "," : "", sequencer_pad_rect(i, W, H));
  std::printf("],\\"steps\\":[");
  for (int i = 0; i < 16; ++i) r(i ? "," : "", step_rect(i, W, H));
  std::printf("],\\"tracks\\":[");
  for (int i = 0; i < 8; ++i) r(i ? "," : "", track_rect(i, W, H));
  std::printf("],\\"status\\":[");
  for (int i = 0; i < 5; ++i) r(i ? "," : "", status_rect(i, W, H));
  std::printf("],\\"play\\":"); r("", control_rect(Control::play, W, H));
  std::printf(",\\"record\\":"); r("", control_rect(Control::record, W, H));
  std::printf(",\\"clear\\":"); r("", control_rect(Control::clear, W, H));
  std::printf(",\\"bpmUp\\":"); r("", control_rect(Control::bpm_up, W, H));
  std::printf("}\\n");
}`,
  );
  execFileSync("c++", ["-std=c++17", `-I${join(root, "native/include")}`, source, "-o", binary]);
  cachedLayout = JSON.parse(execFileSync(binary, { encoding: "utf8" }));
  return cachedLayout;
}
const centre = (r) => [r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)];
// Inside a rounded control, clear of its corner and its centred label.
const inside = (r) => [r.x + 8, r.y + Math.floor(r.h / 2)];
// The session's colours, read from native/include/xmp/live_theme.hpp so the
// checks and the device can never drift apart.
export function themeColours() {
  const text = readFileSync(join(root, "native/include/xmp/live_theme.hpp"), "utf8");
  const colours = {};
  for (const m of text.matchAll(/constexpr Rgb (k\w+)\{(\d+), (\d+), (\d+)\}/g))
    colours[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return colours;
}
const rgb = (c) => c.join(",");
// theme::mix, with the same rounding.
const mix = (a, b, t) =>
  a.map((x, i) => Math.floor(x + (b[i] - x) * Math.min(1, Math.max(0, t)) + 0.5));
const corner = (r) => [r.x + 6, r.y + 6];
const touch = (at, rect) => `${at} touch ${canvasToRaw(...centre(rect)).join(" ")}`;

// Sequencer by touch: select pad 8 (rim), all 16 steps on, play, record a live
// kick, raise the tempo by touch and by the data wheel, stop with the Stop button.
export const SEQ_SCRIPT = (L = deviceLayout()) =>
  [
    touch("1.5", L.pads[7]),
    ...L.steps.map((step, i) => touch((1.6 + i * 0.1).toFixed(1), step)),
    touch("3.3", L.play),
    touch("3.6", L.record),
    "4.03 p1 99 25 7F",
    "4.2 p1 89 25 00",
    touch("4.5", L.record),
    touch("5.2", L.bpmUp),
    // data wheel +5 BPM, then the hardware Stop button (note 51h on channel 1)
    "7.0 p1 B0 64 05",
    "7.5 p1 90 51 7F 80 51 00",
    "",
  ].join("\n");

// Phase 2 tracks: pad bank B selects track 2 (BASS); steps 1, 5, 9, 13 get its
// root note; knob 1 turns its level down to 60%; pad bank A back to the kit,
// kick on steps 1 and 9; play; pad bank C (KEYS) and a live synth note; Stop.
export const TRACKS_SCRIPT = (L = deviceLayout()) =>
  [
    "1.5 p1 90 24 7F 80 24 00",
    ...[0, 4, 8, 12].map((s, i) => touch((1.7 + i * 0.1).toFixed(1), L.steps[s])),
    "2.2 p1 B0 10 6C",
    "2.5 p1 90 23 7F 80 23 00",
    touch("2.7", L.pads[0]),
    touch("2.8", L.steps[0]),
    touch("2.9", L.steps[8]),
    touch("3.3", L.play),
    "5.2 p1 90 25 7F 80 25 00",
    "5.4 p1 99 25 64",
    "5.8 p1 89 25 00",
    "7.5 p1 90 51 7F 80 51 00",
    "",
  ].join("\n");

// Phases 7 and 8: a full project from the stick (Night Shift, the house demo),
// played through XMP's interface (live_ui.hpp). Opening it (a 1.3 MB song
// file: JSON, base64 audio and SHA-256 checks) takes several seconds under the
// emulator's instruction-counted CPU, so the first press waits until 15 s.
// Pads by index: 12 is pad 13 (top left, 0x31), 8 is pad 9 (0x30), 0 is pad 1 (0x25).
export const PROJECT_SCRIPT = [
  "15.0 p1 90 52 7F 80 52 00", // Play: the song
  "19.0 p1 90 51 7F 80 51 00", // Stop
  "20.0 p1 99 31 64 89 31 00", // pad 13: Intro's drums clip alone
  "23.0 p1 99 30 64 89 30 00", // pad 9: Groove's drums clip, from the next bar
  "25.0 p1 90 24 7F 80 24 00", // Pad Bank B: track 2 (the bass)
  "25.5 p1 90 31 7F 90 34 7F 80 34 00 80 31 00", // Shift + Main: the Play view
  "26.0 p1 99 25 64", // pad 1: the bass plays C3...
  "26.6 p1 89 25 00", // ...until let go
  "27.0 p1 90 34 7F 80 34 00", // Main: back to Clips
  "27.5 p1 B0 64 02", // the data wheel, two scenes down: Drop
  "28.0 p1 90 6F 7F 80 6F 00", // the data wheel's press: Drop from the next bar
  "32.0 p1 90 51 7F 80 51 00", // Stop
  "33.0 p1 90 28 7F 80 28 00", // 16 Level: Steps, for Drop's bass clip and C3 (the note pad 1 played)
  "34.0 p1 99 31 64 89 31 00", // pad 13: step 1 on
  "35.0 p1 90 43 7F 80 43 00", // Undo
  "36.0 p1 90 31 7F 90 43 7F 80 43 00 80 31 00", // Shift + Undo: Redo
  "37.0 p1 90 34 7F 80 34 00", // Main: back to Clips; two seconds later the project is saved
  "45.0 p1 90 34 7F 80 34 00", // Main
  // Recording: the lead (track 5, Shift + Pad Bank A) into Intro's empty slot.
  "46.0 p1 90 31 7F 90 23 7F 80 23 00 80 31 00", // Shift + Pad Bank A: track 5
  "46.5 p1 B0 64 7D", // the data wheel, three scenes up: Intro
  "47.0 p1 90 49 7F 80 49 00", // Rec while stopped: Intro starts, one bar (1.94 s at 124 BPM) counts in
  "49.3 p1 99 25 64", // the take's bar: pad 1 (C3)...
  "49.6 p1 89 25 00",
  "50.1 p1 99 28 64", // ...and pad 5 (E3)
  "50.4 p1 89 28 00",
  "50.8 p1 90 49 7F 80 49 00", // Rec, just before the bar ends: a one-bar take, playing from the next bar
  "53.0 p1 90 50 7F 80 50 00", // Overdub onto it
  "53.5 p1 99 2A 64", // pad 3 (D3)
  "53.8 p1 89 2A 00",
  "54.5 p1 90 50 7F 80 50 00", // Overdub off
  "55.0 p1 90 51 7F 80 51 00", // Stop; the project is saved again
  // The Q-Link knobs on the selected track (the lead): touch knob 1, level +5%, then pan 10% left.
  "56.0 p1 90 54 7F",
  "56.2 p1 B0 10 05",
  "56.4 p1 80 54 00",
  "56.8 p1 B0 11 76",
  // The Song view (Menu + pad 10): pad 16 is scene 4 (Drop), added after block 1; knob 1, three
  // clicks: two repeats; Play plays the song from it; Stop.
  "57.5 p1 90 7B 7F 99 2F 64 89 2F 00 80 7B 00",
  "58.0 p1 99 35 64",
  "58.2 p1 89 35 00",
  "58.5 p1 B0 10 03",
  "59.0 p1 90 52 7F 80 52 00",
  "61.0 p1 90 51 7F 80 51 00",
  // The Mix view (Menu + pad 11): pad 5 mutes track 1 (drums); Shift + pad 6 solos track 2 (bass).
  "62.0 p1 90 7B 7F 99 2D 64 89 2D 00 80 7B 00",
  "62.5 p1 99 28 64",
  "62.7 p1 89 28 00",
  "63.0 p1 90 31 7F 99 26 64 89 26 00 80 31 00",
  // The piano roll: Main, the wheel to Groove, Pad Bank B (the bass), 16 Level (Steps is the roll on a
  // synth), + (a semitone up), pad 13: a note on step 1 of Roots.
  "64.0 p1 90 34 7F 80 34 00",
  "64.5 p1 B0 64 01",
  "65.0 p1 90 24 7F 80 24 00",
  "65.5 p1 90 28 7F 80 28 00",
  "66.0 p1 90 36 7F 80 36 00",
  "66.5 p1 99 31 64",
  "66.7 p1 89 31 00",
  // The Sample view (Menu + pad 15): REC opens the inputs and waits for sound; REC again ends it.
  "68.0 p1 90 7B 7F 99 33 64 89 33 00 80 7B 00",
  "68.5 p1 90 49 7F 80 49 00",
  "69.5 p1 90 49 7F 80 49 00",
  // The Sound page (Menu + pad 16) of track 2 (the bass, Pad Bank B): pad 14 chooses the Soft key preset,
  // and with the music stopped the engine takes the new sound.
  "69.8 p1 90 24 7F 80 24 00",
  "70.1 p1 90 7B 7F 99 35 64 89 35 00 80 7B 00",
  "70.4 p1 99 37 64",
  "70.5 p1 89 37 00",
  // Song capture: the Song view (Menu + pad 10), REC arms it; Main to Clips, Play plays the selected
  // scene, the wheel turned and pressed launches the next scene at the bar; Stop ends the capture.
  "72.0 p1 90 7B 7F 99 2F 64 89 2F 00 80 7B 00",
  "72.5 p1 90 49 7F 80 49 00",
  "73.0 p1 90 34 7F 80 34 00",
  "73.5 p1 90 52 7F 80 52 00",
  "76.0 p1 B0 64 01",
  "76.3 p1 90 6F 7F 80 6F 00",
  "82.0 p1 90 51 7F 80 51 00",
  // The Mix view after the Sound view (Menu + pad 11): knob 1 is still the selected track's level
  // (the bass's); it once stayed on the Sound view's empty SOUND page.
  "84.0 p1 90 7B 7F 99 2D 64 89 2D 00 80 7B 00",
  "84.5 p1 B0 10 05",
  // The tempo sheet (the header's BPM), one click of the data wheel, Apply: 124 becomes 125
  // BPM (Apply once dropped a value the wheel had set).
  `85.5 touch ${canvasToRaw(1000, 40).join(" ")}`,
  "86.0 p1 B0 64 01",
  `86.5 touch ${canvasToRaw(844, 647).join(" ")}`,
  "90.0 p1 90 34 7F 80 34 00", // Main, then Steps: exercise all four physical page LEDs.
  "91.0 p1 90 28 7F 80 28 00",
  "92.0 p1 90 00 7F 80 00 00",
  "93.0 p1 90 00 7F 80 00 00",
  "94.0 p1 90 00 7F 80 00 00",
  "95.0 p1 90 00 7F 80 00 00", // wraps to page one
  "96.0 p1 90 31 7F 90 00 7F 80 00 00 80 31 00", // Shift + Q-Link goes back to page four
  "97.0 p1 90 34 7F 80 34 00", // Clips restores its Sound knob page from earlier
  "98.0 p1 80 00 00", // let the twin receive the last LED frame before shutdown
  "",
].join("\n");

export const BRIDGE_TEST_TOKEN = "emulator-bridge-token-0001";

// The identity request and start-up sequence, byte for byte (live_controls.hpp).
export const EXPECTED_STARTUP =
  "F0 7E 00 06 01 F7 " +
  "F0 47 7F 3B 62 00 01 65 F7 F0 47 7F 3B 64 00 03 00 01 01 F7 F0 47 7F 3B 64 00 03 01 01 01 F7 " +
  "F0 47 7F 3B 64 00 03 02 00 00 F7 F0 47 7F 3B 64 00 03 03 00 00 F7 F0 47 7F 3B 63 00 03 00 00 00 F7 " +
  "F0 47 7F 3B 63 00 03 01 00 00 F7 F0 47 7F 3B 41 00 00 F7";

// ---- audio and screen analysis ----
function pcm(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Not a WAV file");
  let at = 12,
    channels = 0,
    rate = 0,
    bits = 0,
    data = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    let size = bytes.readUInt32LE(at + 4);
    if (id === "data" && (size === 0 || at + 8 + size > bytes.length)) size = bytes.length - at - 8;
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === "data") data = bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (!data || bits !== 16 || !channels) throw new Error("Expected 16-bit PCM WAV");
  return { channels, rate, data };
}

export function analyseWav(bytes) {
  const { channels, rate, data } = pcm(bytes);
  const peaks = new Array(channels).fill(0);
  let peak = 0,
    loudFrames = 0;
  const frames = Math.floor(data.length / (2 * channels));
  for (let f = 0; f < frames; f++) {
    let framePeak = 0;
    for (let c = 0; c < channels; c++) {
      const v = Math.abs(data.readInt16LE((f * channels + c) * 2)) / 32768;
      if (v > peaks[c]) peaks[c] = v;
      if (v > framePeak) framePeak = v;
    }
    peak = Math.max(peak, framePeak);
    if (framePeak > 0.003) loudFrames++;
  }
  return { channels, rate, frames, peak, peaks, loudSeconds: rate ? loudFrames / rate : 0 };
}

// Onset times (seconds) of separate hits: the level rises above `on` after at
// least 25 ms without any sample above it.
export function onsets(bytes, on = 0.03) {
  const { channels, rate, data } = pcm(bytes);
  const frames = Math.floor(data.length / (2 * channels));
  const out = [];
  let sinceLoud = Number.POSITIVE_INFINITY;
  for (let f = 0; f < frames; f++) {
    let m = 0;
    for (let c = 0; c < channels; c++)
      m = Math.max(m, Math.abs(data.readInt16LE((f * channels + c) * 2)) / 32768);
    if (m > on) {
      if (sinceLoud >= rate * 0.025) out.push(f / rate);
      sinceLoud = 0;
    } else sinceLoud++;
  }
  return out;
}

// Binary PPM (P6), as written by QMP screendump.
export function parsePpm(bytes) {
  const header = [];
  let at = 0;
  while (header.length < 4) {
    while (/\s/.test(String.fromCharCode(bytes[at]))) at++;
    if (bytes[at] === 0x23) {
      while (bytes[at] !== 0x0a) at++;
      continue;
    }
    let token = "";
    while (!/\s/.test(String.fromCharCode(bytes[at]))) token += String.fromCharCode(bytes[at++]);
    header.push(token);
  }
  at++;
  const [magic, width, height, max] = header;
  if (magic !== "P6" || max !== "255") throw new Error("Expected a binary 8-bit PPM");
  const w = Number(width),
    h = Number(height);
  return {
    width: w,
    height: h,
    pixel: (x, y) => {
      const i = at + (y * w + x) * 3;
      return [bytes[i], bytes[i + 1], bytes[i + 2]];
    },
  };
}
// Colour at a canvas point of a screenshot taken in framebuffer orientation.
const canvasColour = (shot, x, y) => shot.pixel(...canvasToFb(x, y)).join(",");

// ---- machine ----
// Sets the root node's compatible list, splicing the structure block and
// updating the header (struct size, strings offset, total size). Only the root
// node's "compatible" property changes.
export function setRootCompatible(input, expected, list) {
  const bytes = Buffer.from(input);
  const be = (o) => bytes.readUInt32BE(o);
  if (be(0) !== 0xd00dfeed) throw new Error("Not a flattened device tree");
  const structAt = be(8),
    stringsAt = be(12),
    structSize = be(36);
  if (stringsAt < structAt + structSize) throw new Error("Unexpected block order");
  const name = (off) =>
    bytes.toString("latin1", stringsAt + off, bytes.indexOf(0, stringsAt + off));
  const align = (n) => (n + 3) & ~3;
  let at = structAt,
    depth = 0;
  for (;;) {
    const token = be(at);
    at += 4;
    if (token === 1) {
      at = align(bytes.indexOf(0, at) + 1);
      depth++;
    } else if (token === 2) depth--;
    else if (token === 4) continue;
    else if (token === 3) {
      const len = be(at),
        nameoff = be(at + 4),
        value = at + 8;
      if (depth === 1 && name(nameoff) === "compatible") {
        const current = bytes.toString("latin1", value, value + len);
        if (current !== `${expected}\0`)
          throw new Error(`Unexpected root compatible ${JSON.stringify(current)}`);
        const replacement = Buffer.from(`${list.join("\0")}\0`, "latin1");
        const oldSlot = align(len),
          newSlot = align(replacement.length);
        const padded = Buffer.alloc(newSlot);
        replacement.copy(padded);
        // Trimmed to the blocks actually used: QEMU's dump is padded to 1 MiB,
        // which the kernel's decompressor cannot boot from.
        const used = stringsAt + be(32);
        const out = Buffer.concat([
          bytes.subarray(0, value),
          padded,
          bytes.subarray(value + oldSlot, used),
        ]);
        const delta = newSlot - oldSlot;
        out.writeUInt32BE(replacement.length, at);
        out.writeUInt32BE(used + delta, 4);
        out.writeUInt32BE(stringsAt + delta, 12);
        out.writeUInt32BE(structSize + delta, 36);
        return out;
      }
      at = align(value + len);
    } else throw new Error("Root compatible not found");
  }
}

export async function liveDtb(run, hw) {
  // QEMU virt's device tree for the Live-like machine, with "inmusic,acv8"
  // added to the root compatible list.
  const qemu = await emulator("armv7");
  const vm = kernelLock().vm;
  const raw = join(run, "virt.dtb");
  const dump = spawnSync(
    qemu.binary,
    [
      "-machine",
      `${vm.machine},highmem=off,dumpdtb=${raw}`,
      "-cpu",
      vm.cpu,
      "-smp",
      String(hw.board.cpus),
      "-m",
      String(hw.board.memoryMiB),
      "-nodefaults",
      "-display",
      "none",
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  if (!existsSync(raw)) throw new Error(`QEMU did not dump its device tree: ${dump.stderr}`);
  // QEMU's machine first (so the kernel picks QEMU's board code, not the Live's
  // Rockchip code), then the Live's, so the session's Live board rule applies.
  const bytes = setRootCompatible(await readFile(raw), "linux,dummy-virt", [
    "linux,dummy-virt",
    "inmusic,acv8",
  ]);
  const out = join(run, "live-like.dtb");
  await writeFile(out, bytes);
  return out;
}

export const liveLikeDevices = (hw, stick, wav) => [
  // Modern virtio-mmio: the virtio GPU is a virtio 1.0 device.
  "-global",
  "virtio-mmio.force-legacy=false",
  "-device",
  "qemu-xhci,id=xhci",
  "-drive",
  `if=none,id=stick,file=${stick},format=raw`,
  "-device",
  "usb-storage,bus=xhci.0,drive=stick",
  "-device",
  `virtio-gpu-device,xres=${hw.display.framebuffer.xres},yres=${hw.display.framebuffer.yres}`,
  // The Live's audio card: QEMU's usb-audio with the card's USB ID and name
  // (XMP's QEMU patch), recording everything played to a WAV on the Mac.
  "-audiodev",
  `wav,id=snd0,path=${wav}`,
  // Its own USB controller: sharing one with the stick sometimes failed to
  // enumerate the audio card under the instruction-counting clock.
  "-device",
  "qemu-xhci,id=xhci2",
  "-device",
  `usb-audio,bus=xhci2.0,audiodev=snd0,vendorid=0x${hw.audio.usbId.split(":")[0]},productid=0x${hw.audio.usbId.split(":")[1]},manufacturer=XMP emulator,product=${hw.audio.card}`,
];

async function makeMedia(run, systemImage, { downstreamOnly = false, readyFile = null } = {}) {
  if (readyFile && !/^\/tmp\/[a-z0-9-]+$/.test(readyFile))
    throw new Error("Invalid readiness marker");
  await writeFile(
    join(run, "pads-script.txt"),
    (readyFile ? `0 wait ${readyFile}\n` : "") + PAD_SCRIPT,
  );
  await writeFile(join(run, "seq-script.txt"), SEQ_SCRIPT());
  await writeFile(join(run, "tracks-script.txt"), TRACKS_SCRIPT());
  await writeFile(join(run, "session.conf"), "listen_seconds=1\n");
  await writeFile(join(run, "bridge-script.txt"), "600 p1 99 25 7F\n");
  await writeFile(join(run, "bridge.token"), `${BRIDGE_TEST_TOKEN}\n`);
  await writeFile(join(run, "project-script.txt"), PROJECT_SCRIPT);
  // The house demo as the browser studio saves it: a song file with its samples packaged.
  if (!downstreamOnly) {
    const { saveSong: exportSong } = await import("../../packages/core/src/project-io.ts");
    const { nightShift } = await import("../demo/house-song.mjs");
    await writeFile(join(run, "project.xmpsong"), await exportSong(nightShift()));
  } else {
    // The downstream bootstrap never loads an XMP song or browser module.
    await writeFile(join(run, "project.xmpsong"), "");
  }
  const stick = (name, script) => [
    `truncate -s 96M /out/${name} && python3 /w/mbr.py /out/${name} 58504d32 0c`,
    `mkfs.vfat -F 32 -n XMP --offset 2048 /out/${name} $((94 * 1024)) >/dev/null`,
    `mmd -i /out/${name}@@1M ::xmp && mcopy -i /out/${name}@@1M /in-system.img ::xmp/system.img`,
    `mcopy -i /out/${name}@@1M /in-${script} ::xmp/twin-script.txt && mcopy -i /out/${name}@@1M /in-session.conf ::xmp/session.conf`,
  ];
  const script = [
    "mkdir -p /out /w/stock/sbin",
    `cat > /w/mbr.py <<'PY'
import struct, sys, os
path, signature, kind = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16)
size = os.path.getsize(path)
with open(path, 'r+b') as f:
    f.seek(440); f.write(struct.pack('<I', signature))
    f.seek(446); f.write(struct.pack('<B3sB3sII', 0, bytes(3), kind, bytes(3), 2048, size // 512 - 2048))
    f.seek(510); f.write(b'\\x55\\xaa')
PY`,
    "truncate -s 32M /out/stock.img && python3 /w/mbr.py /out/stock.img 58504d31 83",
    "echo stock > /w/stock/sbin/marker && mkfs.ext4 -q -F -L rootfs -d /w/stock -E offset=1048576 /out/stock.img 31M",
    ...stick("pads-stick.img", "pads-script.txt"),
    ...stick("seq-stick.img", "seq-script.txt"),
    ...stick("tracks-stick.img", "tracks-script.txt"),
    ...stick("bridge-stick.img", "bridge-script.txt"),
    ...stick("project-stick.img", "project-script.txt"),
    "mcopy -i /out/project-stick.img@@1M /in-project.xmpsong ::xmp/project.xmpsong",
    "mcopy -i /out/bridge-stick.img@@1M /in-bridge.token ::xmp/bridge.token",
  ].join("\n");
  // The owner image stays private. A copy in the private VM run directory
  // can be read by the unprivileged builder after docker cp preserves its mode.
  const stagedImage = join(run, "system-for-vm.img");
  await writeFile(stagedImage, await readFile(systemImage), { mode: 0o644, flag: "wx" });
  try {
    await runContainer({
      image: "xmp-live-mk1-probe:1",
      copyIn: [
        { from: stagedImage, to: "/in-system.img" },
        { from: join(run, "pads-script.txt"), to: "/in-pads-script.txt" },
        { from: join(run, "seq-script.txt"), to: "/in-seq-script.txt" },
        { from: join(run, "tracks-script.txt"), to: "/in-tracks-script.txt" },
        { from: join(run, "session.conf"), to: "/in-session.conf" },
        { from: join(run, "bridge-script.txt"), to: "/in-bridge-script.txt" },
        { from: join(run, "bridge.token"), to: "/in-bridge.token" },
        { from: join(run, "project-script.txt"), to: "/in-project-script.txt" },
        { from: join(run, "project.xmpsong"), to: "/in-project.xmpsong" },
      ],
      command: script,
      out: run,
      timeout: 900000,
    });
  } finally {
    await unlink(stagedImage);
  }
}

async function readStick(run, stick) {
  const files = {
    log: "xmp/logs/session-001.txt",
    pattern: "xmp/pattern.txt",
    received: "xmp/twin/controller-received.txt",
    twinLog: "xmp/twin/twin-log.txt",
    frame: "xmp/logs/session-001.txt.ppm",
    saved: "xmp/project.xmpsong",
  };
  const prefix = stick.replace(/\.img$/, "");
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [{ from: join(run, stick), to: "/in-stick.img" }],
    command: [
      "mkdir -p /out",
      ...Object.entries(files).map(
        ([name, path]) =>
          `mcopy -n -i /in-stick.img@@1M ::${path} /out/${prefix}.${name} 2>/dev/null || : > /out/${prefix}.${name}`,
      ),
    ].join("\n"),
    out: run,
    timeout: 300000,
  });
  const read = (name, binary = false) =>
    readFile(join(run, `${prefix}.${name}`), binary ? undefined : "utf8");
  return {
    frame: await read("frame", true),
    log: await read("log"),
    pattern: await read("pattern"),
    saved: await read("saved"),
    received: await read("received"),
    twinLog: await read("twinLog"),
  };
}

// Everything the session sent to the controller, per port, as hex.
export function sentBytes(received) {
  const ports = { 0: [], 1: [] };
  for (const line of received.split("\n")) {
    const m = /port (\d):((?: [0-9A-F]{2})+)/.exec(line);
    if (m) ports[m[1]].push(m[2].trim());
  }
  return { public: ports[0].join(" "), private: ports[1].join(" ") };
}

// Validate the exact startup prefix and every subsequent display-only byte.
// Parses across twin write boundaries, including short raw MIDI writes.
export function feedbackBytesAllowed(sent) {
  const parse = (text) =>
    text.trim()
      ? text
          .trim()
          .split(/\s+/)
          .map((v) => (/^[0-9A-F]{2}$/.test(v) ? Number.parseInt(v, 16) : -1))
      : [];
  const pub = parse(sent.public),
    priv = parse(sent.private),
    startup = parse(EXPECTED_STARTUP);
  if (startup.some((byte, i) => priv[i] !== byte)) return false;
  const buttons = new Set([
    0x23, 0x24, 0x25, 0x26, 0x0b, 0x27, 0x28, 0x35, 0x49, 0x50, 0x51, 0x52, 0x53, 0x5a, 0x5b, 0x5c,
    0x5d,
  ]);
  if ((priv.length - startup.length) % 3 || pub.length % 12) return false;
  for (let i = startup.length; i < priv.length; i += 3)
    if (priv[i] !== 0xb0 || !buttons.has(priv[i + 1]) || ![0, 3].includes(priv[i + 2]))
      return false;
  for (let i = 0; i < pub.length; i += 12) {
    const header = [0xf0, 0x47, 0x7f, 0x3b, 0x65, 0, 4];
    if (
      header.some((b, n) => pub[i + n] !== b) ||
      pub[i + 7] < 0 ||
      pub[i + 7] > 15 ||
      pub[i + 11] !== 0xf7
    )
      return false;
    for (let n = 8; n <= 10; n++) if (pub[i + n] < 0 || pub[i + n] > 127) return false;
  }
  return pub.length >= 192 && priv.length >= startup.length + 51;
}

// The sessions a run boots, in order. `only` (one or more names) boots just
// those: the others' checks are then not results (they read empty logs), and
// the result says so in `only`. The full run stays the one that counts.
export const SESSIONS = ["pads", "seq", "tracks", "project", "bridge"];
export async function testSessionInVm({
  icount = "shift=0,sleep=off",
  only = null,
  sessionDirectory = null,
} = {}) {
  if (only && (!only.length || only.some((name) => !SESSIONS.includes(name))))
    throw new Error(`Sessions are: ${SESSIONS.join(", ")}`);
  const wanted = (name) => !only || only.includes(name.replace(/-second$/, ""));
  const hw = hardware();
  const pointer = join(root, "artifacts/live-mk1/latest-session-image.json");
  const loaderPointer = join(root, "artifacts/live-mk1/latest-loader-image.json");
  if (!sessionDirectory && !existsSync(pointer))
    throw new Error("Build/assemble the session image first");
  if (!existsSync(loaderPointer))
    throw new Error("Build the loader image first: npm run live:loader-image");
  const sessionDir = sessionDirectory
    ? resolve(sessionDirectory)
    : resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  const manifest = JSON.parse(await readFile(join(sessionDir, "manifest.json"), "utf8"));
  if (manifest.runtimeMode === "owner-local-3.10.1") {
    if (
      manifest.format !== "xmp-live-mk1-owner-session-image" ||
      manifest.runtimeLibrariesIncluded !== true
    )
      throw new Error(
        "Assemble the owner runtime before session VM testing; public templates are not bootable",
      );
    const image = await readFile(join(sessionDir, "system-emulator.img"));
    if (sha(image) !== manifest.files?.["system-emulator.img"]?.sha256)
      throw new Error("Owner emulator image hash mismatch or --emulator assembly missing");
  }
  const loaderDir = resolve(root, JSON.parse(await readFile(loaderPointer, "utf8")).directory);
  const kernelDir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-kernel.json"), "utf8"))
      .directory,
  );
  if (!only) prune({ log: () => {} });
  const run = await mkdtemp(join(root, "artifacts/live-mk1/session-vm-"));
  await makeMedia(run, join(sessionDir, "system-emulator.img"));
  const dtb = await liveDtb(run, hw);
  const stock = join(run, "stock.img");
  const before = sha(await readFile(stock));
  const boot = (name, stick, screenshotWhen, more = {}) =>
    !wanted(name)
      ? Promise.resolve({ log: "", skipped: true })
      : runQemu({
          zImage: join(kernelDir, "zImage"),
          initramfs: join(loaderDir, "probe.cpio.gz"),
          disks: [stock],
          log: join(run, `${name}.log`),
          // The project session's script is the longest: it gets more time under emulation.
          seconds: more.seconds ?? 1500,
          extra: ` root=PARTUUID=58504d31-01 rootwait ro isolcpus=${hw.board.isolatedCpus} dummy_hcd.num=3`,
          smp: hw.board.cpus,
          memoryMiB: hw.board.memoryMiB,
          dtb,
          icount,
          pressPowerWhen: /XMP-TWIN script done/,
          screenshots: screenshotWhen
            ? [{ when: screenshotWhen, file: join(run, `${name}.ppm`) }]
            : [],
          ...more,
          qemuArgs: [
            ...liveLikeDevices(hw, join(run, stick), join(run, `${name}.wav`)),
            ...(more.qemuArgs ?? []),
          ],
        });

  const padsRun = await boot("pads", "pads-stick.img", /XMP-SESSION pad 16 off/);
  const afterPads = sha(await readFile(stock));
  const pads = await readStick(run, "pads-stick.img");
  const padsBytes = existsSync(join(run, "pads.wav"))
    ? await readFile(join(run, "pads.wav"))
    : Buffer.alloc(0);
  const padsWav = padsBytes.length > 44 ? analyseWav(padsBytes) : null;
  const padsSent = sentBytes(pads.received);
  const padsShot = existsSync(join(run, "pads.ppm"))
    ? parsePpm(await readFile(join(run, "pads.ppm")))
    : null;

  const seqRun = await boot("seq", "seq-stick.img", /XMP-SESSION record on/);
  const afterSeq = sha(await readFile(stock));
  const seq = await readStick(run, "seq-stick.img");
  const seqBytes = existsSync(join(run, "seq.wav"))
    ? await readFile(join(run, "seq.wav"))
    : Buffer.alloc(0);
  const seqWav = seqBytes.length > 44 ? analyseWav(seqBytes) : null;
  const hitTimes = seqBytes.length > 44 ? onsets(seqBytes) : [];
  const gaps = hitTimes.slice(1).map((t, i) => (t - hitTimes[i]) * 1000);
  const near = (ms) => gaps.filter((g) => Math.abs(g - ms) <= 1.5).length;
  const seqShot = existsSync(join(run, "seq.ppm"))
    ? parsePpm(await readFile(join(run, "seq.ppm")))
    : null;

  // ---- phase 2: eight tracks, the synth, levels, track buttons ----
  const tracksRun = await boot("tracks", "tracks-stick.img", /XMP-SESSION track 3 KEYS selected/);
  const afterTracks = sha(await readFile(stock));
  const tracks = await readStick(run, "tracks-stick.img");
  const tracksBytes = existsSync(join(run, "tracks.wav"))
    ? await readFile(join(run, "tracks.wav"))
    : Buffer.alloc(0);
  const tracksWav = tracksBytes.length > 44 ? analyseWav(tracksBytes) : null;
  const tracksHits = tracksBytes.length > 44 ? onsets(tracksBytes) : [];
  const tracksGaps = tracksHits.slice(1).map((t, i) => (t - tracksHits[i]) * 1000);
  const tracksShot = existsSync(join(run, "tracks.ppm"))
    ? parsePpm(await readFile(join(run, "tracks.ppm")))
    : null;

  // ---- phase 7: a full project from the stick ----
  const projectRun = await boot("project", "project-stick.img", /XMP-SESSION ui: launch scene/, {
    seconds: 2400,
  });
  const afterProject = sha(await readFile(stock));
  const project = await readStick(run, "project-stick.img");
  const projectSent = sentBytes(project.received);
  const projectBytes = existsSync(join(run, "project.wav"))
    ? await readFile(join(run, "project.wav"))
    : Buffer.alloc(0);
  const projectWav = projectBytes.length > 44 ? analyseWav(projectBytes) : null;
  // The project the Live saved: it opens in the browser's core, with the step
  // made in the Steps view (redone after its undo) on Drop's bass clip.
  let savedStep = false,
    savedTake = false,
    savedKnobs = false,
    savedTempo = false,
    savedSong = false,
    savedMix = false,
    savedRoll = false;
  try {
    const { openProject } = await import("../../packages/core/src/project-io.ts");
    const saved = await openProject(project.saved);
    const octaves = saved.tracks
      .find((t) => t.id === "bass")
      ?.clips.find((c) => c.id === "bass-octaves");
    savedStep = !!octaves?.steps.some((st) => st.step === 0 && st.note === 48);
    // The take: a clip of the lead in Intro, with the two recorded notes and the overdubbed one.
    const take = saved.tracks.find((t) => t.id === "lead")?.clips.find((c) => c.id === "take-1");
    savedTake =
      !!take &&
      take.name === "Take 1" &&
      saved.scenes.find((sc) => sc.id === "intro")?.clips.lead === "take-1" &&
      [48, 52, 50].every((n) => take.steps.some((st) => st.note === n));
    // The knobs: the lead's level from 55% to 60%, its pan from R10 to L10.
    savedTempo = saved.bpm === 125;
    savedKnobs =
      saved.tracks.find((t) => t.id === "lead")?.volume === 0.6 &&
      saved.mix?.tracks.lead?.pan === 0.45;
    // The song: a second block of Drop with two repeats, the six blocks after it unchanged.
    const chain = saved.performance?.chain ?? [];
    savedMix =
      saved.performance?.mutes?.drums === true && !!saved.performance?.solos.includes("bass");
    savedRoll = !!saved.tracks
      .find((t) => t.id === "bass")
      ?.clips.find((c) => c.id === "bass-roots")
      ?.steps.some((st) => st.step === 0 && typeof st.note === "number");
    savedSong =
      chain.length >= 7 && // seven set by hand; a song capture later in the session adds more
      chain[1]?.sceneId === "drop" &&
      chain[1]?.repeats === 2 &&
      chain[2]?.id === "part-2";
  } catch {
    savedStep = false;
  }
  const projectShot = existsSync(join(run, "project.ppm"))
    ? parsePpm(await readFile(join(run, "project.ppm")))
    : null;
  // live_ui.hpp's layout: the clip cell of track t in screen row r, a point inside its body.
  // live_ui.hpp's layout (the web Device view's): the Clips cell in column c and row r, its left edge.
  const uiCellEdge = (c, r) => [
    24 + Math.round((c * (1256 - 24 + 10)) / 4) + 1,
    222 + r * 108 + 49,
  ];
  // apps/studio/src/device/style.css colours the screen is drawn in.
  const css = { gold: "216,180,80", goldDeep: "143,114,40", line: "36,69,58" };

  const outputsOneTwoOnly = (wav) =>
    !!wav &&
    wav.channels >= 2 &&
    wav.peaks[0] > 0.05 &&
    wav.peaks[1] > 0.05 &&
    wav.peaks.slice(2).every((p) => p === 0);
  const T = themeColours();
  const green = rgb(T.kEmeraldBright);
  // ---- control bridge: the Mac tool over the bridge's USB serial, relayed by
  // the twin to a virtio console on a socket on the Mac.
  const socketPath = join(tmpdir(), `xmp-bridge-${process.pid}.sock`);
  const console_ = [
    "-device",
    "virtio-serial-device",
    "-chardev",
    `socket,id=bridge,path=${socketPath},server=on,wait=off`,
    "-device",
    "virtconsole,chardev=bridge,name=xmp.bridge",
  ];
  const pushed = await readFile(join(sessionDir, "system-emulator.img"));
  const pushedSha = sha(pushed);
  const bridgeRun = await boot("bridge", "bridge-stick.img", null, {
    pressPowerWhen: null,
    qemuArgs: console_,
    during: {
      when: /XMP-TWIN bridge relay: 1209:0001/,
      run: async () => {
        const out = join(run, "bridge-out");
        await mkdir(out, { recursive: true });
        const steps = {};
        // Each step keeps its own result, so one slow or failed step does not hide the rest.
        const step = async (name, fn) => {
          try {
            steps[name] = await fn();
          } catch (error) {
            steps[name] = { ok: false, error: error.message };
          }
        };
        try {
          await openBridge({ socket: socketPath, token: "wrong" });
          steps.wrongTokenRefused = false;
        } catch (error) {
          steps.wrongTokenRefused = /wrong token/.test(error.message);
        }
        const bridge = await openBridge({
          socket: socketPath,
          token: BRIDGE_TEST_TOKEN,
          log: join(run, "bridge.log"),
        });
        steps.hello = bridge.hello;
        // The emulated link is slow under the instruction-counting clock.
        const slow = { timeoutScale: 8 };
        const [px, py] = centre(deviceLayout().play);
        await step("status", () => bridgeCommand(bridge, "status", [], out, slow));
        await step("pad", () => bridgeCommand(bridge, "input", ["pad", "1", "127"], out, slow));
        await step("touchPlay", () =>
          bridgeCommand(bridge, "input", ["touch", String(px), String(py)], out, slow),
        );
        await step("badInput", () => bridgeCommand(bridge, "input", ["rm", "-rf", "/"], out, slow));
        await step("screenshot", () =>
          bridgeCommand(bridge, "screenshot", [join(out, "screen.png")], out, slow),
        );
        await step("record", () =>
          bridgeCommand(bridge, "record", ["2", join(out, "record.wav")], out, slow),
        );
        await step("log", () => bridgeCommand(bridge, "log", [], out, slow));
        await step("push", () =>
          bridgeCommand(bridge, "push", [join(sessionDir, "system-emulator.img")], out, slow),
        );
        await step("reboot", () => bridgeCommand(bridge, "reboot", [], out, slow));
        bridge.close();
        return steps;
      },
    },
  });
  const steps = bridgeRun.during ?? {};
  const afterPush = await readStick(run, "bridge-stick.img");
  // Second boot from the same stick: the pushed image must start.
  const secondRun = await boot("bridge-second", "bridge-stick.img", null, {
    pressPowerWhen: /XMP-SESSION ready/,
  });
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [{ from: join(run, "bridge-stick.img"), to: "/in-stick.img" }],
    command:
      "mkdir -p /out && mcopy -n -i /in-stick.img@@1M ::xmp/system.img /out/stick-system.img && (mcopy -n -i /in-stick.img@@1M ::xmp/system.img.previous /out/stick-previous.img || : > /out/stick-previous.img)",
    out: run,
    timeout: 300000,
  });
  const onStick = sha(await readFile(join(run, "stick-system.img")));
  const previousKept = (await readFile(join(run, "stick-previous.img"))).length > 1024;
  const recordWav = existsSync(join(run, "bridge-out/record.wav"))
    ? analyseWav(await readFile(join(run, "bridge-out/record.wav")))
    : null;
  const afterBridge = sha(await readFile(stock));

  const result = {
    format: "xmp-session-vm-test",
    version: 2,
    ...(only ? { only, note: "A partial run: checks of the other sessions are not results." } : {}),
    machine: {
      sameSessionBinaryAsLive:
        manifest.sameSessionBinary === true &&
        !!(manifest.files.session || manifest.sessionBinarySha256),
      liveBoardRuleApplied: pads.log.includes("board: linux,dummy-virt inmusic,acv8"),
      fourCoresIsolatedPinned:
        /audio: blocks \d+, xruns \d+, errors \d+, peak [-.\d]+ dBFS, sched-fifo, cpu 3/.test(
          pads.log,
        ),
      stickOnUsbStorage: /XMP-LOADER system image \/dev\/loop\d+ on \/dev\/sd[a-z]1/.test(
        padsRun.log,
      ),
      screen800x1280Rotated: pads.log.includes(
        "screen: 800x1280, 32 bpp, rotation 270, canvas 1280x800",
      ),
      twinCards:
        pads.twinLog.includes("gadget-side cards: controller") && !pads.twinLog.includes("failed"),
      touchscreenLikeLive:
        /touch: \/dev\/input\/event\d+ "XMP emulator XMP twin touchscreen", x 0\.\.1280, y 0\.\.720/.test(
          pads.log,
        ),
    },
    pads: {
      audioCardAccepted: /audio: plughw:\d+,0 open/.test(pads.log),
      bothPortsRead: pads.log.includes("(Public)") && pads.log.includes("(Private)"),
      startupBytesExactOnPrivatePort:
        padsSent.private === EXPECTED_STARTUP && padsSent.public === "",
      identityReplyLoggedWithoutSerial:
        pads.log.includes("identity reply; serial number not logged") &&
        !pads.log.includes("54 57 49 4E"),
      padOneHard: pads.log.includes("pad 1 on velocity 127 (kick) port 1"),
      padSixteenSoft: pads.log.includes("pad 16 on velocity 48 (pluck E+) port 1"),
      runningStatusOff: pads.log.includes("pad 16 off port 1"),
      buttonLogged: pads.log.includes("button 09 down port 1"),
      knobLogged: pads.log.includes("track 8 level 17% (knob 1)"),
      eightAtOnce: /pad hits \[2,1,1,1,1,1,1,1,0,0,0,0,0,0,0,1\]/.test(pads.log),
      soundOnOutputsOneTwoOnly: outputsOneTwoOnly(padsWav),
      peakWithinMinus12dBFS: !!padsWav && padsWav.peak <= PEAK_LIMIT + 1 / 32768,
      noXruns: /audio: blocks [1-9]\d*, xruns 0, errors 0/.test(pads.log),
      powerButtonEndsSession: pads.log.includes("done (power button)"),
      switchedOff: padsRun.log.includes("XMP-SESSION powering off (session ended)"),
      screenGridDrawn:
        !!padsShot &&
        padsShot.width === hw.display.framebuffer.xres &&
        canvasColour(padsShot, ...centre(deviceLayout().pads[0])) === rgb(T.kSurface) && // pad 1, idle
        [0, 1, 2, 3].every(
          (i) => canvasColour(padsShot, ...centre(deviceLayout().status[i])) === green,
        ),
      rootDiskUnchanged: afterPads === before,
    },
    sequencer: {
      touchesSelectAndProgram:
        seq.log.includes("selected pad 8 (rim, touch)") &&
        seq.log.includes("step 16 on for pad 8 on track 1 (touch)"),
      played: seq.log.includes("play at 120 BPM (touch)"),
      recordedLiveHit: /pad 1 on velocity 127 \(kick\) port 1, recorded on step \d+/.test(seq.log),
      tempoChanged: seq.log.includes("tempo 125 BPM (touch)"),
      stopped: seq.log.includes("stop (Stop button)"),
      dataWheelTempo: seq.log.includes("tempo 130 BPM (data wheel)"),
      noLateNotes:
        /sequencer: [1-9]\d* notes scheduled, 0 late, 1 recorded, 21 touches, 130 BPM/.test(
          seq.log,
        ),
      stepsAt120BpmExact: near(125) >= 4,
      stepsAt125BpmExact: near(120) >= 4,
      patternSavedToStick:
        seq.pattern.includes("bpm=130") &&
        seq.pattern.includes("pad8=64 64 64 64 64 64 64 64 64 64 64 64 64 64 64 64") &&
        /pad1=(00 )*7F/.test(seq.pattern),
      soundOnOutputsOneTwoOnly: outputsOneTwoOnly(seqWav),
      peakWithinMinus12dBFS: !!seqWav && seqWav.peak <= PEAK_LIMIT + 1 / 32768,
      noXruns: /audio: blocks [1-9]\d*, xruns 0, errors 0/.test(seq.log),
      screenShowsPlayingAndSteps:
        !!seqShot &&
        canvasColour(seqShot, ...inside(deviceLayout().play)) === rgb(T.kEmerald) &&
        canvasColour(seqShot, ...inside(deviceLayout().record)) === rgb(T.kRuby) &&
        deviceLayout().steps.every((r) =>
          [rgb(mix(T.kGoldDeep, T.kGoldBright, 100 / 127)), rgb(T.kIvory)].includes(
            canvasColour(seqShot, ...centre(r)),
          ),
        ),
      switchedOff: seqRun.log.includes("XMP-SESSION powering off (session ended)"),
      rootDiskUnchanged: afterSeq === before,
    },
    tracks: {
      trackButtonsSelect:
        tracks.log.includes("track 2 BASS selected (track button)") &&
        tracks.log.includes("track 1 KIT selected (track button)") &&
        tracks.log.includes("track 3 KEYS selected (track button)"),
      synthStepsEntered: [1, 5, 9, 13].every((n) =>
        tracks.log.includes(`step ${n} on note 36 on track 2 (touch)`),
      ),
      knobSetsLevel: tracks.log.includes("track 2 level 60% (knob 1)"),
      kitStepsOnTrack1:
        tracks.log.includes("step 1 on for pad 1 on track 1 (touch)") &&
        tracks.log.includes("step 9 on for pad 1 on track 1 (touch)"),
      liveSynthNote: tracks.log.includes("pad 1 on velocity 100 (KEYS) port 1"),
      noLateNotes: /sequencer: [1-9]\d* notes scheduled, 0 late/.test(tracks.log),
      // Notes land on exact frames: the detected hit pattern (kick, bass and the
      // bass waveform's own threshold crossings) repeats every half bar (1000 ms
      // at 120 BPM) to within 0.5 ms.
      bassOnQuarterNotes:
        tracksGaps.filter(
          (_, i) =>
            i + 2 < tracksGaps.length &&
            Math.abs(tracksGaps[i] + tracksGaps[i + 1] + tracksGaps[i + 2] - 1000) <= 0.5,
        ).length >= 2,
      songSavedToStick:
        tracks.pattern.includes("xmp-live-song=2") &&
        tracks.pattern.includes("track2=synth preset=0 root=36 level=60 mute=0") &&
        tracks.pattern.includes("track2.notes=24 00 00 00 24 00 00 00 24 00 00 00 24 00 00 00") &&
        tracks.pattern.includes("track1.pad1=64 00 00 00 00 00 00 00 64 00 00 00 00 00 00 00"),
      soundOnOutputsOneTwoOnly: outputsOneTwoOnly(tracksWav),
      peakWithinMinus12dBFS: !!tracksWav && tracksWav.peak <= PEAK_LIMIT + 1 / 32768,
      noXruns: /audio: blocks [1-9]\d*, xruns 0, errors 0/.test(tracks.log),
      screenShowsTrackStrip:
        !!tracksShot &&
        canvasColour(tracksShot, ...corner(deviceLayout().tracks[2])) === rgb(T.kEmeraldDeep) && // selected track
        canvasColour(tracksShot, ...corner(deviceLayout().tracks[3])) === rgb(T.kSurface),
      switchedOff: tracksRun.log.includes("XMP-SESSION powering off (session ended)"),
      rootDiskUnchanged: afterTracks === before,
    },
    project: {
      controllerFeedbackAllowlisted: feedbackBytesAllowed(projectSent),
      projectOpened: /project: project\.xmpsong "Night Shift", 6 tracks, 5 scenes/.test(
        project.log,
      ),
      playButtonPlaysTheSong: project.log.includes("ui: play the song (controls)"),
      stopButtonStops: project.log.includes("ui: stop (controls)"),
      // The twin's card may have no inputs: either way the Sample view asks for them only on REC.
      soundPresetChosen: project.log.includes("ui: track 2 preset Soft key (controls)"),
      soundEngineReloaded: project.log.includes(
        "ui: sound: the engine has the project's new sounds",
      ),
      songCaptured: /ui: song: captured \d+ parts as \d+ blocks/.test(project.log),
      sampleViewRecords:
        /sample: (waiting for sound|cannot open the inputs|.*refused 48 kHz stereo input)/.test(
          project.log,
        ),
      padPlaysOneClip: project.log.includes("ui: play clip Kick and hats on track 1 (controls)"),
      padLaunchesAtTheBar: project.log.includes(
        "ui: launch clip Full on track 1 at the next bar (controls)",
      ),
      shiftMainOpensPlay: /pad 1 on velocity 100 port 1 \(PLAY view\)/.test(project.log),
      wheelLaunchesScene: project.log.includes("ui: launch scene Drop at the next bar (controls)"),
      stepsViewEdits: project.log.includes("ui: step 1 of Octaves on track 2 toggled (controls)"),
      undoAndRedo:
        project.log.includes("ui: undo (controls)") && project.log.includes("ui: redo (controls)"),
      savedToTheStick:
        // An edit that changes no sample is saved as project.edits (the song
        // without its audio); a whole project.xmpsong follows a sample change.
        /project: (edits saved to the stick as project\.edits|saved to the stick as project\.xmpsong), \d+ bytes in \d+ ms \(edited\)/.test(
          project.log,
        ),
      wholeSongSavedAtTheEnd:
        /project: saved to the stick as project\.xmpsong, \d+ bytes in \d+ ms \(session end\)/.test(
          project.log,
        ),
      savedProjectOpensWithTheEdit: savedStep,
      recCountsIn: project.log.includes(
        "ui: recording track 5 into scene Intro from step 17 (controls)",
      ),
      recordedATake: /ui: recorded Take 1, (16|32) steps, 2 hits, on track 5 in scene Intro/.test(
        project.log,
      ),
      overdubbed: /ui: overdub on track 5 at step/.test(project.log),
      savedProjectHasTheTake: savedTake,
      knobsChangeTheTrack:
        project.log.includes("ui: track 5 Level 60% (knob 1, controls)") &&
        project.log.includes("ui: track 5 Pan L10 (knob 2, controls)"),
      savedProjectHasTheKnobs: savedKnobs,
      mixKnobsAfterTheSoundView: /ui: track 2 Level \d+% \(knob 1, controls\)/.test(project.log),
      wheelValueKeptOnApply: savedTempo,
      screenMessagesLogged: /XMP-SESSION screen: |\d screen: /.test(project.log),
      songViewEdits:
        project.log.includes("ui: song: Drop added as block 2 (controls)") &&
        project.log.includes("ui: song block 2: Repeats x2 (knob 1, controls)"),
      songPlaysFromABlock: project.log.includes("ui: play the song from block 2 (controls)"),
      savedProjectHasTheSong: savedSong,
      mixViewMutesAndSolos:
        project.log.includes("ui: mix: track 1 muted (controls)") &&
        project.log.includes("ui: mix: track 2 soloed (controls)"),
      savedProjectHasTheMix: savedMix,
      pianoRollEdits: project.log.includes("ui: step 1 of Roots on track 2 toggled (controls)"),
      savedProjectHasTheRollNote: savedRoll,
      screenShowsClips:
        !!projectShot &&
        canvasColour(projectShot, ...uiCellEdge(1, 1)) === css.gold && // the bass in Groove, focused
        canvasColour(projectShot, 640, 71) === css.goldDeep && // the header's gold line
        canvasColour(projectShot, 319, 760) === css.line, // the Q-Link strip
      noCommandsDropped: !project.log.includes("commands dropped"),
      soundOnOutputsOneTwoOnly: outputsOneTwoOnly(projectWav),
      peakWithinMinus12dBFS: !!projectWav && projectWav.peak <= PEAK_LIMIT + 1 / 32768,
      noXruns: /audio: blocks [1-9]\d*, xruns 0, errors 0/.test(project.log),
      switchedOff: projectRun.log.includes("XMP-SESSION powering off (session ended)"),
      rootDiskUnchanged: afterProject === before,
    },
    bridge: {
      gadgetUp: bridgeRun.log.includes(
        'XMP-BRIDGE gadget 1209:0001 "XMP bridge" (serial) on dummy_udc.2',
      ),
      wrongTokenRefused: steps.wrongTokenRefused === true,
      helloLiveBoard: !!steps.hello?.ok && /inmusic,acv8/.test(steps.hello.board),
      statusFromSession: steps.status?.ok === true && steps.status.session?.audio === true,
      inputInjected:
        steps.pad?.ok === true && afterPush.log.includes("pad 1 on velocity 127 (kick) port 2"),
      touchInjected: steps.touchPlay?.ok === true && afterPush.log.includes("play at"),
      shellLikeInputRefused: steps.badInput?.ok === false,
      screenshotLandscape:
        steps.screenshot?.ok === true &&
        steps.screenshot.width === 800 &&
        existsSync(join(run, "bridge-out/screen.png")),
      recordHasSound:
        !!recordWav && recordWav.peak > 0.02 && recordWav.peak <= PEAK_LIMIT + 1 / 32768,
      logRead: steps.log?.ok === true,
      pushVerified: steps.push?.installed === true && steps.push.sha256 === pushedSha,
      rebootedIntoPushedImage:
        bridgeRun.log.includes("restarting the unit to start the new system image") &&
        secondRun.log.includes("XMP-SESSION ready") &&
        onStick === pushedSha,
      previousImageKept: previousKept,
      rootDiskUnchanged: afterBridge === before,
      error: steps.error ?? null,
    },
    timing: { icount, onsets: hitTimes.length, gapsMs: gaps.map((g) => Number(g.toFixed(2))) },
    audio: padsWav && {
      channels: padsWav.channels,
      rate: padsWav.rate,
      peakDbfs: Number((20 * Math.log10(Math.max(padsWav.peak, 1e-9))).toFixed(2)),
      channelPeaks: padsWav.peaks.map((p) => Number(p.toFixed(4))),
    },
    scope:
      "QEMU virt shaped like the Live (os/live-mk1/hardware.json) with the official az01 kernel source, the XMP stick loader and the exact Live session binary. USB gadgets on dummy_hcd stand in for the Live's internal controller and touchscreen, and QEMU's usb-audio (patched to carry the card's USB ID and name, 2 channels at 48 kHz rather than the Live card's 6) for its audio card; behaviour of the real devices beyond what the owner's sessions recorded is not modelled.",
  };
  result.verification = evaluateSessionResult(result, only);
  await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return { directory: run, result };
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const imageAt = args.indexOf("--image-dir");
  let sessionDirectory = null;
  if (imageAt >= 0) {
    sessionDirectory = args[imageAt + 1];
    if (!sessionDirectory || sessionDirectory.startsWith("--"))
      throw new Error("--image-dir needs an owner image directory");
    args.splice(imageAt, 2);
  }
  const realtime = args.includes("--realtime");
  const at = args.indexOf("--only");
  const only = at >= 0 ? (args[at + 1] ?? "").split(",").filter(Boolean) : null;
  const rest = args.filter((a, i) => a !== "--realtime" && i !== at && (at < 0 || i !== at + 1));
  if (rest.length || (at >= 0 && !only.length))
    throw new Error(
      `Usage: npm run live:session-vm [-- --image-dir <owner-image-directory>] [--realtime] [--only ${SESSIONS.join("|")}[,...]]`,
    );
  const { directory, result } = await testSessionInVm({
    ...(realtime ? { icount: null } : {}),
    only,
    sessionDirectory,
  });
  console.log(JSON.stringify({ directory: relative(root, directory), ...result }, null, 2));
  process.exitCode = result.verification.passed ? 0 : 1;
}

// Generic downstream session smoke: same protected disks, loader, twin and GPU.
// No assumptions about the downstream program's musical UI or TypeScript code.
export async function testDownstreamSessionInVm({
  imageDirectory,
  readyPattern,
  selectedPattern,
  instructionClock = false,
}) {
  const hw = hardware();
  const manifest = JSON.parse(await readFile(join(imageDirectory, "manifest.json"), "utf8"));
  if (!manifest.downstreamProgram) throw new Error("Not a downstream image");
  for (const name of ["system-emulator.img", "session"]) {
    if (sha(await readFile(join(imageDirectory, name))) !== manifest.files[name].sha256)
      throw new Error("Downstream image hash mismatch");
  }
  const pointer = async (name) =>
    resolve(
      root,
      JSON.parse(await readFile(join(root, `artifacts/live-mk1/latest-${name}.json`), "utf8"))
        .directory,
    );
  const loaderDir = await pointer("loader-image"),
    kernelDir = await pointer("kernel");
  const run = await mkdtemp(join(root, "artifacts/live-mk1/downstream-vm-"));
  await makeMedia(run, join(imageDirectory, "system-emulator.img"), {
    downstreamOnly: true,
    readyFile: "/tmp/xmp-downstream-ready",
  });
  const dtb = await liveDtb(run, hw),
    stock = join(run, "stock.img");
  const before = sha(await readFile(stock));
  const boot = await runQemu({
    zImage: join(kernelDir, "zImage"),
    initramfs: join(loaderDir, "probe.cpio.gz"),
    disks: [stock],
    log: join(run, "boot.log"),
    seconds: 600,
    smp: hw.board.cpus,
    memoryMiB: hw.board.memoryMiB,
    dtb,
    extra: ` root=PARTUUID=58504d31-01 rootwait ro isolcpus=${hw.board.isolatedCpus} dummy_hcd.num=3`,
    icount: instructionClock ? "shift=0,sleep=off" : null,
    pressPowerWhen: /XMP-TWIN script done/,
    screenshots: [{ when: selectedPattern, file: join(run, "selected.ppm") }],
    qemuArgs: liveLikeDevices(hw, join(run, "pads-stick.img"), join(run, "audio.wav")),
  });
  const result = {
    format: "xmp-downstream-vm",
    version: 1,
    program: manifest.downstreamProgram,
    ready: readyPattern.test(boot.log),
    selected: selectedPattern.test(boot.log),
    screenshot: existsSync(join(run, "selected.ppm")),
    protectedDiskUnchanged: before === sha(await readFile(stock)),
    exited: boot.code === 0,
    copiedToDevice: false,
    directory: run,
  };
  if (result.ready && result.selected && result.exited) {
    Object.assign(result, await auditDownstreamSessionVm(run));
    result.screenshot = result.framebufferCaptured;
  }
  await writeFile(join(run, "report.json"), JSON.stringify(result, null, 2) + "\n");
  if (
    !result.ready ||
    !result.selected ||
    !result.screenshot ||
    !result.protectedDiskUnchanged ||
    !result.exited ||
    !result.controllerOutputAllowed ||
    !result.audioWithinLimit
  )
    throw new Error(`Downstream session VM failed: ${JSON.stringify(result)}`);
  return result;
}

// Re-audit retained VM artifacts without rerunning the guest or trusting a pass flag.
export async function auditDownstreamSessionVm(run) {
  const captured = await readStick(run, "pads-stick.img");
  if (captured.frame.toString("ascii", 0, 3) !== "P6\n" || captured.frame.length < 1000)
    throw new Error("Missing guest framebuffer evidence");
  await writeFile(join(run, "guest-framebuffer.ppm"), captured.frame);
  const sent = sentBytes(captured.received);
  const audio = analyseWav(await readFile(join(run, "audio.wav")));
  // Reading controls does not require transmitting startup bytes. No output
  // is valid; when output is observed it must be exactly the approved traffic.
  const identity = "F0 7E 00 06 01 F7";
  if (!["", identity, EXPECTED_STARTUP].includes(sent.private) || sent.public !== "")
    throw new Error("Unexpected controller output");
  if (audio.frames === 0 || audio.peak > PEAK_LIMIT || audio.channels !== 2)
    throw new Error("Invalid downstream audio capture");
  return {
    framebufferCaptured: true,
    controllerOutputAllowed: true,
    startupObserved: sent.private === EXPECTED_STARTUP,
    audioWithinLimit: true,
    audio: { channels: audio.channels, rate: audio.rate, frames: audio.frames, peak: audio.peak },
  };
}
