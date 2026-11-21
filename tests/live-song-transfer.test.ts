import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProject, openSongSnapshot, saveSong } from "../packages/core/src/project-io.ts";
// @ts-expect-error Executable host file adapter.
import { readStickSong, transferSong } from "../tools/live-mk1/song-convert.mjs";
import { extensibleProject } from "./project-extension-fixtures.ts";

function snapshotEdits(base: string, changes: string) {
  let h = 1469598103934665603n;
  for (const byte of Buffer.from(base)) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 1099511628211n);
  return `xmp-edits 1 ${Buffer.byteLength(base)}-${h.toString(16).padStart(16, "0")}\n${changes}`;
}
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
describe("lossless songs between the browser, emulator and native Live", () => {
  it("transfers the whole song and exports the latest native autosave without losing future data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xmp-song-transfer-"));
    directories.push(dir);
    const input = join(dir, "input.xmpsong"),
      target = join(dir, "project.xmpsong"),
      output = join(dir, "output.xmpsong");
    const project = extensibleProject(),
      base = await saveSong(project);
    await writeFile(input, base);
    await transferSong("to-stick", input, target);
    expect(await readFile(target, "utf8")).toBe(base);
    const later = structuredClone(project);
    later.name = "Latest native autosave";
    const edits = snapshotEdits(base, await saveSong(later, { packageSamples: false }));
    await writeFile(join(dir, "project.edits"), edits);
    expect(await readStickSong(target)).toEqual(later);
    expect(await openSongSnapshot(base, edits)).toEqual(later);
    await transferSong("from-stick", output, target);
    expect(await openProject(await readFile(output, "utf8"))).toEqual(later);
    await transferSong("to-stick", input, target);
    expect(
      await openProject(await readFile(join(dir, "project.previous.xmpsong"), "utf8")),
    ).toEqual(later);
    expect(await readStickSong(target)).toEqual(project);
  });
  it("refuses a newer incompatible autosave and leaves the current song untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xmp-song-future-"));
    directories.push(dir);
    const project = extensibleProject(),
      base = await saveSong(project);
    const future = JSON.stringify({ ...project, version: 9 });
    const edits = snapshotEdits(base, future);
    await writeFile(join(dir, "project.xmpsong"), base);
    await writeFile(join(dir, "project.edits"), edits);
    await expect(readStickSong(join(dir, "project.xmpsong"))).rejects.toThrow(
      "Unsupported project version",
    );
    expect(await readFile(join(dir, "project.xmpsong"), "utf8")).toBe(base);
    await expect(openSongSnapshot(base, "xmp-edits 2 unknown\n{}")).rejects.toThrow(
      "Unsupported song edits version",
    );
    await expect(
      transferSong("to-stick", join(dir, "in.xmpsong"), join(dir, "pattern.txt")),
    ).rejects.toThrow("legacy import");
  });
});
