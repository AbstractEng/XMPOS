// The rear button is outside the front teaching drawing. A labelled button
// callout lights whenever a hardware lesson asks the owner to operate it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const dir = resolve(root, "apps/studio/public/manual-media/hardware");
const work = resolve(root, "artifacts/tutorial-refresh");
const data = JSON.parse(await readFile(`${dir}/videos.json`, "utf8"));
for (const [id, steps] of [
  ["16-hardware-boot", [0, 5]],
  ["17-hardware-return", [0, 1, 2, 5]],
]) {
  const lesson = data.lessons.find((l) => l.id === id);
  let time = 0;
  const windows = [];
  for (const [i, duration] of lesson.stepDurations.entries()) {
    if (steps.includes(i)) windows.push(`between(t,${time},${time + duration})`);
    time += duration;
  }
  const enable = windows.join("+");
  const font = `${root}/brand/abstract-engineering/assets/fonts/Manrope-SemiBold.ttf`;
  const filter = `drawbox=x=1578:y=10:w=342:h=45:color=0x202221:t=fill:enable='${enable}',drawbox=x=1578:y=10:w=342:h=45:color=0xE6C779:t=3:enable='${enable}',drawtext=fontfile='${font}':text='REAR POWER':x=1674:y=18:fontsize=23:fontcolor=white:enable='${enable}'`;
  const target = `${work}/${id}-power.mp4`;
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    `${dir}/${id}.mp4`,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    target,
  ]);
  await rename(target, `${dir}/${id}.mp4`);
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    `${dir}/${id}.mp4`,
    "-c:v",
    "libvpx-vp9",
    "-threads",
    "2",
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
    `${dir}/${id}.webm`,
  ]);
  lesson.sha256 = createHash("sha256")
    .update(await readFile(`${dir}/${id}.mp4`))
    .digest("hex");
  lesson.rearPowerHighlightedSteps = steps.map((n) => n + 1);
  console.log(`Highlighted rear POWER: ${id}`);
}
await writeFile(`${dir}/videos.json`, JSON.stringify(data, null, 2));
