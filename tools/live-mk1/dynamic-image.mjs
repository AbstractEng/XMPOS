import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { factoryKits, kitImagePath } from "../factory-kits.mjs";
import { ensureFonts } from "../fonts.mjs";
import { bootScreen } from "./boot-screen.mjs";
import { MPC_RUNTIME } from "./compatibility.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";
import { verifyG1Archives } from "./g1-userspace.mjs";
import { compileOnHost } from "./host-build.mjs";
import {
  inputDirectory,
  lockFile,
  makeExt4,
  publishArtifactPointer,
  pythonRuntime,
  regularFile,
  runtimeLockHash,
  temporaryArtifact,
  writeManifest,
} from "./image-artifacts.mjs";

export const DYNAMIC_BINARIES = [
  "session",
  "session-image",
  "init-live",
  "xmp-bridge",
  "init-emulator",
  "live-twin",
  "runtime-probe",
];
const CPP = ["native/src/live_session.cpp", "native/src/engine.cpp", "native/src/rt_thread.cpp"];

// Explicit shared SONAMEs and -nodefaultlibs prevent the cross compiler from
// silently selecting its own libasound/libstdc++/libgcc/libc archives or DSOs.
export function dynamicBuildRecipe(sourceHash) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Invalid source identity");
  const cpu =
    "-O2 -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard -fno-pie -ffp-contract=off -Wall -Wextra -Werror";
  const cxx = `arm-linux-gnueabihf-g++ -std=c++17 ${cpu} -Inative/include -Ibuild/fonts -I/stage/opt/g1/include -include os/live-mk1/cxx-math-compat.hpp`;
  const cc = `arm-linux-gnueabihf-gcc -std=gnu11 ${cpu} -Ios/live-mk1 -I/stage/opt/g1/include`;
  const link =
    "-no-pie -nodefaultlibs -Wl,--dynamic-linker=/lib/ld-linux-armhf.so.3 -L/in-runtime/lib -Wl,-rpath-link,/in-runtime/lib -Wl,--no-as-needed -Wl,--disable-new-dtags,-rpath,/lib";
  const libs = "-l:libgcc_s.so.1 -l:libm.so.6 -l:libc.so.6";
  const sources = [
    { name: "runtime-probe", source: "native/tests/live_runtime_probe.cpp", compiler: cxx },
    ...CPP.map((source, index) => ({ name: `session-${index}`, source, compiler: cxx })),
    { name: "init-live", source: "os/live-mk1/session-init.c", compiler: cc },
    { name: "xmp-bridge", source: "os/live-mk1/xmp-bridge.c", compiler: cc },
    {
      name: "init-emulator",
      source: "os/live-mk1/session-init.c",
      compiler: `${cc} -DXMP_SESSION_EMULATOR`,
    },
    { name: "live-twin", source: "os/live-mk1/live-twin.c", compiler: cc },
  ];
  const checks = MPC_RUNTIME.files
    .map((entry) => `${entry.sha256}  /in-runtime/${entry.destination}`)
    .join("\n");
  return [
    "mkdir -p /out/objects /out/link-maps /out/toolchain /src /stage /xmp/os /xmp/build",
    `cat > /out/runtime-inputs.sha256 <<'XMP_HASHES'\n${checks}\nXMP_HASHES`,
    "sha256sum -c /out/runtime-inputs.sha256 >/out/runtime-check.log",
    "tar --no-same-owner -xJf /in-alsa.tar.xz -C /src",
    "cd /src/alsa-lib-1.2.11",
    "./configure --host=arm-linux-gnueabihf --prefix=/opt/g1 --disable-python --disable-topology >/out/alsa-configure.log",
    "make -C include install DESTDIR=/stage >/out/alsa-headers.log 2>&1",
    "cp -R /xmp-native /xmp/native && cp -R /xmp-os /xmp/os/live-mk1 && cp -R /xmp-fonts /xmp/build/fonts",
    "cd /xmp",
    "arm-linux-gnueabihf-g++ --version >/out/toolchain/compiler.txt",
    "arm-linux-gnueabihf-g++ -dumpspecs >/out/toolchain/specs.txt",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format placeholders, not JavaScript.
    "dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' >/out/toolchain/packages.tsv",
    "for p in libc6-dev-armhf-cross libgcc-12-dev-armhf-cross libstdc++-12-dev-armhf-cross gcc-12-arm-linux-gnueabihf g++-12-arm-linux-gnueabihf; do if test -f /usr/share/doc/$p/copyright; then cp -L /usr/share/doc/$p/copyright /out/toolchain/$p.copyright; fi; done",
    'for name in crt1.o crti.o crtbegin.o crtend.o crtn.o; do path=$(arm-linux-gnueabihf-gcc -print-file-name=$name); test -f "$path"; cp "$path" /out/objects/$name; done',
    ...sources.map(
      ({ compiler, source, name }) =>
        `${compiler} -c ${source} -o /out/objects/${name}.o 2>>/out/compile.log`,
    ),
    `${cxx} ${link} /out/objects/session-0.o /out/objects/session-1.o /out/objects/session-2.o -Wl,-Map=/out/link-maps/session.map -l:libasound.so.2 -l:libstdc++.so.6 ${libs} -o /out/session 2>>/out/compile.log`,
    `${cxx} ${link} /out/objects/runtime-probe.o -Wl,-Map=/out/link-maps/runtime-probe.map -l:libasound.so.2 -l:libstdc++.so.6 ${libs} -o /out/runtime-probe 2>>/out/compile.log`,
    ...["init-live", "xmp-bridge", "init-emulator", "live-twin"].map(
      (name) =>
        `${cc} ${link} /out/objects/${name}.o -Wl,-Map=/out/link-maps/${name}.map ${name === "live-twin" ? "-l:libasound.so.2 " : ""}${libs} -o /out/${name} 2>>/out/compile.log`,
    ),
    "arm-linux-gnueabihf-objcopy --strip-debug /out/session /out/session-image",
    ...DYNAMIC_BINARIES.map(
      (name) =>
        `arm-linux-gnueabihf-readelf -h -l -d -V /out/${name} >/out/toolchain/${name}.elf.txt`,
    ),
    // Unstripped objects/executables/maps stay local for rebuild/relink review.
    `echo '${sourceHash}' >/out/toolchain/source-hash.txt`,
  ].join("\n");
}

async function ledger(directory, prefix = "") {
  const entries = {};
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(entries, await ledger(directory, name));
    else entries[name] = await regularFile(join(directory, name), 32 * 1024 * 1024);
  }
  return entries;
}

export async function buildDynamicTemplate(runtimeDirectory, { builder = "docker" } = {}) {
  if (!["docker", "host"].includes(builder)) throw new Error("Unknown dynamic builder");
  const runtime = await inputDirectory(runtimeDirectory);
  pythonRuntime(["verify-runtime", runtime, lockFile]);
  const sourceHash = buildIdentity();
  const image = "xmp-live-mk1-userspace:1";
  const imageId =
    builder === "docker"
      ? ensureBuilder({ builder: { tag: image, dockerfile: "os/live-mk1/userspace.Dockerfile" } })
      : null;
  const alsa = (await verifyG1Archives()).find((entry) => entry.id === "alsa-lib");
  const fonts = await ensureFonts();
  const boot = await bootScreen();
  const out = await temporaryArtifact("dynamic-template-");
  const tree = join(out, ".tree");
  try {
    const recipe = dynamicBuildRecipe(sourceHash);
    await writeFile(join(out, "build.sh"), `${recipe}\n`, { flag: "wx" });
    let hostCompiler;
    if (builder === "host")
      hostCompiler = await compileOnHost({ out, runtime, alsa, fonts, sourceHash });
    else
      await runContainer({
        image,
        copyIn: [
          { from: runtime, to: "/in-runtime" },
          { from: alsa.path, to: "/in-alsa.tar.xz" },
          { from: join(root, "native"), to: "/xmp-native" },
          { from: join(root, "os/live-mk1"), to: "/xmp-os" },
          { from: join(fonts, "image"), to: "/xmp-fonts" },
        ],
        command: recipe,
        out,
        timeout: 1800000,
      });
    const elf = pythonRuntime([
      "check-elf",
      join(out, "session"),
      lockFile,
      ...DYNAMIC_BINARIES.slice(1).map((name) => join(out, name)),
    ]);
    for (const dir of [
      "sbin",
      "usr/lib/xmp",
      "usr/share/xmp/fonts",
      "etc",
      "proc",
      "sys",
      "dev",
      "tmp",
      "media/xmp",
    ])
      await mkdir(join(tree, dir), { recursive: true, mode: 0o755 });
    for (const [from, to] of [
      ["init-live", "sbin/init"],
      ["session-image", "usr/lib/xmp/xmp-live-session"],
      ["xmp-bridge", "usr/lib/xmp/xmp-bridge"],
    ])
      await copyFile(join(out, from), join(tree, to), constants.COPYFILE_EXCL);
    for (const name of ["Inter-LICENSE.txt", "JetBrainsMono-OFL.txt"])
      await copyFile(
        join(fonts, "image", name),
        join(tree, "usr/share/xmp/fonts", name),
        constants.COPYFILE_EXCL,
      );
    await copyFile(boot.path, join(tree, "usr/share/xmp/boot-screen.rgb"), constants.COPYFILE_EXCL);
    await mkdir(join(tree, kitImagePath), { recursive: true, mode: 0o755 });
    for (const [name, bytes] of (await factoryKits()).assets)
      await writeFile(join(tree, kitImagePath, name), bytes, { flag: "wx", mode: 0o644 });
    await writeFile(
      join(tree, "etc/xmp-release"),
      `XMP MPC Live Mk1; MPC OS 3.10.1; source ${sourceHash}\n`,
      { flag: "wx", mode: 0o644 },
    );
    const tool = await makeExt4(tree, join(out, "system.img"));
    const audit = pythonRuntime(["audit-public", join(out, "system.img"), lockFile]);
    await rm(tree, { recursive: true, force: true });
    if (sourceHash !== buildIdentity()) throw new Error("Source changed during dynamic build");
    const manifest = {
      format: "xmp-live-mk1-session-image",
      version: 1,
      target: "inmusic,acv8",
      mpcOsVersion: "3.10.1",
      sourceHash,
      runtimeMode: "owner-local-3.10.1",
      runtimeLibrariesIncluded: false,
      runtimeLockSha256: await runtimeLockHash(),
      updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
      containsProprietaryAkaiAssets: false,
      containsVendorFirmware: false,
      builder: builder === "docker" ? { image, imageId } : hostCompiler,
      imageTool: tool,
      files: await ledger(out),
      elf,
      audit,
      alsaHeaders: { archive: alsa.archive, sha256: alsa.sha256 },
      bootScreen: boot.metadata,
      sameSessionBinary: true,
      directlyBootable: false,
      abiExecutionTested: false,
      redistribution: {
        status: "review-required",
        required: ["notices-source-startup-header-review", "owner-install-and-recovery-evidence"],
      },
      publicRedistributionApproved: false,
      copiedToDevice: false,
    };
    await writeManifest(join(out, "manifest.json"), manifest);
    await publishArtifactPointer("latest-dynamic-template.json", {
      directory: relative(root, out),
      sourceHash,
    });
    return { directory: out, manifest };
  } catch (error) {
    await rm(join(out, "manifest.json"), { force: true });
    await rm(join(out, "system.img"), { force: true });
    await writeFile(join(out, "failure.txt"), `${error.message}\n`, { flag: "wx" });
    throw error;
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const host = args.at(-1) === "--host";
  if (host) args.pop();
  if (args.length !== 1)
    throw new Error(
      "Usage: npm run live:dynamic-image -- <verified-owner-runtime-directory> [--host]",
    );
  const result = await buildDynamicTemplate(args[0], { builder: host ? "host" : "docker" });
  console.log(
    JSON.stringify({ directory: relative(root, result.directory), ...result.manifest }, null, 2),
  );
}
