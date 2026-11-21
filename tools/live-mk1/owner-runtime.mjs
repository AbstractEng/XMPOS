import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { MPC_RUNTIME, requireSupportedUpdater } from "./compatibility.mjs";
import { sha256File } from "./container.mjs";
import { pythonRun } from "./installer/runtime.mjs";
import { checkUpdater } from "./probe-image.mjs";
import { prepareVerifiedStock } from "./stock-image.mjs";

export async function prepareOwnerRuntime(app, destination) {
  // Authenticate before parsing any updater contents. Read local files only.
  const updater = checkUpdater(app);
  requireSupportedUpdater(await sha256File(updater.image));
  const output = resolve(destination);
  if (!output.startsWith(resolve(root, "artifacts") + sep))
    throw new Error("New owner-local output under artifacts/ required");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(output))) !== dirname(output))
    throw new Error("Symlink output path refused");
  try {
    await lstat(output);
    throw new Error("Runtime output already exists; choose a new directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stock = await prepareVerifiedStock(updater.image, join(root, "artifacts/live-mk1"));
  if (stock.sha256 !== MPC_RUNTIME.rootfsSha256) throw new Error("Unexpected 3.10.1 rootfs hash");
  const result = pythonRun(
    [
      "-I",
      join(root, "tools/live-mk1/owner-runtime.py"),
      stock.image,
      join(root, "os/live-mk1/mpc-runtime.lock.json"),
      output,
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Runtime extraction failed: ${result.error?.message ?? result.stderr.trim()}`);
  const receipt = JSON.parse(await readFile(join(output, "runtime-receipt.json"), "utf8"));
  const authenticated = { ...receipt, updaterSignatureVerified: true };
  await writeFile(
    join(output, "owner-preparation.json"),
    `${JSON.stringify(authenticated, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { directory: relative(root, output), ...authenticated };
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: npm run live:prepare-runtime -- "<3.10.1 Updater.app>" artifacts/<new-directory>',
    );
  console.log(JSON.stringify(await prepareOwnerRuntime(process.argv[2], process.argv[3]), null, 2));
}
