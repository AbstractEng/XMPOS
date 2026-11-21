import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import { buildArm } from "../os/arm-build.mjs";
import { releaseGate } from "../os/policy.mjs";

// Assembles the ARMv7 Device image: the official inMusic az01 kernel, pinned
// Alpine armv7 userspace for Node and Chromium, XMP's Device app and native
// ARM tests, and hardware tools built from the official G1 sources in /opt/g1.
// The output boots only in the owned QEMU "virt" VM; it is not MPC media.

export const ARM_DEVICE_IMAGE = "artifacts/os/live-mk1-device";

async function latest(pointer, hint) {
  const path = join(root, "artifacts/live-mk1", pointer);
  if (!existsSync(path)) throw new Error(hint);
  return resolve(root, JSON.parse(await readFile(path, "utf8")).directory);
}

export async function buildArmDeviceImage() {
  const sourceHash = buildIdentity();
  const kernelDir = await latest("latest-kernel.json", "Run npm run live:kernel -- build first");
  const g1Dir = await latest("latest-g1-userspace.json", "Run npm run live:g1-userspace first");
  const arm = await buildArm();
  const lock = JSON.parse(
    await readFile(join(root, "os/live-mk1/arm-device-inputs.lock.json"), "utf8"),
  );
  const components = [lock.base, ...lock.packages];
  for (let i = 0; i < components.length; i += 128) releaseGate(components.slice(i, i + 128));
  await mkdir(join(root, "build/live-mk1-device"), { recursive: true });
  const overlay = await mkdtemp(join(root, "build/live-mk1-device/overlay-"));
  await cp(join(arm.directory, "studio"), join(overlay, "studio"), { recursive: true });
  await cp(join(arm.directory, "bin"), join(overlay, "arm/bin"), { recursive: true });
  await cp(join(arm.directory, "manifest.json"), join(overlay, "arm/manifest.json"));
  const env = { ...process.env, XMP_DEVICE_BUILD: "1", XMP_BUILDER_NODE: process.version };
  for (const [program, args] of [
    [process.execPath, ["tools/os/fetch-inputs.mjs", "live-mk1/arm-device-inputs.lock.json"]],
    [process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "os/vite.config.ts"]],
    [
      "python3",
      [
        "-I",
        "tools/os/build-image.py",
        "--lock",
        "os/live-mk1/arm-device-inputs.lock.json",
        "--app",
        "build/device-app/guest.mjs",
        "--output",
        ARM_DEVICE_IMAGE,
        "--source-hash",
        sourceHash,
        "--device-overlay",
        overlay,
        "--profile",
        "os/live-mk1/device-profile.json",
        "--kernel",
        join(kernelDir, "zImage"),
        "--init",
        "os/live-mk1/init",
        "--g1-overlay",
        g1Dir,
      ],
    ],
  ])
    execFileSync(program, args, { cwd: root, env, stdio: "inherit", timeout: 1200000 });
  if (sourceHash !== buildIdentity()) throw new Error("Source changed during ARM Device build");
  return { image: join(root, ARM_DEVICE_IMAGE), arm, kernelDir, g1Dir };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2)
    throw new Error("Fixed ARM Device VM only; no device, flash or deploy options exist");
  console.log(JSON.stringify({ image: (await buildArmDeviceImage()).image }));
}
