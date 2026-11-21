import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateUsbVolume, writeUsbImage } from "./usb.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xmp-usb-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mountPoint = join(root, "key");
  await mkdir(join(mountPoint, "xmp"), { recursive: true });
  const source = join(root, "source.img"),
    data = Buffer.alloc(1024 * 1024 + 27, 42);
  await writeFile(source, data);
  const volume = {
    mountPoint,
    external: true,
    removable: true,
    bus: "USB",
    filesystem: "fat32",
    model: "test key",
    deviceKey: "test-key",
    usbVendorId: 0xdead,
    freeBytes: 1024 ** 3,
  };
  return {
    root,
    source,
    data,
    volume,
    options: { volume, source, expectedSha256: hash(data), inspect: async () => volume },
  };
}
test("USB transaction preserves projects, token and both prior images; readback and progress verify the new image", async (t) => {
  const f = await fixture(t),
    xmp = join(f.volume.mountPoint, "xmp");
  for (const [n, b] of [
    ["system.img", "old"],
    ["system.img.previous", "older"],
    ["token", "owner-token"],
    ["project.xmp", "music"],
  ])
    await writeFile(join(xmp, n), b);
  const progress = [];
  const r = await writeUsbImage({ ...f.options, progress: (p) => progress.push(p) });
  assert.equal(r.sha256, hash(f.data));
  assert.deepEqual(await readFile(join(xmp, "system.img")), f.data);
  assert.equal(await readFile(join(xmp, "system.img.previous"), "utf8"), "old");
  assert.equal(await readFile(join(xmp, "project.xmp"), "utf8"), "music");
  assert.equal(await readFile(join(xmp, "token"), "utf8"), "owner-token");
  const backup = await readdir(join(xmp, ".installer-backups"));
  assert.equal(backup.length, 2);
  assert.deepEqual(
    (
      await Promise.all(backup.map((n) => readFile(join(xmp, ".installer-backups", n), "utf8")))
    ).sort(),
    ["old", "older"],
  );
  assert.equal(progress.at(-1).current, f.data.length);
  assert.equal(r.safelyEjectBeforeUse, true);
});
test("rejects internal/Force volumes and a changed device before promotion", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { external: false },
    { removable: false },
    { bus: "SATA" },
    { usbVendorId: undefined },
    { usbVendorId: 0x09e8 },
    { filesystem: "apfs" },
    { model: "Akai Force" },
    { model: "inMusic ACV8" },
  ])
    assert.throws(() => validateUsbVolume({ ...f.volume, ...change }));
  await writeFile(join(f.volume.mountPoint, "xmp/system.img"), "preserve");
  let n = 0;
  await assert.rejects(
    writeUsbImage({
      ...f.options,
      inspect: async () => ({ ...f.volume, deviceKey: ++n > 1 ? "other" : f.volume.deviceKey }),
    }),
    /changed before/,
  );
  assert.equal(await readFile(join(f.volume.mountPoint, "xmp/system.img"), "utf8"), "preserve");
  assert.equal(
    (await readdir(join(f.volume.mountPoint, "xmp"))).some((n) => n.endsWith(".new")),
    false,
  );
});
test("rejects insufficient backup space and altered source before writing an image", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.volume.mountPoint, "xmp/system.img"), Buffer.alloc(5 * 1024 ** 2));
  await writeFile(
    join(f.volume.mountPoint, "xmp/system.img.previous"),
    Buffer.alloc(6 * 1024 ** 2),
  );
  await assert.rejects(
    writeUsbImage({
      ...f.options,
      inspect: async () => ({ ...f.volume, freeBytes: 15 * 1024 ** 2 }),
    }),
    /more free space/,
  );
  await assert.rejects(
    writeUsbImage({ ...f.options, expectedSha256: "0".repeat(64) }),
    /Verified XMP/,
  );
  assert.deepEqual(await readdir(join(f.volume.mountPoint, "xmp/.installer-backups")), []);
});
test("rejects redirected XMP directories", async (t) => {
  if (process.platform === "win32")
    return t.skip("Symlink creation requires extra host privilege on Windows");
  const f = await fixture(t);
  await rm(join(f.volume.mountPoint, "xmp"), { recursive: true });
  await symlink(f.root, join(f.volume.mountPoint, "xmp"));
  await assert.rejects(writeUsbImage(f.options), /Symlink/);
});
