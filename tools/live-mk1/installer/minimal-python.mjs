import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function verifyMinimalPython(directory) {
  const at = resolve(directory);
  const receipt = JSON.parse(await readFile(join(at, "receipt.json"), "utf8"));
  if (
    receipt.format !== "xmp-minimal-python" ||
    receipt.version !== 1 ||
    receipt.pythonVersion !== "3.13.18" ||
    receipt.sourceSha256 !== "abb0102e6d4ae027509bcb82327d9dd85515b44a3ba8ad538cfc5e9847029f68" ||
    receipt.systemLibrariesOnly !== true
  )
    throw new Error("Reviewed source-built CPython 3.13.18 with system libraries required");
  for (const [path, expected] of Object.entries(receipt.files)) {
    if (
      !/^(?:python|source|licenses)\//.test(path) ||
      path.split("/").includes("..") ||
      !/^([a-f0-9]{64})$/.test(expected)
    )
      throw new Error("Invalid CPython runtime receipt path/hash");
    const target = join(at, path),
      s = await lstat(target);
    if (!s.isFile() || s.isSymbolicLink() || sha(await readFile(target)) !== expected)
      throw new Error("Changed CPython runtime/source input " + path);
  }
  const actual = [];
  async function inventory(directory, prefix) {
    for (const e of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + "/" + e.name,
        p = join(directory, e.name);
      if (e.isDirectory()) await inventory(p, name);
      else if (e.isFile()) actual.push(name);
      else throw new Error("Regular CPython runtime/source files required");
    }
  }
  for (const prefix of ["python", "source", "licenses"]) await inventory(join(at, prefix), prefix);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(receipt.files).sort()))
    throw new Error("Unreviewed extra CPython runtime/source file");
  const executable = join(at, "python/bin/python3.13");
  execFileSync(
    executable,
    [
      "-I",
      "-B",
      "-S",
      "-c",
      'import hashlib,lzma,json,struct,pathlib,plistlib,subprocess,shutil,importlib.util; assert importlib.util.find_spec("_ssl") is None; assert importlib.util.find_spec("_hashlib") is None; assert lzma.decompress(lzma.compress(b"XMP"))==b"XMP"; assert hashlib.sha256(b"abc").hexdigest()=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"',
    ],
    { timeout: 20000 },
  );
  return { directory: at, receipt };
}
export async function minimalPythonRuntime(from, cache) {
  if (from) return verifyMinimalPython(from);
  await mkdir(cache, { recursive: true });
  const output = join(cache, "mac-python-runtime");
  if (!existsSync(join(output, "receipt.json")))
    execFileSync("/bin/sh", [join(import.meta.dirname, "build-macos-python.sh")], {
      cwd: cache,
      timeout: 900000,
      stdio: "inherit",
    });
  return verifyMinimalPython(output);
}
