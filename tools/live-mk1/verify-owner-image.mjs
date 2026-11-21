import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { pythonRun } from "./installer/runtime.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
async function regular(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("Bounded regular file required");
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const { bytesRead } = await file.read(bytes, at, bytes.length - at, at);
      if (!bytesRead) throw new Error("File changed during verification");
      at += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

// This runs before device discovery in the CLI and before any push request in
// the exported command. Only these verified bytes are subsequently transferred.
export async function verifyOwnerImage(image) {
  const manifestBytes = await regular(join(dirname(image), "manifest.json"), 256 * 1024);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const lockFile = join(root, "os/live-mk1/mpc-runtime.lock.json");
  const lockBytes = await regular(lockFile, 256 * 1024);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (
    manifest.format !== "xmp-live-mk1-owner-session-image" ||
    manifest.version !== 1 ||
    manifest.target !== "inmusic,acv8" ||
    manifest.mpcOsVersion !== "3.10.1" ||
    manifest.runtimeMode !== "owner-local-3.10.1" ||
    manifest.runtimeLibrariesIncluded !== true ||
    !hex(manifest.sourceHash) ||
    !hex(manifest.sessionBinarySha256) ||
    !hex(manifest.template?.imageSha256) ||
    !hex(manifest.template?.manifestSha256) ||
    manifest.runtime?.lockSha256 !== hash(lockBytes) ||
    manifest.runtime?.updaterImageSha256 !== lock.updaterImageSha256 ||
    manifest.runtime?.rootfsSha256 !== lock.rootfsSha256 ||
    manifest.files?.["system.img"]?.bytes !== 32 * 1024 * 1024 ||
    !hex(manifest.files?.["system.img"]?.sha256)
  )
    throw new Error("Verified owner-local MPC OS 3.10.1 manifest required");
  const bytes = await regular(image, 32 * 1024 * 1024);
  const sha256 = hash(bytes);
  if (
    bytes.length !== manifest.files["system.img"].bytes ||
    sha256 !== manifest.files["system.img"].sha256
  )
    throw new Error("Owner image hash/size differs from manifest");
  const audit = pythonRun(
    [
      join(root, "tools/live-mk1/owner-runtime.py"),
      "audit-owner-push",
      image,
      lockFile,
      manifest.sourceHash,
      manifest.sessionBinarySha256,
    ],
    { encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 },
  );
  if (audit.error || audit.status !== 0) throw new Error("Owner image filesystem audit failed");
  // Bind the path-based filesystem audit to the exact bytes we will send.
  if (hash(await regular(image, 32 * 1024 * 1024)) !== sha256)
    throw new Error("Owner image changed during audit");
  return { bytes, sha256, manifest, manifestSha256: hash(manifestBytes) };
}
