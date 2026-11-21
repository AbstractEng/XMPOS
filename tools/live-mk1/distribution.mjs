import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { root } from "../../acceptance/lib/workspace.mjs";
import { MPC_RUNTIME, requireSupportedUpdater } from "./compatibility.mjs";
import { sha256File } from "./container.mjs";
import { runtimeLockHash } from "./image-artifacts.mjs";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  .max(64);
const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(80);
const Https = z
  .string()
  .url()
  .max(500)
  .refine((v) => v.startsWith("https://"));
const Entry = z
  .object({
    sha256: Hash,
    bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
  })
  .strict();
export const INSTALL_STEPS = [
  "install-loader-rootfs",
  "boot-xmp-from-usb",
  "boot-stock-without-usb",
  "restore-stock-rootfs",
  "boot-restored-stock",
];
export const PUBLIC_FILES = [
  "system.img",
  "THIRD-PARTY-NOTICES.txt",
  "corresponding-source.tar.gz",
  "INSTALL.md",
  "RECOVERY.md",
  "LICENSE",
  "manifest.json",
  "SHA256SUMS",
];
const Clearance = z
  .object({
    format: z.literal("xmp-live-mk1-distribution-review"),
    version: z.literal(1),
    status: z.literal("approved"),
    releaseVersion: Version,
    target: z.literal("inmusic,acv8"),
    sourceHash: Hash,
    sessionManifestSha256: Hash,
    installationSha256: Hash,
    updaterImageSha256: Hash,
    reviewReference: Https,
    proprietaryAkaiAssets: z.literal("excluded"),
    staticLinkingAndCorrespondingSourceReview: z.literal("complete"),
    components: z
      .array(
        z
          .object({
            id: Id,
            license: z.string().min(1).max(160),
            version: z.string().min(1).max(100),
            source: Https,
            sourcePath: z.string().regex(/^sources\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/),
            sourceSha256: Hash,
          })
          .strict(),
      )
      .min(5)
      .max(256),
    files: z
      .object({
        "system.img": Entry,
        "THIRD-PARTY-NOTICES.txt": Entry,
        "corresponding-source.tar.gz": Entry,
        "INSTALL.md": Entry,
        "RECOVERY.md": Entry,
        LICENSE: Entry,
      })
      .strict(),
  })
  .strict();
const Installation = z
  .object({
    format: z.literal("xmp-live-mk1-installation-evidence"),
    version: z.union([z.literal(2), z.literal(3)]),
    loaderSourceHash: Hash.optional(),
    loaderManifestSha256: Hash.optional(),
    status: z.literal("passed"),
    method: z.literal("owner-observed-physical"),
    synthetic: z.literal(false),
    target: z.literal("inmusic,acv8"),
    sourceHash: Hash,
    sessionImageSha256: Hash,
    publicTemplateSha256: Hash,
    ownerAssemblyManifestSha256: Hash,
    runtimeLockSha256: Hash,
    loaderImageSha256: Hash,
    updaterImageSha256: Hash,
    stockRootfsSha256: Hash,
    privateDeviceIdentitySha256: Hash,
    startingMpcOsVersion: z.literal("3.10.1"),
    restoredMpcOsVersion: z.literal("3.10.1"),
    steps: z
      .array(
        z
          .object({
            id: z.enum(INSTALL_STEPS),
            outcome: z.literal("passed"),
            observedAt: z.string().datetime({ offset: true }),
            evidence: z
              .object({
                file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:log|txt|json|png)$/),
                sha256: Hash,
              })
              .strict(),
          })
          .strict(),
      )
      .length(INSTALL_STEPS.length),
  })
  .strict();

async function regular(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum)
    throw new Error(`Bounded regular file required: ${path}`);
  return { sha256: await sha256File(path), bytes: info.size };
}
async function directory(path) {
  const at = resolve(path);
  if (!(await lstat(at)).isDirectory() || (await realpath(at)) !== at)
    throw new Error("Regular, non-symlink input directory required");
  return at;
}
async function json(path) {
  await regular(path, 256 * 1024);
  return JSON.parse(await readFile(path, "utf8"));
}
function equal(a, b, label) {
  if (a !== b) throw new Error(`${label} differs from the reviewed candidate`);
}

// Verifies file bindings to the owner's observations. It cannot independently
// witness physical actions; neither generated nor simulated receipts qualify.
export async function verifyInstallation(reviewDirectory, expected) {
  const at = await directory(reviewDirectory);
  const evidence = Installation.parse(await json(join(at, "installation.json")));
  requireSupportedUpdater(evidence.updaterImageSha256);
  const loader = await json(join(at, "loader-manifest.json"));
  if (loader.format !== "xmp-live-mk1-loader-image" || loader.containsVendorFirmware !== true)
    throw new Error("Owner-local loader build manifest required");
  if (evidence.version === 3) {
    // Loader and session may be built separately. Bind the actual observed
    // loader manifest and its own source; never relabel the session source.
    equal(loader.sourceHash, Hash.parse(evidence.loaderSourceHash), "Loader source");
    equal(
      (await regular(join(at, "loader-manifest.json"), 256 * 1024)).sha256,
      Hash.parse(evidence.loaderManifestSha256),
      "Loader manifest hash",
    );
  } else {
    if (evidence.loaderSourceHash || evidence.loaderManifestSha256)
      throw new Error("Separate loader bindings require installation evidence v3");
    equal(loader.sourceHash, evidence.sourceHash, "Loader source");
  }
  equal(loader.output?.sha256, evidence.loaderImageSha256, "Loader image");
  equal(loader.source?.imageSha256, evidence.updaterImageSha256, "Loader updater");
  const stock = await json(join(at, "stock-receipt.json"));
  if (
    stock.format !== "xmp-local-stock-rootfs" ||
    stock.updaterSignatureVerified !== true ||
    stock.verifiedAgainstFreshExtraction !== true ||
    stock.target !== "inmusic,acv8"
  )
    throw new Error("Authenticated fresh stock recovery receipt required");
  equal(stock.updaterImageSha256, evidence.updaterImageSha256, "Stock updater");
  equal(stock.output?.sha256, evidence.stockRootfsSha256, "Stock rootfs");
  const assembly = await json(join(at, "owner-assembly.json"));
  equal(
    (await regular(join(at, "owner-assembly.json"), 256 * 1024)).sha256,
    evidence.ownerAssemblyManifestSha256,
    "Owner assembly manifest hash",
  );
  if (
    assembly.format !== "xmp-live-mk1-owner-session-image" ||
    assembly.version !== 1 ||
    assembly.runtimeMode !== "owner-local-3.10.1" ||
    assembly.runtimeLibrariesIncluded !== true ||
    assembly.mpcOsVersion !== "3.10.1" ||
    assembly.publicRedistributionApproved !== false
  )
    throw new Error("Owner-local runtime assembly manifest required");
  equal(assembly.sourceHash, evidence.sourceHash, "Assembly source");
  equal(assembly.template?.imageSha256, evidence.publicTemplateSha256, "Assembly public template");
  equal(
    assembly.template?.manifestSha256,
    expected.templateManifestSha256,
    "Assembly template manifest",
  );
  equal(
    assembly.files?.["system.img"]?.sha256,
    evidence.sessionImageSha256,
    "Assembly private image",
  );
  equal(assembly.runtime?.lockSha256, evidence.runtimeLockSha256, "Assembly runtime lock");
  equal(assembly.runtime?.rootfsSha256, MPC_RUNTIME.rootfsSha256, "Assembly stock runtime");
  equal(assembly.runtime?.updaterImageSha256, evidence.updaterImageSha256, "Assembly updater");
  equal(evidence.runtimeLockSha256, await runtimeLockHash(), "Pinned runtime lock");
  for (const key of ["target", "sourceHash", "publicTemplateSha256", "updaterImageSha256"])
    equal(evidence[key], expected[key], `Installation ${key}`);
  equal(evidence.restoredMpcOsVersion, evidence.startingMpcOsVersion, "Restored MPC OS version");
  equal(
    JSON.stringify(evidence.steps.map((s) => s.id)),
    JSON.stringify(INSTALL_STEPS),
    "Installation sequence",
  );
  let previous = 0;
  for (const step of evidence.steps) {
    const time = Date.parse(step.observedAt);
    if (time < previous) throw new Error("Installation observations are out of order");
    previous = time;
    const file = await regular(join(at, step.evidence.file), 32 * 1024 * 1024);
    equal(file.sha256, step.evidence.sha256, `${step.id} evidence hash`);
  }
  return {
    sha256: (await regular(join(at, "installation.json"), 256 * 1024)).sha256,
    ownerEvidenceBindingsVerified: true,
    independentlyWitnessed: false,
    startingMpcOsVersion: evidence.startingMpcOsVersion,
    publicTemplateSha256: evidence.publicTemplateSha256,
    assembledImageSha256: evidence.sessionImageSha256,
    runtimeLockSha256: evidence.runtimeLockSha256,
  };
}

export async function planDistribution(sessionDirectory, reviewDirectory) {
  const session = await directory(sessionDirectory),
    review = await directory(reviewDirectory);
  const original = await json(join(session, "manifest.json"));
  if (
    original.format !== "xmp-live-mk1-session-image" ||
    original.version !== 1 ||
    original.containsProprietaryAkaiAssets !== false ||
    original.containsVendorFirmware === true ||
    /forbidden/i.test(String(original.redistribution ?? ""))
  )
    throw new Error(
      "Only an original XMP session image is eligible; loader/probe/stock firmware is local-only",
    );
  if (
    original.runtimeMode !== "owner-local-3.10.1" ||
    original.runtimeLibrariesIncluded !== false ||
    original.mpcOsVersion !== MPC_RUNTIME.mpcOsVersion
  )
    throw new Error(
      "Public XMP requires the owner-local 3.10.1 runtime profile; legacy static/private assembled images are ineligible",
    );
  equal(original.runtimeLockSha256, await runtimeLockHash(), "Build runtime lock");
  requireSupportedUpdater(original.updaterImageSha256);
  const sourceHash = Hash.parse(original.sourceHash);
  const imageEntry = Entry.parse(original.files?.["system.img"]);
  if (imageEntry.bytes > 64 * 1024 * 1024)
    throw new Error("Session image exceeds the reviewed image profile");
  const checkedImage = await regular(join(session, "system.img"), 64 * 1024 * 1024);
  equal(checkedImage.sha256, imageEntry.sha256, "Session image hash");
  equal(checkedImage.bytes, imageEntry.bytes, "Session image size");
  const image = await open(join(session, "system.img"), "r");
  try {
    const magic = Buffer.alloc(2);
    await image.read(magic, 0, 2, 1080);
    if (imageEntry.bytes < 4096 || imageEntry.bytes % 4096 || magic.readUInt16LE(0) !== 0xef53)
      throw new Error("Expected the XMP ext4 userspace image, not an arbitrary payload");
  } finally {
    await image.close();
  }
  const record = Clearance.parse(await json(join(review, "clearance.json")));
  requireSupportedUpdater(record.updaterImageSha256);
  equal(record.sourceHash, sourceHash, "Source identity");
  equal(
    record.sessionManifestSha256,
    (await regular(join(session, "manifest.json"), 256 * 1024)).sha256,
    "Build manifest hash",
  );
  const required = ["xmp", "libc-startup", "gcc-runtime", "inter", "jetbrains-mono"];
  const ids = record.components.map((c) => c.id);
  const sourcePaths = record.components.map((c) => c.sourcePath);
  if (
    new Set(sourcePaths).size !== sourcePaths.length ||
    new Set(ids).size !== ids.length ||
    required.some((id) => !ids.includes(id))
  )
    throw new Error("Incomplete or duplicate component/source review");
  const inputs = {
    "system.img": join(session, "system.img"),
    "THIRD-PARTY-NOTICES.txt": join(review, "THIRD-PARTY-NOTICES.txt"),
    "corresponding-source.tar.gz": join(review, "corresponding-source.tar.gz"),
    "INSTALL.md": join(root, "docs/install-live-mk1.md"),
    "RECOVERY.md": join(root, "docs/recover-live-mk1.md"),
    LICENSE: join(root, "LICENSE"),
  };
  for (const [name, file] of Object.entries(inputs)) {
    const actual = await regular(
      file,
      name === "system.img"
        ? 64 * 1024 * 1024
        : name === "corresponding-source.tar.gz"
          ? 1024 * 1024 * 1024
          : 1024 * 1024,
    );
    equal(actual.sha256, record.files[name].sha256, `${name} hash`);
    equal(actual.bytes, record.files[name].bytes, `${name} size`);
  }
  const filesystemAudit = spawnSync(
    "python3",
    [
      "-I",
      join(root, "tools/live-mk1/owner-runtime.py"),
      "audit-public",
      inputs["system.img"],
      join(root, "os/live-mk1/mpc-runtime.lock.json"),
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  if (filesystemAudit.error || filesystemAudit.status !== 0)
    throw new Error(
      `Public filesystem audit failed: ${filesystemAudit.error?.message ?? filesystemAudit.stderr.trim()}`,
    );
  const sourceAudit = spawnSync(
    "python3",
    [
      "-I",
      join(root, "tools/live-mk1/audit-source-bundle.py"),
      inputs["corresponding-source.tar.gz"],
      JSON.stringify(record.components),
    ],
    { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 },
  );
  if (sourceAudit.error || sourceAudit.status !== 0)
    throw new Error(
      `Source bundle audit failed: ${sourceAudit.error?.message ?? sourceAudit.stderr.trim()}`,
    );
  equal(record.files["system.img"].sha256, imageEntry.sha256, "Session build image hash");
  equal(record.files["system.img"].bytes, imageEntry.bytes, "Session build image size");
  const installation = await verifyInstallation(review, {
    target: record.target,
    sourceHash,
    publicTemplateSha256: imageEntry.sha256,
    templateManifestSha256: record.sessionManifestSha256,
    updaterImageSha256: record.updaterImageSha256,
  });
  equal(installation.sha256, record.installationSha256, "Installation receipt hash");
  return { record, installation, inputs, sourceHash, publicFiles: PUBLIC_FILES, published: false };
}

export async function packDistribution(sessionDirectory, reviewDirectory, destination) {
  const plan = await planDistribution(sessionDirectory, reviewDirectory);
  const output = resolve(destination),
    artifactBase = resolve(root, "artifacts");
  if (!output.startsWith(artifactBase + sep))
    throw new Error("New output under artifacts/ required");
  await mkdir(dirname(output), { recursive: true });
  if ((await realpath(dirname(output))) !== dirname(output))
    throw new Error("Symlink output path refused");
  // Reserve the new destination before work, never replace an existing result.
  await mkdir(output, { mode: 0o700 });
  const stage = await mkdtemp(join(output, ".stage-"));
  try {
    const ledger = {};
    const copy = async (from, name, expected) => {
      // The source tar can exceed 200 MB. Stream that already audited input
      // into the ZIP without a second staging copy; verify its archived bytes
      // against the reviewed ledger before accepting the result.
      const streamed = name === "corresponding-source.tar.gz";
      if (!streamed) await copyFile(from, join(stage, name), constants.COPYFILE_EXCL);
      const actual = await regular(streamed ? from : join(stage, name), 1024 * 1024 * 1024);
      if (expected) {
        equal(actual.sha256, expected.sha256, `${name} staged hash`);
        equal(actual.bytes, expected.bytes, `${name} staged size`);
      }
      ledger[name] = actual;
    };
    for (const [name, input] of Object.entries(plan.inputs))
      await copy(input, name, plan.record.files[name]);
    const audited = spawnSync(
      "python3",
      [
        "-I",
        join(root, "tools/live-mk1/audit-source-bundle.py"),
        plan.inputs["corresponding-source.tar.gz"],
        JSON.stringify(plan.record.components),
      ],
      { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 },
    );
    if (audited.error || audited.status !== 0) throw new Error("Staged source bundle audit failed");
    const manifest = {
      format: "xmp-live-mk1-public-distribution",
      version: 1,
      releaseVersion: plan.record.releaseVersion,
      target: plan.record.target,
      sourceHash: plan.sourceHash,
      files: ledger,
      installationEvidence: plan.installation,
      redistributionReview: {
        reference: plan.record.reviewReference,
        components: plan.record.components,
      },
      mpcOsVersion: MPC_RUNTIME.mpcOsVersion,
      runtimeMode: "owner-local-3.10.1",
      runtimeLibrariesIncluded: false,
      runtimeLockSha256: await runtimeLockHash(),
      localUpdaterRequired: true,
      localUpdater: {
        imageSha256: plan.record.updaterImageSha256,
        startingMpcOsVersion: plan.installation.startingMpcOsVersion,
      },
      proprietaryAkaiArtifactsIncluded: false,
      published: false,
      qualificationScope: "distribution-boundary-only",
    };
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    ledger["manifest.json"] = await regular(join(stage, "manifest.json"), 256 * 1024);
    await writeFile(
      join(stage, "SHA256SUMS"),
      Object.keys(ledger)
        .sort()
        .map((name) => `${ledger[name].sha256}  ${name}\n`)
        .join(""),
      { flag: "wx" },
    );
    const archiveEntries = {
      ...ledger,
      SHA256SUMS: await regular(join(stage, "SHA256SUMS"), 256 * 1024),
    };
    const filename = `xmp-os-live-mk1-${plan.record.releaseVersion}.zip`;
    const zip = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `import pathlib,sys,zipfile,json,hashlib
base=pathlib.Path(sys.argv[1]); source=pathlib.Path(sys.argv[3]); entries=json.loads(sys.argv[4]); names=sys.argv[5:]
with zipfile.ZipFile(sys.argv[2], 'x', compression=zipfile.ZIP_STORED) as archive:
 for name in names:
  archive.write(source if name == 'corresponding-source.tar.gz' else base/name, name)
with zipfile.ZipFile(sys.argv[2]) as archive:
 assert sorted(archive.namelist()) == sorted(names)
 for name in names:
  assert archive.getinfo(name).file_size == entries[name]['bytes']
  with archive.open(name) as member:
   h=hashlib.sha256()
   for chunk in iter(lambda:member.read(1048576),b''):h.update(chunk)
   assert h.hexdigest() == entries[name]['sha256'], 'Changed archive member '+name
`,
        stage,
        join(output, filename),
        plan.inputs["corresponding-source.tar.gz"],
        JSON.stringify(archiveEntries),
        ...PUBLIC_FILES,
      ],
      { encoding: "utf8", timeout: 600000 },
    );
    if (zip.error || zip.status !== 0)
      throw new Error(`Archive creation failed: ${zip.error?.message ?? zip.stderr}`);
    const receipt = {
      format: "xmp-local-distribution-receipt",
      version: 1,
      filename,
      ...(await regular(join(output, filename), 2 * 1024 * 1024 * 1024)),
      sourceHash: plan.sourceHash,
      files: PUBLIC_FILES,
      published: false,
      qualificationScope: "distribution-boundary-only",
    };
    await writeFile(join(output, "distribution.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
    return receipt;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const [mode, session, review, output, ...rest] = process.argv.slice(2);
  if (
    rest.length ||
    !session ||
    !review ||
    (mode === "check" ? output : mode !== "pack" || !output)
  )
    throw new Error(
      "Usage: npm run live:release -- check <session-dir> <review-dir> | pack <session-dir> <review-dir> <new-artifacts-dir>; no publishing or hardware commands",
    );
  if (mode === "check") {
    const plan = await planDistribution(session, review);
    console.log(
      JSON.stringify({
        eligible: true,
        sourceHash: plan.sourceHash,
        files: plan.publicFiles,
        published: false,
        qualificationScope: "distribution-boundary-only",
      }),
    );
  } else console.log(JSON.stringify(await packDistribution(session, review, output)));
}
