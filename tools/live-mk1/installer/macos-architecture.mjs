import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Intel 13.4.1 is the measured owner host. The exact Node binary below ran
// the complete installer flow there, despite its declared 13.5 build minimum.
export function macosMinimum(arch) {
  return arch === "x64" ? "13.4.1" : "13.5";
}
const TESTED_INTEL_NODE = "50a3ba85f9a2445591012eb9932966acf313c86712847e5c2ef19774636e681f";
export function macosTarget(arch) {
  if (!["x64", "arm64"].includes(arch)) throw Error("Unsupported macOS architecture");
  return `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos${macosMinimum(arch)}`;
}
const version = (value) =>
  value.split(".").reduce((n, part, i) => n + Number(part) * [65536, 256, 1][i], 0);
export function auditMacBinaries(app, paths, arch) {
  macosTarget(arch);
  const wanted = arch === "x64" ? "x86_64" : "arm64";
  const files = {};
  for (const path of paths) {
    const architectures = execFileSync("/usr/bin/lipo", ["-archs", path], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    })
      .trim()
      .split(/\s+/);
    if (!architectures.includes(wanted))
      throw Error(`Non-native macOS host binary: ${relative(app, path)}`);
    const build = execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", path], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    });
    const minimums = [...build.matchAll(/\bminos\s+([\d.]+)/g)].map((match) => match[1]);
    if (!minimums.length) throw Error("Missing macOS binary minimum");
    let hostCompatibilityProbe = null;
    if (minimums.some((minimum) => version(minimum) > version(macosMinimum(arch)))) {
      const testedNode =
        arch === "x64" &&
        path === join(app, "Contents/Resources/node") &&
        minimums.every((minimum) => version(minimum) <= version("13.5")) &&
        createHash("sha256").update(readFileSync(path)).digest("hex") === TESTED_INTEL_NODE;
      if (!testedNode)
        throw Error(`Host binary exceeds declared macOS minimum: ${relative(app, path)}`);
      const nodeVersion = execFileSync(path, ["-p", "process.versions.node"], {
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (nodeVersion !== "24.14.0") throw Error("Unreviewed Intel compatibility runtime");
      hostCompatibilityProbe = {
        nodeVersion,
        buildHostMacos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim(),
        reviewedOwnerHostMacos: "13.4.1",
        declaredRuntimeMinimum: "13.5",
      };
    }
    files[relative(app, path).replaceAll("\\", "/")] = {
      architectures,
      minimums,
      ...(hostCompatibilityProbe ? { hostCompatibilityProbe } : {}),
    };
  }
  return { arch, minimumMacos: macosMinimum(arch), nativeHostBinariesVerified: true, files };
}
