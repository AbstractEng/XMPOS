import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { releaseGate } from "./policy.mjs";

export function buildImage(
  output = "artifacts/os/p10",
  { publicImage = false, variant = "development", parityBinary } = {},
) {
  if (!["development", "update-candidate"].includes(variant))
    throw new Error("Unknown development image variant");
  const lock = JSON.parse(readFileSync(resolve(root, "os/inputs.lock.json"), "utf8"));
  releaseGate([lock.base, ...lock.packages], { publicImage });
  const sourceHash = buildIdentity();
  for (const [program, args] of [
    [process.execPath, ["tools/os/fetch-inputs.mjs"]],
    [process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "os/vite.config.ts"]],
    [
      "python3",
      [
        "tools/os/build-image.py",
        "--output",
        resolve(root, output),
        "--source-hash",
        sourceHash,
        "--variant",
        variant,
        ...(parityBinary ? ["--parity-binary", resolve(parityBinary)] : []),
      ],
    ],
  ]) {
    const result = spawnSync(program, args, {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
      env: { ...process.env, XMP_BUILDER_NODE: process.version },
    });
    if (result.status !== 0)
      throw new Error(`Image build failed: ${program}: ${result.error?.message ?? result.status}`);
  }
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during image build");
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== "--public"))
    throw new Error("Build uses the frozen local profile; no deployment flags");
  buildImage("artifacts/os/p10", { publicImage: process.argv[2] === "--public" });
}
