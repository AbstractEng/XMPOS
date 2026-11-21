import { execFileSync } from "node:child_process";
import { relative } from "node:path";

// Node 24's official macOS binaries require 13.5. Match the launcher and tools.
export const MACOS_MINIMUM = "13.5";
export function macosTarget(arch) {
  if (!["x64", "arm64"].includes(arch)) throw Error("Unsupported macOS architecture");
  return `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos${MACOS_MINIMUM}`;
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
    if (!minimums.length || minimums.some((minimum) => version(minimum) > version(MACOS_MINIMUM)))
      throw Error(`Host binary exceeds declared macOS minimum: ${relative(app, path)}`);
    files[relative(app, path).replaceAll("\\", "/")] = { architectures, minimums };
  }
  return { arch, minimumMacos: MACOS_MINIMUM, nativeHostBinariesVerified: true, files };
}
