import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { repositories } = JSON.parse(readFileSync(resolve(root, "references/sources.json"), "utf8"));
const destination = resolve(root, "references/repos");
mkdirSync(destination, { recursive: true });
const git = (cwd, args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.required=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
const results = [];
for (const repo of repositories) {
  const directory = resolve(destination, repo.name);
  try {
    if (!existsSync(resolve(directory, ".git"))) {
      git(root, [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--no-checkout",
        ...(repo.branch ? ["--branch", repo.branch] : []),
        repo.url,
        directory,
      ]);
      git(directory, ["config", "core.hooksPath", "/dev/null"]);
      git(directory, ["config", "submodule.recurse", "false"]);
    }
    // Keep LFS pointers readable without depending on a global git-lfs install.
    // Payload downloads are explicit and hash checked by fetch-akai-sources.py.
    git(directory, ["config", "filter.lfs.process", ""]);
    git(directory, ["config", "filter.lfs.clean", "cat"]);
    git(directory, ["config", "filter.lfs.smudge", "cat"]);
    git(directory, ["config", "filter.lfs.required", "false"]);
    // No upstream build, install, submodule, filter or deployment scripts are run.
    // Source checkout excludes binary firmware and compressed source archives.
    git(directory, ["config", "core.sparseCheckout", "true"]);
    git(directory, ["config", "core.sparseCheckoutCone", "false"]);
    writeFileSync(
      resolve(directory, ".git/info/sparse-checkout"),
      repo.sourceArchives
        ? "/*\n"
        : "/*\n!*.img\n!*.bin\n!*.so\n!*.so.*\n!*.zip\n!*.tar\n!*.gz\n!*.bz2\n!*.xz\n!*.zst\n!*.7z\n!*.deb\n!*.rpm\n!*.a\n!*.elf\n!*.dll\n!*.exe\n!*.dylib\n!*.AppImage\n",
    );
    git(directory, [
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.required=false",
      "read-tree",
      "-mu",
      "HEAD",
    ]);
    const commit = git(directory, ["rev-parse", "HEAD"]).trim();
    const tree = git(directory, ["ls-tree", "-r", "-l", "HEAD"]);
    const licenseFiles = tree
      .split("\n")
      .map((line) => line.split("\t")[1])
      .filter((path) => path && /(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(path));
    results.push({
      ...repo,
      commit,
      licenseFiles,
      status: "cloned",
      checkout: repo.sourceArchives
        ? "official source archive LFS pointers; use tools/fetch-akai-sources.py for verified payloads"
        : "source and docs; binary images and compressed archives excluded",
    });
    console.log(`${repo.name}: ${commit.slice(0, 12)}`);
  } catch (error) {
    results.push({ ...repo, status: "failed", error: error.message });
    process.exitCode = 1;
    console.error(`${repo.name}: failed`);
  }
}
writeFileSync(
  resolve(root, "references/lock.json"),
  `${JSON.stringify({ recordedAt: new Date().toISOString(), repositories: results }, null, 2)}\n`,
);
