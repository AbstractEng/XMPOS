import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { buildArm } from "./arm-build.mjs";
import { releaseGate } from "./policy.mjs";

export async function buildDeviceImage() {
  const sourceHash = buildIdentity(),
    arm = await buildArm();
  const lock = JSON.parse(await readFile(join(root, "os/device-inputs.lock.json"), "utf8"));
  const components = [lock.base, ...lock.packages];
  for (let i = 0; i < components.length; i += 128) releaseGate(components.slice(i, i + 128));
  await mkdir(join(root, "build/device"), { recursive: true });
  const overlay = await mkdtemp(join(root, "build/device/overlay-"));
  await cp(join(arm.directory, "studio"), join(overlay, "studio"), { recursive: true });
  await cp(join(arm.directory, "bin"), join(overlay, "arm/bin"), { recursive: true });
  await cp(join(arm.directory, "manifest.json"), join(overlay, "arm/manifest.json"));
  const env = { ...process.env, XMP_DEVICE_BUILD: "1", XMP_BUILDER_NODE: process.version };
  for (const [program, args] of [
    [process.execPath, ["tools/os/fetch-inputs.mjs", "device-inputs.lock.json"]],
    [process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "os/vite.config.ts"]],
    [
      "python3",
      [
        "tools/os/build-image.py",
        "--lock",
        "os/device-inputs.lock.json",
        "--app",
        "build/device-app/guest.mjs",
        "--output",
        "artifacts/os/device",
        "--source-hash",
        sourceHash,
        "--device-overlay",
        overlay,
      ],
    ],
  ])
    execFileSync(program, args, { cwd: root, env, stdio: "inherit", timeout: 600000 });
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during Device image build");
  return { image: join(root, "artifacts/os/device"), arm };
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2)
    throw new Error("Fixed generic Device VM only; no physical targets");
  console.log(JSON.stringify({ image: (await buildDeviceImage()).image }));
}
