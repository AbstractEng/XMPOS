import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export function sourceFiles({ trackedOnly = false } = {}) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", ...(trackedOnly ? [] : ["--others", "--exclude-standard"]), "-z"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((path) => path && existsSync(resolve(root, path)))
    .sort();
}
export function buildIdentity() {
  const hash = createHash("sha256");
  for (const path of sourceFiles())
    hash.update(`${path}\0`).update(readFileSync(resolve(root, path)));
  return hash.digest("hex");
}
export function scenarioWorkspace() {
  const directory = mkdtempSync(resolve(tmpdir(), "xmp-acceptance-"));
  const processes = new Set();
  return {
    directory,
    processes,
    path(name) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Owned workspace filename required");
      return resolve(directory, name);
    },
    close() {
      for (const child of processes) child.kill("SIGTERM");
      processes.clear();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function command(program, args, cwd = root, timeout = 120000) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} ${args.join(" ")}: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout + result.stderr;
}
export function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function ownedScenarioDirectory(directory) {
  const path = realpathSync(directory);
  if (
    lstatSync(directory).isSymbolicLink() ||
    dirname(path) !== realpathSync(tmpdir()) ||
    !basename(path).startsWith("xmp-acceptance-")
  )
    throw new Error("Owned temporary scenario directory required");
  return path;
}
