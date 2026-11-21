// Build-only integration. The existing isolated XMP container owns the build;
// no host mounts, networking or devices are granted to downstream source.

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { armElf } from "../os/arm-build.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";
import { verifyG1Archives } from "./g1-userspace.mjs";
import { alsaLibStatic } from "./session-image.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function buildDownstreamSession({ directory, target }) {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(target)) throw new Error("Invalid CMake target");
  const image = "xmp-live-mk1-downstream:1";
  const imageId = ensureBuilder({
    builder: { tag: image, dockerfile: "os/live-mk1/downstream.Dockerfile" },
  });
  const probeId = ensureBuilder({
    builder: { tag: "xmp-live-mk1-probe:1", dockerfile: "os/live-mk1/probe.Dockerfile" },
  });
  const alsa = (await verifyG1Archives()).find((a) => a.id === "alsa-lib");
  const library = await alsaLibStatic(alsa, probeId);
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const out = await mkdtemp(join(root, "artifacts/live-mk1/downstream-build-"));
  const source = join(out, "source");
  const excluded = new Set([".git", "build", "node_modules", ".venv", "artifacts", "reports"]);
  await cp(resolve(directory), source, {
    recursive: true,
    filter: (path) =>
      !path
        .slice(resolve(directory).length)
        .split(/[\\/]/)
        .some((p) => excluded.has(p)),
  });
  await runContainer({
    image,
    copyIn: [
      { from: source, to: "/downstream" },
      { from: library.tarball, to: "/alsa.tar" },
    ],
    command: [
      "mkdir -p /out /stage",
      "tar -C /stage -xf /alsa.tar",
      "cmake -S /downstream -B /build -G Ninja -DCMAKE_TOOLCHAIN_FILE=/downstream/cmake/toolchains/live-mk1.cmake -DCMAKE_BUILD_TYPE=Release -DXMP_MODULAR_TARGET=arm-session -DALSA_INCLUDE_DIR=/stage/opt/g1/include -DALSA_LIBRARY=/stage/opt/g1/lib/libasound.a -DCMAKE_EXE_LINKER_FLAGS=-static > /out/configure.log 2>&1",
      `cmake --build /build --target ${target} > /out/build.log 2>&1`,
      `cp /build/${target} /out/session`,
    ].join("\n"),
    out,
    timeout: 1800000,
  });
  const bytes = await readFile(join(out, "session"));
  const manifest = {
    name: target.replaceAll("_", "-"),
    binary: join(out, "session"),
    sha256: sha(bytes),
    ...armElf(bytes),
    builder: imageId,
  };
  await writeFile(join(out, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
