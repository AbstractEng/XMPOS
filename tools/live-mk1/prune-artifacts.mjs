import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";

// Old build and emulator output under artifacts/live-mk1 (git-ignored): each
// emulator run keeps about 0.6 GB and each session image 24 MB or more, and
// nothing removed them (the disk filled, and Docker stopped, on 2026-11-15).
//
// Kept: the newest few of each kind, whatever a latest-*.json pointer names,
// and every run the docs cite. Only folders this project's tools create by
// these names, directly under artifacts/live-mk1, are ever removed.
//
//   npm run live:prune             remove old runs and images
//   npm run live:prune -- --dry    list what would go

const KINDS = { "session-vm-": 3, "session-image-": 4, "device-vm-": 2 };
const NAME = /^(session-vm-|session-image-|device-vm-)[A-Za-z0-9_-]{6}$/;

export function prunable(names, { pointed = new Set(), cited = new Set(), age = () => 0 } = {}) {
  const out = [];
  for (const [kind, keep] of Object.entries(KINDS)) {
    const mine = names
      .filter((n) => n.startsWith(kind) && NAME.test(n))
      .sort((a, b) => age(b) - age(a)); // newest first
    out.push(...mine.slice(keep).filter((n) => !pointed.has(n) && !cited.has(n)));
  }
  return out;
}

export function prune({ dry = false, log = console.log } = {}) {
  const dir = join(root, "artifacts/live-mk1");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const pointed = new Set();
  for (const name of names.filter((n) => /^latest-.*\.json$/.test(n))) {
    try {
      const at = JSON.parse(readFileSync(join(dir, name), "utf8")).directory;
      if (typeof at === "string") pointed.add(at.split("/").pop());
    } catch {
      // an unreadable pointer protects nothing
    }
  }
  const cited = new Set();
  const docs = join(root, "docs");
  for (const file of existsSync(docs) ? readdirSync(docs) : []) {
    if (!file.endsWith(".md")) continue;
    for (const m of readFileSync(join(docs, file), "utf8").matchAll(
      /(session-vm-|session-image-|device-vm-)[A-Za-z0-9_-]{6}/g,
    ))
      cited.add(m[0]);
  }
  const age = (n) => statSync(join(dir, n)).mtimeMs;
  const gone = prunable(
    names.filter((n) => statSync(join(dir, n)).isDirectory()),
    { pointed, cited, age },
  );
  for (const name of gone) {
    if (!dry) rmSync(join(dir, name), { recursive: true, force: true });
    log(`${dry ? "would remove" : "removed"} artifacts/live-mk1/${name}`);
  }
  return gone;
}

if (process.argv[1] === import.meta.filename) {
  const gone = prune({ dry: process.argv.includes("--dry") });
  if (!gone.length) console.log("Nothing to remove.");
}
