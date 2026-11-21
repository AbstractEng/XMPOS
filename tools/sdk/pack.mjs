import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import compatibility from "./compatibility.json" with { type: "json" };

export async function packSdk(destination) {
  const output = resolve(destination);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const sourceHash = buildIdentity();
  execFileSync(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "tools/sdk/bundle.config.mjs"],
    { cwd: root, stdio: "pipe", timeout: 120000 },
  );
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "--ignoreConfig",
      "--declaration",
      "--emitDeclarationOnly",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--skipLibCheck",
      "--allowImportingTsExtensions",
      "--rootDir",
      "packages",
      "--outDir",
      "build/sdk-types",
      "packages/sdk/src/index.ts",
    ],
    { cwd: root, stdio: "pipe", timeout: 120000 },
  );
  const dir = join(output, "package");
  await mkdir(dir);
  await cp(join(root, "build/sdk-bundle"), join(dir, "dist"), { recursive: true });
  await cp(join(root, "build/sdk-types"), join(dir, "types"), { recursive: true });
  await mkdir(join(dir, "native"));
  await cp(join(root, "native/src/parity_render.c"), join(dir, "native/parity_render.c"));
  await cp(join(root, "native/src/parity_dsp.c"), join(dir, "native/parity_dsp.c"));
  await cp(join(root, "native/include/xmp/community_dsp.h"), join(dir, "native/community_dsp.h"));
  await cp(join(root, "LICENSE"), join(dir, "LICENSE"));
  await writeFile(
    join(dir, "README.md"),
    "# XMP SDK\n\nStart with the [offline SDK manual](docs/sdk/README.md), " +
      "[installation and conformance guide](docs/supported-sdk.md), " +
      "and [community reference](docs/community-sdk.md). " +
      "Runnable examples are included under examples/. " +
      "The full OS checkout is a separate development path; " +
      "see the [repository setup guide](docs/sdk/repository-setup.md).\n",
  );
  await mkdir(join(dir, "docs"));
  for (const name of ["supported-sdk.md", "community-sdk.md"])
    await cp(join(root, "docs", name), join(dir, "docs", name));
  const included = {
    "docs/sdk": ["README.md", "reference.md", "examples.md", "repository-setup.md"],
    "examples/community-tone": [
      "AGENTS.md",
      "LICENSE",
      "PARAMETERS.md",
      "module.json",
      "program.json",
    ],
    "examples/community-filter": [
      "AGENTS.md",
      "LICENSE",
      "PARAMETERS.md",
      "module.json",
      "program.json",
    ],
    "examples/sdk-ui": ["LICENSE", "README.md", "render.mjs"],
  };
  for (const [directory, files] of Object.entries(included)) {
    await mkdir(join(dir, directory), { recursive: true });
    for (const file of files) await cp(join(root, directory, file), join(dir, directory, file));
  }
  await cp(join(root, "node_modules/zod"), join(dir, "node_modules/zod"), { recursive: true });
  await writeFile(
    join(dir, "compatibility.json"),
    JSON.stringify({ ...compatibility, sourceHash }, null, 2),
  );
  const pkg = {
    name: "@xmp/sdk",
    version: compatibility.version,
    type: "module",
    license: "Apache-2.0",
    engines: { node: ">=24 <25" },
    bin: { xmp: "dist/cli.mjs" },
    exports: { ".": { types: "./types/sdk/src/index.d.ts", import: "./dist/index.mjs" } },
    files: [
      "dist",
      "types",
      "native",
      "docs",
      "examples",
      "compatibility.json",
      "README.md",
      "LICENSE",
    ],
    dependencies: { zod: "4.6.7" },
    bundledDependencies: ["zod"],
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const cli = join(dir, "dist/cli.mjs");
  await writeFile(cli, `#!/usr/bin/env node\n${await readFile(cli, "utf8")}`);
  await chmod(cli, 0o755);
  const data = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", output],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 120000,
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    ),
  );
  const tarball = join(output, data[0].filename),
    sha256 = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during SDK build");
  const report = {
    format: "xmp-sdk-distribution",
    version: 1,
    sourceHash,
    sha256,
    tarball,
    compatibility,
    publicRegistryPublished: false,
  };
  await writeFile(join(output, "distribution.json"), JSON.stringify(report, null, 2), {
    flag: "wx",
  });
  return report;
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 3) throw new Error("sdk:pack requires a new local output directory");
  console.log(JSON.stringify(await packSdk(process.argv[2])));
}
