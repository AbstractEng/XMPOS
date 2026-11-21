import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { ensureFonts } from "../fonts.mjs";
import { armElf } from "../os/arm-build.mjs";
import { bootScreen } from "./boot-screen.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";
import { verifyG1Archives } from "./g1-userspace.mjs";
import { prune } from "./prune-artifacts.mjs";

// Builds the XMP session system image for the MPC Live Mk1 stick loader
// (AGENTS.md, "Device-specific authorization 2"): an ext4 image the owner
// copies to the stick as xmp/system.img. It holds only XMP code built here
// (session init, session program) and alsa-lib's configuration files, no Akai
// firmware. This LEGACY STATIC development build is not the owner-local
// 3.10.1 public release profile and is blocked by live:release. Two images are built:
//   system.img           the Live build (the only one meant for the stick)
//   system-emulator.img  the same session binary plus the Live twin, for
//                        npm run live:session-vm
// Nothing is copied to a stick or a device by this tool.

const SESSION_SOURCES = [
  "native/src/live_session.cpp",
  "native/src/engine.cpp",
  "native/src/rt_thread.cpp",
  "native/src/live_platform.cpp",
  "native/src/live_platform_linux.cpp",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const SESSION_CONF_EXAMPLE = `# XMP session settings (optional). Copy to xmp/session.conf on the stick.
# Screen rotation in degrees (0, 90, 180, 270). Default: 270 on a portrait panel.
#rotation=270
# What XMP sends the pad controller after listening: none, identity, or full
# (identity request plus the start-up sequence Akai's MPC app sends). Default: full.
#startup=full
# Controller port for those messages: 0 Public, 1 Private. Default: 1.
#startup_port=1
# Seconds of listening before anything is sent (0-30). Default: 2.
#listen_seconds=2
# Switch off after this many minutes without pad input (1-120). Default: 30.
#idle_minutes=30
`;

const PREFIX = "/opt/g1";
const ALSA_CONFIGURE = `./configure --host=arm-linux-gnueabihf --prefix=${PREFIX} --enable-static --disable-shared --disable-python --disable-topology --with-configdir=${PREFIX}/share/alsa`;

// Static ARM alsa-lib, built once and cached by everything that determines it:
// the hash-verified source archive, the builder image and the configure line.
export async function alsaLibStatic(alsa, imageId) {
  const key = sha(Buffer.from(`${alsa.sha256}\n${imageId}\n${ALSA_CONFIGURE}`)).slice(0, 16);
  const dir = join(root, "artifacts/live-mk1", `alsa-lib-static-${key}`);
  const tarball = join(dir, "alsa-lib-static.tar");
  if (existsSync(tarball)) return { tarball, key, cached: true };
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const work = await mkdtemp(join(root, "artifacts/live-mk1/alsa-lib-build-"));
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [{ from: alsa.path, to: "/in-alsa-lib.tar.xz" }],
    command: [
      "mkdir -p /out /src /stage",
      "tar --no-same-owner -xJf /in-alsa-lib.tar.xz -C /src",
      "cd /src/alsa-lib-1.2.11",
      `${ALSA_CONFIGURE} >/out/configure.log`,
      "make -j6 >/out/make.log 2>&1 && make install DESTDIR=/stage >/dev/null",
      `tar -C /stage -cf /out/alsa-lib-static.tar .${PREFIX}/include .${PREFIX}/lib/libasound.a .${PREFIX}/share/alsa`,
    ].join("\n"),
    out: work,
    timeout: 1800000,
  });
  await rename(work, dir);
  return { tarball, key, cached: false };
}

export async function buildSessionImage({ program = null } = {}) {
  // Downstream artifacts are reviewed static ARM ELFs, never command strings.
  let downstream = null;
  if (program) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(program.name) || !/^[a-f0-9]{64}$/.test(program.sha256))
      throw new Error("Invalid downstream program identity");
    const bytes = await readFile(program.binary);
    if (sha(bytes) !== program.sha256) throw new Error("Downstream binary hash mismatch");
    armElf(bytes);
    downstream = { name: program.name, sha256: program.sha256, bytes: bytes.length };
  }
  const sourceHash = buildIdentity();
  const alsa = (await verifyG1Archives()).find((a) => a.id === "alsa-lib");
  const userspace = {
    builder: { tag: "xmp-live-mk1-userspace:1", dockerfile: "os/live-mk1/userspace.Dockerfile" },
  };
  ensureBuilder(userspace);
  const probe = {
    builder: { tag: "xmp-live-mk1-probe:1", dockerfile: "os/live-mk1/probe.Dockerfile" },
  };
  const imageId = ensureBuilder(probe);
  // The interface's font atlas, made on the Mac (tools/fonts.mjs).
  const fonts = await ensureFonts();
  const boot = await bootScreen();
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  prune({ log: () => {} }); // old runs and images (the newest few, and cited ones, stay)
  const out = await mkdtemp(join(root, "artifacts/live-mk1/session-image-"));
  const prefix = PREFIX;
  const alsaStatic = await alsaLibStatic(alsa, imageId);
  const cxx = [
    "arm-linux-gnueabihf-g++ -std=c++17 -O2 -static -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard",
    "-Wall -Wextra -Werror -Inative/include -Ibuild/fonts",
    `-I/stage${prefix}/include`,
    ...SESSION_SOURCES,
    `-L/stage${prefix}/lib -lasound -lpthread -lm -ldl -lrt`,
  ].join(" ");
  const cc =
    "arm-linux-gnueabihf-gcc -std=gnu11 -O2 -static -mcpu=cortex-a17 -mfloat-abi=hard -Wall -Wextra -Werror -Ios/live-mk1";
  const twin = `${cc} -I/stage${prefix}/include os/live-mk1/live-twin.c -L/stage${prefix}/lib -lasound -lpthread -lm -ldl -lrt`;
  const tree = (name) => [
    `mkdir -p /w/${name}/sbin /w/${name}/usr/lib/xmp /w/${name}/proc /w/${name}/sys /w/${name}/dev /w/${name}/media/xmp /w/${name}/tmp /w/${name}/etc /w/${name}${prefix}/share`,
    `cp -R /stage${prefix}/share/alsa /w/${name}${prefix}/share/alsa`,
  ];
  const script = [
    "mkdir -p /out /stage /w",
    "tar -C /stage -xf /in-alsa-lib-static.tar",
    "cd /xmp",
    // One session binary: the emulator image carries the Live build itself.
    downstream
      ? "cp /in-downstream-session /w/session && chmod 755 /w/session"
      : `${cxx} -o /w/session 2>/out/compile.log`,
    `${cc} os/live-mk1/session-init.c -o /w/init-live 2>>/out/compile.log`,
    `${cc} -DXMP_SESSION_EMULATOR os/live-mk1/session-init.c -o /w/init-emulator 2>>/out/compile.log`,
    `${twin} -o /w/live-twin 2>>/out/compile.log`,
    `${cc} os/live-mk1/xmp-bridge.c -o /w/xmp-bridge 2>>/out/compile.log`,
    `${downstream ? "true" : "arm-linux-gnueabihf-strip /w/session"} && arm-linux-gnueabihf-strip /w/init-live /w/init-emulator /w/live-twin /w/xmp-bridge`,
    ...tree("live"),
    ...tree("emulator"),
    // The interface draws Inter and JetBrains Mono (SIL Open Font Licence): their licences travel with it.
    "mkdir -p /w/live/usr/share/xmp/fonts /w/emulator/usr/share/xmp/fonts",
    "cp /xmp/build/fonts/*.txt /w/live/usr/share/xmp/fonts/ && cp /xmp/build/fonts/*.txt /w/emulator/usr/share/xmp/fonts/",
    "install -m 644 /in-boot-screen.rgb /w/live/usr/share/xmp/boot-screen.rgb && install -m 644 /in-boot-screen.rgb /w/emulator/usr/share/xmp/boot-screen.rgb",
    "install -m 755 /w/init-live /w/live/sbin/init && install -m 755 /w/session /w/live/usr/lib/xmp/xmp-live-session",
    "install -m 755 /w/init-emulator /w/emulator/sbin/init && install -m 755 /w/session /w/emulator/usr/lib/xmp/xmp-live-session",
    "install -m 755 /w/live-twin /w/emulator/usr/lib/xmp/xmp-live-twin",
    // The control bridge (AGENTS.md authorizations 3 and 4): the same binary in both images.
    "install -m 755 /w/xmp-bridge /w/live/usr/lib/xmp/xmp-bridge && install -m 755 /w/xmp-bridge /w/emulator/usr/lib/xmp/xmp-bridge",
    `echo "XMP session for the MPC Live Mk1, source ${sourceHash}" > /w/live/etc/xmp-release`,
    `echo "XMP session with the Live twin (emulator only), source ${sourceHash}" > /w/emulator/etc/xmp-release`,
    "cp /w/session /w/init-live /w/init-emulator /w/live-twin /w/xmp-bridge /out/",
    "truncate -s 24M /out/system.img && mkfs.ext4 -q -F -L xmpsys -m 0 -d /w/live /out/system.img",
    "truncate -s 24M /out/system-emulator.img && mkfs.ext4 -q -F -L xmpsys -m 0 -d /w/emulator /out/system-emulator.img",
    "e2fsck -fn /out/system.img > /out/fsck.log 2>&1",
  ].join("\n");
  await runContainer({
    image: probe.builder.tag,
    copyIn: [
      ...(downstream ? [{ from: resolve(program.binary), to: "/in-downstream-session" }] : []),
      { from: boot.path, to: "/in-boot-screen.rgb" },
      { from: alsaStatic.tarball, to: "/in-alsa-lib-static.tar" },
      { from: resolve(root, "native"), to: "/xmp-native" },
      { from: resolve(root, "os/live-mk1"), to: "/xmp-os" },
      { from: join(fonts, "image"), to: "/xmp-fonts" },
    ],
    command: `mkdir -p /xmp/os /xmp/build && cp -R /xmp-native /xmp/native && cp -R /xmp-os /xmp/os/live-mk1 && cp -R /xmp-fonts /xmp/build/fonts\n${script}`,
    out,
    timeout: 1800000,
  });
  const files = {};
  for (const name of [
    "system.img",
    "system-emulator.img",
    "session",
    "init-live",
    "init-emulator",
    "live-twin",
  ]) {
    const bytes = await readFile(join(out, name));
    files[name] = { sha256: sha(bytes), bytes: bytes.length };
    if (!name.endsWith(".img")) Object.assign(files[name], armElf(bytes));
  }
  if (
    downstream &&
    (sha(await readFile(join(out, "session"))) !== downstream.sha256 ||
      sha(await readFile(program.binary)) !== downstream.sha256)
  )
    throw new Error("Downstream binary changed during build");
  await writeFile(join(out, "session.conf.example"), SESSION_CONF_EXAMPLE);
  const manifest = {
    format: "xmp-live-mk1-session-image",
    version: 1,
    sourceHash,
    sources: [
      ...SESSION_SOURCES,
      "os/live-mk1/session-init.c",
      "os/live-mk1/boot-screen.h",
      "os/live-mk1/boot-screen-format.h",
      "os/live-mk1/assets/boot-screen.rgb",
      "os/live-mk1/xmp-live-common.h",
      "os/live-mk1/live-twin.c",
      "os/live-mk1/xmp-bridge.c",
    ],
    alsaLib: {
      archive: alsa.archive,
      sha256: alsa.sha256,
      cacheKey: alsaStatic.key,
      cached: alsaStatic.cached,
    },
    // The emulator image runs this exact session binary; only its init (which
    // also starts the twin) and the twin itself differ.
    sameSessionBinary: true,
    downstreamProgram: downstream,
    bootScreen: boot.metadata,
    builder: { image: probe.builder.tag, imageId },
    files,
    stickPath: "xmp/system.img",
    // Legacy field: no proprietary Akai files. It is NOT redistribution clearance.
    containsVendorFiles: false,
    containsProprietaryAkaiAssets: false,
    thirdPartyOpenSourceIncluded: true,
    redistribution: {
      status: "review-required",
      required: [
        "component-notices",
        "corresponding-source",
        "static-linking-review",
        "owner-install-and-stock-recovery-evidence",
      ],
    },
    runtimeMode: "legacy-static-development-only",
    runtimeLibrariesIncluded: true,
    publicRedistributionApproved: false,
    copiedToDevice: false,
  };
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during the session build");
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, "artifacts/live-mk1/latest-session-image.json"),
    `${JSON.stringify({ directory: relative(root, out), sourceHash })}\n`,
  );
  return { directory: out, manifest };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2) throw new Error("Session image build takes no options");
  const { directory, manifest } = await buildSessionImage();
  console.log(
    JSON.stringify({ directory: relative(root, directory), files: manifest.files }, null, 2),
  );
}
