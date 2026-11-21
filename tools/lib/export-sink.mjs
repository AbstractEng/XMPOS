import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
// A sibling temporary file keeps the final commit on the same filesystem.
export function fileExportSink(destination, overwrite = false) {
  const temporary = join(dirname(destination), `.xmp-export-${randomUUID()}.partial`);
  let staged;
  return {
    async exists() {
      try {
        await lstat(destination);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    async stage(bytes) {
      staged = await open(temporary, "wx", 0o600);
      await staged.writeFile(bytes);
    },
    async append(bytes) {
      if (!staged) throw new Error("Export was not staged");
      await staged.writeFile(bytes);
    },
    async commit() {
      if (!staged) throw new Error("Export was not staged");
      await staged.sync();
      await staged.close();
      staged = undefined;
      if (overwrite) await rename(temporary, destination);
      else {
        await link(temporary, destination);
        await unlink(temporary);
      }
    },
    async abort() {
      if (staged) {
        await staged.close();
        staged = undefined;
      }
      try {
        await unlink(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
}
