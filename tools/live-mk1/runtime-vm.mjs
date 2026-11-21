import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { emulator } from "../os/vm.mjs";
import { verifyTemplate } from "./assemble-image.mjs";
import {
  inputDirectory,
  lockFile,
  pythonRuntime,
  readJson,
  regularFile,
  temporaryArtifact,
  writeManifest,
} from "./image-artifacts.mjs";

export async function testDynamicRuntime(
  templateDirectory,
  ownerDirectory,
  kernelDirectory = null,
) {
  const template = await verifyTemplate(templateDirectory),
    owner = await inputDirectory(ownerDirectory);
  const manifest = await readJson(join(owner, "manifest.json"));
  const image = await regularFile(join(owner, "system.img"));
  if (
    manifest.format !== "xmp-live-mk1-owner-session-image" ||
    manifest.runtimeLibrariesIncluded !== true ||
    manifest.template?.imageSha256 !== template.image.sha256 ||
    image.sha256 !== manifest.files?.["system.img"]?.sha256
  )
    throw new Error("Matching verified owner image required for ARM runtime test");
  const probe = await regularFile(join(template.directory, "runtime-probe"), 8 * 1024 * 1024);
  if (probe.sha256 !== template.manifest.files?.["runtime-probe"]?.sha256)
    throw new Error("Runtime probe differs from build");
  if (!kernelDirectory) {
    const pointer = await readJson(join(root, "artifacts/live-mk1/latest-kernel.json"));
    kernelDirectory = resolve(root, pointer.directory);
  }
  const kernel = await inputDirectory(kernelDirectory),
    km = await readJson(join(kernel, "manifest.json"));
  const kImage = await regularFile(join(kernel, "zImage"), 32 * 1024 * 1024);
  if (km.format !== "xmp-live-mk1-kernel" || kImage.sha256 !== km.zImage?.sha256)
    throw new Error("Kernel build hash mismatch");
  const qemu = await emulator("armv7");
  const out = await temporaryArtifact("dynamic-runtime-vm-");
  const cpio = pythonRuntime([
    "runtime-cpio",
    join(owner, "system.img"),
    join(template.directory, "system.img"),
    join(template.directory, "runtime-probe"),
    lockFile,
    join(out, "runtime.cpio.gz"),
  ]);
  const args = [
    "-no-user-config",
    "-nodefaults",
    "-machine",
    "virt,highmem=off",
    "-accel",
    "tcg",
    "-cpu",
    "cortex-a15",
    "-smp",
    "2",
    "-m",
    "256",
    "-display",
    "none",
    "-monitor",
    "none",
    "-serial",
    "stdio",
    "-nic",
    "none",
    "-no-reboot",
    "-kernel",
    join(kernel, "zImage"),
    "-initrd",
    join(out, "runtime.cpio.gz"),
    "-append",
    "console=ttyAMA0 rdinit=/init panic=-1",
  ];
  const result = spawnSync(qemu.binary, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  await writeFile(join(out, "console.log"), log);
  const passed =
    !result.error &&
    result.status === 0 &&
    /XMP_DYNAMIC_RUNTIME_OK libc=2\.39 alsa=1\.2\.11 threads=7168 unwind=1 config=1/.test(log);
  const report = {
    format: "xmp-dynamic-runtime-vm-test",
    version: 1,
    passed,
    sourceHash: template.manifest.sourceHash,
    publicTemplateSha256: template.image.sha256,
    ownerImageSha256: image.sha256,
    kernelSha256: kImage.sha256,
    probeSha256: probe.sha256,
    cpio,
    command: [qemu.binary, ...args],
    checks: [
      "ARM ELF loader and glibc",
      "C++ allocation and exceptions/unwinding",
      "pthread/TLS",
      "libm",
      "ALSA version and configuration",
    ],
    audioHardwareTested: false,
    sessionWorkflowTested: false,
    hardwareAccess: false,
    network: false,
    error: result.error?.message ?? null,
    exitCode: result.status,
  };
  await writeManifest(join(out, "result.json"), report);
  return { directory: out, result: report };
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.length !== 2 && args.length !== 3)
    throw new Error(
      "Usage: npm run live:runtime-vm -- <template-directory> <owner-image-directory> [kernel-directory]",
    );
  const outcome = await testDynamicRuntime(...args);
  console.log(
    JSON.stringify({ directory: relative(root, outcome.directory), ...outcome.result }, null, 2),
  );
  process.exitCode = outcome.result.passed ? 0 : 1;
}
