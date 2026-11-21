import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { armElf } from "../os/arm-build.mjs";
import { kernelLock } from "./board.mjs";
import { ensureBuilder, runContainer, sha256File } from "./container.mjs";

// Cross-builds the hardware-facing userspace that the official G1 release
// ships (ALSA, libgpiod, libusb) from inMusic's published source archives.
// Binaries are static ARMv7 hard-float so they run in any XMP ARM rootfs.
// No archive script is executed outside the network-less build container.

export const G1_COMPONENTS = [
  {
    id: "alsa-lib",
    archive: "alsa-lib-1.2.11-r0-patched.tar.xz",
    directory: "alsa-lib-1.2.11",
    license: "LGPL-2.1-or-later",
  },
  {
    id: "alsa-utils",
    archive: "alsa-utils-1.2.11-r0-patched.tar.xz",
    directory: "alsa-utils-1.2.11",
    license: "GPL-2.0-or-later",
    tools: ["aplay", "arecord", "amixer", "alsactl"],
  },
  {
    id: "libgpiod",
    archive: "libgpiod-2.1.3-r0-patched.tar.xz",
    directory: "libgpiod-2.1.3",
    license: "LGPL-2.1-or-later (library), GPL-2.0-or-later (tools)",
    tools: ["gpiodetect", "gpioinfo"],
  },
  {
    id: "libusb",
    archive: "libusb1-1.0.27-r0-patched.tar.xz",
    directory: "libusb-1.0.27",
    license: "LGPL-2.1-or-later",
    tools: ["listdevs"],
  },
  {
    id: "alsa-state",
    archive: "alsa-state-0.2.0-r0-patched.tar.xz",
    directory: "archiver-work",
    license: "MIT (recipe files)",
  },
];

const catalog = () =>
  JSON.parse(readFileSync(resolve(root, "references/official-g1-sources.json"), "utf8"));

export async function verifyG1Archives(source = catalog()) {
  const downloaded = source.downloaded;
  const verified = [];
  for (const component of G1_COMPONENTS) {
    const entry = downloaded.find((d) => d.localPath.endsWith(`/${component.archive}`));
    if (!entry) throw new Error(`${component.archive} is not in the official G1 catalog`);
    const path = resolve(root, entry.localPath);
    const digest = await sha256File(path);
    if (digest !== entry.sha256)
      throw new Error(`${component.archive} does not match the official G1 hash; refusing`);
    verified.push({ ...component, path, sha256: digest, officialPath: entry.path });
  }
  return verified;
}

export async function buildG1Userspace() {
  const lock = kernelLock();
  const archives = await verifyG1Archives();
  ensureBuilder(lock);
  const userspace = {
    builder: { tag: "xmp-live-mk1-userspace:1", dockerfile: "os/live-mk1/userspace.Dockerfile" },
  };
  const builderId = ensureBuilder(userspace);
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const out = await mkdtemp(join(root, "artifacts/live-mk1/g1-userspace-"));
  const host = "--host=arm-linux-gnueabihf";
  const prefix = "/opt/g1";
  const script = [
    "mkdir -p /out/bin /src /stage",
    ...archives.map((a) => `tar --no-same-owner -xJf /in-${a.id}.tar.xz -C /src`),
    // alsa-lib: static, built-in PCM plugins, configuration under /opt/g1.
    "cd /src/alsa-lib-1.2.11",
    `./configure ${host} --prefix=${prefix} --enable-static --disable-shared --disable-python --disable-topology --with-configdir=${prefix}/share/alsa --with-plugindir=${prefix}/lib/alsa-lib >/out/alsa-lib.configure.log`,
    "make -j6 >/out/alsa-lib.make.log 2>&1",
    "make install DESTDIR=/stage >/dev/null",
    // alsa-utils: only the playback, capture, mixer and state tools.
    "cd /src/alsa-utils-1.2.11",
    `./configure ${host} --prefix=${prefix} --disable-alsamixer --disable-alsaconf --disable-alsaloop --disable-bat --disable-nls --disable-xmlto --disable-rst2man --with-alsa-prefix=/stage${prefix}/lib --with-alsa-inc-prefix=/stage${prefix}/include LDFLAGS=-static >/out/alsa-utils.configure.log`,
    "for d in aplay amixer alsactl; do make -C $d -j6 LDFLAGS=-all-static >>/out/alsa-utils.make.log 2>&1; done",
    "cp aplay/aplay amixer/amixer alsactl/alsactl /out/bin/ && ln -sf aplay /out/bin/arecord",
    // libgpiod tools.
    "cd /src/libgpiod-2.1.3",
    `./configure ${host} --prefix=${prefix} --enable-tools --enable-static --disable-shared >/out/libgpiod.configure.log`,
    "make -j6 LDFLAGS=-all-static >/out/libgpiod.make.log 2>&1",
    "cp tools/gpiodetect tools/gpioinfo /out/bin/",
    // libusb with its device-listing example; no udev, no hotplug daemon.
    "cd /src/libusb-1.0.27",
    `./configure ${host} --prefix=${prefix} --disable-udev --enable-static --disable-shared --enable-examples-build >/out/libusb.configure.log`,
    "make -j6 LDFLAGS=-all-static >/out/libusb.make.log 2>&1",
    "cp examples/listdevs /out/bin/",
    // ALSA configuration from alsa-lib plus the G1 alsa-state files.
    `mkdir -p /out/share && cp -r /stage${prefix}/share/alsa /out/share/alsa`,
    "cp /src/archiver-work/asound.conf /out/share/asound.conf",
    "arm-linux-gnueabihf-strip /out/bin/aplay /out/bin/amixer /out/bin/alsactl /out/bin/gpiodetect /out/bin/gpioinfo /out/bin/listdevs",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format, not a template
    "dpkg-query -W -f '${Package}=${Version}\\n' gcc-arm-linux-gnueabihf libc6-dev-armhf-cross > /out/packages.txt",
  ].join("\n");
  await runContainer({
    image: userspace.builder.tag,
    volumes: [],
    copyIn: archives.map((a) => ({ from: a.path, to: `/in-${a.id}.tar.xz` })),
    command: script,
    out,
    timeout: 3600000,
  });
  const binaries = {};
  for (const name of (await readdir(join(out, "bin"))).sort()) {
    if (name === "arecord") continue;
    const bytes = await readFile(join(out, "bin", name));
    binaries[name] = {
      ...armElf(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
  const manifest = {
    format: "xmp-g1-userspace",
    version: 1,
    builtAt: new Date().toISOString(),
    officialSource: {
      repository: "https://github.com/inmusic-software/az0x-open-source",
      commit: catalog().commit,
      archives: archives.map(({ id, archive, sha256, license, officialPath }) => ({
        id,
        archive,
        sha256,
        license,
        officialPath,
      })),
    },
    builder: {
      image: `${userspace.builder.tag} on ${lock.builder.image}`,
      imageId: builderId,
      packages: (await readFile(join(out, "packages.txt"), "utf8")).trim().split("\n"),
    },
    linkage: "static glibc (Debian armhf cross toolchain); G1 itself links glibc 2.39 dynamically",
    install: "/opt/g1",
    binaries,
    alsaStateNote:
      "G1 alsa-state ships an empty asound.conf and a placeholder asound.state; no MPC mixer state is published",
    deployable: false,
    hardwareQualified: false,
  };
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, "artifacts/live-mk1/latest-g1-userspace.json"),
    `${JSON.stringify({ directory: relative(root, out) })}\n`,
  );
  return { directory: out, manifest };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2)
    throw new Error("G1 userspace build takes no options; no device or deploy options exist");
  const { directory, manifest } = await buildG1Userspace();
  console.log(
    JSON.stringify(
      { directory: relative(root, directory), binaries: Object.keys(manifest.binaries) },
      null,
      2,
    ),
  );
}
