import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { observeReference } from "../acceptance/lib/provenance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = JSON.parse(readFileSync(resolve(root, "references/sources.json"), "utf8"));
const stateFile = resolve(root, "reports/reference-monitor.json");
const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const state = { ...previous };
const changes = [];
const unique = [...new Set(sources.repositories.map((repo) => repo.url))];
for (const url of unique) {
  try {
    const refs = Object.fromEntries(
      execFileSync("git", ["ls-remote", url, "HEAD", "refs/heads/*", "refs/tags/*"], {
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 4 * 1024 * 1024,
      })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/);
          return [ref, sha];
        }),
    );
    const result = observeReference(previous[url], url, {
      refs,
      checkedAt: new Date().toISOString(),
    });
    state[url] = result.state;
    changes.push(...result.changes);
  } catch {
    const result = observeReference(previous[url], url, {
      error: true,
      checkedAt: new Date().toISOString(),
    });
    state[url] = result.state;
    changes.push(...result.changes);
  }
}
mkdirSync(resolve(root, "reports"), { recursive: true });
writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      initialized: !existsSync(stateFile) || !Object.keys(previous).length,
      changes,
      source: "git remote heads and tags; release notes need upstream review",
    },
    null,
    2,
  ),
);
