// Compile the small Windows-only helpers for an installer patch. No WMI,
// registry, elevation, USB, vendor updater or owner files are used by the tests.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { INSTALLER_VERSION, windowsVersionSource } from "./version.mjs";

if (process.platform !== "win32" || process.arch !== "x64" || process.argv.length !== 3)
  throw Error("Run on Windows x64: node build-windows-native.mjs <new output folder>");
const source = import.meta.dirname;
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const csc = join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const version = join(output, "InstallerVersion.cs");
await writeFile(version, windowsVersionSource());
const refs = [
  "/r:System.Windows.Forms.dll",
  "/r:System.Management.dll",
  "/r:System.Web.Extensions.dll",
];
function compile(name, files, options = []) {
  execFileSync(csc, [
    "/nologo",
    "/platform:x64",
    `/out:${join(output, name)}`,
    ...refs,
    ...options,
    ...files.map((name) => join(source, name)),
    version,
  ]);
}
compile("host-helper.exe", ["WindowsHost.cs"], ["/target:exe"]);
compile(
  "launcher.exe",
  ["WindowsLauncher.cs"],
  ["/target:winexe", `/win32icon:${join(source, "icon.ico")}`],
);
compile("stock-askpass.exe", ["StockAskPass.cs"], ["/target:winexe"]);
compile(
  "policy-tests.exe",
  ["WindowsHost.cs", "WindowsUsbCompatibilityTests.cs"],
  ["/target:exe", "/main:WindowsUsbCompatibilityTests"],
);
const testLog = execFileSync(join(output, "policy-tests.exe"), [join(output, "host-helper.exe")], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 30000,
});
await writeFile(join(output, "policy-tests.txt"), testLog);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const sources = {};
for (const name of ["WindowsHost.cs", "WindowsLauncher.cs", "StockAskPass.cs"])
  sources[name] = hash(await readFile(join(source, name)));
sources["InstallerVersion.cs"] = hash(windowsVersionSource());
const outputs = {};
for (const name of ["host-helper.exe", "launcher.exe", "stock-askpass.exe"])
  outputs[name] = hash(await readFile(join(output, name)));
await writeFile(
  join(output, "native-receipt.json"),
  `${JSON.stringify({ installerVersion: INSTALLER_VERSION, platform: "win32", arch: "x64", policyTestsPassed: true, consoleFreeStartupPassed: true, sources, outputs }, null, 2)}\n`,
);
console.log(testLog.trim());
console.log(`Windows installer ${INSTALLER_VERSION} native helpers built and verified.`);
