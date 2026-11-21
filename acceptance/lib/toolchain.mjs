import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
export function inspectToolchain(root, probe = spawnSync) {
  const local = (name) =>
    existsSync(resolve(root, `.venv/bin/${name}`)) ? resolve(root, `.venv/bin/${name}`) : name;
  const checks = [
    ["Node 24", process.execPath, ["--version"], /^v24\./],
    ["TLS fixture certificate tool", "openssl", ["version"], /^(?:OpenSSL|LibreSSL) /],
    ["Python 3", "python3", ["--version"], /^Python 3\./],
    ["C++ compiler", process.env.CXX ?? "clang++", ["--version"], /clang|gcc|g\+\+/i],
    ["CMake", local("cmake"), ["--version"], /cmake version (?:3\.(?:2[5-9]|[3-9]\d)|[4-9]\.)/],
    ["Ninja", local("ninja"), ["--version"], /^1\./],
  ].map(([name, bin, args, pattern]) => {
    const result = probe(bin, args, { encoding: "utf8", timeout: 15000 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return {
      name,
      ok: result.status === 0 && pattern.test(output),
      version: output.split("\n")[0],
    };
  });
  const directory = mkdtempSync(resolve(tmpdir(), "xmp-doctor-"));
  try {
    const source = resolve(directory, "probe.cpp");
    writeFileSync(source, "#include <optional>\nint main(){std::optional<int> n=1;return *n-1;}\n");
    const result = probe(
      process.env.CXX ?? "clang++",
      ["-std=c++17", "-c", source, "-o", resolve(directory, "probe.o")],
      { encoding: "utf8", timeout: 30000 },
    );
    checks.push({ name: "C++17 compilation", ok: result.status === 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    ok: checks.every((check) => check.ok),
    checks,
    scope: "local version probes and temporary compile only",
  };
}
