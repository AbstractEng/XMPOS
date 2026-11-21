import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const hash = (b, algorithm = "sha256") => createHash(algorithm).update(b).digest("hex");
export async function verifyWindowsRuntimeSources(host) {
  const closure = JSON.parse(await readFile(join(host, "source/runtime-closure.json"), "utf8"));
  const review = JSON.parse(await readFile(join(host, "source/cygwin-sources.lock.json"), "utf8"));
  const expected = JSON.parse(
    await readFile(new URL("./windows-runtime.lock.json", import.meta.url), "utf8"),
  );
  if (
    JSON.stringify(review.sourcePackages) !== JSON.stringify(expected.sourcePackages) ||
    JSON.stringify(review.nativeFileOwners) !== JSON.stringify(expected.nativeFileOwners) ||
    review.noticeSha256 !== expected.noticeSha256
  )
    throw new Error("Windows source inventory differs from the reviewed lock");
  const actual = {};
  async function inventory(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const p = join(directory, entry.name),
        name = prefix + "/" + entry.name;
      if (entry.isDirectory()) await inventory(p, name);
      else if (entry.isFile()) actual[name] = hash(await readFile(p));
      else throw new Error("Regular reviewed runtime files required");
    }
  }
  await inventory(join(host, "bin"), "bin");
  await inventory(join(host, "lib"), "lib");
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(expected.files).sort())
  )
    throw new Error("Windows runtime differs from the exact reviewed file set");

  if (
    closure.format !== "xmp-windows-runtime-closure" ||
    closure.version !== 1 ||
    review.format !== "xmp-cygwin-corresponding-source" ||
    review.version !== 1 ||
    review.unattributedNativeFiles.length
  )
    throw new Error("Complete exact Windows runtime/source attribution required");
  for (const [path, expected] of Object.entries(closure.files)) {
    if (
      path.includes("\\") ||
      path.split("/").includes("..") ||
      !path.match(/^(?:bin|lib|source)\//)
    )
      throw new Error("Unsafe Windows runtime receipt path");
    const p = join(host, path),
      s = await lstat(p);
    if (!s.isFile() || s.isSymbolicLink() || hash(await readFile(p)) !== expected)
      throw new Error("Changed reviewed host file " + path);
  }
  for (const native of Object.keys(closure.imports)) {
    if (/^bin\/(?:debugfs|e2fsck|dumpe2fs|mke2fs)\.exe$/.test(native)) continue;
    if (!review.nativeFileOwners[native])
      throw new Error("Unattributed Windows native file " + native);
  }
  for (const pin of review.sourcePackages) {
    const name = pin.path.split("/").at(-1);
    if (!/^[A-Za-z0-9._+-]+$/.test(name))
      throw new Error("Invalid corresponding-source package name");
    const bytes = await readFile(join(host, "source/cygwin-sources", name));
    if (bytes.length !== pin.bytes || hash(bytes, "sha512") !== pin.sha512)
      throw new Error("Changed corresponding-source archive " + name);
  }
  const notices = await readFile(join(host, "source/WINDOWS-THIRD-PARTY-NOTICES.txt"));
  if (hash(notices) !== review.noticeSha256) throw new Error("Changed Windows component notices");
  return {
    nativeFiles: Object.keys(review.nativeFileOwners).length,
    sourcePackages: review.sourcePackages.length,
    noticesSha256: review.noticeSha256,
  };
}
