// Rebuild installer application code around the exact already-published runtime.
// No device is opened and no owner state/updater is an input to this command.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInstaller } from "./bundle-common.mjs";
import previous from "./previous-release.lock.json" with { type: "json" };
import { INSTALLER_VERSION, windowsVersionSource } from "./version.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const [platformId, archiveInput, outputInput, nativeInput] = process.argv.slice(2);
const pin = previous.kits[platformId];
if (process.platform !== "darwin" || !pin || !archiveInput || !outputInput)
  throw Error(
    "Usage on macOS: node rebuild-release.mjs <platform ID> <published ZIP> <new output> [Windows native outputs]",
  );
const archive = resolve(archiveInput),
  output = resolve(outputInput);
if (basename(archive) !== pin.file || hash(await readFile(archive)) !== pin.sha256)
  throw Error("Previous published installer archive does not match its pinned hash");
await mkdir(output, { recursive: false }); // Never overwrite a previous release/staging directory.
const extracted = join(output, "previous");
await mkdir(extracted);
execFileSync("/usr/bin/ditto", ["-x", "-k", archive, extracted], { timeout: 300000 });
const mac = pin.platform === "darwin";
const kit = mac ? extracted : join(extracted, "installer");
const app = join(kit, "XMP OS Installer.app");
const resources = mac ? join(app, "Contents/Resources") : join(kit, "resources");
const original = JSON.parse(await readFile(join(resources, "bundle-manifest.json"), "utf8"));
if (original.platform !== pin.platform || original.arch !== pin.arch)
  throw Error("Previous package platform mismatch");
for (const [path, digest] of Object.entries(original.files)) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
    throw Error("Unsafe previous resource path");
  if (hash(await readFile(join(resources, path))) !== digest)
    throw Error(`Previous resource changed: ${path}`);
}
if (mac) execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const oldSources = join(output, "runtime-sources");
await rename(join(resources, "Corresponding Source"), oldSources);
const release = join(output, "release-inputs");
await mkdir(join(release, "hardware-candidate/template"), { recursive: true });
await mkdir(join(release, "downloads"), { recursive: true });
for (const name of ["system.img", "manifest.json"])
  await copyFile(
    join(resources, "xmp-template", name),
    join(release, "hardware-candidate/template", name),
  );
await copyFile(
  join(oldSources, "xmp-session-source.tar.gz"),
  join(release, "downloads/xmp-source.tar.gz"),
);
await copyFile(
  join(resources, "Licenses/XMP-session-third-party.txt"),
  join(release, "downloads/THIRD-PARTY-NOTICES.txt"),
);
const licenses = join(output, "runtime-licenses");
await cp(join(resources, "Licenses"), licenses, { recursive: true });
for (const name of ["Licenses", "demo", "xmp-template"])
  await rm(join(resources, name), { recursive: true });
const extras = [
  "Zig-0.13.0-compiler-runtime.tar.gz",
  ...(mac ? ["mac-python", "mac-python-receipt.json"] : ["windows-host-tools", "7zip-src.tar.xz"]),
].map((name) => ({ from: join(oldSources, name), to: name }));
let nativeReceipt = null;
if (!mac) {
  if (!nativeInput) throw Error("Windows-native compiled outputs required");
  const native = resolve(nativeInput);
  nativeReceipt = JSON.parse(await readFile(join(native, "native-receipt.json"), "utf8"));
  if (
    nativeReceipt.installerVersion !== INSTALLER_VERSION ||
    nativeReceipt.platform !== "win32" ||
    !nativeReceipt.policyTestsPassed
  )
    throw Error("Windows native build verification missing");
  for (const name of ["WindowsHost.cs", "WindowsLauncher.cs", "StockAskPass.cs"])
    if (nativeReceipt.sources[name] !== hash(await readFile(new URL(name, import.meta.url))))
      throw Error("Windows compiled source differs from this checkout");
  if (nativeReceipt.sources["InstallerVersion.cs"] !== hash(windowsVersionSource()))
    throw Error("Windows compiled version source differs");
  for (const [from, to] of [
    ["launcher.exe", join(kit, "XMP OS Installer.exe")],
    ["host-helper.exe", join(resources, "host-helper.exe")],
    ["stock-askpass.exe", join(resources, "stock-askpass.exe")],
  ]) {
    const path = join(native, from),
      st = await lstat(path);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      hash(await readFile(path)) !== nativeReceipt.outputs[from]
    )
      throw Error("Windows native output hash changed");
    await copyFile(path, to);
  }
  const versionSource = join(output, "InstallerVersion.cs");
  await writeFile(versionSource, windowsVersionSource());
  extras.push({ from: versionSource, to: "InstallerVersion.cs" });
} else {
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString", "XMPInstallerVersion"])
    execFileSync("/usr/bin/plutil", [
      "-replace",
      key,
      "-string",
      INSTALLER_VERSION,
      join(app, "Contents/Info.plist"),
    ]);
}
const result = await bundleInstaller({
  resources,
  workspaceFiles: original.workspaceFiles,
  extraSources: extras,
  filesystemSourceArchive: join(oldSources, "e2fsprogs-1.47.2.tar.xz"),
  nodeLicense: join(licenses, "Node.js.txt"),
  muslLicense: join(licenses, "musl.txt"),
  platform: pin.platform,
  arch: pin.arch,
  releaseInputs: release,
});
if (!mac)
  await copyFile(
    join(licenses, "Windows-host-runtime.txt"),
    join(resources, "Licenses/Windows-host-runtime.txt"),
  );
// Recheck retained runtime bytes against the previous public package; application
// bundles, source/licences, metadata and the reviewed Windows helpers are new.
for (const [path, digest] of Object.entries(original.files)) {
  if (!/^(?:python\/|bin\/|image-tools\/|node(?:\.exe)?$|7zr\.exe$|loader-init$)/.test(path))
    continue;
  if (hash(await readFile(join(resources, path))) !== digest)
    throw Error(`Retained runtime changed: ${path}`);
}
const manifestPath = join(resources, "bundle-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!mac)
  manifest.files["Licenses/Windows-host-runtime.txt"] = hash(
    await readFile(join(resources, "Licenses/Windows-host-runtime.txt")),
  );
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
if (mac) {
  // Keep the valid, unchanged nested native signatures; reseal the new outer app.
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app]);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}
const receipt = {
  format: "xmp-installer-patch-build",
  installerVersion: INSTALLER_VERSION,
  platform: pin.platform,
  arch: pin.arch,
  ...result,
  previousPublishedArchive: { file: pin.file, sha256: pin.sha256 },
  nativeReceipt,
  runtimeBytesPreserved: true,
  systemImageChanged: false,
  containsAkaiFirmware: false,
  ownerStateIncluded: false,
};
await writeFile(join(kit, "build-receipt.json"), JSON.stringify(receipt, null, 2));
await writeFile(
  join(extracted, "START-HERE.txt"),
  `XMP OS Installer ${INSTALLER_VERSION}\n\nExtract the entire ZIP. ${mac ? "Open XMP OS Installer.app." : "Open XMP OS Installer.exe and keep its resources folder beside it."}\nUse the hardware setup guide: https://abstracteng.com/xmpos/manual/#hardware-setup\nMPC Live Mk1 / ACV8, stock MPC OS 3.10.1 only. Supply your own official updater.\nWindows: if WinUSB is present but detection fails, use Repair Windows connection, approve the targeted registration change, reconnect the USB-B cable to the same port and check again.\nMac: ad-hoc signed, not notarized. Windows: unsigned.\nThis patch rebuilds installer application code with the existing verified runtime and system image. Windows read-only detection was verified using the owner's Live in a Windows 11 VM; physical Windows PC flashing remains unqualified.\n`,
);
const zip = join(output, `XMPOS-Live-Mk1-${platformId}-${INSTALLER_VERSION}.zip`);
// Retain the previously published runtime review as historical evidence; it
// does not describe the new installer application/source closure.
for (const name of ["COMPONENT-REVIEW.json", "RELEASE.json", "SHA256SUMS", "RELEASE-NOTES.md"])
  await rename(join(extracted, name), join(extracted, `PREVIOUS-${name}`));
await writeFile(join(extracted, "RELEASE.json"), JSON.stringify(receipt, null, 2));
await writeFile(
  join(extracted, "RELEASE-NOTES.md"),
  `# XMP OS Installer ${INSTALLER_VERSION}\n\nFixes Windows detection when WinUSB is loaded without fastboot's interface registration. Use Repair Windows connection, reconnect the USB-B cable and check again. The existing driver is preserved and the prior registration is backed up. Improved driver diagnostics and regression tests are included.\n\nInstaller application code was rebuilt. Native Windows helpers were compiled on Windows 11. The published ${previous.release} runtimes, original MPC system image and their corresponding source remain unchanged; PREVIOUS-* records describe those earlier inputs only. New installer sources and licences are inside the app/resources folder.\n\nWindows read-only detection passed with the owner's Live through a Windows 11 VM. No flash was tested by an agent. Physical Windows PC flash qualification and Apple Silicon laptop testing remain pending.\n`,
);
execFileSync(
  "python3",
  [fileURLToPath(new URL("package-release.py", import.meta.url)), extracted, zip],
  { timeout: 300000 },
);
await writeFile(
  join(output, "build-receipt.json"),
  JSON.stringify(
    {
      ...receipt,
      archive: {
        file: basename(zip),
        sha256: hash(await readFile(zip)),
        bytes: (await lstat(zip)).size,
      },
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    platformId,
    installerVersion: INSTALLER_VERSION,
    archive: zip,
    sourceHash: result.sourceHash,
  }),
);
