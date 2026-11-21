import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encodeWav } from "../../packages/core/src/index.ts";
import {
  compareParity,
  packagePlan,
  parityFixtures,
  referenceParity,
  verifyParityOracle,
} from "../../packages/sdk/src/parity.ts";
import { runSdk } from "./commands.mjs";
import compatibility from "./compatibility.json" with { type: "json" };
import { compileParity, nativeParity } from "./parity-host.mjs";

try {
  if (
    Number(process.versions.node.split(".")[0]) !== 24 ||
    !compatibility.hostPlatforms.includes(process.platform)
  )
    throw new Error("Supported SDK requires Node 24 on macOS or Linux");
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "version" || mode === "--version") console.log(JSON.stringify(compatibility));
  else if (mode === "help" || mode === "--help" || !mode)
    console.log(
      "XMP SDK 0.1.0: doctor | version | new | build | test | preview | parity package.xmpkg new-report-directory | conformance new-report-directory | store-init | install | bind | rollback | store-status. Mac/Linux software only; no hardware adapters.",
    );
  else if (mode === "doctor") {
    if (args.length) throw new Error("doctor accepts no target flags");
    const cc = spawnSync("cc", ["--version"], { encoding: "utf8", timeout: 15000 });
    const result = {
      ...compatibility,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      compilerAvailable: cc.status === 0,
      compiler: cc.stdout?.split("\n")[0] ?? null,
      ready: cc.status === 0,
    };
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } else if (mode === "parity" || mode === "conformance") {
    if (args.length !== (mode === "parity" ? 2 : 1) || args.some((a) => a.startsWith("--")))
      throw new Error(
        "Use parity package.xmpkg new-report-directory or conformance new-report-directory; no target flags",
      );
    let cases = parityFixtures();
    let packageSha256 = null;
    if (mode === "parity") {
      const info = await lstat(args[0]);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
        throw new Error("Bounded regular package file required");
      const input = JSON.parse(await readFile(args[0], "utf8"));
      const plan = await packagePlan(input);
      packageSha256 = input.sha256;
      cases = [{ id: "package-preview", plan, expectedFrames: plan.events.map((e) => e.frame) }];
    }
    const directory = resolve(args.at(-1));
    await mkdir(directory, { mode: 0o700 });
    const { binary, receipt } = await compileParity(directory),
      results = [];
    for (const c of cases) {
      const reference = referenceParity(c.plan),
        native = await nativeParity(binary, c.plan, directory, c.id),
        comparison = compareParity(reference, native);
      if (mode === "conformance") {
        verifyParityOracle(c.id, reference);
        verifyParityOracle(c.id, native);
      }
      for (const [name, result] of [
        ["reference", reference],
        ["native", native],
      ])
        await writeFile(
          join(directory, `${c.id}-${name}.wav`),
          Buffer.from(encodeWav([result.pcm, result.pcm], 48000)),
          { flag: "wx" },
        );
      results.push({
        id: c.id,
        ...comparison,
        activeVoices: native.activeVoices,
        trace: native.trace,
      });
    }
    const report = {
      format: "xmp-native-parity-report",
      version: 1,
      sdkVersion: compatibility.version,
      sdkSourceHash:
        typeof __XMP_SDK_SOURCE_HASH__ === "undefined" ? null : __XMP_SDK_SOURCE_HASH__,
      packageSha256,
      nativeBuild: receipt,
      results,
      passed: results.every((r) => r.passed),
      physicalAccess: false,
    };
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        passed: report.passed,
        report: join(directory, "report.json"),
        cases: results.length,
        physicalAccess: false,
      }),
    );
    if (!report.passed) process.exitCode = 1;
  } else await runSdk([mode, ...args]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "SDK command failed");
  process.exitCode = 1;
}
