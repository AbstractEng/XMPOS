import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requirePreparationSpace,
  reusableHostLoader,
} from "../tools/live-mk1/loader-preparation.mjs";

let root: string;
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const expected = {
  updaterSha256: "a".repeat(64),
  stockSha256: "b".repeat(64),
  initSha256: "c".repeat(64),
  toolsSha256: "d".repeat(64),
  stockBytes: 8,
  files: {
    "boot.cmd": Buffer.from("cmd"),
    "boot.scr.uimg": Buffer.from("boot"),
    "probe.cpio.gz": Buffer.from("cpio"),
  },
};
function fixture() {
  const directory = join(root, "artifacts/live-mk1/loader-host-test");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(root, "artifacts/live-mk1/latest-loader-image.json"),
    JSON.stringify({ directory: "artifacts/live-mk1/loader-host-test" }),
  );
  for (const [name, b] of Object.entries(expected.files)) writeFileSync(join(directory, name), b);
  writeFileSync(join(directory, "rootfs.ext4"), "12345678");
  const manifest = {
    format: "xmp-live-mk1-loader-image",
    version: 6,
    source: { imageSha256: expected.updaterSha256, originalRootfsSha256: expected.stockSha256 },
    loader: { initSha256: expected.initSha256 },
    builder: { sourceSha256: expected.toolsSha256 },
    ubootInodes: { allInGroup0: true },
    changes: { changed: ["boot/boot.scr.uimg"], added: [], removed: [] },
    output: { file: "rootfs.ext4", sha256: hash("12345678") },
  };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xmp-preparation-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("bounded loader preparation", () => {
  it("fails before an allocation with a useful free-space message", async () => {
    await expect(
      requirePreparationSpace(root, 1024 ** 3, async () => ({ bavail: 100, bsize: 4096 })),
    ).rejects.toThrow(
      /Free at least 1024 MiB here; 0 MiB is available.*recovery image are preserved/,
    );
  });
  it("accepts adequate real available space without reserving a file", async () => {
    expect(
      await requirePreparationSpace(root, 100, async () => ({ bavail: 100n, bsize: 4096n })),
    ).toBe(409600);
  });
  it("reuses the verified loader only when actual image, payload and boot inputs match", async () => {
    const f = fixture();
    expect((await reusableHostLoader(root, expected))?.directory).toBe(f.directory);
    writeFileSync(join(f.directory, "rootfs.ext4"), "tampered");
    expect(await reusableHostLoader(root, expected)).toBeNull();
  });
  it("rejects changed compiler output, updater, tools or boot script", async () => {
    fixture();
    for (const changed of [
      { initSha256: "0".repeat(64) },
      { updaterSha256: "0".repeat(64) },
      { toolsSha256: "0".repeat(64) },
      { files: { ...expected.files, "boot.cmd": Buffer.from("changed") } },
    ])
      expect(await reusableHostLoader(root, { ...expected, ...changed })).toBeNull();
  });
  it("treats incomplete or escaped candidates as unusable without overwriting them", async () => {
    fixture();
    writeFileSync(
      join(root, "artifacts/live-mk1/latest-loader-image.json"),
      JSON.stringify({ directory: "../../outside" }),
    );
    expect(await reusableHostLoader(root, expected)).toBeNull();
  });
});
