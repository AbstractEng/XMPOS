import { inspectSong } from "../../packages/core/src/assets.ts";
import { sha } from "./arm-build.mjs";

export async function uploadVmFile(vm, input, kind = "song") {
  if (
    !(input instanceof Uint8Array) ||
    !["song", "sample"].includes(kind) ||
    !input.byteLength ||
    input.byteLength > (kind === "song" ? 24 : 4) * 1024 * 1024
  )
    throw new Error("Invalid VM file bounds");
  const bytes = Buffer.from(input);
  await vm.request({ op: "device-file-start", kind, bytes: bytes.length, sha256: sha(bytes) });
  for (let offset = 0; offset < bytes.length; offset += 2048) {
    const part = bytes.subarray(offset, offset + 2048),
      ack = await vm.request({ op: "device-file-write", offset, data: part.toString("base64") });
    if (ack.offset !== offset + part.length) throw new Error("VM file acknowledgement mismatch");
  }
  return vm.request({ op: "device-file-open" });
}
export async function downloadVmSong(vm, packageSamples = true) {
  const receipt = await vm.request({ op: "device-file-save", packageSamples });
  if (
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 1 ||
    receipt.bytes > 96 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    !/^[a-f0-9-]{36}$/.test(receipt.id)
  )
    throw new Error("Invalid VM song receipt");
  const chunks = [];
  for (let offset = 0; offset < receipt.bytes; offset += 2048) {
    const part = await vm.request({ op: "device-file-read", id: receipt.id, offset }),
      bytes = Buffer.from(part.data, "base64");
    if (
      part.id !== receipt.id ||
      part.offset !== offset ||
      bytes.length !== Math.min(2048, receipt.bytes - offset)
    )
      throw new Error("Invalid VM song chunk");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (sha(bytes) !== receipt.sha256) throw new Error("VM song checksum mismatch");
  await inspectSong(bytes.toString("utf8"));
  return { bytes, receipt };
}

export async function finishDeviceVm(vm) {
  const stopped = await vm.finish();
  if (
    stopped.code !== 0 ||
    stopped.signal ||
    !stopped.log.includes('"event":"storage-closed"') ||
    /Kernel panic|storage-close-failed|Out of memory|Killed process/.test(stopped.log)
  )
    throw new Error("Device VM did not flush, unmount and shut down cleanly");
  return stopped;
}

// Serial replies stay below 4 KiB; a PNG is fetched in bounded hash-checked chunks.
export async function deviceScreenshot(vm) {
  const receipt = await vm.request({ op: "device-snapshot" });
  if (
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 1000 ||
    receipt.bytes > 2_000_000 ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    throw new Error("Invalid guest screenshot receipt");
  const chunks = [];
  for (let offset = 0; offset < receipt.bytes; offset += 2048) {
    const part = await vm.request({ op: "device-chunk", offset });
    const bytes = Buffer.from(part.data, "base64");
    if (part.offset !== offset || bytes.length !== Math.min(2048, receipt.bytes - offset))
      throw new Error("Incomplete guest screenshot");
    chunks.push(bytes);
  }
  const png = Buffer.concat(chunks);
  if (sha(png) !== receipt.sha256 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a")
    throw new Error("Guest screenshot hash mismatch");
  return { png, receipt };
}
