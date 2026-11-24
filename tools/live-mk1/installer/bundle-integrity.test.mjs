import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resourceHashes } from "./bundle-integrity.mjs";

test("rebuilding over a prior manifest produces a ledger that verifies after publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "xmp-bundle-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime/native.bin"), "unchanged reviewed runtime");
  await writeFile(join(root, "server.mjs"), "updated application");
  await writeFile(join(root, "bundle-manifest.json"), "previous manifest bytes");
  const files = await resourceHashes(root);
  assert.deepEqual(Object.keys(files).sort(), ["runtime/native.bin", "server.mjs"]);
  await writeFile(join(root, "bundle-manifest.json"), JSON.stringify({ files }));
  for (const [path, digest] of Object.entries(files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
      digest,
    );
  assert.deepEqual(await resourceHashes(root), files);
  await writeFile(join(root, "server.mjs"), "tampered application");
  assert.notEqual((await resourceHashes(root))["server.mjs"], files["server.mjs"]);
});
