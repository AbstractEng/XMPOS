import { rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { MPC_RUNTIME, requireSupportedUpdater } from "./compatibility.mjs";
import {
  inputDirectory,
  lockFile,
  makeExt4,
  newArtifactDirectory,
  publishArtifactPointer,
  pythonRuntime,
  readJson,
  regularFile,
  runtimeLockHash,
  writeManifest,
} from "./image-artifacts.mjs";

export async function verifyTemplate(directory) {
  const at = await inputDirectory(directory);
  const manifest = await readJson(join(at, "manifest.json"));
  if (
    !["xmp-live-mk1-session-image", "xmp-live-mk1-public-distribution"].includes(manifest.format) ||
    manifest.version !== 1 ||
    manifest.runtimeMode !== "owner-local-3.10.1" ||
    manifest.runtimeLibrariesIncluded !== false ||
    manifest.mpcOsVersion !== "3.10.1" ||
    manifest.containsProprietaryAkaiAssets === true ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceHash ?? "")
  )
    throw new Error("Reviewed owner-local 3.10.1 public template profile required");
  if (manifest.runtimeLockSha256 !== (await runtimeLockHash()))
    throw new Error("Runtime lock differs from the template");
  requireSupportedUpdater(manifest.updaterImageSha256 ?? manifest.localUpdater?.imageSha256);
  const actual = await regularFile(join(at, "system.img"));
  if (
    actual.sha256 !== manifest.files?.["system.img"]?.sha256 ||
    actual.bytes !== manifest.files["system.img"].bytes
  )
    throw new Error("Template image differs from its manifest");
  const audit = pythonRuntime(["audit-public", join(at, "system.img"), lockFile]);
  return {
    directory: at,
    manifest,
    image: actual,
    audit,
    manifestFile: await regularFile(join(at, "manifest.json"), 256 * 1024),
  };
}

export async function assembleOwnerImage(
  templateDirectory,
  runtimeDirectory,
  destination,
  { emulator = false } = {},
) {
  const template = await verifyTemplate(templateDirectory);
  const runtime = await inputDirectory(runtimeDirectory);
  // Verify all pinned files before reserving an output. Extra files/symlinks fail.
  const runtimeAudit = pythonRuntime(["verify-runtime", runtime, lockFile]);
  const out = await newArtifactDirectory(destination);
  const stage = join(out, ".tree");
  try {
    pythonRuntime([
      "stage-owner",
      join(template.directory, "system.img"),
      runtime,
      lockFile,
      stage,
    ]);
    const files = {},
      tools = {};
    tools.live = await makeExt4(stage, join(out, "system.img"));
    const liveAudit = pythonRuntime([
      "audit-owner",
      join(out, "system.img"),
      join(template.directory, "system.img"),
      runtime,
      lockFile,
    ]);
    for (const [name, expected] of Object.entries(template.audit.fileHashes))
      if (liveAudit.fileHashes[name] !== expected)
        throw new Error("Assembled public files changed during assembly");
    if (liveAudit.preparationSha256 !== runtimeAudit.preparationSha256)
      throw new Error("Runtime receipt changed during assembly");
    files["system.img"] = await regularFile(join(out, "system.img"));
    if (emulator) {
      // Only locally built XMP extras, never vendor executables or arbitrary paths.
      for (const name of ["init-emulator", "live-twin"]) {
        const expected = template.manifest.files?.[name];
        const actual = await regularFile(join(template.directory, name), 16 * 1024 * 1024);
        if (actual.sha256 !== expected?.sha256 || actual.bytes !== expected.bytes)
          throw new Error(`Missing or changed emulator build input: ${name}`);
      }
      pythonRuntime([
        "stage-emulator",
        stage,
        join(template.directory, "init-emulator"),
        join(template.directory, "live-twin"),
        lockFile,
      ]);
      tools.emulator = await makeExt4(stage, join(out, "system-emulator.img"));
      const emulatorAudit = pythonRuntime([
        "audit-owner",
        join(out, "system-emulator.img"),
        join(template.directory, "system.img"),
        runtime,
        lockFile,
        join(template.directory, "init-emulator"),
        join(template.directory, "live-twin"),
      ]);
      if (
        emulatorAudit.fileHashes["/sbin/init"] !==
          template.manifest.files["init-emulator"].sha256 ||
        emulatorAudit.fileHashes["/usr/lib/xmp/xmp-live-twin"] !==
          template.manifest.files["live-twin"].sha256
      )
        throw new Error("Emulator inputs changed during assembly");
      files["system-emulator.img"] = await regularFile(join(out, "system-emulator.img"));
    }
    const manifest = {
      format: "xmp-live-mk1-owner-session-image",
      version: 1,
      target: "inmusic,acv8",
      mpcOsVersion: "3.10.1",
      sourceHash: template.manifest.sourceHash,
      runtimeMode: "owner-local-3.10.1",
      runtimeLibrariesIncluded: true,
      template: {
        imageSha256: template.image.sha256,
        manifestSha256: template.manifestFile.sha256,
      },
      runtime: {
        lockSha256: await runtimeLockHash(),
        updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
        rootfsSha256: MPC_RUNTIME.rootfsSha256,
        preparationSha256: runtimeAudit.preparationSha256,
      },
      files,
      tools,
      sameSessionBinary: true,
      sessionBinarySha256: template.audit.fileHashes["/usr/lib/xmp/xmp-live-session"],
      publicRedistributionApproved: false,
      redistribution: "forbidden: owner-local runtime-bearing image",
      copiedToDevice: false,
      hardwareAccess: false,
      abiExecutionTested: false,
    };
    await writeManifest(join(out, "manifest.json"), manifest);
    if (
      (await regularFile(join(template.directory, "system.img"))).sha256 !==
        template.image.sha256 ||
      (await regularFile(join(template.directory, "manifest.json"))).sha256 !==
        template.manifestFile.sha256
    )
      throw new Error("Template changed during assembly");
    await publishArtifactPointer("latest-owner-session-image.json", {
      directory: relative(root, out),
      sourceHash: manifest.sourceHash,
    });
    return { directory: out, manifest };
  } catch (error) {
    // Keep diagnostics but do not leave a promotable image or pointer on failure.
    await rm(join(out, "manifest.json"), { force: true });
    await rm(join(out, "system.img"), { force: true });
    await rm(join(out, "system-emulator.img"), { force: true });
    await writeFile(join(out, "failure.txt"), `${error.message}\n`, { flag: "wx" });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2),
    emulator = args.at(-1) === "--emulator";
  if (emulator) args.pop();
  if (args.length !== 3)
    throw new Error(
      "Usage: npm run live:assemble -- <template-directory> <owner-runtime-directory> artifacts/<new-directory> [--emulator]",
    );
  const result = await assembleOwnerImage(...args, { emulator });
  console.log(
    JSON.stringify({ directory: relative(root, result.directory), ...result.manifest }, null, 2),
  );
}
