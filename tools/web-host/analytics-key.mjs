// Owner-local dashboard credential. Never print it or copy it into public assets.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, "../../artifacts/web-analytics");
const file = resolve(directory, "dashboard-key.txt");
await mkdir(directory, { recursive: true, mode: 0o700 });
let key;
try {
  key = (await readFile(file, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  key = randomBytes(32).toString("base64url");
  await writeFile(file, `${key}\n`, { flag: "wx", mode: 0o600 });
}
if (!/^[A-Za-z0-9_-]{43}$/.test(key))
  throw new Error(
    "Existing dashboard key is invalid; do not replace an owner credential automatically",
  );
await chmod(file, 0o600);
const secretFile = resolve(directory, "secrets.json");
await writeFile(
  secretFile,
  JSON.stringify({ ANALYTICS_KEY_HASH: createHash("sha256").update(key).digest("hex") }) + "\n",
  { mode: 0o600 },
);
await chmod(secretFile, 0o600);
console.log("Dashboard key: artifacts/web-analytics/dashboard-key.txt (private, not committed)");
console.log("Deploy secrets: artifacts/web-analytics/secrets.json (hash only, not public assets)");
