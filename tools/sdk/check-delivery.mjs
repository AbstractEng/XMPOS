import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// Check the installed tree, not the staging directory: npm's file allowlist
// must actually deliver every manual/example and its offline links.
export function checkSdkDelivery(directory) {
  const base = resolve(directory);
  const required = [
    "README.md",
    "docs/supported-sdk.md",
    "docs/community-sdk.md",
    "docs/sdk/README.md",
    "docs/sdk/reference.md",
    "docs/sdk/examples.md",
    "docs/sdk/repository-setup.md",
    "examples/community-tone/module.json",
    "examples/community-filter/program.json",
    "examples/sdk-ui/render.mjs",
    "examples/sdk-ui/LICENSE",
    "native/community_dsp.h",
  ];
  for (const file of required) {
    const info = lstatSync(join(base, file));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Missing regular SDK file: ${file}`);
  }
  const documents = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("SDK documentation must not contain symlinks");
      if (info.isDirectory()) walk(path);
      else if (name.endsWith(".md")) documents.push(path);
    }
  };
  walk(join(base, "docs"));
  walk(join(base, "examples"));
  documents.push(join(base, "README.md"));
  let links = 0;
  for (const document of documents) {
    for (const [, target] of readFileSync(document, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const local = resolve(dirname(document), target.split("#")[0]);
      if (!local.startsWith(base + sep) || !lstatSync(local).isFile())
        throw new Error(`Broken offline link in ${relative(base, document)}: ${target}`);
      links++;
    }
  }
  return { documents: documents.length, localLinks: links, requiredFiles: required.length };
}
