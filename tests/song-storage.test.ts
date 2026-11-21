import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SongFiles } from "../apps/studio/src/song-files.ts";
import { saveSong } from "../packages/core/src/project-io.ts";
import { ProjectSession } from "../packages/core/src/session.ts";
import { extensibleProject } from "./project-extension-fixtures.ts";

afterEach(() => vi.unstubAllGlobals());
async function storage() {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  return import("../apps/studio/src/storage.ts");
}
describe("browser and emulator song storage", () => {
  it("uses the shared song for downloads, autosave and reload with unknown feature data intact", async () => {
    const store = await storage(),
      project = extensibleProject();
    const downloaded = await new SongFiles(new ProjectSession(project)).save();
    expect(downloaded).toBe(await saveSong(project));
    await store.saveProject(project);
    expect((await store.loadProjectState()).project).toEqual(project);
  });
  it("blocks autosave over an incompatible current snapshot even when a readable previous snapshot exists", async () => {
    const store = await storage(),
      project = extensibleProject();
    await store.saveProject(project);
    const awaitedSong = await saveSong(project);
    const future = JSON.stringify({ ...project, version: 9 });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xmp-studio-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite"),
        files = tx.objectStore("projects");
      files.put(awaitedSong, "previous");
      files.put(future, "autosave");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await expect(store.loadProjectState()).rejects.toThrow("Unsupported project version");
    await expect(store.saveProject(project)).rejects.toThrow("Saved files were retained");
  });
});
