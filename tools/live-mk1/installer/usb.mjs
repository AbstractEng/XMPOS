import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
export function validateUsbVolume(v) {
  if (
    !v ||
    v.external !== true ||
    v.removable !== true ||
    v.bus !== "USB" ||
    v.filesystem?.toLowerCase() !== "fat32" ||
    !Number.isInteger(v.usbVendorId) ||
    v.usbVendorId < 1 ||
    v.usbVendorId > 65535 ||
    v.usbVendorId === 0x09e8 ||
    !v.mountPoint ||
    !v.deviceKey ||
    /force|ada2|akai|inmusic/i.test(v.model ?? "")
  )
    throw new Error(
      "Choose an external removable FAT32 USB key; MPC/Force storage and internal disks are refused",
    );
  return v;
}
const sha = (path) =>
  new Promise((done, fail) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (b) => h.update(b))
      .on("error", fail)
      .on("end", () => done(h.digest("hex")));
  });
async function syncDir(path) {
  let d;
  try {
    d = await open(path, "r");
    await d.sync();
    return true;
  } catch (e) {
    if (process.platform === "win32" && ["EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(e.code))
      return false;
    throw e;
  } finally {
    await d?.close();
  }
}
async function regular(path) {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 64 * 1024 ** 2)
      throw Error("Expected a bounded regular XMP image");
    return s;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function durableCopy(source, target, onProgress = () => {}) {
  const input = await open(source, "r");
  let out;
  try {
    out = await open(target, "wx", 0o600);
    const buffer = Buffer.alloc(1024 ** 2);
    let at = 0;
    const total = (await input.stat()).size;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, at);
      if (!bytesRead) break;
      let offset = 0;
      while (offset < bytesRead) {
        const r = await out.write(buffer, offset, bytesRead - offset, at + offset);
        if (!r.bytesWritten) throw Error("USB write stopped");
        offset += r.bytesWritten;
      }
      at += bytesRead;
      onProgress({ current: at, total });
    }
    await out.sync();
    if ((await sha(source)) !== (await sha(target))) throw Error("USB copy verification failed");
  } catch (e) {
    if (out) {
      await out.close();
      out = null;
      await unlink(target).catch(() => {});
    }
    throw e;
  } finally {
    await input.close();
    await out?.close();
  }
}
// All device selection is passive host metadata. This function writes ordinary
// files only after revalidating the same selected removable volume.
export async function writeUsbImage({
  volume,
  source,
  expectedSha256,
  inspect,
  progress = () => {},
  prepareToken = async () => {},
  profile = null,
}) {
  validateUsbVolume(volume);
  const current = validateUsbVolume(await inspect(volume.mountPoint));
  if (current.deviceKey !== volume.deviceKey)
    throw Error("The selected USB key changed; select it again");
  const input = await regular(source);
  if (!input || (await sha(source)) !== expectedSha256)
    throw Error("Verified XMP system image required");
  if ((await realpath(current.mountPoint)) !== resolve(current.mountPoint))
    throw Error("Regular USB mount root required");
  const xmp = join(current.mountPoint, "xmp");
  await mkdir(xmp, { recursive: true });
  if ((await lstat(xmp)).isSymbolicLink()) throw Error("Symlink XMP folder refused");
  const active = join(xmp, "system.img"),
    previous = join(xmp, "system.img.previous");
  const id =
    new Date().toISOString().replaceAll(/[:.]/g, "-") + "-" + randomBytes(4).toString("hex");
  const backups = join(xmp, ".installer-backups");
  await mkdir(backups, { recursive: true });
  if ((await lstat(backups)).isSymbolicLink()) throw Error("Symlink backup folder refused");
  const old = await regular(active),
    older = await regular(previous);
  const required = input.size + (old?.size ?? 0) * 2 + (older?.size ?? 0) + 4 * 1024 ** 2;
  if (!Number.isSafeInteger(current.freeBytes) || current.freeBytes < required)
    throw Error("The USB key needs more free space for the image and preserved backups");
  for (const [file, label, info] of [
    [active, "active", old],
    [previous, "previous", older],
  ])
    if (info) await durableCopy(file, join(backups, `${id}-${label}.img`));
  const temp = join(xmp, `system.img.${id}.new`);
  const pending = new Set([temp]);
  try {
    await durableCopy(source, temp, progress);
    await prepareToken(current.mountPoint);
    if (profile) {
      const dir = join(xmp, ".installer-profile");
      await mkdir(dir, { recursive: true });
      if ((await lstat(dir)).isSymbolicLink()) throw Error("Symlink profile folder refused");
      for (const [name, data] of Object.entries(profile)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error("Invalid private profile name");
        const p = join(dir, `${name}.${id}.new`);
        const f = await open(p, "wx", 0o600);
        try {
          await f.writeFile(data);
          await f.sync();
        } finally {
          await f.close();
        }
        await rename(p, join(dir, name));
      }
    }
    const again = validateUsbVolume(await inspect(current.mountPoint));
    if (again.deviceKey !== current.deviceKey)
      throw Error("USB key changed before image promotion");
    if (old) {
      const fallback = join(xmp, `system.img.previous.${id}.new`);
      pending.add(fallback);
      await durableCopy(active, fallback);
      await rename(fallback, previous);
      await syncDir(xmp);
    }
    await rename(temp, active);
    const directorySynced = await syncDir(xmp);
    await unlink(join(xmp, ".fallback-tried")).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if ((await sha(active)) !== expectedSha256) throw Error("Installed USB image hash mismatch");
    return {
      mountPoint: current.mountPoint,
      sha256: expectedSha256,
      bytes: input.size,
      previousPreserved: !!old,
      olderPreviousBackedUp: !!older,
      directorySynced,
      safelyEjectBeforeUse: true,
      deviceKey: current.deviceKey,
    };
  } finally {
    for (const path of pending)
      await unlink(path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  }
}
