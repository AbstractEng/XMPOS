import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { ensureFonts } from "../fonts.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";
import { uiCompiler } from "./ui-toolchain.mjs";
import { wasiSysroot } from "./wasi-sysroot.mjs";

// Builds XMP's C++ engine modules to WebAssembly with the pinned Zig compiler
// and writes each one as a TypeScript module under packages/core/src/generated,
// so the browser, the audio worklet and Node load the same bytes with no fetch.
//
//   npm run engine:wasm            build and write the modules whose sources changed
//   npm run engine:wasm -- --all   build every module
//   npm run engine:wasm -- --check fail if a committed module is stale
export const MODULES = [
  {
    name: "engine",
    prefix: "ENGINE",
    main: "native/src/rack_wasm.cpp",
    sources: ["native/include/xmp/rack.hpp", "native/src/rack_wasm.cpp"],
    output: "packages/core/src/generated/xmp-engine-wasm.ts",
  },
  {
    name: "sequencer",
    prefix: "SEQUENCER",
    main: "native/src/sequencer_wasm.cpp",
    sources: ["native/include/xmp/sequencer.hpp", "native/src/sequencer_wasm.cpp"],
    output: "packages/core/src/generated/xmp-sequencer-wasm.ts",
  },
  {
    name: "transport",
    prefix: "TRANSPORT",
    main: "native/src/transport_wasm.cpp",
    sources: ["native/include/xmp/transport.hpp", "native/src/transport_wasm.cpp"],
    output: "packages/core/src/generated/xmp-transport-wasm.ts",
  },
  {
    name: "controls",
    prefix: "CONTROLS",
    main: "native/src/controls_wasm.cpp",
    sources: ["native/include/xmp/controls.hpp", "native/src/controls_wasm.cpp"],
    output: "packages/core/src/generated/xmp-controls-wasm.ts",
  },
  {
    // Phase 9: the project core for the browser (opening, checking, saving).
    name: "project",
    prefix: "PROJECT",
    main: "native/src/project_wasm.cpp",
    sources: [
      "native/include/xmp/base.hpp",
      "native/include/xmp/json.hpp",
      "native/include/xmp/numbers.hpp",
      "native/include/xmp/project.hpp",
      "native/include/xmp/project_extensions.hpp",
      "native/include/xmp/project_limits.hpp",
      "native/include/xmp/project_schema.hpp",
      "native/include/xmp/portable.hpp",
      "native/include/xmp/song_snapshot.hpp",
      "native/include/xmp/commands.hpp",
      "native/include/xmp/project_edit.hpp",
      "native/include/xmp/parameters.hpp",
      "native/include/xmp/machines.hpp",
      "native/include/xmp/files.hpp",
      "native/include/xmp/render.hpp",
      "native/include/xmp/voices.hpp",
      "native/include/xmp/rack.hpp",
      "native/include/xmp/performance.hpp",
      "native/include/xmp/play.hpp",
      "native/include/xmp/sequencer.hpp",
      "native/include/xmp/controls.hpp",
      "native/include/xmp/transport.hpp",
      "native/src/project_wasm.cpp",
    ],
    output: "packages/core/src/generated/xmp-project-wasm.ts",
    flags: ["-fno-threadsafe-statics", "-Wl,-z,stack-size=1048576"],
  },
  {
    name: "wave-export",
    prefix: "WAVE_EXPORT",
    main: "native/src/wave_export_wasm.cpp",
    sources: [
      ...readdirSync(join(root, "native/include/xmp"))
        .filter((name) => name.endsWith(".hpp"))
        .sort()
        .map((name) => `native/include/xmp/${name}`),
      "native/src/wave_export_wasm.cpp",
      "tools/engine/build-wasm.mjs",
      "tools/engine/wasi-sysroot.mjs",
    ],
    output: "packages/core/src/generated/xmp-wave-export-wasm.ts",
    cpp: true,
    flags: ["-fno-threadsafe-statics", "-Wl,-z,stack-size=4194304"],
  },
  {
    name: "device-ui",
    prefix: "DEVICE_UI",
    main: "native/src/live_device_wasm.cpp",
    sources: [
      ...readdirSync(join(root, "native/include/xmp"))
        .filter((name) => name.endsWith(".hpp"))
        .sort()
        .map((name) => `native/include/xmp/${name}`),
      "native/src/live_device_wasm.cpp",
      "tools/fonts.mjs",
      "tools/engine/wasi-sysroot.mjs",
      "tools/engine/build-wasm.mjs",
    ],
    output: "packages/core/src/generated/xmp-device-ui-wasm.ts",
    cpp: true,
    flags: ["-fno-threadsafe-statics", "-Wl,-z,stack-size=4194304"],
  },
];
MODULES.push({
  name: "sampler-ui",
  prefix: "DEVICE_UI",
  main: "native/src/device_ui_wasm.cpp",
  compiler: "ui",
  sources: [
    ...MODULES[4].sources,
    "native/src/device_ui_wasm.cpp",
    "native/include/xmp/live_ui.hpp",
    "native/include/xmp/live_edit.hpp",
    "native/include/xmp/live_fields.hpp",
    "native/include/xmp/live_sample.hpp",
    "native/include/xmp/live_screen.hpp",
    "native/include/xmp/live_text.hpp",
    "native/include/xmp/live_theme.hpp",
    "native/include/xmp/live_logo.hpp",
    "native/include/xmp/live_session.hpp",
    "native/include/xmp/live_sequencer.hpp",
    "native/include/xmp/pad_scale.hpp",
    "tools/fonts.mjs",
    "tools/engine/ui-toolchain.mjs",
    "tools/engine/ui-toolchain.lock.json",
  ],
  output: "packages/core/src/generated/xmp-sampler-ui-wasm.ts",
  flags: ["-fno-threadsafe-statics", "-Wl,-z,stack-size=1048576", "-Wl,--max-memory=268435456"],
});
MODULES.push({
  name: "loop",
  prefix: "LOOP",
  main: "native/src/loop_wasm.cpp",
  compiler: "ui",
  sources: [
    "native/src/loop_wasm.cpp",
    "native/include/xmp/live_loop.hpp",
    "native/include/xmp/live_sample.hpp",
    "tools/engine/ui-toolchain.mjs",
    "tools/engine/ui-toolchain.lock.json",
  ],
  output: "packages/core/src/generated/xmp-loop-wasm.ts",
  flags: ["-fno-threadsafe-statics", "-Wl,-z,stack-size=65536", "-Wl,--max-memory=16777216"],
});
// Kept for the engine's staleness test.
export const SOURCES = MODULES[0].sources;
export const OUTPUT = MODULES[0].output;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function sourceHash(module = MODULES[0]) {
  const hash = createHash("sha256");
  for (const file of module.sources)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(root, file)));
  return hash.digest("hex");
}

async function build(module, zig) {
  const out = join(root, `build/wasm/xmp-${module.name}.wasm`);
  await mkdir(join(root, "build/wasm"), { recursive: true });
  const isUi = module.compiler === "ui";
  const sysroot = module.cpp ? await wasiSysroot() : undefined;
  const fonts = module.cpp ? await ensureFonts() : undefined;
  const compiler = isUi ? await uiCompiler() : zig;
  const fontFlags = isUi ? [`-I${join(await ensureFonts(), "image")}`] : [];
  execFileSync(
    compiler,
    [
      ...(isUi ? ["-x", "c++"] : module.cpp ? ["c++"] : ["cc", "-x", "c++"]),
      "-std=c++17",
      "-target",
      isUi ? "wasm32-wasip1" : "wasm32-wasi",
      "-mexec-model=reactor",
      "-O2",
      "-fno-exceptions",
      "-fno-rtti",
      "-fno-stack-protector",
      "-s",
      "-Wall",
      "-Wextra",
      "-Werror",
      ...(sysroot
        ? [
            "-nostdinc",
            "-nostdlib++",
            `-I${join(sysroot, "include/c++/v1")}`,
            `-I${join(sysroot, "include")}`,
            `-I${fonts}`,
          ]
        : []),
      `-I${join(root, "native/include")}`,
      ...fontFlags,
      ...(module.flags ?? []),
      "-o",
      out,
      join(root, module.main),
      ...(sysroot
        ? ["libc++.a", "libc++abi.a"].map((file) => join(sysroot, "lib/wasm32-wasi", file))
        : []),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: join(root, "build/wasm/zig-cache"),
        ZIG_LOCAL_CACHE_DIR: join(root, "build/wasm/zig-local"),
      },
    },
  );
  const bytes = await readFile(out);
  const text = [
    `// Generated by tools/engine/build-wasm.mjs from ${module.main} and its headers.`,
    "// Do not edit; run `npm run engine:wasm`.",
    `export const ${module.prefix}_SOURCE_SHA256 =\n  "${await sourceHash(module)}";`,
    module.prefix.length <= 4
      ? `export const ${module.prefix}_WASM_SHA256 = "${sha(bytes)}";`
      : `export const ${module.prefix}_WASM_SHA256 =\n  "${sha(bytes)}";`,
    `export const ${module.prefix}_WASM_BASE64 =\n  "${bytes.toString("base64")}";`,
    "",
  ].join("\n");
  await writeFile(join(root, module.output), text);
  console.log(`${module.output}: ${bytes.length} bytes, sha256 ${sha(bytes).slice(0, 16)}…`);
}

// The source hash a generated module was built from.
async function builtFrom(module) {
  const text = await readFile(join(root, module.output), "utf8").catch(() => "");
  return new RegExp(`${module.prefix}_SOURCE_SHA256 =\\s*"([0-9a-f]{64})"`).exec(text)?.[1];
}

async function check() {
  for (const module of MODULES) {
    if ((await builtFrom(module)) !== (await sourceHash(module)))
      throw new Error(`The WebAssembly ${module.name} is stale: run \`npm run engine:wasm\``);
  }
  console.log("WebAssembly modules are up to date with their C++ sources.");
}

if (process.argv[1] === import.meta.filename)
  (async () => {
    if (process.argv.includes("--check")) return check();
    const zig = await vmCompiler();
    const all = process.argv.includes("--all");
    for (const module of MODULES) {
      // A module built from these exact sources is left alone (the project
      // module alone takes most of the build).
      if (!all && (await builtFrom(module)) === (await sourceHash(module))) {
        console.log(`${module.output}: unchanged`);
        continue;
      }
      await build(module, zig);
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
