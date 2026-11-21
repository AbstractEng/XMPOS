// Writes XMP Velvet, the multi-sampled groove kit, from its C++ source
// (native/include/xmp/velvet_kit.hpp) to apps/studio/public/kits/xmp, and
// records the file's size and SHA-256 where the browser checks them.
//
//   npm run kits:velvet
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = (name) =>
  existsSync(resolve(root, `.venv/bin/${name}`)) ? resolve(root, `.venv/bin/${name}`) : name;
const run = (program, args) => execFileSync(program, args, { cwd: root, stdio: "inherit" });
run(bin("cmake"), [
  "-S",
  "native",
  "-B",
  "build/native",
  "-G",
  "Ninja",
  `-DCMAKE_MAKE_PROGRAM=${bin("ninja")}`,
  "-DCMAKE_BUILD_TYPE=Debug",
  "-DXMP_SANITIZE=OFF",
]);
run(bin("cmake"), ["--build", "build/native", "--target", "xmp_velvet_kit"]);
const file = resolve(root, "apps/studio/public/kits/xmp/xmp-velvet.xmpkit");
run(resolve(root, "build/native/xmp_velvet_kit"), [file]);
const bytes = readFileSync(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const loader = resolve(root, "apps/studio/src/bundled-drum-kits.ts");
const source = readFileSync(loader, "utf8").replace(
  /(file: "kits\/xmp\/xmp-velvet\.xmpkit",\n\s*bytes: )\d+(,\n\s*sha256: ")[0-9a-f]{64}"/,
  `$1${bytes.length}$2${sha256}"`,
);
writeFileSync(loader, source);
console.log(`recorded ${bytes.length} bytes, sha256 ${sha256}`);
