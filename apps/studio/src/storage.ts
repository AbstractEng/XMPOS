import type { Project } from "@xmp/core";
import { UnsupportedSongError } from "../../../packages/core/src/project-errors.ts";
// Autosaves are songs with their samples packaged, written and opened by the
// C++ core (WebAssembly); older autosaves (version 1 bundles) still open.
import { openProject, saveSong } from "../../../packages/core/src/project-io.ts";

const DB = "xmp-studio-v1";
let observed = false;
let lastObserved: string | undefined;
let validatedPrevious: string | undefined;
let writeBlocked: string | undefined;
export async function saveProject(project: Project): Promise<void> {
  await saveProjectText(await saveSong(project));
}

export async function saveProjectText(text: string): Promise<void> {
  if (!observed) await loadProjectState();
  if (writeBlocked) throw new Error(writeBlocked);
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      const store = tx.objectStore("projects");
      let failure: Error | undefined;
      const request = store.get("autosave");
      request.onsuccess = () => {
        try {
          const current = typeof request.result === "string" ? request.result : undefined;
          if (current !== lastObserved) {
            failure = new Error(
              "Another tab changed this project. Download your edits, then reload before saving.",
            );
            tx.abort();
            return;
          }
          if (validatedPrevious) store.put(validatedPrevious, "previous");
          store.put(text, "autosave");
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Storage write failed");
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        observed = true;
        lastObserved = text;
        validatedPrevious = text;
        resolve();
      };
      tx.onerror = () => reject(failure ?? tx.error ?? new Error("Project storage failed"));
      tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("Save interrupted; previous project retained"));
    });
  } finally {
    db.close();
  }
}
export async function loadProjectState(): Promise<{ project?: Project; recovered: boolean }> {
  writeBlocked = undefined;
  const db = await open();
  let current: unknown, previous: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const store = tx.objectStore("projects");
      store.get("autosave").onsuccess = (event) => {
        current = (event.target as IDBRequest).result;
      };
      store.get("previous").onsuccess = (event) => {
        previous = (event.target as IDBRequest).result;
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Read interrupted"));
    });
  } finally {
    db.close();
  }
  observed = true;
  lastObserved = typeof current === "string" ? current : undefined;
  for (const [text, recovered] of [
    [current, false],
    [previous, true],
  ] as const) {
    if (typeof text !== "string") continue;
    try {
      const project = await openProject(text);
      validatedPrevious = text;
      return { project, recovered };
    } catch (error) {
      if (error instanceof UnsupportedSongError) {
        writeBlocked = `${error.message}. Saved files were retained; open them in a supporting XMP build.`;
        throw error;
      }
    }
  }
  if (current !== undefined || previous !== undefined)
    throw new Error(
      "No valid project snapshot. Existing storage was retained; use a portable backup.",
    );
  return { recovered: false };
}
export async function loadProject(): Promise<Project | undefined> {
  return (await loadProjectState()).project;
}
export async function loadProjectText(): Promise<string | undefined> {
  await loadProjectState();
  return validatedPrevious;
}

export async function loadProjectCopies(): Promise<{ name: string; text: string }[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const result: { name: string; text: string }[] = [];
      const cursor = tx
        .objectStore("projects")
        .openCursor(IDBKeyRange.bound("copy:", "copy:\uffff"));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        result.push(row.value);
        row.continue();
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("Project library read interrupted"));
    });
  } finally {
    db.close();
  }
}

export async function saveProjectCopy(name: string, text: string): Promise<boolean> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      const store = tx.objectStore("projects");
      const request = store.add({ name, text }, `copy:${name.toLowerCase()}`);
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => {
        if (request.error?.name === "ConstraintError") resolve(false);
        else reject(tx.error ?? new Error("Project library write interrupted"));
      };
    });
  } finally {
    db.close();
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Storage is blocked by another tab"));
  });
}
