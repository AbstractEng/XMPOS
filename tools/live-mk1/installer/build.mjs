import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { vmCompiler } from "../../sdk/toolchain.mjs";
import { hostImageTools } from "../host-image-tools.mjs";
import { bundleInstaller } from "./bundle-common.mjs";
import { compilerRuntimeSource } from "./compiler-runtime-source.mjs";
import { minimalPythonRuntime } from "./minimal-python.mjs";

const here = import.meta.dirname,
  root = resolve(here, "../../..");
if (process.platform !== "darwin" || process.arch !== "x64")
  throw new Error("This installer build is currently qualified for Intel macOS only");
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Build with Node 24");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const outputIndex = process.argv.indexOf("--output");
const output =
  outputIndex < 0 ? join(root, "artifacts/installer") : resolve(process.argv[outputIndex + 1]);
const app = join(output, "XMP OS Installer.app");
const cache = join(root, "build/installer-inputs");
await mkdir(cache, { recursive: true });
await mkdir(join(cache, "swift-modules"), { recursive: true });
const swiftModules = await realpath(join(cache, "swift-modules"));
const pythonIndex = process.argv.indexOf("--python-from");
const python = await minimalPythonRuntime(
  pythonIndex < 0 ? null : process.argv[pythonIndex + 1],
  join(cache, "minimal-python"),
);
await mkdir(output, { recursive: true });
if (existsSync(app)) await rm(app, { recursive: true });
// Native launcher only starts the local UI; it never invokes a device command.
const resources = join(app, "Contents/Resources");
await mkdir(resources, { recursive: true });
await mkdir(join(app, "Contents/MacOS"));
await writeFile(
  join(app, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>XMPInstaller</string><key>CFBundleIdentifier</key><string>org.xmpos.installer</string><key>CFBundleName</key><string>XMP OS Installer</string><key>CFBundleIconFile</key><string>XMPInstaller.icns</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`,
);
execFileSync(
  "/usr/bin/swiftc",
  [
    "-O",
    "-module-cache-path",
    swiftModules,
    join(here, "Launcher.swift"),
    "-o",
    join(app, "Contents/MacOS/XMPInstaller"),
  ],
  { timeout: 120000 },
);
execFileSync(
  "/usr/bin/swiftc",
  [
    "-O",
    "-module-cache-path",
    swiftModules,
    join(here, "StockAskPass.swift"),
    "-o",
    join(resources, "stock-askpass"),
  ],
  { timeout: 120000 },
);
await copyFile(process.execPath, join(resources, "node"));
await chmod(join(resources, "node"), 0o755);
await copyFile(join(here, "inputs.lock.json"), join(resources, "inputs.lock.json"));
await copyFile(join(here, "index.html"), join(resources, "index.html"));
await copyFile(join(here, "icon.icns"), join(resources, "XMPInstaller.icns"));
await copyFile(join(here, "mac-volumes.py"), join(resources, "mac-volumes.py"));
await cp(join(python.directory, "python"), join(resources, "python"), { recursive: true });
await cp(join(python.directory, "licenses"), join(resources, "python/share/xmp-licenses"), {
  recursive: true,
});
await mkdir(join(resources, "bin"));
await writeFile(
  join(resources, "bin/python3"),
  '#!/bin/sh\nexec "$(/usr/bin/dirname "$0")/../python/bin/python3.13" -B "$@"\n',
  { mode: 0o755 },
);

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
const toolsOption = process.argv.indexOf("--tools-from");
let tools;
if (toolsOption !== -1) {
  const m = JSON.parse(
    await readFile(join(resolve(process.argv[toolsOption + 1]), "manifest.json"), "utf8"),
  );
  const pin = JSON.parse(
    await readFile(join(root, "os/live-mk1/host-image-tools.lock.json"), "utf8"),
  );
  if (
    m.builder.sourceSha256 !== pin.sha256 ||
    m.builder.platform !== process.platform ||
    m.builder.arch !== process.arch
  )
    throw new Error("Unverified host tools");
  tools = { receipt: m.builder };
  for (const [name, item] of Object.entries(m.builder.binaries)) {
    if (hash(await readFile(item.path)) !== item.sha256) throw new Error("Changed host tools");
    tools[name] = item.path;
  }
} else tools = await hostImageTools();
await mkdir(join(resources, "image-tools"));
const toolReceipt = structuredClone(tools.receipt);
tools.mke2fs = join(dirname(tools.dumpe2fs), "mke2fs");
toolReceipt.binaries.mke2fs = { path: tools.mke2fs, sha256: hash(await readFile(tools.mke2fs)) };
for (const name of ["debugfs", "e2fsck", "dumpe2fs", "mke2fs"]) {
  await copyFile(tools[name], join(resources, "image-tools", name));
  await chmod(join(resources, "image-tools", name), 0o755);
  // Only system macOS libraries are allowed in this portable Intel build.
  const dylibs = execFileSync("/usr/bin/otool", ["-L", tools[name]], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .filter(Boolean);
  if (
    dylibs.some(
      (line) => !line.trim().startsWith("/usr/lib/") && !line.trim().startsWith("/System/Library/"),
    )
  )
    throw new Error("Host tool has a non-system dependency");
  toolReceipt.binaries[name].path = `image-tools/${name}`;
}
await writeFile(join(resources, "image-tools/receipt.json"), JSON.stringify(toolReceipt, null, 2));
const payloadIndex = process.argv.indexOf("--payload-from");
let zig = null;
if (payloadIndex >= 0) {
  const from = resolve(process.argv[payloadIndex + 1]);
  const previous = JSON.parse(await readFile(join(from, "source-ledger.json"), "utf8"));
  const receipt = JSON.parse(await readFile(join(from, "bundle-manifest.json"), "utf8"));
  const bytes = await readFile(join(from, "loader-init"));
  for (const path of ["os/live-mk1/loader-init.c", "tools/sdk/toolchain.lock.json"])
    if (previous.files[path] !== hash(await readFile(join(root, path))))
      throw new Error("Cached loader source/compiler changed; rebuild payload");
  if (hash(bytes) !== receipt.initHash) throw new Error("Changed retained loader payload");
  await writeFile(join(resources, "loader-init"), bytes);
} else {
  zig = await vmCompiler();
  execFileSync(
    zig,
    [
      "cc",
      "-target",
      "arm-linux-musleabihf",
      "-mcpu=cortex_a17",
      "-static",
      "-s",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "os/live-mk1/loader-init.c",
      "-o",
      join(resources, "loader-init"),
    ],
    { cwd: root, timeout: 120000 },
  );
}
const fsLock = JSON.parse(
  await readFile(join(root, "os/live-mk1/host-image-tools.lock.json"), "utf8"),
);
const fsArchive = join(
  root,
  "references/archives/host-image-tools",
  `e2fsprogs-${fsLock.release}.tar.xz`,
);
let archive = fsArchive;
if (!existsSync(archive) && toolsOption !== -1)
  archive = join(
    resolve(dirname(tools.debugfs), "../../../.."),
    "references/archives/host-image-tools",
    `e2fsprogs-${fsLock.release}.tar.xz`,
  );
if (!existsSync(archive) || hash(await readFile(archive)) !== fsLock.sha256)
  throw new Error("Exact e2fsprogs source archive is required beside the host-tool build");
const rtIndex = process.argv.indexOf("--compiler-rt-from");
const runtimeSources = await compilerRuntimeSource({
  python: join(python.directory, "python/bin/python3.13"),
  provided: rtIndex < 0 ? null : process.argv[rtIndex + 1],
  compilerDirectory: rtIndex < 0 ? dirname(zig ?? (await vmCompiler())) : null,
  cache,
});
const { sourceHash, initHash } = await bundleInstaller({
  extraSources: [
    { from: runtimeSources, to: "Zig-0.13.0-compiler-runtime.tar.gz" },
    { from: join(python.directory, "source"), to: "mac-python" },
    { from: join(python.directory, "receipt.json"), to: "mac-python-receipt.json" },
  ],
  releaseInputs: process.argv.includes("--release-from")
    ? resolve(process.argv[process.argv.indexOf("--release-from") + 1])
    : undefined,
  resources,
  workspaceFiles,
  filesystemSourceArchive: archive,
  nodeLicense: join(dirname(dirname(process.execPath)), "LICENSE"),
  muslLicense: zig
    ? join(dirname(zig), "lib/libc/musl/COPYRIGHT")
    : join(resolve(process.argv[payloadIndex + 1]), "musl.txt"),
});
execFileSync("/usr/bin/plutil", [
  "-replace",
  "CFBundleIdentifier",
  "-string",
  "org.xmpos.installer",
  join(app, "Contents/Info.plist"),
]);
execFileSync("/usr/bin/plutil", [
  "-replace",
  "CFBundleName",
  "-string",
  "XMP OS Installer",
  join(app, "Contents/Info.plist"),
]);
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" });
await writeFile(
  join(output, "build-receipt.json"),
  JSON.stringify(
    {
      app,
      sourceHash,
      initHash,
      platform: process.platform,
      arch: process.arch,
      publication: "private preparation only",
      containsAkaiFirmware: false,
      signing: "ad-hoc; not Developer ID notarized",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(
  `Built ${app}\nSource ${sourceHash}\nPrivate Intel macOS preview; no device contacted.`,
);
