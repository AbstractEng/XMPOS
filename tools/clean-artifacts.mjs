import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { root } from "../acceptance/lib/workspace.mjs";

// Removes old, regenerable Live Mk1 build and test outputs (all git-ignored).
// Keeps: every folder a latest-*.json pointer names, the newest `keep` folders
// of each kind, Akai's stock rootfs (needed by restore-stock), and everything
// in reports/live-mk1 (flash logs, the recorded Live identity, hardware reports).
// Dry run unless --delete is given.

const KINDS = [
  "uboot-test",
  "probe-vm",
  "probe-image",
  "boot",
  "alsa-engine",
  "kernel",
  "g1-userspace",
  "live-session",
  "loader-image",
  "loader-vm",
  "session-image",
  "session-vm",
  "device-image",
  "device-vm",
  "alsa-lib-build",
];

export function plan({ keep = 1, reports = false } = {}) {
  const base = join(root, "artifacts/live-mk1");
  const remove = [];
  if (existsSync(base)) {
    const pinned = new Set(
      readdirSync(base)
        .filter((name) => /^latest-.*\.json$/.test(name))
        .map((name) => resolve(root, JSON.parse(readFileSync(join(base, name), "utf8")).directory)),
    );
    for (const kind of KINDS) {
      const folders = readdirSync(base)
        .filter((name) => name.startsWith(`${kind}-`) && statSync(join(base, name)).isDirectory())
        .map((name) => join(base, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      folders.slice(keep).forEach((folder) => {
        if (!pinned.has(folder)) remove.push(folder);
      });
    }
  }
  if (reports) {
    const acceptance = join(root, "reports/acceptance");
    if (existsSync(acceptance))
      for (const name of readdirSync(acceptance))
        if (name !== "live-mk1" && statSync(join(acceptance, name)).isDirectory())
          remove.push(join(acceptance, name));
  }
  return remove;
}

const size = (path) => {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
};

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  for (const arg of args)
    if (!["--delete", "--reports"].includes(arg))
      throw new Error("Usage: npm run clean:artifacts -- [--reports] [--delete]");
  const targets = plan({ reports: args.includes("--reports") });
  let bytes = 0;
  for (const target of targets) {
    const b = size(target);
    bytes += b;
    console.log(`${(b / 1e6).toFixed(0).padStart(6)} MB  ${relative(root, target)}`);
    if (args.includes("--delete")) rmSync(target, { recursive: true, force: true });
  }
  console.log(
    `${args.includes("--delete") ? "Removed" : "Would remove"} ${targets.length} folders, ${(bytes / 1e9).toFixed(1)} GB` +
      (args.includes("--delete") ? "" : " (dry run; add --delete)"),
  );
}
