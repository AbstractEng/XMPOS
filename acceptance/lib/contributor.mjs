import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { command, root, sourceFiles } from "./workspace.mjs";
export function cleanCheckout(workspace) {
  const snapshot = workspace.path("snapshot"),
    checkout = workspace.path("checkout");
  mkdirSync(snapshot);
  // A contributor receives repository source, never unrelated untracked artwork or local output.
  for (const path of sourceFiles({ trackedOnly: true })) {
    const output = resolve(snapshot, path);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(resolve(root, path), output);
  }
  command("git", ["init", "--quiet", snapshot]);
  command("git", ["add", "."], snapshot);
  command(
    "git",
    [
      "-c",
      "user.name=XMP acceptance fixture",
      "-c",
      "user.email=fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Ephemeral acceptance snapshot",
    ],
    snapshot,
  );
  const commit = command("git", ["rev-parse", "HEAD"], snapshot).trim();
  command("git", ["clone", "--quiet", "--no-local", snapshot, checkout]);
  if (command("git", ["status", "--porcelain"], checkout).trim())
    throw new Error("Expected clean checkout");
  return { checkout, commit };
}
export function bootstrapChecks(checkout) {
  const logs = [];
  for (const script of ["bootstrap", "check", "inventory:test", "native:test", "bdd:test"])
    logs.push({
      script,
      output: command("npm", ["run", script], checkout, script === "check" ? 1800000 : 600000),
    });
  return logs;
}
export async function startSimulator(checkout, workspace) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] },
  );
  workspace.processes.add(child);
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Simulator exited: ${logs}`);
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()).includes("XMP")) return { child, url };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Simulator did not start: ${logs}`);
}
