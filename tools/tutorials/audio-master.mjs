// Master complete narrated lessons with measured loudness and encoded true-peak checks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-threads", "1", ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || "Audio mastering failed");
  return result.stderr;
}
export function audioStats(file) {
  const stderr = ffmpeg([
    "-i",
    file,
    "-vn",
    "-af",
    "loudnorm=I=-16:TP=-3:LRA=11:print_format=json",
    "-f",
    "null",
    "-",
  ]);
  const stats = JSON.parse(stderr.slice(stderr.lastIndexOf("{")));
  assert.ok(
    Number.isFinite(Number(stats.input_i)) && Number.isFinite(Number(stats.input_tp)),
    "The lesson must contain audible narration",
  );
  return stats;
}
export function masterVideo(input, output) {
  const before = audioStats(input);
  const filter = `loudnorm=I=-16:TP=-3:LRA=11:measured_I=${before.input_i}:measured_TP=${before.input_tp}:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}:linear=true`;
  ffmpeg([
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    filter,
    "-ar",
    "48000",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    output,
  ]);
  const after = audioStats(output);
  assert.ok(Number(after.input_tp) <= -1, `Encoded true peak exceeds -1 dBTP: ${after.input_tp}`);
  assert.ok(
    Math.abs(Number(after.input_i) + 16) < 1,
    `Lesson loudness differs from -16 LUFS: ${after.input_i}`,
  );
  return {
    targetLufs: -16,
    maximumTruePeakDb: -1,
    before: { lufs: Number(before.input_i), truePeakDb: Number(before.input_tp) },
    after: { lufs: Number(after.input_i), truePeakDb: Number(after.input_tp) },
  };
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function main() {
  const root = resolve(import.meta.dirname, "../..");
  const hardware = process.argv.includes("--hardware"),
    apply = process.argv.includes("--apply");
  const work = resolve(
    root,
    "artifacts/tutorial-video-audit/normalized",
    hardware ? "hardware" : "course",
  );
  await mkdir(work, { recursive: true });
  const manifestPath = resolve(
    root,
    hardware
      ? "apps/studio/public/manual-media/hardware/videos.json"
      : "artifacts/tutorial-refresh/manifest.json",
  );
  const media = JSON.parse(await readFile(manifestPath, "utf8"));
  if (apply && !hardware)
    assert.equal(media.lessons.length, 16, "Finish every capture before promotion");
  for (const lesson of media.lessons) {
    const input = resolve(
      root,
      hardware ? "apps/studio/public/manual-media/hardware" : "artifacts/tutorial-refresh/drafts",
      `${lesson.id}.mp4`,
    );
    const output = resolve(work, `${lesson.id}.mp4`),
      receipt = resolve(work, `${lesson.id}.json`);
    const inputSha = sha(await readFile(input));
    let got;
    try {
      got = JSON.parse(await readFile(receipt, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!got || ![got.inputSha, got.outputSha].includes(inputSha)) {
      const levels = masterVideo(input, output);
      got = { inputSha, outputSha: sha(await readFile(output)), ...levels };
      await writeFile(receipt, JSON.stringify(got, null, 2));
    }
    if (apply) {
      assert.equal(sha(await readFile(output)), got.outputSha);
      await writeFile(input, await readFile(output));
      lesson.audioVerification = {
        targetLufs: got.targetLufs,
        maximumTruePeakDb: got.maximumTruePeakDb,
        ...got.after,
      };
      if (hardware) {
        lesson.sha256 = got.outputSha;
        ffmpeg([
          "-y",
          "-v",
          "error",
          "-i",
          input,
          "-c:v",
          "libvpx-vp9",
          "-threads",
          "2",
          "-row-mt",
          "1",
          "-deadline",
          "realtime",
          "-cpu-used",
          "8",
          "-crf",
          "36",
          "-b:v",
          "0",
          "-c:a",
          "libopus",
          "-b:a",
          "96k",
          input.replace(/\.mp4$/, ".webm"),
        ]);
      } else {
        lesson.videoSha256 = got.outputSha;
        await writeFile(input.replace(/\.mp4$/, ".json"), JSON.stringify(lesson, null, 2));
      }
    }
    console.log(
      `${lesson.id}: ${got.after.lufs} LUFS, ${got.after.truePeakDb} dBTP${apply ? " applied" : " prepared"}`,
    );
  }
  if (apply) await writeFile(manifestPath, JSON.stringify(media, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
