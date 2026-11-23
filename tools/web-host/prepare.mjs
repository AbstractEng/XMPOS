import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { checkDemo } from "./check-demo.mjs";
import { checkKits } from "./check-kits.mjs";
import { prepareMediaSizes } from "./media-sizes.mjs";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "dist-hosted");
for (const name of ["index.html", "manual/index.html"])
  if (!readFileSync(resolve(source, name), "utf8").includes("/xmpos/"))
    throw new Error("Build with npm run web:build before packaging the hosted preview");
const destination = resolve(root, "build/web-assets");
mkdirSync(destination, { recursive: true });
for (const name of readdirSync(destination))
  if (name !== "xmpos") throw new Error("Unexpected deployment directory content");
if (existsSync(resolve(destination, "xmpos")))
  rmSync(resolve(destination, "xmpos"), { recursive: true });
cpSync(source, resolve(destination, "xmpos"), { recursive: true });
const kits = checkKits(resolve(destination, "xmpos"));
checkDemo(resolve(destination, "xmpos"));
prepareMediaSizes(resolve(destination, "xmpos"));
console.log(`Checked ${kits} drum kit files`);
console.log("Prepared browser Studio and manual only; no OS images or personal projects");
