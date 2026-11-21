import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import {
  assertLiveTarget,
  auditFragment,
  describeBoard,
  explicitlyDisabled,
  kernelLock,
  parseKernelConfig,
} from "./board.mjs";
import { ensureBuilder, runContainer, sha256File, WORK_VOLUME } from "./container.mjs";

// Builds and boot-tests the official inMusic az01 kernel for the MPC Live Mk1
// entirely on the development Mac (Docker + QEMU). There is deliberately no
// option to select a device, write media, flash, or contact hardware.

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const KERNEL_INPUTS = [
  "os/live-mk1/kernel.lock.json",
  "os/live-mk1/xmp-virt.config",
  "os/live-mk1/builder.Dockerfile",
  "tools/live-mk1/kernel.mjs",
  "tools/live-mk1/container.mjs",
];
// Identity of everything that can change the kernel build (the archive is
// covered by its pinned hash, which is part of the lock file).
export async function kernelInputsHash() {
  const hash = createHash("sha256");
  for (const path of KERNEL_INPUTS)
    hash.update(`${path}\0`).update(await readFile(resolve(root, path)));
  return hash.digest("hex");
}

export { dockerCreateArgs } from "./container.mjs";

export async function verifySource(lock = kernelLock()) {
  const archive = resolve(root, lock.source.archive);
  if (!existsSync(archive))
    throw new Error("Official kernel archive missing; run npm run refs:sources");
  const { size } = await stat(archive);
  const digest = await sha256File(archive);
  if (size !== lock.source.bytes || digest !== lock.source.sha256)
    throw new Error("Official kernel archive does not match the pinned hash; refusing to extract");
  return { archive, sha256: digest, bytes: size };
}

export async function buildKernel() {
  const lock = kernelLock();
  const inputsHash = await kernelInputsHash();
  const source = await verifySource(lock);
  const builderId = ensureBuilder(lock);
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const out = await mkdtemp(join(root, "artifacts/live-mk1/kernel-"));
  const dtbs = lock.target.boards.map((b) => `rockchip/${b.dtb}`).join(" ");
  const { crossCompile, jobs } = lock.builder;
  const make = `make -s -C /work/src/${lock.source.root} O=/work/out ARCH=arm CROSS_COMPILE=${crossCompile}`;
  const script = [
    // Extract once per pinned archive hash into the case-sensitive volume.
    "mkdir -p /out",
    `if [ "$(cat /work/src/.archive-sha256 2>/dev/null)" != "${source.sha256}" ]; then`,
    "  rm -rf /work/src /work/out && mkdir -p /work/src",
    "  tar --no-same-owner --no-same-permissions -xJf /kernel.tar.xz -C /work/src",
    `  echo ${source.sha256} > /work/src/.archive-sha256`,
    "fi",
    "mkdir -p /work/out",
    `${make} ${lock.config.defconfig}`,
    "cp /work/out/.config /out/official.config",
    `cp /work/src/${lock.source.root}/arch/arm/configs/${lock.config.defconfig} /out/${lock.config.defconfig}`,
    `/work/src/${lock.source.root}/scripts/kconfig/merge_config.sh -m -O /work/out /work/out/.config /cfg/xmp-virt.config >/out/merge.log`,
    `${make} olddefconfig`,
    "cp /work/out/.config /out/merged.config",
    `${make} -j${jobs} zImage ${dtbs} 2>/out/build-warnings.log`,
    "cp /work/out/arch/arm/boot/zImage /out/zImage",
    ...lock.target.boards.map(
      (b) => `cp /work/out/arch/arm/boot/dts/rockchip/${b.dtb} /out/${b.dtb}`,
    ),
    `${make} -s kernelrelease > /out/kernelrelease`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format, not a template
    "dpkg-query -W -f '${Package}=${Version}\\n' gcc-arm-linux-gnueabihf binutils-arm-linux-gnueabihf make bison flex device-tree-compiler qemu-system-arm > /out/packages.txt",
  ].join("\n");
  const started = Date.now();
  await runContainer({
    image: lock.builder.tag,
    volumes: [{ source: WORK_VOLUME, target: "/work" }],
    copyIn: [
      { from: source.archive, to: "/kernel.tar.xz" },
      { from: resolve(root, "os/live-mk1"), to: "/cfg" },
    ],
    command: script,
    out,
    timeout: 7200000,
  });
  const official = parseKernelConfig(await readFile(join(out, "official.config"), "utf8"));
  const merged = parseKernelConfig(await readFile(join(out, "merged.config"), "utf8"));
  const disabled = explicitlyDisabled(await readFile(join(out, lock.config.defconfig), "utf8"));
  const fragmentProblems = auditFragment(official, merged, lock.config.required, disabled);
  if (fragmentProblems.length)
    throw new Error(`Kernel configuration audit failed:\n${fragmentProblems.join("\n")}`);
  const boards = {};
  for (const board of lock.target.boards) {
    const bytes = await readFile(join(out, board.dtb));
    boards[board.dtb] = {
      sha256: sha(bytes),
      bytes: bytes.length,
      ...assertLiveTarget(describeBoard(bytes, lock)),
    };
  }
  const zImage = await readFile(join(out, "zImage"));
  // ARM zImage magic 0x016f2818 at offset 0x24.
  if (zImage.readUInt32LE(0x24) !== 0x016f2818) throw new Error("zImage is not an ARM kernel");
  const added = [...merged].filter(([k, v]) => (official.get(k) ?? "n") !== v).length;
  const manifest = {
    format: "xmp-live-mk1-kernel",
    version: 1,
    inputsHash,
    inputs: KERNEL_INPUTS,
    builtAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    officialSource: { ...lock.source, verified: true },
    kernelRelease: (await readFile(join(out, "kernelrelease"), "utf8")).trim(),
    builder: {
      image: lock.builder.image,
      imageId: builderId,
      packages: (await readFile(join(out, "packages.txt"), "utf8")).trim().split("\n"),
    },
    config: {
      defconfig: lock.config.defconfig,
      fragment: lock.config.fragment,
      officialOptions: official.size,
      optionsAddedByFragment: added,
      officialOptionsChanged: 0,
      explicitlyDisabledKept: disabled.size,
      required: lock.config.required,
      officialSha256: sha(await readFile(join(out, "official.config"))),
      mergedSha256: sha(await readFile(join(out, "merged.config"))),
    },
    zImage: { sha256: sha(zImage), bytes: zImage.length },
    boards,
    deployable: false,
    excluded: lock.outputs.excluded,
    hardwareQualified: false,
    physicalAccess: false,
    scope:
      "Official az01 kernel cross-built with an add-only virt fragment; Live Mk1 device trees verified by content. Not flashed, booted on, or tested with any MPC.",
  };
  if (inputsHash !== (await kernelInputsHash()))
    throw new Error("Kernel build inputs changed during the build");
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, "artifacts/live-mk1/latest-kernel.json"),
    `${JSON.stringify({ directory: relative(root, out) })}\n`,
  );
  return { directory: out, manifest };
}

export { bootKernel, parseBootLog } from "./boot.mjs";

if (process.argv[1] === import.meta.filename) {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length || !["build", "boot", "verify-source"].includes(command ?? ""))
    throw new Error(
      "Usage: npm run live:kernel -- build|boot|verify-source (no device, flash or deploy options exist)",
    );
  if (command === "verify-source") console.log(JSON.stringify(await verifySource()));
  if (command === "build") {
    const { directory, manifest } = await buildKernel();
    console.log(
      JSON.stringify(
        {
          directory: relative(root, directory),
          kernelRelease: manifest.kernelRelease,
          boards: Object.keys(manifest.boards),
          optionsAddedByFragment: manifest.config.optionsAddedByFragment,
          deployable: false,
        },
        null,
        2,
      ),
    );
  }
  if (command === "boot") {
    const { bootKernel } = await import("./boot.mjs");
    const { directory, report } = await bootKernel();
    console.log(
      JSON.stringify(
        {
          directory: relative(root, directory),
          ended: report.boot.ended,
          version: report.boot.version,
          realtime: report.boot.realtime,
          identity: report.boot.identity,
          tests: Object.fromEntries(Object.entries(report.tests).map(([k, v]) => [k, v.exit])),
        },
        null,
        2,
      ),
    );
  }
}
