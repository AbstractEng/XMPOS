import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createController } from "./controller.mjs";
import { openBrowser, pickHostFile, supportDirectory } from "./host.mjs";

// A Windows GUI launcher has no console. Keep startup failures visible in a
// per-user log instead of writing to invalid inherited console handles.
if (process.platform === "win32") {
  const logRoot = supportDirectory();
  mkdirSync(logRoot, { recursive: true });
  const log = (...args) =>
    appendFileSync(
      join(logRoot, "launch.log"),
      `${new Date().toISOString()} ${args.map(String).join(" ")}\n`,
    );
  console.log = console.warn = console.error = log;
}

export async function startInstaller({
  execute,
  pick,
  html,
  simulation = false,
  initialSelection = null,
  rememberSelection = async () => {},
}) {
  const nonce = randomBytes(32).toString("hex");
  const controller = createController({
    execute,
    pick,
    simulation,
    initialSelection,
    rememberSelection,
  });
  let origin;
  let lastRequest = Date.now();
  const json = (res, code, value) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    lastRequest = Date.now();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    if (req.headers.host !== origin?.slice(7) || req.socket.remoteAddress !== "127.0.0.1")
      return json(res, 403, { error: "Local installer only" });
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html.replaceAll("__NONCE__", nonce));
      return;
    }
    if (
      !req.url?.startsWith("/api/") ||
      req.headers["x-xmp-installer"] !== nonce ||
      (req.headers.origin !== undefined && req.headers.origin !== origin)
    )
      return json(res, 403, { error: "Installer token required" });
    if (req.method === "GET" && req.url === "/api/state") return json(res, 200, controller.view());
    if (
      req.method !== "POST" ||
      req.url !== "/api/action" ||
      req.headers.origin !== origin ||
      req.headers["content-type"] !== "application/json"
    )
      return json(res, 403, { error: "Same-origin JSON required" });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) {
          json(res, 413, { error: "Request too large" });
          req.resume();
          return;
        }
        chunks.push(chunk);
      }
      await controller.action(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      json(res, 200, controller.view());
    } catch (error) {
      json(res, 400, { error: error.message, state: controller.view() });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const idle = setInterval(() => {
    if (!controller.view().busy && Date.now() - lastRequest > 30 * 60_000) server.close();
  }, 60000);
  idle.unref();
  server.on("close", () => clearInterval(idle));
  return { server, origin, nonce, controller };
}

async function packagedMain() {
  const resources = dirname(fileURLToPath(import.meta.url));
  const simulation = process.argv.includes("--simulate");
  const workspace = resolve(
    process.env.XMP_INSTALLER_WORKSPACE ||
      join(supportDirectory(), simulation ? "simulation" : "live"),
  );
  process.umask(0o077);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  if ((await lstat(workspace)).isSymbolicLink() || (await realpath(workspace)) !== workspace)
    throw new Error("Installer workspace must be a regular private folder");
  const lockPath = join(workspace, "instance.lock");
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await lstat(lockPath)).isSymbolicLink())
      throw new Error("Invalid installer instance lock");
    const previous = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(previous.pid) || previous.pid < 1)
      throw new Error("Invalid installer instance lock");
    let active = true;
    try {
      process.kill(previous.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") active = false;
      else throw e;
    }
    if (active) {
      const session = JSON.parse(await readFile(join(workspace, "session.json"), "utf8"));
      if (session.pid !== previous.pid || !/^http:\/\/127\.0\.0\.1:\d+$/.test(session.url))
        throw new Error("Installer is already starting; reopen it shortly");
      const page = await fetch(session.url, {
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      if (!page.ok) throw new Error("An installer is already running; use its existing window");
      if (process.argv.includes("--open")) openBrowser(session.url);
      console.log(session.url);
      return;
    }
    await rm(lockPath);
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  }
  process.env.XMP_INSTALLER_WORKSPACE = workspace;
  process.env.XMP_INSTALLER_RESOURCES = resources;
  const manifest = JSON.parse(await readFile(join(resources, "bundle-manifest.json"), "utf8"));
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new Error("Invalid installer resource path");
    const bytes = await readFile(join(resources, path));
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error(`Installer resource changed: ${path}`);
  }
  for (const path of manifest.workspaceFiles) {
    const dest = join(workspace, path);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(resources, "workspace", path), dest);
  }
  const execute = (request, record) =>
    new Promise((done, fail) => {
      const worker = new Worker(join(resources, "worker.mjs"), {
        workerData: { request, resources, workspace, simulation },
      });
      let settled = false;
      worker.on("message", (msg) => {
        if (msg.log !== undefined) record(msg.log);
        if (msg.progress !== undefined) record(msg.progress);
        if (msg.error !== undefined) {
          settled = true;
          fail(new Error(msg.error));
        }
        if (msg.result !== undefined) {
          settled = true;
          done(msg.result);
        }
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!settled)
          fail(
            new Error(
              `Installer operation ended unexpectedly (${code}); inspect the log before retrying`,
            ),
          );
      });
    });
  const pick = (kind) => pickHostFile(kind, resources);
  let initialSelection = null;
  const selectionFile = join(workspace, "selection.json");
  try {
    const info = await lstat(selectionFile);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 16384)
      initialSelection = JSON.parse(await readFile(selectionFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      console.warn("Previous selection could not be restored; choose files again.");
  }
  const rememberSelection = async (selection) => {
    const temp = join(workspace, `selection-${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(temp, JSON.stringify(selection), { flag: "wx", mode: 0o600 });
    await rename(temp, selectionFile);
  };
  const instance = await startInstaller({
    initialSelection,
    rememberSelection,
    execute,
    pick,
    html: await readFile(join(resources, "index.html"), "utf8"),
    simulation,
  });
  await writeFile(
    join(workspace, "session.json"),
    JSON.stringify({ pid: process.pid, url: instance.origin, simulation }),
    { mode: 0o600 },
  );
  instance.server.on("close", () => {
    rm(lockPath).catch(() => {});
  });
  console.log(instance.origin);
  if (process.argv.includes("--open")) openBrowser(instance.origin);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  packagedMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
