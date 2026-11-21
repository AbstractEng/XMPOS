// Every drum kit file the app fetches at runtime must ship with the site. The
// app's JavaScript does not reference them directly, so a deploy that rebuilt the
// site from the app's dependency graph once dropped them (all kits but the two
// built in code failed with HTTP 404).
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const source = resolve(import.meta.dirname, "../../apps/studio/public/kits");
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

export function checkKits(site) {
  const missing = [];
  for (const file of files(source)) {
    const path = join(site, "kits", relative(source, file));
    try {
      if (statSync(path).size !== statSync(file).size) missing.push(`${path} (size differs)`);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length)
    throw new Error(`The site would be missing drum kit files:\n${missing.join("\n")}`);
  return files(source).length;
}
