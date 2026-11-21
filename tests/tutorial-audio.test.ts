import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Executable authoring source shared with tutorial publishing.
import { masterVideo } from "../tools/tutorials/audio-master.mjs";

it("masters an over-level soundtrack and verifies true peak after AAC encoding", () => {
  const dir = mkdtempSync(join(tmpdir(), "xmp-tutorial-audio-"));
  try {
    const input = join(dir, "source.mkv"),
      output = join(dir, "master.mp4");
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:r=24:d=4",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=1.25*sin(2*PI*440*t):s=48000:d=4",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "pcm_f32le",
      input,
    ]);
    const got = masterVideo(input, output);
    expect(got.before.truePeakDb).toBeGreaterThan(0);
    expect(got.after.truePeakDb).toBeLessThanOrEqual(-1);
    expect(Math.abs(got.after.lufs + 16)).toBeLessThan(1);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", output],
        { encoding: "utf8" },
      ),
    );
    expect(Number(probe.format.duration)).toBeCloseTo(4, 1);
    expect(
      probe.streams.find((s: { codec_type: string }) => s.codec_type === "video").codec_name,
    ).toBe("h264");
    expect(
      probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio").codec_name,
    ).toBe("aac");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
