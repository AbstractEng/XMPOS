import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { assembleOwnerImage, verifyTemplate } from "../assemble-image.mjs";
import { buildHostLoader } from "../host-loader.mjs";
import {
  lockFile,
  publishArtifactPointer,
  pythonRuntime,
  readJson,
  temporaryArtifact,
} from "../image-artifacts.mjs";
import { requirePreparationSpace } from "../loader-preparation.mjs";
import { prepareOwnerRuntime } from "../owner-runtime.mjs";
import { verifyOwnerImage } from "../verify-owner-image.mjs";

export async function prepareInstallation({
  updater,
  resources,
  workspace,
  log = () => {},
  phase = () => {},
}) {
  phase("Verifying updater and preparing the MPC loader");
  const loader = await buildHostLoader(updater);
  log(
    loader.reused
      ? "Reused your verified MPC loader."
      : "MPC loader prepared and audited; only the boot script changed.",
  );
  phase("Verifying the bundled XMP template");
  const templateDir = join(resources, "xmp-template");
  const template = await verifyTemplate(templateDir);
  const runtimeRoot = join(workspace, "artifacts/live-mk1");
  await mkdir(runtimeRoot, { recursive: true });
  let runtime = null;
  try {
    const p = await readJson(join(runtimeRoot, "latest-installer-runtime.json"));
    const at = resolve(workspace, p.directory);
    if (!at.startsWith(resolve(workspace, "artifacts") + sep))
      throw Error("Invalid runtime cache path");
    pythonRuntime(["verify-runtime", at, lockFile]);
    runtime = at;
  } catch {}
  if (!runtime) {
    phase("Extracting owner-local 3.10.1 runtime files");
    await requirePreparationSpace(workspace, 128 * 1024 ** 2);
    const container = await temporaryArtifact("runtime-cache-");
    const out = join(container, "runtime");
    try {
      await prepareOwnerRuntime(updater, out);
      pythonRuntime(["verify-runtime", out, lockFile]);
      runtime = out;
      await publishArtifactPointer("latest-installer-runtime.json", {
        directory: relative(workspace, out),
      });
    } catch (e) {
      await rm(container, { recursive: true, force: true });
      throw e;
    }
  }
  const auditedRuntime = pythonRuntime(["verify-runtime", runtime, lockFile]);
  let owner = null;
  try {
    const p = await readJson(join(runtimeRoot, "latest-owner-session-image.json"));
    const at = resolve(workspace, p.directory);
    if (!at.startsWith(resolve(workspace, "artifacts") + sep))
      throw Error("Invalid owner cache path");
    const v = await verifyOwnerImage(join(at, "system.img"));
    if (
      v.manifest.template.imageSha256 !== template.image.sha256 ||
      v.manifest.runtime.preparationSha256 !== auditedRuntime.preparationSha256
    )
      throw Error("Owner image inputs changed");
    pythonRuntime([
      "audit-owner",
      join(at, "system.img"),
      join(templateDir, "system.img"),
      runtime,
      lockFile,
    ]);
    owner = { directory: at, sha256: v.sha256, manifest: v.manifest };
    log("Reused your verified XMP USB system image.");
  } catch {}
  if (!owner) {
    phase("Assembling the XMP USB system image");
    await requirePreparationSpace(workspace, 128 * 1024 ** 2);
    const container = await temporaryArtifact("owner-cache-");
    const out = join(container, "owner");
    const r = await assembleOwnerImage(templateDir, runtime, out);
    const v = await verifyOwnerImage(join(out, "system.img"));
    owner = { directory: r.directory, sha256: v.sha256, manifest: r.manifest };
    log("XMP USB system image assembled and audited against the exact template and runtime files.");
  }
  return {
    directory: loader.directory,
    sha256: loader.manifest.output.sha256,
    ownerImage: {
      image: join(owner.directory, "system.img"),
      sha256: owner.sha256,
      sourceHash: template.manifest.sourceHash,
    },
    reusedLoader: loader.reused,
  };
}
