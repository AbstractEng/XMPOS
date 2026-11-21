// Trusted source example: a custom UI over a validated declarative instrument.
// No server, audio device, shell or imported executable module is used.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPackage, packagePlan, referenceParity } from "@xmp/sdk";

if (process.argv.length !== 3) throw new Error("Usage: node render.mjs new-output.html");
const example = new URL("../examples/community-tone/", import.meta.resolve("@xmp/sdk"));
const read = (name) => readFile(new URL(name, example), "utf8");
const pkg = await buildPackage(
  JSON.parse(await read("module.json")),
  JSON.parse(await read("program.json")),
  await read("LICENSE"),
);
const result = referenceParity(await packagePlan(pkg));
const pcm = result.pcm;
if (!pcm.length || !pcm.every(Number.isFinite) || !pcm.some((v) => v !== 0))
  throw new Error("Invalid example audio");
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24);
wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++)
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
const points = Array.from({ length: 240 }, (_, i) => {
  const start = Math.floor((i * pcm.length) / 240);
  const end = Math.floor(((i + 1) * pcm.length) / 240);
  let peak = 0;
  for (let at = start; at < end; at++) peak = Math.max(peak, Math.abs(pcm[at]));
  return `<line x1="${i}" x2="${i}" y1="${40 - peak * 120}" y2="${40 + peak * 120}"/>`;
}).join("");
const audio = `data:audio/wav;base64,${wav.toString("base64")}`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My XMP instrument</title>
<style>body{font:18px system-ui;max-width:720px;margin:48px auto;padding:24px;background:#f2efe9;color:#35473e}svg{width:100%;height:160px;stroke:currentColor}audio{width:100%}a{color:inherit}</style>
<main><h1>My XMP instrument</h1><p>A custom sound card built with the public SDK. Original declarative tone, API 2 / DSP ABI 1.</p>
<svg viewBox="0 0 240 80" role="img" aria-label="Peak waveform of the rendered original tone">${points}</svg>
<audio controls preload="none" src="${audio}">Audio playback requires a browser with WAV support.</audio>
<p><a href="${audio}" download="my-xmp-tone.wav">Download the rendered tone</a></p>
<p>48 kHz mono, ${pcm.length} frames. Offline reference render; no hardware access.</p></main></html>`;
await writeFile(process.argv[2], html, { flag: "wx" });
console.log(
  JSON.stringify({ written: resolve(process.argv[2]), frames: pcm.length, physicalAccess: false }),
);
