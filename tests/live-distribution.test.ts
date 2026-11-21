import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MPC_RUNTIME } from "../tools/live-mk1/compatibility.mjs";
import {
  INSTALL_STEPS,
  PUBLIC_FILES,
  packDistribution,
  planDistribution,
} from "../tools/live-mk1/distribution.mjs";

// Policy-only fixtures. These are not an actual filesystem, legal clearance,
// installation evidence or a hardware qualification result.
const runtimeLock = createHash("sha256")
  .update(readFileSync("os/live-mk1/mpc-runtime.lock.json"))
  .digest("hex");
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const identity = (b: Buffer) => ({ sha256: hash(b), bytes: b.length });
let directory: string, session: string, review: string, output: string;
const json = (name: string) => JSON.parse(readFileSync(name, "utf8"));
const save = (name: string, value: unknown) => writeFileSync(name, JSON.stringify(value));
function reseal() {
  const record = json(join(review, "clearance.json"));
  record.sessionManifestSha256 = hash(readFileSync(join(session, "manifest.json")));
  record.installationSha256 = hash(readFileSync(join(review, "installation.json")));
  save(join(review, "clearance.json"), record);
}
beforeEach(() => {
  mkdirSync("artifacts", { recursive: true });
  directory = mkdtempSync(resolve("artifacts/r01-policy-test-"));
  session = join(directory, "session");
  review = join(directory, "review");
  output = join(directory, "public");
  mkdirSync(session);
  mkdirSync(review);
  const image = spawnSync("python3", ["-I", "tests/fixtures/public-filesystem.py"]);
  if (image.status !== 0) throw new Error(String(image.stderr));
  const payload = image.stdout;
  const notices = Buffer.from("Synthetic component notices");
  const sourceRows = [
    "xmp",
    "libc-startup",
    "alsa-lib",
    "libc",
    "gcc-runtime",
    "inter",
    "jetbrains-mono",
  ].map((id) => ({
    id,
    license: "TEST-ONLY",
    version: "synthetic",
    source: `https://example.invalid/source/${id}`,
    sourcePath: `sources/${id}.txt`,
    sourceSha256: hash(`Synthetic source ${id}`),
  }));
  const made = spawnSync("python3", [
    "-I",
    "-c",
    `import io,sys,tarfile,json
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as archive:
 for name,data in [('BUILDING.md', b'Synthetic build instructions'),('STATIC-LINKING.md', b'Synthetic relink instructions')]+[(c['sourcePath'],('Synthetic source '+c['id']).encode()) for c in json.loads(sys.argv[1])]:
  member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
`,
    JSON.stringify(sourceRows),
  ]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  const sources = made.stdout;
  writeFileSync(join(session, "system.img"), payload);
  writeFileSync(join(review, "THIRD-PARTY-NOTICES.txt"), notices);
  writeFileSync(join(review, "corresponding-source.tar.gz"), sources);
  save(join(session, "manifest.json"), {
    format: "xmp-live-mk1-session-image",
    version: 1,
    sourceHash: "a".repeat(64),
    containsProprietaryAkaiAssets: false,
    runtimeMode: "owner-local-3.10.1",
    runtimeLibrariesIncluded: false,
    mpcOsVersion: "3.10.1",
    runtimeLockSha256: runtimeLock,
    updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
    files: { "system.img": identity(payload) },
  });
  const steps = INSTALL_STEPS.map((id, i) => {
    const file = `step-${i}.txt`,
      evidence = `Synthetic policy observation ${id}`;
    writeFileSync(join(review, file), evidence);
    return {
      id,
      outcome: "passed",
      observedAt: `2026-11-16T12:0${i}:00Z`,
      evidence: { file, sha256: hash(evidence) },
    };
  });
  save(join(review, "installation.json"), {
    format: "xmp-live-mk1-installation-evidence",
    version: 2,
    status: "passed",
    method: "owner-observed-physical",
    synthetic: false,
    target: "inmusic,acv8",
    sourceHash: "a".repeat(64),
    sessionImageSha256: "e".repeat(64),
    publicTemplateSha256: hash(payload),
    runtimeLockSha256: runtimeLock,
    ownerAssemblyManifestSha256: "0".repeat(64),
    loaderImageSha256: "b".repeat(64),
    updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
    stockRootfsSha256: "d".repeat(64),
    privateDeviceIdentitySha256: "e".repeat(64),
    startingMpcOsVersion: "3.10.1",
    restoredMpcOsVersion: "3.10.1",
    steps,
  });
  const assembly = {
    format: "xmp-live-mk1-owner-session-image",
    version: 1,
    mpcOsVersion: "3.10.1",
    sourceHash: "a".repeat(64),
    runtimeMode: "owner-local-3.10.1",
    runtimeLibrariesIncluded: true,
    publicRedistributionApproved: false,
    template: {
      imageSha256: hash(payload),
      manifestSha256: hash(readFileSync(join(session, "manifest.json"))),
    },
    runtime: {
      lockSha256: runtimeLock,
      rootfsSha256: MPC_RUNTIME.rootfsSha256,
      updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
    },
    files: { "system.img": { sha256: "e".repeat(64), bytes: 4096 } },
  };
  save(join(review, "owner-assembly.json"), assembly);
  const installation = json(join(review, "installation.json"));
  installation.ownerAssemblyManifestSha256 = hash(
    readFileSync(join(review, "owner-assembly.json")),
  );
  save(join(review, "installation.json"), installation);
  save(join(review, "clearance.json"), {
    format: "xmp-live-mk1-distribution-review",
    version: 1,
    status: "approved",
    releaseVersion: "0.1.0-test",
    target: "inmusic,acv8",
    sourceHash: "a".repeat(64),
    sessionManifestSha256: "0".repeat(64),
    installationSha256: "0".repeat(64),
    updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
    reviewReference: "https://example.invalid/review/policy-fixture",
    proprietaryAkaiAssets: "excluded",
    staticLinkingAndCorrespondingSourceReview: "complete",
    components: sourceRows,
    files: {
      "system.img": identity(payload),
      "THIRD-PARTY-NOTICES.txt": identity(notices),
      "corresponding-source.tar.gz": identity(sources),
    },
  });
  save(join(review, "loader-manifest.json"), {
    format: "xmp-live-mk1-loader-image",
    containsVendorFirmware: true,
    sourceHash: "a".repeat(64),
    output: { sha256: "b".repeat(64) },
    source: { imageSha256: MPC_RUNTIME.updaterImageSha256 },
  });
  save(join(review, "stock-receipt.json"), {
    format: "xmp-local-stock-rootfs",
    updaterSignatureVerified: true,
    verifiedAgainstFreshExtraction: true,
    target: "inmusic,acv8",
    updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
    output: { sha256: "d".repeat(64) },
  });
  const record = json(join(review, "clearance.json"));
  for (const [name, path] of Object.entries({
    "INSTALL.md": "docs/install-live-mk1.md",
    "RECOVERY.md": "docs/recover-live-mk1.md",
    LICENSE: "LICENSE",
  }))
    record.files[name] = identity(readFileSync(path));
  save(join(review, "clearance.json"), record);
  reseal();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("Live distributable package boundary", () => {
  it("ships only the fixed allowlist and redacts private evidence/build siblings", async () => {
    writeFileSync(join(session, "rootfs-xmp-loader.ext4"), "NEVER DISTRIBUTE ME");
    writeFileSync(join(review, "private.log"), "PRIVATE OWNER LOG");
    const result = await packDistribution(session, review, output);
    const archive = join(output, String(result.filename));
    const listing = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps(z.namelist()));print(z.read('manifest.json').decode())",
        archive,
      ],
      { encoding: "utf8" },
    );
    expect(listing.status).toBe(0);
    const [names, ...manifest] = listing.stdout.trim().split("\n");
    expect(JSON.parse(names ?? "[]").sort()).toEqual([...PUBLIC_FILES].sort());
    expect(manifest.join("\n")).not.toContain("privateDeviceIdentity");
    expect(manifest.join("\n")).not.toContain("builder");
    expect(result.published).toBe(false);
    await expect(packDistribution(session, review, output)).rejects.toThrow();
    expect(existsSync(archive)).toBe(true);
  });
  it("binds a separately built loader to its exact source and manifest, preserving session identity", async () => {
    const loader = json(join(review, "loader-manifest.json"));
    loader.sourceHash = "f".repeat(64);
    save(join(review, "loader-manifest.json"), loader);
    await expect(planDistribution(session, review)).rejects.toThrow(/Loader source/);
    const evidence = json(join(review, "installation.json"));
    evidence.version = 3;
    evidence.loaderSourceHash = loader.sourceHash;
    evidence.loaderManifestSha256 = hash(readFileSync(join(review, "loader-manifest.json")));
    save(join(review, "installation.json"), evidence);
    reseal();
    expect((await planDistribution(session, review)).sourceHash).toBe("a".repeat(64));
    loader.source.extra = "changed after observation";
    save(join(review, "loader-manifest.json"), loader);
    await expect(planDistribution(session, review)).rejects.toThrow(/Loader manifest hash/);
  });
  it("refuses incomplete separate-loader bindings", async () => {
    const evidence = json(join(review, "installation.json"));
    evidence.version = 3;
    evidence.loaderSourceHash = "a".repeat(64);
    save(join(review, "installation.json"), evidence);
    reseal();
    await expect(planDistribution(session, review)).rejects.toThrow();
  });
  it("inspects the filesystem even when flags and hashes claim clearance", async () => {
    const made = spawnSync("python3", [
      "-I",
      "tests/fixtures/public-filesystem.py",
      "/lib/libc.so.6",
    ]);
    writeFileSync(join(session, "system.img"), made.stdout);
    const manifest = json(join(session, "manifest.json"));
    manifest.files["system.img"] = identity(made.stdout);
    save(join(session, "manifest.json"), manifest);
    const record = json(join(review, "clearance.json"));
    record.files["system.img"] = identity(made.stdout);
    save(join(review, "clearance.json"), record);
    reseal();
    await expect(planDistribution(session, review)).rejects.toThrow(/Unapproved public filesystem/);
  });
  it("refuses legacy static and owner-assembled runtime images", async () => {
    const original = json(join(session, "manifest.json"));
    for (const patch of [
      { runtimeMode: "legacy-static-development-only" },
      { runtimeLibrariesIncluded: true },
      { mpcOsVersion: "3.10.0" },
    ]) {
      save(join(session, "manifest.json"), { ...original, ...patch });
      await expect(planDistribution(session, review)).rejects.toThrow(/owner-local/);
    }
  });
  it("pins installation and stock evidence to MPC OS 3.10.1", async () => {
    const original = json(join(review, "installation.json"));
    for (const version of ["3.10.0", "3.10.2"]) {
      save(join(review, "installation.json"), {
        ...original,
        startingMpcOsVersion: version,
        restoredMpcOsVersion: version,
      });
      reseal();
      await expect(planDistribution(session, review)).rejects.toThrow();
    }
    save(join(review, "installation.json"), { ...original, updaterImageSha256: "c".repeat(64) });
    reseal();
    await expect(planDistribution(session, review)).rejects.toThrow(/pinned/);
  });
  it("refuses loader/probe/stock metadata despite a claimed clearance", async () => {
    const manifest = json(join(session, "manifest.json"));
    for (const format of [
      "xmp-live-mk1-loader-image",
      "xmp-live-mk1-probe-image",
      "stock-rootfs",
    ]) {
      save(join(session, "manifest.json"), { ...manifest, format, containsVendorFirmware: true });
      reseal();
      await expect(planDistribution(session, review)).rejects.toThrow(/local-only/);
    }
  });
  it("does not accept no-vendor flags as clearance or permit substituted payloads", async () => {
    const record = json(join(review, "clearance.json"));
    save(join(review, "clearance.json"), { ...record, status: "pending" });
    await expect(packDistribution(session, review, output)).rejects.toThrow();
    expect(existsSync(output)).toBe(false);
    save(join(review, "clearance.json"), record);
    writeFileSync(join(session, "system.img"), "substituted firmware");
    await expect(planDistribution(session, review)).rejects.toThrow(/hash/);
  });
  it("binds the private booted image and runtime lock to the public template", async () => {
    const original = json(join(review, "owner-assembly.json"));
    for (const patch of [
      { ...original, runtime: { ...original.runtime, lockSha256: "0".repeat(64) } },
      { ...original, template: { ...original.template, imageSha256: "0".repeat(64) } },
      { ...original, files: { "system.img": { sha256: "0".repeat(64), bytes: 4096 } } },
    ]) {
      save(join(review, "owner-assembly.json"), patch);
      const evidence = json(join(review, "installation.json"));
      evidence.ownerAssemblyManifestSha256 = hash(
        readFileSync(join(review, "owner-assembly.json")),
      );
      save(join(review, "installation.json"), evidence);
      reseal();
      await expect(planDistribution(session, review)).rejects.toThrow(/Assembly/);
    }
  });
  it("refuses simulated, incomplete, stale or tampered owner observations", async () => {
    const original = json(join(review, "installation.json"));
    for (const patch of [
      { synthetic: true },
      { steps: original.steps.slice(1) },
      { sessionImageSha256: "0".repeat(64) },
    ]) {
      save(join(review, "installation.json"), { ...original, ...patch });
      reseal();
      await expect(planDistribution(session, review)).rejects.toThrow();
    }
    save(join(review, "installation.json"), original);
    reseal();
    writeFileSync(join(review, "step-0.txt"), "changed observation");
    await expect(planDistribution(session, review)).rejects.toThrow(/evidence hash/);
  });
  it("refuses owner-local rootfs files hidden in an otherwise approved source archive", async () => {
    const archive = spawnSync("python3", [
      "-I",
      "-c",
      `import io,sys,tarfile
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as a:
 m=tarfile.TarInfo('rootfs-xmp-loader.ext4');m.size=4;a.addfile(m,io.BytesIO(b'FAKE'))
`,
    ]);
    const source = join(review, "corresponding-source.tar.gz");
    writeFileSync(source, archive.stdout);
    const record = json(join(review, "clearance.json"));
    record.files["corresponding-source.tar.gz"] = identity(archive.stdout);
    save(join(review, "clearance.json"), record);
    await expect(planDistribution(session, review)).rejects.toThrow(/Owner-local firmware/);
  });

  it("refuses symlinked payloads and missing component/source review", async () => {
    const record = json(join(review, "clearance.json"));
    save(join(review, "clearance.json"), { ...record, components: record.components.slice(1) });
    await expect(planDistribution(session, review)).rejects.toThrow();
    save(join(review, "clearance.json"), record);
    const target = join(session, "system.img");
    rmSync(target);
    symlinkSync(join(review, "THIRD-PARTY-NOTICES.txt"), target);
    await expect(planDistribution(session, review)).rejects.toThrow(/regular/);
  });
});
