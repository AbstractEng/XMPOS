import { createHash } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const FIRST_PROJECT = Object.freeze({
  name: "Acid Circuit",
  bytes: 6380577,
  sha256: "5b98138fcf7e4cf38cfc57edd7cf1ca72fee85de76c127e7755ec3727947de80",
  file: "demo/acid-circuit.xmpsong",
});
// A damaged save or an unfinished migration is still the owner's work.
const STARTUP_FILES = [
  "project.xmpsong",
  "project.xmp.json",
  "project.xmp",
  "pattern.txt",
  "project.edits",
  "project.previous.xmpsong",
  "project.xmpsong.new",
  "project.edits.new",
  "project.previous.xmpsong.new",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function readFirstProject(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== FIRST_PROJECT.bytes)
    throw Error("Verified bundled first-boot demo required");
  const bytes = await readFile(path);
  if (bytes.length !== FIRST_PROJECT.bytes || hash(bytes) !== FIRST_PROJECT.sha256)
    throw Error("Bundled first-boot demo hash mismatch");
  return bytes;
}
export async function seedFirstProject(xmp, bytes) {
  if (bytes.length !== FIRST_PROJECT.bytes || hash(bytes) !== FIRST_PROJECT.sha256)
    throw Error("Verified bundled first-boot demo required");
  for (const name of STARTUP_FILES) {
    try {
      await lstat(join(xmp, name));
      return {
        status: "preserved",
        name: FIRST_PROJECT.name,
        reason: "Existing startup or recovery files",
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const target = join(xmp, "project.xmpsong");
  let file;
  try {
    // Exclusive creation works on FAT32 and cannot overwrite a saved project.
    file = await open(target, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      return {
        status: "preserved",
        name: FIRST_PROJECT.name,
        reason: "Startup project appeared during preparation",
      };
    throw error;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
    if (hash(await readFile(target)) !== FIRST_PROJECT.sha256)
      throw Error("First-boot demo readback verification failed");
  } catch (error) {
    // Only remove the file this operation created, never a replacement.
    const owned = await file.stat();
    const current = await lstat(target).catch(() => null);
    if (owned.ino !== 0 && current?.ino === owned.ino && current?.dev === owned.dev)
      await unlink(target);
    throw error;
  } finally {
    await file.close();
  }
  return { status: "installed", name: FIRST_PROJECT.name, sha256: FIRST_PROJECT.sha256 };
}
