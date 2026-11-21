import "../../examples/track-machines/register.ts";
import { readdirSync } from "node:fs";
import { lstat, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { saveExport } from "../../packages/core/src/export-sink.ts";
import { MAX_SONG_BYTES } from "../../packages/core/src/input.ts";
import { openProject, openSongSnapshot, saveSong } from "../../packages/core/src/project-io.ts";
import { fileExportSink } from "../lib/export-sink.mjs";

// Host file transfer only. No device connection, pattern conversion or MIDI.
// Both directions use the same lossless song codec as the browser and Live.
async function boundedFile(path, optional = false, limit = MAX_SONG_BYTES) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
      throw new Error("Regular bounded song file required");
    return await readFile(path, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function readStickSong(path) {
  if (basename(path) === "pattern.txt")
    throw new Error("Legacy patterns must be migrated with their sounds by the native XMP session");
  const base = await boundedFile(path);
  const edits =
    basename(path) === "project.xmpsong"
      ? await boundedFile(join(dirname(path), "project.edits"), true, MAX_SONG_BYTES + 128)
      : "";
  return openSongSnapshot(base, edits);
}

async function writeSong(path, text) {
  const previous = await boundedFile(path, true);
  if (previous) await openProject(previous);
  await saveExport(fileExportSink(path, true), true, async () => new TextEncoder().encode(text));
}

export async function transferSong(command, song, target) {
  const file = resolve(target),
    local = resolve(song);
  if (!["to-stick", "from-stick"].includes(command) || file === local)
    throw new Error("Choose a transfer direction and distinct source/destination files");
  if (basename(file) === "pattern.txt")
    throw new Error("Use project.xmpsong; pattern.txt is a legacy import, never a song export");
  if (command === "from-stick") {
    const project = await readStickSong(file);
    await writeSong(local, await saveSong(project));
    return { ok: true, wrote: local, bpm: project.bpm };
  }
  const project = await openProject(await boundedFile(local));
  const text = await saveSong(project);
  if (basename(file) === "project.xmpsong" && (await boundedFile(file, true))) {
    const previous = await readStickSong(file);
    await writeSong(join(dirname(file), "project.previous.xmpsong"), await saveSong(previous));
  }
  await writeSong(file, text);
  if (basename(file) === "project.xmpsong") {
    try {
      await unlink(join(dirname(file), "project.edits"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { ok: true, wrote: file, bpm: project.bpm };
}

const stickFile = () => {
  const volumes = readdirSync("/Volumes").filter((v) => v === "XMP" || v === "XMPPROBE");
  if (volumes.length !== 1)
    throw new Error("Mount exactly one XMP stick (label XMP or XMPPROBE) on the Mac");
  return join("/Volumes", volumes[0], "xmp/project.xmpsong");
};

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const fileAt = args.indexOf("--file");
  if (fileAt >= 0 && (fileAt !== 2 || args.length !== 4))
    throw new Error("Expected --file <project.xmpsong>");
  const target = fileAt >= 0 ? resolve(args.splice(fileAt, 2)[1]) : null;
  const [command, song] = args;
  if (args.length !== 2 || !["to-stick", "from-stick"].includes(command))
    throw new Error(
      "Usage: npm run live:song -- to-stick <song.xmpsong> | from-stick <out.xmpsong> [--file project.xmpsong]",
    );
  console.log(JSON.stringify(await transferSong(command, song, target ?? stickFile()), null, 2));
}
