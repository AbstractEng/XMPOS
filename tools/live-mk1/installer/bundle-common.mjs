import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { resourceHashes } from "./bundle-integrity.mjs";
import { FIRST_PROJECT, readFirstProject } from "./first-project.mjs";
import { INSTALLER_VERSION } from "./version.mjs";

const here = import.meta.dirname,
  root = resolve(here, "../../..");
const hash = (b) => createHash("sha256").update(b).digest("hex");
export async function bundleInstaller({
  resources,
  workspaceFiles,
  filesystemSourceArchive,
  nodeLicense,
  muslLicense,
  platform = process.platform,
  arch = process.arch,
  extraSources = [],
  releaseInputs = join(root, "artifacts/gate5"),
}) {
  const initHash = hash(await readFile(join(resources, "loader-init")));
  const plugins = [
    {
      name: "installer-local-workspace",
      setup(b) {
        b.onLoad({ filter: /acceptance[\\/]lib[\\/]workspace\.mjs$/ }, async ({ path }) => {
          let source = await readFile(path, "utf8");
          source = source.replace(
            'export const root = fileURLToPath(new URL("../../", import.meta.url));',
            "export const root = process.env.XMP_INSTALLER_WORKSPACE;",
          );
          const start = source.indexOf("export function buildIdentity() {");
          const end = source.indexOf("\nexport function scenarioWorkspace", start);
          if (start < 0 || end < 0) throw new Error("Workspace bundle rewrite failed");
          source =
            source.slice(0, start) +
            "export const buildIdentity = () => __XMP_SOURCE_HASH__;\n" +
            source.slice(end);
          return { contents: source, loader: "js" };
        });
        b.onLoad({ filter: /live-mk1[\\/]compatibility\.mjs$/ }, async ({ path }) => {
          let source = await readFile(path, "utf8");
          source = source.replace(
            /readFileSync\(new URL\("\.\.\/\.\.\/os\/live-mk1\/mpc-runtime\.lock\.json", import\.meta\.url\), "utf8"\)/,
            JSON.stringify(await readFile(join(root, "os/live-mk1/mpc-runtime.lock.json"), "utf8")),
          );
          source = source.replace(
            /readFileSync\(new URL\("\.\.\/\.\.\/os\/compatibility\.json", import\.meta\.url\), "utf8"\)/,
            JSON.stringify(await readFile(join(root, "os/compatibility.json"), "utf8")),
          );
          if (source.includes("new URL")) throw new Error("Compatibility resource rewrite failed");
          return { contents: source, loader: "js" };
        });
        b.onLoad({ filter: /live-mk1[\\/]loader-payload\.mjs$/ }, () => ({
          contents: `import { mkdir, readFile, writeFile } from "node:fs/promises"; import {join} from "node:path"; import { createHash } from "node:crypto"; export async function loaderPayload(stage) { const init=await readFile(join(process.env.XMP_INSTALLER_RESOURCES,"loader-init")); const sha=createHash("sha256").update(init).digest("hex"); if(sha!==${JSON.stringify(initHash)}) throw new Error("Changed XMP loader payload"); for(const name of ["proc","sys","dev"]) await mkdir(join(stage,name)); await writeFile(join(stage,"init"),init,{mode:0o755,flag:"wx"}); return {initSha256:sha}; }`,
          loader: "js",
        }));
        b.onLoad({ filter: /live-mk1[\\/]host-image-tools\.mjs$/ }, () => ({
          contents: `import { readFile } from "node:fs/promises"; import {join} from "node:path"; import {createHash} from "node:crypto"; export async function hostImageTools() { const base=process.env.XMP_INSTALLER_RESOURCES; const receipt=JSON.parse(await readFile(join(base,"image-tools/receipt.json"),"utf8")); const paths={}; for(const [name,item] of Object.entries(receipt.binaries)){ const path=join(base,item.path); if(createHash("sha256").update(await readFile(path)).digest("hex")!==item.sha256) throw new Error("Changed filesystem tools"); paths[name]=path; } return {...paths,receipt}; }`,
          loader: "js",
        }));
      },
    },
  ];
  plugins.push({
    name: "import-only-modules",
    setup(b) {
      b.onLoad({ filter: /\.mjs$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        if (path === join(here, "worker.mjs")) return { contents: source, loader: "js" };
        return {
          contents: source.replaceAll(/process\.argv\[1\] === import\.meta\.filename/g, "false"),
          loader: "js",
        };
      });
    },
  });
  const config = {
    absWorkingDir: root,
    preserveSymlinks: true,
    entryPoints: [join(here, "worker.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins,
    metafile: true,
    write: false,
    logLevel: "warning",
    define: { __XMP_SOURCE_HASH__: JSON.stringify("pending") },
  };
  const initial = await build(config);
  const sourcePaths = new Set([
    ...Object.keys(initial.metafile.inputs).map((path) =>
      relative(root, resolve(root, path)).replaceAll("\\", "/"),
    ),
    ...workspaceFiles,
    "os/live-mk1/loader-init.c",
    "os/live-mk1/host-image-tools.lock.json",
    "tools/sdk/toolchain.lock.json",
    "tools/sdk/toolchain.mjs",
    "package.json",
    "package-lock.json",
    "node_modules/zod/package.json",
    "node_modules/zod/LICENSE",
    "LICENSE",
    "tools/live-mk1/installer/demo/acid-circuit.xmpsong",
    "tools/live-mk1/installer/demo/README.md",
  ]);
  for (const entry of await readdir(here, { withFileTypes: true }))
    if (entry.isFile() && !entry.name.startsWith("."))
      sourcePaths.add(relative(root, join(here, entry.name)).replaceAll("\\", "/"));
  const sourceLedger = {};
  for (const path of [...sourcePaths].sort()) {
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\"))
      throw new Error("Installer source must stay within its declared checkout");
    sourceLedger[path] = hash(await readFile(join(root, path)));
  }
  const sourceHash = hash(JSON.stringify(sourceLedger));
  const firstProject = await readFirstProject(join(here, FIRST_PROJECT.file));
  await mkdir(join(resources, "demo"));
  await writeFile(join(resources, FIRST_PROJECT.file), firstProject);
  const worker = await build({
    ...config,
    define: { __XMP_SOURCE_HASH__: JSON.stringify(sourceHash) },
  });
  if (/process\.argv\[1\]/.test(worker.outputFiles[0].text))
    throw new Error("Packaged worker must not retain command-line entry points");
  await writeFile(join(resources, "worker.mjs"), worker.outputFiles[0].contents);
  await build({
    entryPoints: [join(here, "server.mjs")],
    outfile: join(resources, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "warning",
  });
  const sourceDir = join(resources, "Corresponding Source");
  await mkdir(sourceDir);
  for (const item of extraSources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.to))
      throw new Error("Invalid source bundle destination");
    await cp(item.from, join(sourceDir, item.to), { recursive: true });
  }
  for (const path of sourcePaths) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true });
    await copyFile(join(root, path), join(sourceDir, path));
  }
  await writeFile(
    join(sourceDir, "source-ledger.json"),
    JSON.stringify({ sourceHash, files: sourceLedger }, null, 2),
  );
  const fsLock = JSON.parse(
    await readFile(join(root, "os/live-mk1/host-image-tools.lock.json"), "utf8"),
  );
  if (hash(await readFile(filesystemSourceArchive)) !== fsLock.sha256)
    throw new Error("Changed filesystem-tool source archive");
  await copyFile(filesystemSourceArchive, join(sourceDir, `e2fsprogs-${fsLock.release}.tar.xz`));
  const notices = join(resources, "Licenses");
  await mkdir(notices);
  await copyFile(nodeLicense, join(notices, "Node.js.txt"));
  await copyFile(join(root, "node_modules/zod/LICENSE"), join(notices, "Zod.txt"));
  await copyFile(join(here, "node_modules/esbuild/LICENSE.md"), join(notices, "esbuild.txt"));
  await copyFile(join(root, "LICENSE"), join(notices, "XMP.txt"));
  await copyFile(muslLicense, join(notices, "musl.txt"));
  await copyFile(join(here, "Zig-LICENSE.txt"), join(notices, "Zig-compiler-rt.txt"));
  await copyFile(join(here, "NOTICES.txt"), join(notices, "README.txt"));
  await copyFile(join(here, "REBUILD.md"), join(sourceDir, "REBUILD.md"));
  const release = JSON.parse(await readFile(join(here, "release.lock.json"), "utf8"));
  const template = join(releaseInputs, "hardware-candidate/template");
  await mkdir(join(resources, "xmp-template"));
  for (const name of ["system.img", "manifest.json"]) {
    const b = await readFile(join(template, name));
    if (hash(b) !== release.template[name]) throw new Error(`Changed XMP template input ${name}`);
    await writeFile(join(resources, "xmp-template", name), b);
  }
  const sourceArchive = await readFile(join(releaseInputs, "downloads/xmp-source.tar.gz"));
  if (hash(sourceArchive) !== release.sourceArchiveSha256)
    throw new Error("Changed XMP corresponding-source archive");
  await writeFile(join(sourceDir, "xmp-session-source.tar.gz"), sourceArchive);
  await copyFile(
    join(releaseInputs, "downloads/THIRD-PARTY-NOTICES.txt"),
    join(notices, "XMP-session-third-party.txt"),
  );
  const ico = await readFile(join(here, "icon.ico"));
  let icon;
  for (let k = 0; k < ico.readUInt16LE(4); k++) {
    const at = 6 + k * 16;
    if (ico[at] === 128)
      icon = ico.subarray(
        ico.readUInt32LE(at + 12),
        ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8),
      );
  }
  if (!icon) throw new Error("Installer icon requires a 128px PNG frame");
  let html = await readFile(join(here, "index.html"), "utf8");
  html = html.replaceAll("__ICON_DATA__", `data:image/png;base64,${icon.toString("base64")}`);
  await writeFile(join(resources, "index.html"), html);
  // Hash every regular resource. Internal Python symlinks are kept in their signed bundle.
  const files = await resourceHashes(resources);
  await writeFile(
    join(resources, "bundle-manifest.json"),
    JSON.stringify(
      {
        format: "xmp-local-installer",
        version: 1,
        platform: platform,
        arch,
        installerVersion: INSTALLER_VERSION,
        sourceHash,
        initHash,
        workspaceFiles,
        files,
      },
      null,
      2,
    ),
  );
  return { sourceHash, initHash, installerVersion: INSTALLER_VERSION };
}
