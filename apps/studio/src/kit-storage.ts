import { type DrumKit, validateDrumKit } from "../../../packages/core/src/drum-kits.ts";

const DB = "xmp-drum-kits-v1";
export interface SavedKit {
  id: string;
  kit: DrumKit;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kits");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Kit storage is blocked by another tab"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
export async function loadKits(): Promise<SavedKit[]> {
  const db = await open();
  try {
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("kits", "readonly");
      const request = tx.objectStore("kits").getAll(undefined, 9);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Kit read interrupted"));
    });
    if (records.length > 8) throw new Error("Kit library exceeds eight kits");
    return records.map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(value.id) ||
        !("kit" in value)
      )
        throw new Error("Invalid saved kit; existing library retained");
      return { id: value.id, kit: validateDrumKit(value.kit) };
    });
  } finally {
    db.close();
  }
}
export async function saveKit(input: DrumKit): Promise<SavedKit> {
  const record = { id: crypto.randomUUID(), kit: validateDrumKit(input) },
    db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kits", "readwrite"),
        store = tx.objectStore("kits");
      let failure: Error | undefined;
      const count = store.count();
      count.onsuccess = () => {
        if (count.result >= 8) {
          failure = new Error("Library full: eight kits maximum");
          tx.abort();
        } else store.put(record, record.id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(failure ?? tx.error ?? new Error("Could not save kit"));
      tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("Could not save kit; project unchanged"));
    });
    return record;
  } finally {
    db.close();
  }
}
