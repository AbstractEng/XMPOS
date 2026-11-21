import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { exportPortable, importPortable } from "../../packages/core/src/assets.ts";
import { ownedScenarioDirectory } from "./workspace.mjs";
// This port is used only with owned Mac scenario directories, never device paths.
export class LocalProjectStore {
  constructor(workspace) {
    ownedScenarioDirectory(workspace.directory);
    this.workspace = workspace;
  }
  async load() {
    for (const name of ["committed.xmp.json", "previous.xmp.json"]) {
      const path = this.workspace.path(name);
      if (!existsSync(path)) continue;
      try {
        return {
          project: await importPortable(readFileSync(path, "utf8")),
          recovered: name === "previous.xmp.json",
        };
      } catch {}
    }
    if (existsSync(this.workspace.path("committed.xmp.json")))
      throw new Error(
        "No validated committed or previous project; keep the original files for recovery",
      );
    return undefined;
  }
  async prepare(project) {
    const text = await exportPortable(project);
    const path = this.workspace.path("pending.xmp.json");
    if (existsSync(path)) unlinkSync(path);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  async commit() {
    const staged = this.workspace.path("pending.xmp.json");
    await importPortable(readFileSync(staged, "utf8"));
    const current = this.workspace.path("committed.xmp.json");
    if (existsSync(current)) {
      const text = readFileSync(current, "utf8");
      await importPortable(text);
      const previous = this.workspace.path("previous.tmp");
      const fd = openSync(previous, "w", 0o600);
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(previous, this.workspace.path("previous.xmp.json"));
    }
    renameSync(staged, current);
    const directory = openSync(this.workspace.directory, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  async save(project) {
    await this.prepare(project);
    await this.commit();
  }
}
