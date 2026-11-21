import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDemoProject, encodeWav } from "../../packages/core/src/index.ts";
import {
  buildPackage,
  parameterDocumentation,
  parsePackage,
} from "../../packages/sdk/src/community/package.ts";
import { renderCommunity } from "../../packages/sdk/src/community/program.ts";
import { bindCommunity } from "../../packages/sdk/src/community/project.ts";
import { openPackageStore } from "./store.mjs";
import { template } from "./template.mjs";

export async function runSdk(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv;
  const read = async (path, max = 1048576) => {
    if ((await stat(path)).size > max) throw new Error("Input exceeds byte budget");
    return readFile(path, "utf8");
  };
  if (mode === "new") {
    const [kind, id, directory] = args;
    if (args.length !== 3) throw new Error("sdk new instrument|effect id new-directory");
    const t = await template(kind, id),
      root = resolve(directory);
    await mkdir(root, { mode: 0o700 });
    for (const [name, value] of Object.entries({
      "module.json": JSON.stringify(t.manifest, null, 2),
      "program.json": JSON.stringify(t.program, null, 2),
      LICENSE: t.license,
      "PARAMETERS.md": parameterDocumentation(t.manifest),
      "AGENTS.md":
        "# Community module development\n\nKeep packages declarative: program.json accepts only the documented sine/triangle/input, gain and cutoff primitives. Never put JavaScript, native binaries, hardware access or scripts in a package. Preserve API/ABI and stable parameter IDs/units. Declare exact DSP dependencies and hashes; use xmp build, test and preview after edits (in the repository: npm run sdk -- command). Bump stateVersion and declare rename migrations for incompatible state IDs. Physical Akai devices are outside this workbench.\n",
    }))
      await writeFile(join(root, name), value, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ created: root, kind, id, physicalAccess: false }));
  } else if (mode === "build") {
    const [directory, destination] = args;
    if (args.length !== 2) throw new Error("sdk build template-directory new-package.xmpkg");
    const pkg = await buildPackage(
      JSON.parse(await read(join(directory, "module.json"))),
      JSON.parse(await read(join(directory, "program.json"))),
      await read(join(directory, "LICENSE")),
    );
    await writeFile(destination, JSON.stringify(pkg), { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({ built: resolve(destination), sha256: pkg.sha256, executableCode: false }),
    );
  } else if (mode === "test" || mode === "preview") {
    const [source, destination] = args;
    if (args.length !== (mode === "test" ? 1 : 2))
      throw new Error("sdk test package.xmpkg | sdk preview package.xmpkg new-preview.wav");
    const p = await parsePackage(await read(source)),
      state = Object.fromEntries(p.manifest.parameters.map((p) => [p.id, p.default]));
    const events =
      p.manifest.kind === "instrument"
        ? [
            { kind: "on", id: 1, timestamp: 0, note: 69, velocity: 1 },
            { kind: "off", id: 1, timestamp: 0.25 },
          ]
        : [];
    const pcm = renderCommunity(p.manifest, p.program, state, events, 0.5);
    if (!pcm.every(Number.isFinite) || !pcm.some((v) => v !== 0))
      throw new Error("Example failed its behavioral preview");
    if (mode === "preview")
      await writeFile(destination, Buffer.from(encodeWav([pcm, pcm], 48000)), {
        flag: "wx",
        mode: 0o600,
      });
    console.log(
      JSON.stringify({
        passed: true,
        frames: pcm.length,
        peak: Math.max(...pcm.map(Math.abs)),
        physicalAccess: false,
        backend: "offline-data-interpreter",
      }),
    );
  } else if (mode === "store-init") {
    if (args.length !== 1) throw new Error("sdk store-init new-store-directory");
    const store = await openPackageStore(args[0], { create: true });
    console.log(JSON.stringify({ generation: (await store.read()).generation }));
  } else if (
    mode === "install" ||
    mode === "rollback" ||
    mode === "bind" ||
    mode === "store-status"
  ) {
    const expected = mode === "install" || mode === "bind" ? 2 : 1;
    if (args.length !== expected)
      throw new Error(
        "sdk install|bind store-directory package.xmpkg | sdk rollback|store-status store-directory",
      );
    const store = await openPackageStore(args[0]),
      state = await store.read();
    let result = state;
    if (mode === "install")
      result = await store.install((await parsePackage(await read(args[1]))).pkg, state.generation);
    if (mode === "rollback") result = await store.rollback(state.generation);
    if (mode === "bind") {
      const p = await parsePackage(await read(args[1])),
        project = await bindCommunity(createDemoProject(), "drums", p.pkg);
      result = await store.setProject(project, state.generation);
    }
    console.log(
      JSON.stringify({
        generation: result.generation,
        installed: result.active.packages.length,
        projectBound: !!result.active.project,
        physicalAccess: false,
      }),
    );
  } else
    throw new Error(
      "Use sdk new, build, test, preview, store-init, install, bind, rollback or store-status",
    );
}
