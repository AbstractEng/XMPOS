import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAz01 } from "../tools/live-mk1/az01-image.mjs";
import { prepareVerifiedStock } from "../tools/live-mk1/stock-image.mjs";

let directory: string;
let image: string;
const original = Buffer.alloc(8192, 0x43);
original.writeUInt16LE(0xef53, 1080);
beforeEach(() => {
  mkdirSync("build", { recursive: true });
  directory = mkdtempSync(resolve("build/r01-stock-"));
  image = join(directory, "Update.img");
  const result = spawnSync(
    "python3",
    ["-I", "-c", "import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read()))"],
    { input: original },
  );
  if (result.status !== 0) throw new Error(String(result.stderr));
  writeFileSync(image, buildAz01("SYNTHETIC", ["inmusic,acv8"], result.stdout));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("owner-local stock recovery extraction", () => {
  it("derives exact original bytes and revalidates an existing cache on every call", async () => {
    const first = await prepareVerifiedStock(image, directory);
    expect(readFileSync(first.image)).toEqual(original);
    expect(first.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(first.receipt.redistribution).toContain("forbidden");
    expect((await prepareVerifiedStock(image, directory)).image).toBe(first.image);
    writeFileSync(first.image, Buffer.alloc(original.length, 0x5a));
    await expect(prepareVerifiedStock(image, directory)).rejects.toThrow(
      /Cached stock rootfs differs/,
    );
    expect(readFileSync(first.image)).toEqual(Buffer.alloc(original.length, 0x5a));
  });
  it("bounds decompression and refuses a tampered compressed payload", async () => {
    await expect(prepareVerifiedStock(image, directory, { maxBytes: 4096 })).rejects.toThrow(
      /bound/,
    );
    const bytes = readFileSync(image);
    bytes[bytes.length - 12] = (bytes[bytes.length - 12] ?? 0) ^ 1;
    writeFileSync(image, bytes);
    await expect(prepareVerifiedStock(image, directory)).rejects.toThrow(/verified Live Mk1/);
  });
  it("refuses a wrong-model container before extracting", async () => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read()))",
      ],
      { input: original },
    );
    writeFileSync(image, buildAz01("SYNTHETIC", ["inmusic,ada2"], result.stdout));
    await expect(prepareVerifiedStock(image, directory)).rejects.toThrow(/Live Mk1/);
  });
});
