import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project } from "../../packages/core/src/index.ts";
import { MAX_SONG_BYTES } from "../../packages/core/src/input.ts";
import { UnsupportedSongError } from "../../packages/core/src/project-errors.ts";
import { openProject, saveSong } from "../../packages/core/src/project-io.ts";

const maxBytes = MAX_SONG_BYTES;
const names = [
  "project.xmp.json",
  "project.xmp.json.previous",
  "project.xmp.json.pending",
  "project.xmp.json.previous.pending",
] as const;
export const savePoints = [
  "pending-fsynced",
  "backup-fsynced",
  "primary-renamed",
  "directory-fsynced",
] as const;
export type SavePoint = (typeof savePoints)[number];
const hash = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function syncFile(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export class ProjectJournal {
  private readonly cache = new Map<string, { projectJSON: string; assets: string[] } | null>();
  private remember(hash: string, value: { projectJSON: string; assets: string[] } | null) {
    this.cache.delete(hash);
    this.cache.set(hash, value);
    while (this.cache.size > 3) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  private read(name: (typeof names)[number]) {
    const path = join(this.directory, name);
    if (!present(path)) return null;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
      throw new Error("Invalid bounded project candidate");
    return readFileSync(path);
  }
  private write(name: (typeof names)[number], text: string) {
    const path = join(this.directory, name);
    if (present(path) && !lstatSync(path).isFile())
      throw new Error("Regular journal file required");
    writeFileSync(path, text, { mode: 0o600 });
    syncFile(path);
  }
  async inspect() {
    const candidates = [];
    let compatibilityError: string | undefined;
    let project: Project | null = null,
      selected: string | null = null;
    for (const [index, name] of names.entries()) {
      let bytes: Buffer | null = null,
        valid = false,
        assets: string[] = [];
      try {
        bytes = this.read(name);
        if (bytes && index < 2) {
          const digest = hash(bytes);
          let cached = this.cache.get(digest);
          if (!this.cache.has(digest)) {
            try {
              const parsed = await openProject(bytes.toString("utf8")),
                envelope = JSON.parse(bytes.toString("utf8"));
              const bundle =
                envelope.format === "xmp-bundle" ? envelope : JSON.parse(await saveSong(parsed));
              cached = {
                projectJSON: JSON.stringify(parsed),
                assets: bundle.assets.map((asset: { hash: string }) => asset.hash),
              };
              this.remember(digest, cached);
            } catch (error) {
              if (error instanceof UnsupportedSongError) throw error;
              this.remember(digest, null);
              cached = null;
            }
          }
          if (cached) {
            assets = [...cached.assets];
            valid = true;
            if (!project) {
              project = JSON.parse(cached.projectJSON);
              selected = name;
            }
          }
        }
      } catch (error) {
        if (error instanceof UnsupportedSongError) compatibilityError = error.message;
        /* Preserve invalid bytes; never substitute an empty project. */
      }
      candidates.push({
        role: name,
        exists: present(join(this.directory, name)),
        valid,
        sha256: bytes ? hash(bytes) : null,
        bytes: bytes?.length ?? null,
        assets,
      });
    }
    const empty = candidates.every((c) => !c.exists);
    if (compatibilityError) {
      project = null;
      selected = null;
    }
    return {
      project,
      report: {
        selected,
        empty,
        recoveryRequired: !empty && !project,
        readOnly: !empty && selected !== names[0],
        candidates,
        ...(compatibilityError ? { compatibilityError } : {}),
      },
    };
  }
  async commit(
    project: Project,
    checkpoint?: (
      point: SavePoint,
      receipt: { candidateHash: string; previousHash: string | null },
    ) => Promise<void>,
  ) {
    const before = await this.inspect();
    if (before.report.readOnly)
      throw new Error("Recovery candidates preserved; export before replacing saved work");
    const text = await saveSong(project);
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Project exceeds journal budget");
    const previous = this.read(names[0]);
    const receipt = { candidateHash: hash(text), previousHash: previous ? hash(previous) : null };
    this.remember(receipt.candidateHash, {
      projectJSON: JSON.stringify(project),
      assets: JSON.parse(text).assets.map((asset: { hash: string }) => asset.hash),
    });
    this.write(names[2], text);
    await checkpoint?.("pending-fsynced", receipt);
    if (previous) {
      this.write(names[3], previous.toString("utf8"));
      renameSync(join(this.directory, names[3]), join(this.directory, names[1]));
      syncFile(this.directory);
    }
    await checkpoint?.("backup-fsynced", receipt);
    renameSync(join(this.directory, names[2]), join(this.directory, names[0]));
    await checkpoint?.("primary-renamed", receipt);
    syncFile(this.directory);
    await checkpoint?.("directory-fsynced", receipt);
    return receipt.candidateHash;
  }
  exportRecovery() {
    let total = 0;
    const files = names.flatMap((role) => {
      const bytes = this.read(role);
      if (!bytes) return [];
      total += bytes.length;
      if (total > maxBytes) throw new Error("Recovery export exceeds budget");
      return [{ role, sha256: hash(bytes), bytes: bytes.length, base64: bytes.toString("base64") }];
    });
    const text = JSON.stringify({ format: "xmp-recovery-export", version: 1, files });
    const path = join(this.directory, "recovery-export.json");
    if (present(path) && !lstatSync(path).isFile())
      throw new Error("Regular recovery export required");
    writeFileSync(path, text, { mode: 0o600 });
    syncFile(path);
    syncFile(this.directory);
    return {
      written: true,
      sha256: hash(text),
      files: files.map(({ base64: _base64, ...metadata }) => metadata),
      privateProjectDataIncluded: true,
    };
  }
  corruptFixture(all: boolean) {
    this.write(names[0], "XMP ORIGINAL INVALID PRIMARY FIXTURE\n");
    if (all) this.write(names[1], "XMP ORIGINAL INVALID PREVIOUS FIXTURE\n");
    syncFile(this.directory);
  }
}
