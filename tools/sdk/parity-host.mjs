import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventRecord, ParityPlanSchema } from "../../packages/sdk/src/parity.ts";

export const nativeRoot = fileURLToPath(
  new URL(typeof __XMP_BUNDLED__ !== "undefined" ? "../native/" : "../../native/", import.meta.url),
);
export async function compileParity(directory, { linuxVm = false, zig } = {}) {
  const source = join(
    nativeRoot,
    typeof __XMP_BUNDLED__ !== "undefined" ? "parity_render.c" : "src/parity_render.c",
  );
  const include = join(nativeRoot, typeof __XMP_BUNDLED__ !== "undefined" ? "." : "include/xmp");
  const binary = join(directory, "xmp_parity_render");
  try {
    await lstat(binary);
    throw new Error("Native build output exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const args = [
    ...(linuxVm ? ["cc", "-target", "x86_64-linux-musl", "-static"] : []),
    "-std=c99",
    "-D_POSIX_C_SOURCE=200809L",
    "-O2",
    "-ffp-contract=off",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I",
    include,
    source,
    join(nativeRoot, typeof __XMP_BUNDLED__ !== "undefined" ? "parity_dsp.c" : "src/parity_dsp.c"),
    "-lm",
    "-o",
    binary,
  ];
  if (linuxVm && !zig) throw new Error("Pinned VM cross compiler required");
  const compiler = linuxVm ? zig : "cc";
  const version = execFileSync(compiler, linuxVm ? ["version"] : ["--version"], {
    encoding: "utf8",
    timeout: 15000,
  }).split("\n")[0];
  execFileSync(compiler, args, {
    encoding: "utf8",
    timeout: 600000,
    env: {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: join(directory, "zig-cache"),
      ZIG_LOCAL_CACHE_DIR: join(directory, "zig-local"),
    },
  });
  const receipt = {
    backend: linuxVm ? "native-linux-x64-musl" : "native-host",
    compiler: version,
    sourceSha256: createHash("sha256")
      .update(await readFile(source))
      .update(await readFile(join(include, "community_dsp.h")))
      .update(
        await readFile(
          join(
            nativeRoot,
            typeof __XMP_BUNDLED__ !== "undefined" ? "parity_dsp.c" : "src/parity_dsp.c",
          ),
        ),
      )
      .digest("hex"),
    flags: args.filter((a) => a.startsWith("-")),
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    physicalAccess: false,
  };
  await writeFile(join(directory, "native-build.json"), JSON.stringify(receipt, null, 2), {
    flag: "wx",
  });
  return { binary, receipt };
}
export function encodePlan(input) {
  const p = ParityPlanSchema.parse(input),
    b = Buffer.alloc(40 + p.events.length * 24);
  b.write("XMPD");
  [
    1,
    48000,
    p.frames,
    ["sine", "triangle", "virtual-input"].indexOf(p.source),
    p.events.length,
  ].forEach((v, i) => {
    b.writeUInt32LE(v, 4 + i * 4);
  });
  b.writeDoubleLE(p.gain, 24);
  b.writeDoubleLE(p.cutoff, 32);
  p.events.forEach((event, i) => {
    const e = eventRecord(event),
      at = 40 + i * 24;
    [e.frame, e.op, e.id, e.arg].forEach((n, j) => {
      b.writeUInt32LE(n, at + j * 4);
    });
    b.writeDoubleLE(e.value, at + 16);
  });
  return b;
}
export function decodeResult(bytes) {
  if (
    bytes.length < 24 ||
    bytes.toString("utf8", 0, 4) !== "XMPR" ||
    bytes.readUInt32LE(4) !== 1 ||
    bytes.readUInt32LE(8) !== 48000
  )
    throw new Error("Invalid native result header");
  const frames = bytes.readUInt32LE(12),
    count = bytes.readUInt32LE(16),
    activeVoices = bytes.readUInt32LE(20);
  if (
    frames < 480 ||
    frames > 48000 ||
    count > 256 ||
    activeVoices > 32 ||
    bytes.length !== 24 + count * 28 + frames * 4
  )
    throw new Error("Native result exceeds bounds");
  const trace = Array.from({ length: count }, (_, i) => {
    const at = 24 + i * 28,
      accepted = bytes.readUInt32LE(at + 24);
    if (accepted > 1) throw new Error("Invalid native acknowledgement");
    return {
      frame: bytes.readUInt32LE(at),
      op: bytes.readUInt32LE(at + 4),
      id: bytes.readUInt32LE(at + 8),
      arg: bytes.readUInt32LE(at + 12),
      value: bytes.readDoubleLE(at + 16),
      accepted: !!accepted,
    };
  });
  const pcm = Float32Array.from({ length: frames }, (_, i) =>
    bytes.readFloatLE(24 + count * 28 + i * 4),
  );
  return { sampleRate: 48000, pcm, trace, activeVoices };
}
export async function nativeParity(binary, plan, directory, name = "case") {
  if (!/^[a-z0-9-]{1,50}$/.test(name)) throw new Error("Named parity case required");
  await writeFile(join(directory, `${name}.plan`), encodePlan(plan), { flag: "wx" });
  execFileSync(binary, [`${name}.plan`, `${name}.result`], {
    cwd: directory,
    timeout: 15000,
    encoding: "utf8",
  });
  return decodeResult(await readFile(join(directory, `${name}.result`)));
}
