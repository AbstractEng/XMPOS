import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { armElf } from "../os/arm-build.mjs";
import { kernelLock } from "./board.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";
import { verifyG1Archives } from "./g1-userspace.mjs";

// Cross-builds XMP's continuous ALSA engine as a static ARMv7 binary, linked
// against the official G1 alsa-lib (hash-verified), inside the locked-down
// userspace container. The result runs only in owned VMs; it is not deployed.

const SOURCES = [
  "native/src/alsa_engine.cpp",
  "native/src/engine.cpp",
  "native/src/host_graph.cpp",
  "native/src/rt_thread.cpp",
  "native/src/rt_audit.cpp",
  "native/src/rt_wrap_linux.cpp",
];
const WRAPPED = [
  "malloc",
  "calloc",
  "realloc",
  "free",
  "pthread_mutex_lock",
  "open",
  "read",
  "write",
  "fwrite",
  "socket",
  "send",
  "recv",
];

export async function buildAlsaEngine() {
  const sourceHash = buildIdentity();
  const alsa = (await verifyG1Archives()).find((a) => a.id === "alsa-lib");
  ensureBuilder(kernelLock());
  const userspace = {
    builder: { tag: "xmp-live-mk1-userspace:1", dockerfile: "os/live-mk1/userspace.Dockerfile" },
  };
  const imageId = ensureBuilder(userspace);
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const out = await mkdtemp(join(root, "artifacts/live-mk1/alsa-engine-"));
  const prefix = "/opt/g1";
  const script = [
    "mkdir -p /out /src /stage",
    "tar --no-same-owner -xJf /in-alsa-lib.tar.xz -C /src",
    "cd /src/alsa-lib-1.2.11",
    `./configure --host=arm-linux-gnueabihf --prefix=${prefix} --enable-static --disable-shared --disable-python --disable-topology --with-configdir=${prefix}/share/alsa >/out/alsa-lib.configure.log`,
    "make -j6 >/out/alsa-lib.make.log 2>&1 && make install DESTDIR=/stage >/dev/null",
    "cd /xmp",
    [
      "arm-linux-gnueabihf-g++ -std=c++17 -O2 -static -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard",
      "-Wall -Wextra -Werror -Inative/include",
      `-I/stage${prefix}/include`,
      ...SOURCES,
      ...WRAPPED.map((s) => `-Wl,--wrap=${s}`),
      `-L/stage${prefix}/lib -lasound -lpthread -lm -ldl -lrt`,
      "-o /out/xmp_alsa_engine 2>/out/compile.log",
    ].join(" "),
    "arm-linux-gnueabihf-strip /out/xmp_alsa_engine",
  ].join("\n");
  await runContainer({
    image: userspace.builder.tag,
    copyIn: [
      { from: alsa.path, to: "/in-alsa-lib.tar.xz" },
      { from: resolve(root, "native"), to: "/xmp-native" },
    ],
    // The compiler runs from /xmp so source paths in diagnostics stay repository-relative.
    command: `mkdir -p /xmp && cp -R /xmp-native /xmp/native\n${script}`,
    out,
    timeout: 1800000,
  });
  const bytes = await readFile(join(out, "xmp_alsa_engine"));
  const manifest = {
    format: "xmp-alsa-engine",
    version: 1,
    sourceHash,
    sources: SOURCES,
    alsaLib: { archive: alsa.archive, sha256: alsa.sha256, officialPath: alsa.officialPath },
    builder: { image: userspace.builder.tag, imageId },
    binary: {
      ...armElf(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    deployable: false,
    physicalAccess: false,
  };
  if (sourceHash !== buildIdentity())
    throw new Error("Source changed during the ALSA engine build");
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, "artifacts/live-mk1/latest-alsa-engine.json"),
    `${JSON.stringify({ directory: relative(root, out), sourceHash })}\n`,
  );
  return { directory: out, manifest };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2)
    throw new Error("ALSA engine build takes no options; no device or deploy options exist");
  const { directory, manifest } = await buildAlsaEngine();
  console.log(
    JSON.stringify({ directory: relative(root, directory), binary: manifest.binary }, null, 2),
  );
}
