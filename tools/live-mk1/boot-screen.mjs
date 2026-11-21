import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";

// Original approved artwork, already encoded for the bounded init renderer.
// No image library or network access is needed by an image build or the Live.
export async function bootScreen() {
  const path = join(root, "os/live-mk1/assets/boot-screen.rgb");
  const metadata = JSON.parse(
    await readFile(join(root, "os/live-mk1/assets/boot-screen.json"), "utf8"),
  );
  const bytes = await readFile(path);
  if (
    bytes.length !== 3072016 ||
    bytes.length !== metadata.bytes ||
    bytes.subarray(0, 8).toString() !== "XMPBOOT1" ||
    bytes.readUInt32LE(8) !== 1280 ||
    bytes.readUInt32LE(12) !== 800 ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  )
    throw new Error("Boot screen differs from the approved Emerald Current asset");
  return { path, metadata };
}
