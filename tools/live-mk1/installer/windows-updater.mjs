import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { root } from "../../../acceptance/lib/workspace.mjs";

function hashFile(path) {
  const h = createHash("sha256"),
    fd = openSync(path, "r"),
    b = Buffer.alloc(1024 ** 2);
  try {
    for (;;) {
      const n = readSync(fd, b, 0, b.length, null);
      if (!n) break;
      h.update(b.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}
function run(program, args) {
  const r = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 1024 ** 2,
  });
  if (r.error || r.status !== 0)
    throw Error(r.stderr?.trim() || r.error?.message || "Windows updater preparation failed");
  return r.stdout;
}
export function checkWindowsUpdater(path) {
  const resources = process.env.XMP_INSTALLER_RESOURCES;
  if (!resources)
    throw Error("Use the packaged Windows installer to authenticate the Windows updater");
  const lock = JSON.parse(readFileSync(join(resources, "inputs.lock.json"), "utf8"));
  path = resolve(path);
  const info = lstatSync(path);
  if (
    !path.toLowerCase().endsWith(".exe") ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== lock.updater.bytes ||
    hashFile(path) !== lock.updater.sha256
  )
    throw Error("Choose the exact official MPC (Gen 1) 3.10.1 Windows updater");
  const directory = join(root, "artifacts/windows-updater", lock.updater.sha256);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw Error("Symlink updater cache refused");
  const image = join(directory, "Update.img"),
    inner = join(directory, "FirmwareUpdater.exe");
  let outerVerified = false;
  try {
    run(join(resources, "host-helper.exe"), ["verify-updater", path]);
    outerVerified = true;
  } catch {}
  if (!existsSync(image) || (!outerVerified && !existsSync(inner)))
    run(join(resources, "7zr.exe"), [
      "e",
      "-y",
      "-bd",
      "-bb0",
      `-o${directory}`,
      path,
      "Update.img",
      "FirmwareUpdater.exe",
      "-r",
    ]);
  if (!outerVerified) run(join(resources, "host-helper.exe"), ["verify-updater", inner]);
  const payload = lstatSync(image);
  if (
    !payload.isFile() ||
    payload.isSymbolicLink() ||
    payload.size !== lock.updater.payloadBytes ||
    hashFile(image) !== lock.updater.payloadSha256
  )
    throw Error("Windows updater payload differs from the pinned Gen 1 3.10.1 image");
  return { path, image };
}
