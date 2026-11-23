// Regenerate with the exact prepared assets before building the Worker.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function prepareMediaSizes(prepared) {
  const sizes = {};
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const file = resolve(directory, name);
      const path = `${prefix}/${name}`;
      const stat = statSync(file);
      if (stat.isDirectory()) visit(file, path);
      else if (/\.(mp4|webm|wav)$/.test(name)) sizes[path] = stat.size;
    }
  }
  visit(resolve(prepared, "manual-media"), "/xmpos/manual-media");
  visit(resolve(prepared, "assets"), "/xmpos/assets");
  writeFileSync(
    new URL("./media-sizes.json", import.meta.url),
    `${JSON.stringify(sizes, null, 2)}\n`,
  );
  return sizes;
}
