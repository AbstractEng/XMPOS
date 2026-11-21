import {
  hashSample,
  MissingSongAssetsError,
  type SongAsset,
  type SongSample,
} from "../../../packages/core/src/assets.ts";
import { decodeSampleWav } from "../../../packages/core/src/edits.ts";
import type { Project } from "../../../packages/core/src/index.ts";
import { saveSong } from "../../../packages/core/src/project-io.ts";
import type { ProjectSession } from "../../../packages/core/src/session.ts";

async function assetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("xmp-song-assets-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("assets");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Sample library is blocked by another tab"));
  });
}
async function cached(hash: string): Promise<SongAsset | undefined> {
  const db = await assetDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("assets", "readonly"),
        request = tx.objectStore("assets").get(hash);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Sample library read interrupted"));
    });
  } finally {
    db.close();
  }
}
async function remember(assets: Map<string, SongAsset>) {
  const db = await assetDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite"),
        store = tx.objectStore("assets");
      for (const [hash, asset] of assets)
        store.put({ sampleRate: asset.sampleRate, pcm: Array.from(asset.pcm) }, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Sample library save interrupted"));
    });
  } finally {
    db.close();
  }
}
async function projectAssets(project: Project) {
  const assets = new Map<string, SongAsset>();
  for (const sample of project.samples)
    assets.set(await hashSample(sample.sampleRate, sample.pcm), sample);
  return assets;
}
export interface SongFileView {
  packageSamples: boolean;
  missing: readonly SongSample[];
}
export class SongFiles implements SongFileView {
  packageSamples = true;
  #pending: { text: string; revision: number; missing: SongSample[] } | undefined;
  readonly session: ProjectSession;
  constructor(session: ProjectSession) {
    this.session = session;
  }
  get missing(): readonly SongSample[] {
    return this.#pending?.missing ?? [];
  }
  async save(): Promise<string> {
    const project = this.session.project;
    const text = await saveSong(project, { packageSamples: this.packageSamples });
    const assets = await projectAssets(project);
    if (this.packageSamples) await remember(assets).catch(() => {});
    else {
      try {
        await remember(assets);
      } catch {
        throw new Error(
          "Could not retain the referenced samples locally. Keep Package samples checked and save again.",
        );
      }
    }
    return text;
  }
  async open(text: string) {
    const revision = this.session.revision,
      assets = await projectAssets(this.session.project);
    if (this.session.revision !== revision)
      throw new Error("Project changed during import; reopen the song");
    try {
      await this.session.open(text, {
        resolveAsset: async (sample) =>
          assets.get(sample.assetHash) ?? (await cached(sample.assetHash).catch(() => undefined)),
      });
      this.#pending = undefined;
      await remember(await projectAssets(this.session.project)).catch(() => {});
    } catch (error) {
      if (error instanceof MissingSongAssetsError)
        this.#pending = { text, revision, missing: error.missing };
      else this.#pending = undefined;
      throw error;
    }
  }
  async relink(files: readonly File[]) {
    const pending = this.#pending;
    if (!pending) throw new Error("Open a song with missing samples first");
    if (this.session.revision !== pending.revision) {
      this.#pending = undefined;
      throw new Error("Your project changed. Reopen the song before locating samples.");
    }
    if (!files.length || files.length > 16)
      throw new Error("Choose between one and sixteen WAV files");
    const matches = new Map<string, SongAsset>();
    let frames = 0;
    for (const file of files) {
      if (file.size > 16 * 1024 * 1024) throw new Error("WAV must be under 16 MiB");
      const sample = decodeSampleWav(new Uint8Array(await file.arrayBuffer()));
      frames += sample.pcm.length;
      if (frames > 1000000) throw new Error("Selected WAVs exceed one million frames");
      const hash = await hashSample(sample.sampleRate, sample.pcm);
      if (pending.missing.some((s) => s.assetHash === hash)) matches.set(hash, sample);
    }
    if (this.session.revision !== pending.revision)
      throw new Error("Your project changed. Reopen the song before locating samples.");
    if (!matches.size)
      throw new Error(
        "No matching sample content found. File names alone do not identify a sound; your song was not changed.",
      );
    await remember(matches);
    if (this.session.revision !== pending.revision)
      throw new Error("Your project changed. Reopen the song before locating samples.");
    await this.open(pending.text);
  }
}
