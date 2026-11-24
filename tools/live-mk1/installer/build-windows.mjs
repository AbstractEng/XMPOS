import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bundleInstaller } from "./bundle-common.mjs";
import { compilerRuntimeSource } from "./compiler-runtime-source.mjs";
import { windowsVersionSource } from "./version.mjs";
import { verifyWindowsRuntimeSources } from "./windows-runtime-review.mjs";

const here = import.meta.dirname,
  root = resolve(here, "../../..");
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  Number(process.versions.node.split(".")[0]) !== 24
)
  throw Error("Build on Windows x64 with Node 24");
const from = resolve(process.argv[2] || "build/windows-inputs"),
  output = resolve(process.argv[3] || "artifacts/windows-installer");
const resources = join(output, "resources");
await mkdir(resources, { recursive: true });
const hash = (b) => createHash("sha256").update(b).digest("hex");
const lock = JSON.parse(await readFile(join(here, "windows.lock.json"), "utf8"));
for (const [name, pin] of [
  ["7zr.exe", lock.sevenZip],
  ["7zip-src.tar.xz", lock.sevenZipSource],
]) {
  const b = await readFile(join(from, name));
  if (b.length !== pin.bytes || hash(b) !== pin.sha256) throw Error(`Changed ${name}`);
}
const host = join(from, "host-tools");
const reviewedRuntime = await verifyWindowsRuntimeSources(host);
await cp(join(host, "bin"), join(resources, "image-tools/bin"), { recursive: true });
await cp(join(host, "lib"), join(resources, "image-tools/lib"), { recursive: true });
const fsLock = JSON.parse(
  await readFile(join(root, "os/live-mk1/host-image-tools.lock.json"), "utf8"),
);
const binaries = {};
for (const name of ["debugfs", "e2fsck", "dumpe2fs", "mke2fs"])
  binaries[name] = {
    path: `image-tools/bin/${name}.exe`,
    sha256: hash(await readFile(join(host, "bin", `${name}.exe`))),
  };
await writeFile(
  join(resources, "image-tools/receipt.json"),
  JSON.stringify(
    { sourceSha256: fsLock.sha256, platform: "win32", arch: "x64", binaries },
    null,
    2,
  ),
);
const csc = join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const assemblyVersion = join(from, "InstallerVersion.cs");
await writeFile(assemblyVersion, windowsVersionSource());
execFileSync(csc, [
  "/nologo",
  "/platform:x64",
  "/target:winexe",
  `/win32icon:${join(here, "icon.ico")}`,
  `/out:${join(output, "XMP OS Installer.exe")}`,
  "/r:System.Windows.Forms.dll",
  join(here, "WindowsLauncher.cs"),
  assemblyVersion,
]);
execFileSync(csc, [
  "/nologo",
  "/platform:x64",
  "/target:exe",
  `/out:${join(resources, "host-helper.exe")}`,
  "/r:System.Windows.Forms.dll",
  "/r:System.Management.dll",
  "/r:System.Web.Extensions.dll",
  join(here, "WindowsHost.cs"),
  assemblyVersion,
]);
execFileSync(csc, [
  "/nologo",
  "/platform:x64",
  "/target:winexe",
  `/out:${join(resources, "stock-askpass.exe")}`,
  "/r:System.Windows.Forms.dll",
  join(here, "StockAskPass.cs"),
  assemblyVersion,
]);
await copyFile(process.execPath, join(resources, "node.exe"));
await copyFile(join(here, "windows.lock.json"), join(resources, "inputs.lock.json"));
await copyFile(join(from, "7zr.exe"), join(resources, "7zr.exe"));
await copyFile(join(here, "icon.ico"), join(output, "XMPInstaller.ico"));
const payload = join(from, "loader-payload");
const ledger = JSON.parse(await readFile(join(payload, "source-ledger.json"), "utf8"));
const receipt = JSON.parse(await readFile(join(payload, "bundle-manifest.json"), "utf8"));
for (const path of ["os/live-mk1/loader-init.c", "tools/sdk/toolchain.lock.json"])
  if (ledger.files[path] !== hash(await readFile(join(root, path))))
    throw Error("Changed loader payload source/compiler");
const init = await readFile(join(payload, "loader-init"));
if (hash(init) !== receipt.initHash) throw Error("Changed loader payload");
await writeFile(join(resources, "loader-init"), init);
const workspaceFiles = [
  "os/live-mk1/mpc-runtime.lock.json",
  "os/live-mk1/assets/boot-screen.json",
  "os/compatibility.json",
  "os/live-mk1/kernel.lock.json",
  "os/live-mk1/xmp-probe.boot.cmd",
  "os/live-mk1/mke2fs.conf",
  "tools/live-mk1/stock-rootfs.py",
  "tools/live-mk1/loader-audit.py",
  "tools/live-mk1/owner-runtime.py",
];
for (const path of workspaceFiles) {
  await mkdir(dirname(join(resources, "workspace", path)), { recursive: true });
  await copyFile(join(root, path), join(resources, "workspace", path));
}
const runtimeSources = await compilerRuntimeSource({
  python: join(host, "bin/python3.12.exe"),
  provided: join(from, "zig-runtime-source.tar.gz"),
  cache: join(from, "source-cache"),
});
const result = await bundleInstaller({
  resources,
  workspaceFiles,
  extraSources: [
    { from: assemblyVersion, to: "InstallerVersion.cs" },
    { from: runtimeSources, to: "Zig-0.13.0-compiler-runtime.tar.gz" },
    { from: join(host, "source"), to: "windows-host-tools" },
    { from: join(from, "7zip-src.tar.xz"), to: "7zip-src.tar.xz" },
  ],
  filesystemSourceArchive: join(host, "source/e2fsprogs-1.47.2.tar.xz"),
  nodeLicense: join(dirname(process.execPath), "LICENSE"),
  muslLicense: join(payload, "musl.txt"),
  platform: "win32",
  releaseInputs: join(from, "release"),
});
await copyFile(
  join(host, "source/WINDOWS-THIRD-PARTY-NOTICES.txt"),
  join(resources, "Licenses/Windows-host-runtime.txt"),
);
await writeFile(
  join(output, "PRIVATE-PREVIEW.txt"),
  "XMP OS Installer — private Windows x64 preview\r\nDouble-click XMP OS Installer.exe. Keep the resources folder beside it.\r\nNo Node, Python, Docker or command line is required on the owner computer.\r\nPhysical Windows USB driver/flash qualification remains unverified; source and licence inventory accompanies this build.\r\nThe owner must use the official 3.10.1 updater. Never share owner-generated images.\r\n",
);
// Add the post-bundle corresponding-source files to the integrity manifest.
const manifest = JSON.parse(await readFile(join(resources, "bundle-manifest.json"), "utf8"));
async function walk(dir, prefix) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = `${prefix}/${e.name}`;
    if (e.isDirectory()) await walk(join(dir, e.name), p);
    else if (e.isFile()) manifest.files[p] = hash(await readFile(join(dir, e.name)));
  }
}
await walk(join(resources, "Licenses"), "Licenses");
await writeFile(join(resources, "bundle-manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(
  join(output, "build-receipt.json"),
  JSON.stringify(
    {
      ...result,
      reviewedRuntime,
      platform: "win32",
      arch: "x64",
      containsAkaiFirmware: false,
      publication: "private preparation only",
      signing: "unsigned private preview",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output, ...result }));
