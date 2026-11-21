import assert from "node:assert/strict";
import { execFileSync, execFileSync as gitExec } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fontCSS, identity, logo } from "./identity.mjs";
import { screenForwardPanel } from "./screen-forward-panel.mjs";

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
export function teachingFrame(lesson, index, screen, controls, native = false) {
  const [title, caption] = lesson.steps[index];
  const mode = native
    ? "Native Live · simulated example"
    : (lesson.mode ?? "Device · web + Live controls");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><style>${fontCSS}*{box-sizing:border-box}body{margin:0;width:1920px;height:1080px;background:#F2EFE9;color:#35473E;font-family:Manrope,sans-serif;font-synthesis:none}header{height:64px;padding:2px 24px;display:flex;gap:32px;align-items:center}header img{width:240px;height:55px;object-fit:contain}header strong{font-size:25px;font-weight:600}header span{margin-left:auto;font-size:16px}.device{position:absolute;left:22px;top:64px;width:1876px;height:914px}.caption{position:absolute;left:32px;right:32px;top:986px;display:flex;gap:24px;align-items:baseline}.caption b{font-size:25px;font-weight:600;white-space:nowrap}.caption p{font-size:26px;line-height:1.3;margin:0;max-width:1380px}.progress{position:absolute;bottom:0;left:0;width:${((index + 1) / 6) * 100}%;height:5px;background:#5862BF}</style><header><img src="${logo}" alt="Abstract Engineering"><strong>XMP OS · ${esc(lesson.id.slice(0, 2))} / ${esc(lesson.title)}</strong><span>${esc(mode)} · ${index + 1}/6</span></header><div class="device">${screenForwardPanel(controls, screen, title)}</div><div class="caption"><b>${index + 1}. ${esc(title)}</b><p>${esc(caption)}</p></div><div class="progress"></div></html>`;
}
const probe = (file) =>
  JSON.parse(
    execFileSync("ffprobe", ["-v", "quiet", "-show_format", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
    }),
  );
const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return `00:${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
export async function encodeLesson({
  lesson,
  frames,
  texts,
  work,
  out,
  music,
  narrationVoice = "Kokoro-82M · am_fenrir (synthetic English neural voice)",
  voiceSpeed = 1.02,
}) {
  assert.equal(frames.length, 6);
  const voices = [],
    durations = [],
    voiceLengths = [];
  const listening = music ? (lesson.id === "04-synth" ? 5 : 4) : -1;
  const listeningLength = lesson.listeningSeconds ?? 3.2;
  for (let i = 0; i < 6; i++) {
    const input = `${work}/voice-${i}.wav`,
      output = `${work}/padded-${i}.wav`;
    const length = Number(probe(input).format.duration);
    const duration = Math.ceil((length + 0.18 + (i === listening ? listeningLength : 0)) * 24) / 24;
    voiceLengths.push(length);
    durations.push(duration);
    voices.push(output);
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      input,
      "-af",
      `apad=whole_dur=${duration}`,
      "-t",
      String(duration),
      "-ar",
      "48000",
      "-ac",
      "1",
      output,
    ]);
  }
  const total = durations.reduce((a, b) => a + b, 0);
  assert.ok(total < 60, `${lesson.id} exceeds one minute: ${total}`);
  const voiceList = `${work}/voices.txt`,
    frameList = `${work}/frames.txt`;
  for (const file of [...voices, ...frames]) assert.ok(!/[\r\n']/.test(file));
  await writeFile(voiceList, voices.map((file) => `file '${file}'`).join("\n"));
  const voiceover = `${work}/voiceover.wav`;
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    voiceList,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=7",
    "-ar",
    "48000",
    voiceover,
  ]);
  await writeFile(
    frameList,
    frames.map((file, i) => `file '${file}'\nduration ${durations[i]}\n`).join("") +
      `file '${frames.at(-1)}'\n`,
  );
  const mp4 = `${out}/${lesson.id}.mp4`;
  let soundtrack = voiceover;
  let listeningWindow;
  if (music) {
    const start =
      durations.slice(0, listening).reduce((a, b) => a + b, 0) + voiceLengths[listening] + 0.1;
    const end = start + listeningLength - 0.15;
    listeningWindow = { start, end };
    // Materialize a bounded music bed before mixing. The video encoder then
    // reads one finite soundtrack, without an infinite input in its filter graph.
    const bed = `${work}/music-bed.wav`;
    execFileSync("ffmpeg", [
      "-y",
      "-nostdin",
      "-v",
      "error",
      "-stream_loop",
      "-1",
      "-i",
      music,
      "-t",
      String(total),
      "-af",
      `volume=0.5,adelay=${Math.round(start * 1000)}:all=1,afade=t=in:st=${start}:d=0.15,afade=t=out:st=${end - 0.2}:d=0.2`,
      "-ar",
      "48000",
      "-ac",
      "2",
      bed,
    ]);
    soundtrack = `${work}/soundtrack.wav`;
    execFileSync("ffmpeg", [
      "-y",
      "-nostdin",
      "-v",
      "error",
      "-i",
      voiceover,
      "-i",
      bed,
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.89:level=0[a]",
      "-map",
      "[a]",
      "-t",
      String(total),
      "-ar",
      "48000",
      soundtrack,
    ]);
  }
  const args = [
    "-y",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    frameList,
    "-i",
    soundtrack,
    "-map",
    "0:v",
    "-map",
    "1:a",
  ];
  args.push(
    "-t",
    String(total),
    "-vf",
    "fps=24,format=yuv420p",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "fast",
    "-crf",
    "21",
    "-tune",
    "stillimage",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    mp4,
  );
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      mp4,
      "-vf",
      "fps=12",
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "32",
      "-b:v",
      "0",
      "-deadline",
      "realtime",
      "-cpu-used",
      "6",
      "-row-mt",
      "1",
      "-threads",
      "2",
      "-c:a",
      "libopus",
      "-b:a",
      "96k",
      `${out}/${lesson.id}.webm`,
    ],
    { stdio: "inherit" },
  );
  let at = 0;
  const captions = texts.map((text, i) => {
    const start = at;
    at += durations[i];
    return `${stamp(start)} --> ${stamp(at)}\n${text}\n`;
  });
  await writeFile(`${out}/${lesson.id}.vtt`, `WEBVTT\n\n${captions.join("\n")}`);
  const result = probe(mp4),
    video = result.streams.find((s) => s.codec_type === "video");
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.ok(result.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Number(result.format.duration) < 60);
  const metadata = {
    id: lesson.id,
    duration: Number(result.format.duration),
    stepDurations: durations,
    voice: narrationVoice,
    voiceSpeed,
    layout: "one full device, 1152×720 screen, aligned physical controls",
    chassis: "charcoal black",
    narration: texts,
    hardwareUsed: false,
    nativeSimulation: false,
    sourceRevision: gitExec("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    identity,
    listeningWindow,
    sha256: createHash("sha256")
      .update(await readFile(mp4))
      .digest("hex"),
  };
  await writeFile(`${work}/verification.json`, JSON.stringify(metadata, null, 2));
  return metadata;
}
