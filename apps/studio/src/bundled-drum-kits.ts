import { drumKitFromWavs, validateDrumKit } from "../../../packages/core/src/drum-kits.ts";
import { drumMachineKit } from "../../../packages/core/src/drum-machines.ts";
import catalog from "../public/kits/catalog.json" with { type: "json" };

export const cc0Kits = catalog.kits;
/**
 * XMP's own kits: the 808 and 909 styles are synthesized in the browser; XMP
 * Velvet, multi-sampled (velocity layers of round-robin takes), is a kit file
 * written by native/src/velvet_kit.cpp (`npm run kits:velvet`) and fetched,
 * size and SHA-256 checked, when chosen.
 */
export const originalKits: readonly OriginalKit[] = [
  { id: "xmp-808", name: "XMP 808 style", style: "808" },
  { id: "xmp-909", name: "XMP 909 style", style: "909" },
  {
    id: "xmp-velvet",
    name: "XMP Velvet · multi-sampled",
    file: "kits/xmp/xmp-velvet.xmpkit",
    bytes: 5545162,
    sha256: "ea70e98491a1b6593ea2588b1e7e4deeed4530b7705cef84ffde96956af80e0f",
  },
];
export interface OriginalKit {
  id: string;
  name: string;
  style?: "808" | "909";
  file?: string;
  bytes?: number;
  sha256?: string;
}
export const isOriginalKit = (id: string) => originalKits.some((kit) => kit.id === id);

/** An original kit (generated or an XMP kit file) or a CC0 kit (downloaded and verified). */
export async function loadKitById(id: string, base = import.meta.env.BASE_URL) {
  const original = originalKits.find((kit) => kit.id === id);
  if (original?.style) return drumMachineKit(original.style);
  if (original?.file) return loadKitFile(original, base);
  return loadBundledDrumKit(id);
}
type FetchKitFile = (url: string) => Promise<Response>;

async function readAsset(response: Response, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body) {
    const path = response.url ? new URL(response.url).pathname : "";
    throw new Error(
      response.status === 404
        ? `Kit file missing on the server (HTTP 404)${path ? `: ${path}` : ""}`
        : `Kit sound unavailable (HTTP ${response.status || "no response"}); retry when online`,
    );
  }
  const declared = response.headers.get("content-length");
  if (declared && !response.headers.get("content-encoding") && Number(declared) !== expected)
    throw new Error("Kit sound size mismatch");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > expected) {
        await reader.cancel();
        throw new Error("Kit sound exceeds size budget");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expected) throw new Error("Kit sound truncated");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** One of XMP's kit files: drum-kit JSON, checked against its recorded size and hash. */
export async function loadKitFile(
  kit: OriginalKit,
  base = import.meta.env.BASE_URL,
  fetchFile: FetchKitFile = (url) =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) }),
) {
  if (!kit.file || !/^kits\/xmp\/[a-z0-9-]+\.xmpkit$/.test(kit.file) || !kit.bytes || !kit.sha256)
    throw new Error("Invalid kit asset descriptor");
  const bytes = await readAsset(await fetchFile(`${base}${kit.file}`), kit.bytes);
  if ((await sha256Hex(bytes)) !== kit.sha256)
    throw new Error("Kit sound integrity check failed; project unchanged");
  return validateDrumKit(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function loadBundledDrumKit(
  id: string,
  base = import.meta.env.BASE_URL,
  fetchFile: FetchKitFile = (url) =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) }),
) {
  const entry = cc0Kits.find((kit) => kit.id === id);
  if (entry?.license !== "CC0-1.0" || entry.files.length > 16) throw new Error("Unknown CC0 kit");
  const files = [];
  for (const file of entry.files) {
    if (
      !/^kits\/cc0\/[a-z0-9-]+\/[a-z0-9-]+\.wav$/.test(file.path) ||
      file.bytes < 44 ||
      file.bytes > 4 * 1024 * 1024
    )
      throw new Error("Invalid kit asset descriptor");
    const bytes = await readAsset(await fetchFile(`${base}${file.path}`), file.bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join(
      "",
    );
    if (hash !== file.sha256)
      throw new Error("Kit sound integrity check failed; project unchanged");
    files.push({ name: `${file.name}.wav`, bytes });
  }
  return drumKitFromWavs(entry.name, files);
}
