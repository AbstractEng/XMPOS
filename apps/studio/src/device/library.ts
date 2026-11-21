import { decodeSampleWav } from "../../../../packages/core/src/edits.ts";
import { cc0Kits } from "../bundled-drum-kits.ts";

export interface LibraryItem {
  id: string;
  name: string;
  folder: string;
  bytes: number;
  read(): Promise<Uint8Array>;
}
export class SampleLibrary {
  revision = 0;
  private local: LibraryItem[] = [];
  readonly bundled: LibraryItem[] = cc0Kits.flatMap((kit) =>
    kit.files.map((file, i) => ({
      id: `${kit.id}-${i}`,
      name: file.name,
      folder: kit.name,
      bytes: file.bytes,
      read: async () => {
        const response = await fetch(`${import.meta.env?.BASE_URL ?? "/"}${file.path}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("Library sound unavailable");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing sample data");
        const bytes = new Uint8Array(file.bytes);
        let at = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (at + value.length > bytes.length) {
              await reader.cancel();
              throw new Error("Sample exceeds catalog size");
            }
            bytes.set(value, at);
            at += value.length;
          }
        } finally {
          reader.releaseLock();
        }
        if (at !== bytes.length) throw new Error("Sample truncated");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        if (
          Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("") !==
          file.sha256
        )
          throw new Error("Sample integrity check failed");
        return bytes;
      },
    })),
  );
  get items() {
    return [...this.bundled, ...this.local];
  }
  addFolder(files: readonly Pick<File, "name" | "size" | "webkitRelativePath" | "arrayBuffer">[]) {
    if (files.length > 10000) throw new Error("Browser session limit: choose at most 10,000 files");
    const selected = files.filter((file) => /\.wav$/i.test(file.name));
    this.local = selected.map((file, i) => ({
      id: `folder-${i}`,
      name: file.name.replace(/\.wav$/i, ""),
      folder: file.webkitRelativePath?.split("/").slice(0, -1).join("/") || "Selected Mac folder",
      bytes: file.size,
      read: async () => {
        if (file.size > 4 * 1024 * 1024) throw new Error("Selected WAV exceeds 4 MiB");
        return new Uint8Array(await file.arrayBuffer());
      },
    }));
    this.revision++;
    return selected.length;
  }
  async decode(id: string) {
    const item = this.items.find((item) => item.id === id);
    if (!item) throw new Error("Sample no longer available");
    return { name: item.name, ...decodeSampleWav(await item.read()) };
  }
}
