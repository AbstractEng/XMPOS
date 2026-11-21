import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { armElf } from "../os/arm-build.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";
import { parseAz01, verifyAz01 } from "./az01-image.mjs";
import { kernelLock } from "./board.mjs";
import { newcArchive } from "./boot.mjs";
import { requireSupportedUpdater } from "./compatibility.mjs";
import { ensureBuilder, runContainer } from "./container.mjs";
import { buildHostLoader } from "./host-loader.mjs";
import { checkWindowsUpdater } from "./installer/windows-updater.mjs";
import { loaderPayload } from "./loader-payload.mjs";

export { loaderPayload } from "./loader-payload.mjs";

// Builds the step 4 probe image for the MPC Live Mk1: a copy of the official
// root filesystem from Akai's own signed updater in which only /boot changes.
// The result is written to an ignored artifact folder. It contains Akai
// firmware, must never be committed or redistributed, and is never flashed by
// this tool: flashing is a separate, owner-approved step.

const INMUSIC_TEAM_ID = "XV2563R65Q";
export const EXPECTED_CHANGES = {
  changed: ["boot/boot.scr.uimg"],
  added: [
    "usr/lib/systemd/system/multi-user.target.wants/xmp-probe-report.service",
    "usr/lib/systemd/system/xmp-probe-report.service",
    "usr/lib/xmp/xmp-probe-report",
  ],
  removed: [],
};
// The stick loader changes only Akai's boot script (which carries the loader).
export const EXPECTED_LOADER_CHANGES = { changed: ["boot/boot.scr.uimg"], added: [], removed: [] };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function checkUpdater(app) {
  if (process.platform === "win32") return checkWindowsUpdater(app);
  const path = resolve(app);
  if (!path.endsWith(".app") || !existsSync(join(path, "Contents/Resources/Update.img")))
    throw new Error("Pass the path to Akai's MPC updater app (…Updater.app)");
  const verify = spawnSync("codesign", ["--verify", "--strict", path], { encoding: "utf8" });
  if (verify.status !== 0) throw new Error("The updater's code signature does not verify");
  const details = spawnSync("codesign", ["-dv", path], { encoding: "utf8" }).stderr ?? "";
  if (!details.includes(`TeamIdentifier=${INMUSIC_TEAM_ID}`))
    throw new Error("The updater is not signed by inMusic");
  return { path, image: join(path, "Contents/Resources/Update.img") };
}

// Compares per-file hash ledgers ("path\tmode\tsha256" lines) of two trees.
export function diffLedgers(before, after) {
  const parse = (text) =>
    new Map(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [path, ...rest] = line.split("\t");
          return [path.replace(/^\.\//, ""), rest.join("\t")];
        }),
    );
  const a = parse(before),
    b = parse(after);
  return {
    changed: [...a.keys()].filter((p) => b.has(p) && a.get(p) !== b.get(p)).sort(),
    added: [...b.keys()].filter((p) => !a.has(p)).sort(),
    removed: [...a.keys()].filter((p) => !b.has(p)).sort(),
  };
}

async function probePayload(stage) {
  await mkdir(join(stage, "opt/g1/bin"), { recursive: true });
  for (const dir of ["proc", "sys", "dev", "report"]) await mkdir(join(stage, dir));
  const g1Dir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-g1-userspace.json"), "utf8"))
      .directory,
  );
  const g1 = JSON.parse(await readFile(join(g1Dir, "manifest.json"), "utf8"));
  for (const [name, entry] of Object.entries(g1.binaries)) {
    const bytes = await readFile(join(g1Dir, "bin", name));
    if (sha(bytes) !== entry.sha256) throw new Error(`G1 ${name} hash mismatch`);
    await writeFile(join(stage, "opt/g1/bin", name), bytes, { mode: 0o755 });
  }
  await cp(join(g1Dir, "share"), join(stage, "opt/g1/share"), { recursive: true });
  const zig = await vmCompiler();
  execFileSync(
    zig,
    [
      "cc",
      "-target",
      "arm-linux-musleabihf",
      "-mcpu=cortex_a17",
      "-static",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "os/live-mk1/probe-init.c",
      "-o",
      join(stage, "init"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: join(root, "build/arm/zig-cache"),
        ZIG_LOCAL_CACHE_DIR: join(stage, "..", "zig-local"),
      },
    },
  );
  const init = await readFile(join(stage, "init"));
  armElf(init);
  return { initSha256: sha(init), g1: Object.keys(g1.binaries) };
}

// kind "probe": the step 4 hardware probe; kind "loader": the XMP stick loader.
export async function buildProbeImage(
  app,
  { kind = "probe", expectedUpdaterImageSha256, host = false } = {},
) {
  if (host) {
    if (kind !== "loader") throw new Error("The host route builds only the private stick loader");
    return buildHostLoader(app, { expectedUpdaterImageSha256 });
  }
  const sourceHash = buildIdentity();
  if (!["probe", "loader"].includes(kind)) throw new Error(`Unknown image kind ${kind}`);
  const probe = kind === "probe";
  const updater = checkUpdater(app);
  const imageBytes = await readFile(updater.image);
  if (kind === "loader") requireSupportedUpdater(sha(imageBytes));
  if (
    expectedUpdaterImageSha256 !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedUpdaterImageSha256) ||
      sha(imageBytes) !== expectedUpdaterImageSha256)
  )
    throw new Error("Owner updater differs from the release-pinned image hash");
  const container = verifyAz01(imageBytes, parseAz01(imageBytes));
  if (!container.verified) throw new Error("The update image fails its own integrity hash");
  if (!container.compatible.includes("inmusic,acv8"))
    throw new Error("The update image does not support the MPC Live (ACV8)");
  if (container.partition.name !== "rootfs" || container.partition.compression !== "xz")
    throw new Error("Unexpected update image partition");
  const kernelDir = resolve(
    root,
    JSON.parse(await readFile(join(root, "artifacts/live-mk1/latest-kernel.json"), "utf8"))
      .directory,
  );
  const kernel = JSON.parse(await readFile(join(kernelDir, "manifest.json"), "utf8"));
  const lock = kernelLock();
  ensureBuilder(lock);
  ensureBuilder({
    builder: { tag: "xmp-live-mk1-userspace:1", dockerfile: "os/live-mk1/userspace.Dockerfile" },
  });
  const imageId = ensureBuilder({
    builder: { tag: "xmp-live-mk1-probe:1", dockerfile: "os/live-mk1/probe.Dockerfile" },
  });
  await mkdir(join(root, "artifacts/live-mk1"), { recursive: true });
  const out = await mkdtemp(join(root, `artifacts/live-mk1/${kind}-image-`));
  const stage = join(out, `${kind}-rootfs`);
  await mkdir(stage);
  const payload = probe ? await probePayload(stage) : await loaderPayload(stage);
  const outputFile = `rootfs-xmp-${kind}.ext4`;
  await writeFile(join(out, "probe.cpio.gz"), await newcArchive(stage));
  const { offset, size, hash } = container.partition;
  const script = [
    "mkdir -p /out /work",
    // Extract and verify the official rootfs.
    `python3 - <<'PY'
import hashlib, lzma
data = open('/in-update.img', 'rb').read()
payload = data[${offset}:${offset} + ${size}]
assert hashlib.sha1(payload).hexdigest() == '${hash}', 'payload hash'
open('/work/original.ext4', 'wb').write(lzma.decompress(payload))
PY`,
    "e2fsck -fn /work/original.ext4 >/out/original-fsck.log 2>&1",
    `debugfs -R "ls -l /boot" /work/original.ext4 2>/dev/null | grep -q "zImage-${kernel.kernelRelease}"`,
    // v2 boots Akai's own kernel through the /boot/zImage link the stock script uses.
    "debugfs -R 'stat /boot/zImage' /work/original.ext4 2>/dev/null | grep -Eq 'Type: (symlink|regular)'",
    `cp /work/original.ext4 /out/${outputFile}`,
    ": >/out/mkimage.log",
    // A two-part script image: part 0 the script, part 1 the probe ramdisk. The Live's
    // U-Boot cannot read files added to this ext4, so the probe travels inside the
    // one file it already reads (Akai's boot.scr.uimg inode, in block group 0).
    // Part 1 is the raw initramfs. The Live's U-Boot has no setexpr, so the script
    // gets precomputed end addresses for each known start address.
    `size=$(stat -c %s /in-probe.cpio.gz); sed -e "s/@XMP_INITRD_END_0x04000000@/$(printf '0x%08x' $((0x04000000 + size)))/" -e "s/@XMP_INITRD_END_0x49000000@/$(printf '0x%08x' $((0x49000000 + size)))/" ${probe ? "" : "-e 's/xmp.probe=6/xmp.loader=1/'"} /in-boot.cmd > /work/boot.cmd`,
    "! grep -q '@XMP_' /work/boot.cmd",
    `mkimage -A arm -O linux -T script -C none -n xmp-${kind} -d /work/boot.cmd:/in-probe.cpio.gz /work/boot.scr.uimg >>/out/mkimage.log`,
    "chmod 0644 /work/boot.scr.uimg",
    `cat > /work/edit.debugfs <<'EOF'
cd /boot
rm boot.scr.uimg
write /work/boot.scr.uimg boot.scr.uimg
EOF`,
    ...(probe
      ? [
          "cp /in-report /work/xmp-probe-report && cp /in-report.service /work/xmp-probe-report.service",
          "chmod 0644 /work/xmp-probe-report.service",
          "chmod 0755 /work/xmp-probe-report",
          `cat >> /work/edit.debugfs <<'EOF'
cd /usr/lib
mkdir xmp
cd xmp
write /work/xmp-probe-report xmp-probe-report
cd /usr/lib/systemd/system
write /work/xmp-probe-report.service xmp-probe-report.service
cd multi-user.target.wants
symlink xmp-probe-report.service ../xmp-probe-report.service
EOF`,
        ]
      : []),
    `debugfs -w -f /work/edit.debugfs /out/${outputFile} >/out/edit.log 2>&1`,
    `e2fsck -fn /out/${outputFile} >/out/result-fsck.log 2>&1`,
    // Every file U-Boot reads must stay in block group 0 (see above).
    `{ dumpe2fs -h /out/${outputFile} 2>/dev/null | sed -n 's/^Inodes per group: *//p'; for f in boot.scr.uimg zImage zImage-${kernel.kernelRelease}; do debugfs -R "stat /boot/$f" /out/${outputFile} 2>/dev/null | sed -n 's/^Inode: \\([0-9]*\\).*/\\1/p'; done; } > /out/uboot-inodes.txt`,
    // Per-file ledgers of both trees (content hash and mode), compared on the host.
    "mkdir -p /cmp/a /cmp/b",
    "debugfs -R 'rdump / /cmp/a' /work/original.ext4 >/dev/null 2>&1",
    `debugfs -R 'rdump / /cmp/b' /out/${outputFile} >/dev/null 2>&1`,
    `ledger() { (cd "$1" && find . \\( -type f -o -type l \\) -print0 | sort -z | while IFS= read -r -d '' f; do if [ -L "$f" ]; then printf '%s\\tlink\\t%s\\n' "$f" "$(readlink "$f")"; else printf '%s\\t%s\\t%s\\n' "$f" "$(stat -c %a "$f")" "$(sha256sum "$f" | cut -c1-64)"; fi; done); }`,
    "ledger /cmp/a > /out/original.ledger",
    "ledger /cmp/b > /out/result.ledger",
    `dumpe2fs -h /out/${outputFile} 2>/dev/null | grep -E 'Free blocks|Block size' > /out/space.txt`,
    `sha256sum /work/original.ext4 /out/${outputFile} > /out/sha256.txt`,
  ].join("\n");
  await runContainer({
    image: "xmp-live-mk1-probe:1",
    copyIn: [
      { from: updater.image, to: "/in-update.img" },
      { from: join(out, "probe.cpio.gz"), to: "/in-probe.cpio.gz" },
      { from: resolve(root, "os/live-mk1/xmp-probe.boot.cmd"), to: "/in-boot.cmd" },
      ...(probe
        ? [
            { from: join(stage, "init"), to: "/in-report" },
            {
              from: resolve(root, "os/live-mk1/xmp-probe-report.service"),
              to: "/in-report.service",
            },
          ]
        : []),
    ],
    command: script,
    out,
    timeout: 3600000,
  });
  const [perGroup, ...ubootInodes] = (await readFile(join(out, "uboot-inodes.txt"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  if (
    !(perGroup > 0) ||
    ubootInodes.length !== 3 ||
    ubootInodes.some((i) => !(i > 0 && i <= perGroup))
  )
    throw new Error(
      `A file U-Boot must read is outside block group 0: ${ubootInodes} (${perGroup}/group)`,
    );
  const diff = diffLedgers(
    await readFile(join(out, "original.ledger"), "utf8"),
    await readFile(join(out, "result.ledger"), "utf8"),
  );
  const expected = probe ? EXPECTED_CHANGES : EXPECTED_LOADER_CHANGES;
  if (JSON.stringify(diff) !== JSON.stringify(expected))
    throw new Error(`${kind} image changes more than expected: ${JSON.stringify(diff)}`);
  const hashes = Object.fromEntries(
    (await readFile(join(out, "sha256.txt"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => [basename(line.split(/\s+/)[1]), line.split(/\s+/)[0]]),
  );
  const manifest = {
    format: `xmp-live-mk1-${kind}-image`,
    version: 6,
    sourceHash,
    builtAt: new Date().toISOString(),
    source: {
      updater: basename(updater.path),
      signedBy: `inMusic (team ${INMUSIC_TEAM_ID})`,
      imageName: container.name,
      imageSha256: sha(imageBytes),
      partitionSha1: hash,
      originalRootfsSha256: hashes["original.ext4"],
    },
    output: { file: outputFile, sha256: hashes[outputFile] },
    changes: diff,
    unchangedFiles:
      (await readFile(join(out, "original.ledger"), "utf8")).split("\n").filter(Boolean).length -
      diff.changed.length,
    // v2 boots Akai's own kernel from the image; XMP adds only the probe initramfs.
    kernel: { source: "Akai stock /boot/zImage (unchanged)", release: kernel.kernelRelease },
    bootScript:
      "os/live-mk1/xmp-probe.boot.cmd (v6): two-part boot.scr.uimg, script plus raw initramfs; sets /chosen itself with precomputed addresses",
    ubootInodes: { perGroup, files: ubootInodes, allInGroup0: true },
    ...(probe
      ? {
          reportService:
            "os/live-mk1/xmp-probe-report.service (runs the same probe binary in report mode under Akai's system)",
          probe: payload,
        }
      : {
          loader: {
            ...payload,
            source: "os/live-mk1/loader-init.c",
            behaviour:
              "XMP stick with xmp/system.img: loop-mount read-only with a RAM overlay and start it; otherwise mount root= read-only (ro,noload) and hand over to Akai's /sbin/init",
          },
        }),
    filesystemCheck: (await readFile(join(out, "result-fsck.log"), "utf8"))
      .trim()
      .split("\n")
      .at(-1),
    builder: { image: "xmp-live-mk1-probe:1", imageId },
    containsVendorFirmware: true,
    redistribution: "forbidden: contains Akai firmware; keep local, never commit",
    flashed: false,
  };
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during loader/probe build");
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, `artifacts/live-mk1/latest-${kind}-image.json`),
    `${JSON.stringify({ directory: relative(root, out) })}\n`,
  );
  return { directory: out, manifest };
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const kind = args[0] === "--loader" ? "loader" : "probe";
  if (kind === "loader") args.shift();
  const host = args.includes("--host");
  if (host) args.splice(args.indexOf("--host"), 1);
  if (args.length !== 1)
    throw new Error(
      'Usage: npm run live:probe-image -- "<MPC (Gen 1) 3.10.0 Updater.app>"\n       npm run live:loader-image -- "<MPC (Gen 1) 3.10.1 Updater.app>"\n(builds only; never flashes)',
    );
  const { directory, manifest } = await buildProbeImage(args[0], { kind, host });
  console.log(
    JSON.stringify(
      {
        directory: relative(root, directory),
        output: manifest.output,
        changes: manifest.changes,
        unchangedFiles: manifest.unchangedFiles,
        filesystemCheck: manifest.filesystemCheck,
      },
      null,
      2,
    ),
  );
}
