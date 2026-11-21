import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { vmCompiler } from "../sdk/toolchain.mjs";
import { sha256File } from "./container.mjs";
import { lockFile, pythonRuntime } from "./image-artifacts.mjs";

export async function hostDevelopmentInputs() {
  const lockPath = join(root, "os/live-mk1/host-toolchain.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const cache = join(root, "references/archives/armhf-development");
  await mkdir(cache, { recursive: true });
  for (const entry of lock.packages) {
    const path = join(cache, `${entry.package}.deb`);
    try {
      if ((await stat(path)).size !== entry.bytes || (await sha256File(path)) !== entry.sha256)
        throw new Error(`Changed cached development package: ${entry.package}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      execFileSync(
        "curl",
        [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--max-time",
          "120",
          "--max-filesize",
          String(entry.bytes),
          entry.url,
          "-o",
          `${path}.partial`,
        ],
        { timeout: 130000 },
      );
      if ((await sha256File(`${path}.partial`)) !== entry.sha256)
        throw new Error("Development package download hash mismatch");
      const { rename } = await import("node:fs/promises");
      await rename(`${path}.partial`, path);
    }
  }
  return { cache, lock, lockPath };
}

export async function compileOnHost({ out, runtime, alsa, fonts, sourceHash }) {
  const zig = await vmCompiler(),
    inputs = await hostDevelopmentInputs();
  const headers = join(out, ".headers");
  try {
    execFileSync(
      "python3",
      [
        "-I",
        join(root, "tools/live-mk1/host-headers.py"),
        inputs.cache,
        inputs.lockPath,
        alsa.path,
        headers,
      ],
      { timeout: 120000 },
    );
    const include = join(headers, "usr/arm-linux-gnueabihf/include");
    const common = [
      "-target",
      "arm-linux-gnueabihf",
      "-mcpu=cortex_a17",
      "-O2",
      "-g0",
      `-ffile-prefix-map=${root}=/xmp/source`,
      `-ffile-prefix-map=${dirname(zig)}=/xmp/compiler`,
      "-fno-pie",
      "-ffp-contract=off",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-nostdinc",
      "-isystem",
      join(dirname(zig), "lib/include"),
      "-isystem",
      join(include, "c++/12"),
      "-isystem",
      join(include, "c++/12/arm-linux-gnueabihf"),
      "-isystem",
      include,
      "-I",
      join(root, "native/include"),
      "-I",
      join(fonts, "image"),
      "-I",
      join(root, "os/live-mk1"),
    ];
    const env = {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: join(root, "build/arm-dynamic-zig-cache"),
      ZIG_LOCAL_CACHE_DIR: join(out, ".zig-cache"),
    };
    await mkdir(join(out, "objects"));
    await mkdir(join(out, "link-maps"));
    await mkdir(join(out, "toolchain"));
    const commands = [];
    const run = (args, mode = "cc") => {
      commands.push([zig, mode, ...args]);
      try {
        execFileSync(zig, [mode, ...args], {
          cwd: root,
          env,
          timeout: 180000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        throw new Error(
          `Host ARM compile/link failed: ${error.stderr?.toString() ?? error.message}`,
        );
      }
    };
    const sources = [
      ["runtime-probe", "native/tests/live_runtime_probe.cpp"],
      ["session-0", "native/src/live_session.cpp"],
      ["session-1", "native/src/engine.cpp"],
      ["session-2", "native/src/rt_thread.cpp"],
      ["init-live", "os/live-mk1/session-init.c"],
      ["xmp-bridge", "os/live-mk1/xmp-bridge.c"],
      ["init-emulator", "os/live-mk1/session-init.c"],
      ["live-twin", "os/live-mk1/live-twin.c"],
    ];
    for (const [name, source] of sources)
      run([
        ...common,
        source.endsWith(".cpp") ? "-std=c++17" : "-std=gnu11",
        ...(source.endsWith(".cpp")
          ? ["-include", join(root, "os/live-mk1/cxx-math-compat.hpp")]
          : []),
        ...(name === "init-emulator" ? ["-DXMP_SESSION_EMULATOR"] : []),
        "-c",
        source,
        "-MD",
        "-MF",
        join(out, "objects", `${name}.d`),
        "-o",
        join(out, "objects", `${name}.o`),
      ]);
    const crts = {};
    for (const name of ["crt1.o", "crti.o", "crtn.o", "crtbegin.o", "crtend.o"]) {
      crts[name] = join(
        headers,
        name.startsWith("crtbegin") || name.startsWith("crtend")
          ? "usr/lib/gcc-cross/arm-linux-gnueabihf/12"
          : "usr/arm-linux-gnueabihf/lib",
        name,
      );
      await copyFile(crts[name], join(out, "objects", name));
    }
    for (const name of [
      "session",
      "init-live",
      "xmp-bridge",
      "init-emulator",
      "live-twin",
      "runtime-probe",
    ]) {
      const libraries = ["libgcc_s.so.1", "libm.so.6", "libc.so.6", "ld-linux-armhf.so.3"];
      if (name === "session" || name === "runtime-probe")
        libraries.unshift("libasound.so.2", "libstdc++.so.6");
      if (name === "live-twin") libraries.unshift("libasound.so.2");
      const linkArgs = [
        "-m",
        "armelf_linux_eabi",
        "--dynamic-linker=/lib/ld-linux-armhf.so.3",
        "--no-as-needed",
        "--disable-new-dtags",
        "-rpath",
        "/lib",
        `-Map=${join(out, "link-maps", `${name}.map`)}`,
        "-rpath-link",
        join(runtime, "lib"),
        crts["crt1.o"],
        crts["crti.o"],
        crts["crtbegin.o"],
        ...(name === "session"
          ? [0, 1, 2].map((i) => join(out, "objects", `session-${i}.o`))
          : [join(out, "objects", `${name}.o`)]),
        ...libraries.map((library) => join(runtime, "lib", library)),
        crts["crtend.o"],
        crts["crtn.o"],
        "-o",
        join(out, name),
      ];
      run(linkArgs, "ld.lld");
      if (name === "session")
        run(
          [
            ...linkArgs
              .slice(0, -1)
              .map((arg) =>
                arg.startsWith("-Map=") ? `-Map=${join(out, "link-maps/session-image.map")}` : arg,
              ),
            join(out, "session-image"),
            "--strip-debug",
          ],
          "ld.lld",
        );
    }
    await writeFile(join(out, "toolchain/commands.json"), JSON.stringify(commands, null, 2));
    await writeFile(
      join(out, "toolchain/development-inputs.json"),
      JSON.stringify(inputs.lock, null, 2),
    );
    await writeFile(
      join(out, "toolchain/compiler-receipt.json"),
      await readFile(join(dirname(zig), "xmp-compiler-receipt.json")),
    );
    await writeFile(join(out, "toolchain/source-hash.txt"), sourceHash);
    // Include actual upstream package notices; full corresponding sources remain a release review gate.
    for (const entry of inputs.lock.packages) {
      const path = join(headers, "usr/share/doc", entry.package, "copyright");
      try {
        await copyFile(path, join(out, "toolchain", `${entry.package}.copyright`));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    pythonRuntime([
      "check-elf",
      join(out, "session"),
      lockFile,
      ...["init-live", "xmp-bridge", "init-emulator", "live-twin"].map((n) => join(out, n)),
    ]);
    return {
      compiler: "zig-cc",
      version: "0.13.0",
      developmentInputs: await sha256File(inputs.lockPath),
    };
  } finally {
    await rm(headers, { recursive: true, force: true });
    await rm(join(out, ".zig-cache"), { recursive: true, force: true });
  }
}
