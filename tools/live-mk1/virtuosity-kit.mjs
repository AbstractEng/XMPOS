// Builds a 16-pad multisampled kit for the Live's sampler track from
// Virtuosity Drums (Versilian Studios and Karoryfer Samples, CC0-1.0).
// Nothing is committed: the samples are downloaded from the pinned commit,
// each file is checked against the repository's own git hash, decoded with
// ffmpeg to mono 48 kHz, mixed, and written in the sampler's folder layout
// (native/include/xmp/live_sample_folder.hpp) with the license and credits.
//
// Two mixes:
//   studio (default)  kick mic, snare mic and overheads, a little room, as the
//                     library's own basic kit; light tape saturation for a
//                     dry 70s character.
//   vintage           the library's single lo-fi room mic (thin, telephone-like).
//
//   npm run live:virtuosity-kit [-- --mix studio|vintage] [-- --out DIR]
//
// Copy the output folder to the stick as xmp/samples/track<N>/ (for example
// track 3), then turn knob 4 on that track until it shows SMPL.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "../..");
const REPO = "sfzinstruments/virtuosity_drums";
const COMMIT = "9f04cf9a734527edfbb0a4eee1f674e45bbf71bc"; // master, 2026-04-21
const RATE = 48000;
const MAX_LAYERS = 8;
const MAX_TAKES = 8;
const MAX_DOWNLOAD = 8 * 1024 * 1024; // per file

// Microphone mixes: mic folder -> gain.
export const MIXES = {
  studio: { kickmic: 1, snaremic: 1, oh: 1, room: 0.3 },
  vintage: { lofi: 1 },
};
// Tape-style soft saturation per mix (0 = none).
const DRIVE = { studio: 1.6, vintage: 0 };

// Pad 1 is bottom left, in the order of XMP's other kits. Seconds: length cap.
// Peak: the loudest take of the pad, in dBFS (drums loud, cymbals lower), so
// the kit is balanced and as loud as the synthesized kits; the recorded
// dynamics between a pad's layers are kept.
// Tune: semitones (the jazz kit's small kick, down 3 for a deeper 70s kick).
// Choke group 1: the hi-hat (closed, pedal and half-open stop the open hat).
export const PADS = [
  { pad: 1, name: "kick", source: "kick/kick_snoff", seconds: 1.5, peak: -1, tune: -3 },
  { pad: 2, name: "snare", source: "snare/snare_center", seconds: 1.5, peak: -1 },
  { pad: 3, name: "closed hat", source: "hh/hh_closed", seconds: 1, peak: -6, choke: 1 },
  { pad: 4, name: "open hat", source: "hh/hh_open", seconds: 3, peak: -5, choke: 1 },
  { pad: 5, name: "x-stick", source: "snare/snare_crossstick", seconds: 1, peak: -3 },
  { pad: 6, name: "rimshot", source: "snare/snare_rimshot", seconds: 1.5, peak: -1 },
  { pad: 7, name: "low tom", source: "ltom/ltom_center", seconds: 2.5, peak: -1 },
  { pad: 8, name: "high tom", source: "htom/htom_center", seconds: 2, peak: -1 },
  { pad: 9, name: "ride", source: "ride/ride_ride", seconds: 5, peak: -5 },
  { pad: 10, name: "crash", source: "crash/crash_crash", seconds: 6, peak: -3 },
  { pad: 11, name: "pedal hat", source: "hh/hh_pedal", seconds: 1, peak: -7, choke: 1 },
  { pad: 12, name: "ride bell", source: "ride/ride_bell", seconds: 5, peak: -5 },
  { pad: 13, name: "snare edge", source: "snare/snare_offcenter", seconds: 1.5, peak: -1 },
  { pad: 14, name: "snare muted", source: "snare/snare_muted", seconds: 1, peak: -3 },
  { pad: 15, name: "snare flam", source: "snare/snare_flam", seconds: 1.5, peak: -1 },
  { pad: 16, name: "half hat", source: "hh/hh_half", seconds: 2, peak: -5, choke: 1 },
];

const gitBlobSha = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// Files of one articulation on one mic, grouped into velocity layers (soft
// first) of round-robin takes; more than 8 layers are thinned evenly to 8.
export function pickLayers(paths, source, mic = "lofi") {
  const [drum, articulation] = source.split("/");
  const re = new RegExp(
    `^Samples/${mic}/${drum}/${mic}_${articulation}_vl(\\d+)(?:_rr(\\d+))?\\.flac$`,
  );
  const layers = new Map();
  for (const path of paths) {
    const m = re.exec(path);
    if (!m) continue;
    const vl = Number(m[1]);
    if (!layers.has(vl)) layers.set(vl, []);
    layers.get(vl).push({ path, rr: Number(m[2] ?? 1) });
  }
  const sorted = [...layers.keys()].sort((a, b) => a - b);
  const keep =
    sorted.length <= MAX_LAYERS
      ? sorted
      : Array.from(
          { length: MAX_LAYERS },
          (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (MAX_LAYERS - 1))],
        );
  return keep.map((vl) => ({
    vl,
    takes: layers
      .get(vl)
      .sort((a, b) => a.rr - b.rr)
      .slice(0, MAX_TAKES),
  }));
}

// The same take on another mic: only the mic folder and prefix differ.
export const onMic = (path, from, to) =>
  path.replace(`Samples/${from}/`, `Samples/${to}/`).replace(`/${from}_`, `/${to}_`);

async function fetchBytes(url, limit) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url}: larger than ${limit} bytes`);
  return bytes;
}

// Mono float samples at 48 kHz, decoded by ffmpeg from a verified file.
function decode(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", `${RATE}`, "-f", "f32le", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    let err = "";
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (c) => (err += c));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${file}: ${err.slice(0, 300)}`));
      const buf = Buffer.concat(chunks);
      resolve(
        Float32Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4))),
      );
    });
  });
}

// Sum of mono signals with gains, as long as the longest.
export function mixDown(parts) {
  const out = new Float32Array(Math.max(0, ...parts.map(([s]) => s.length)));
  for (const [s, g] of parts) for (let i = 0; i < s.length; i++) out[i] += s[i] * g;
  return out;
}

// Pitch by `semitones`, by resampling (lower is longer), linear interpolation.
export function retune(samples, semitones) {
  if (!semitones) return samples;
  const step = 2 ** (semitones / 12);
  const out = new Float32Array(Math.floor((samples.length - 1) / step) + 1);
  for (let i = 0; i < out.length; i++) {
    const pos = i * step,
      a = Math.floor(pos),
      f = pos - a;
    out[i] = samples[a] * (1 - f) + (samples[Math.min(a + 1, samples.length - 1)] ?? 0) * f;
  }
  return out;
}

// Soft saturation relative to `reference` (the pad's loudest peak), so soft
// layers stay clean and hard ones round off, as on tape. Drive 0 = none.
export function saturate(samples, drive, reference) {
  if (!drive || !reference) return samples;
  const k = Math.tanh(drive);
  return samples.map((v) => (Math.tanh((drive * v) / reference) / k) * reference);
}

// Trailing silence off (below -66 dBFS of the take's peak), capped length,
// 20 ms fade at a cut.
export function shape(samples, seconds) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const floor = Math.max(1e-6, peak * 0.0005);
  let end = samples.length;
  while (end > 0 && Math.abs(samples[end - 1]) < floor) end--;
  const cap = Math.round(seconds * RATE);
  const cut = end > cap;
  const out = Float32Array.from(samples.subarray(0, Math.min(end, cap)));
  if (cut) {
    const fade = Math.min(out.length, Math.round(0.02 * RATE));
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  }
  return out;
}

export function wav24(samples, gain) {
  const data = Buffer.alloc(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-8388608, Math.min(8388607, Math.round(samples[i] * gain * 8388607)));
    data.writeIntLE(v, i * 3, 3);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 3, 28);
  head.writeUInt16LE(3, 32);
  head.writeUInt16LE(24, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export const folderName = (p) =>
  `${String(p.pad).padStart(2, "0")} ${p.name}${p.choke ? `_c${p.choke}` : ""}`;

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
  };
  const mix = option("--mix", "studio");
  if (!MIXES[mix]) throw new Error(`--mix must be ${Object.keys(MIXES).join(" or ")}`);
  const mics = Object.entries(MIXES[mix]);
  const out = option("--out", join(root, `artifacts/live-mk1/kits/virtuosity-${mix}`));
  const cache = join(root, "artifacts/live-mk1/kits/cache", COMMIT);

  // The repository's own file list and git hashes at the pinned commit.
  const tree = JSON.parse(
    (
      await fetchBytes(
        `https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`,
        4 << 20,
      )
    ).toString(),
  );
  const sha = new Map(tree.tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
  const raw = (path) =>
    `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${path.split("/").map(encodeURIComponent).join("/")}`;
  async function verified(path) {
    if (!sha.has(path)) throw new Error(`${path}: not in the repository`);
    const local = join(cache, path);
    if (existsSync(local)) {
      const bytes = await readFile(local);
      if (gitBlobSha(bytes) === sha.get(path)) return local;
    }
    const bytes = await fetchBytes(raw(path), MAX_DOWNLOAD);
    if (gitBlobSha(bytes) !== sha.get(path))
      throw new Error(`${path}: hash does not match the repository`);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, bytes);
    return local;
  }

  const license = await verified("LICENSE");
  const [firstMic] = mics[0];
  const plan = PADS.map((p) => ({ ...p, layers: pickLayers([...sha.keys()], p.source, firstMic) }));
  for (const p of plan) if (!p.layers.length) throw new Error(`no samples for ${p.source}`);

  // Every take: each mic decoded and mixed down to one mono signal.
  const jobs = plan.flatMap((p) =>
    p.layers.flatMap((l, li) => l.takes.map((t, ti) => ({ p, li, ti, path: t.path }))),
  );
  let done = 0;
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const parts = [];
        for (const [mic, gain] of mics)
          parts.push([await decode(await verified(onMic(job.path, firstMic, mic))), gain]);
        job.samples = retune(mixDown(parts), job.p.tune ?? 0);
        if (++done % 20 === 0) console.log(`${done}/${jobs.length} takes`);
      }
    }),
  );

  // Per pad: saturate against the pad's loudest take, then one gain so that
  // take peaks at the pad's level. Layers keep their recorded dynamics.
  await rm(out, { recursive: true, force: true });
  let frames = 0;
  const lines = [];
  for (const p of plan) {
    const takes = jobs.filter((j) => j.p === p);
    let reference = 0;
    for (const j of takes) for (const v of j.samples) reference = Math.max(reference, Math.abs(v));
    for (const j of takes) j.samples = shape(saturate(j.samples, DRIVE[mix], reference), p.seconds);
    let peak = 0;
    for (const j of takes) for (const v of j.samples) peak = Math.max(peak, Math.abs(v));
    const gain = 10 ** (p.peak / 20) / peak;
    const dir = join(out, folderName(p));
    await mkdir(dir, { recursive: true });
    for (const j of takes) {
      const name = `${p.name.replaceAll(" ", "-")}_v${j.li + 1}_rr${j.ti + 1}.wav`;
      await writeFile(join(dir, name), wav24(j.samples, gain));
      frames += j.samples.length;
    }
    lines.push(
      `pad ${String(p.pad).padStart(2)}  ${p.name.padEnd(17)} ${p.layers.length} layers x ${Math.max(...p.layers.map((l) => l.takes.length))} takes, peak ${p.peak} dBFS${p.tune ? `, tuned ${p.tune}` : ""}  (${p.source}, layers ${p.layers.map((l) => l.vl).join(",")})`,
    );
  }
  await writeFile(join(out, "LICENSE-CC0.txt"), await readFile(license));
  await writeFile(
    join(out, "CREDITS.txt"),
    [
      `Virtuosity Drums, ${mix} mix (${mics.map(([m, g]) => `${m} x${g}`).join(", ")}), arranged for the XMP sampler track.`,
      "Recorded by Versilian Studios and Karoryfer Samples at Virtuosity Musical Instruments, Boston;",
      "drummer Austin McMahon. Released under CC0-1.0 (see LICENSE-CC0.txt).",
      `Source: https://github.com/${REPO} at commit ${COMMIT}.`,
      `Mixed to mono 48 kHz 24-bit WAV, ${DRIVE[mix] ? "light tape saturation, " : ""}trimmed, levelled per pad.`,
      "",
      ...lines,
      "",
    ].join("\n"),
  );
  console.log(lines.join("\n"));
  console.log(
    `${jobs.length} files, ${(frames / RATE).toFixed(1)} s of audio (${((frames * 4) / 1e6).toFixed(1)} MB on the Live), in ${relative(root, out)}`,
  );
}

if (process.argv[1] === import.meta.filename) await main();
