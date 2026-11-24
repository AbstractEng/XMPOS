import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// A manifest cannot include its own previous bytes. This also makes rebuilding
// a retained runtime tree safe: the ledger describes files after it is written.
export async function resourceHashes(directory) {
  const files = {};
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === "bundle-manifest.json") continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.isFile())
        files[path] = createHash("sha256")
          .update(await readFile(join(dir, entry.name)))
          .digest("hex");
    }
  }
  await walk(directory);
  return files;
}
