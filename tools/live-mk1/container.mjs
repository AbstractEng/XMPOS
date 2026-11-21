import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { root } from "../../acceptance/lib/workspace.mjs";

// Locked-down build containers for Live Mk1 work. The only volume is XMP's own
// work volume; files enter and leave with "docker cp" through the CLI. There
// is no network, no capability, no device and no host directory mount.

export const WORK_VOLUME = "xmp-live-mk1-work";

export const BUILDER_LAYERS = Object.freeze([
  { tag: "xmp-live-mk1-builder:1", dockerfile: "os/live-mk1/builder.Dockerfile" },
  { tag: "xmp-live-mk1-userspace:1", dockerfile: "os/live-mk1/userspace.Dockerfile" },
  { tag: "xmp-live-mk1-probe:1", dockerfile: "os/live-mk1/probe.Dockerfile" },
]);

export function builderPlan(tag) {
  const at = BUILDER_LAYERS.findIndex((layer) => layer.tag === tag);
  if (at < 0) throw new Error(`Unknown XMP builder: ${tag}`);
  return BUILDER_LAYERS.slice(0, at + 1);
}

export function inspectDocker(probe = spawnSync) {
  const result = probe("docker", ["info", "--format", "{{.OSType}}"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    return {
      ready: false,
      reason:
        result.error?.code === "ETIMEDOUT"
          ? "Docker did not respond within 10 seconds; inspect/restart Docker Desktop before retrying"
          : "Docker is unavailable; install/start the Docker daemon before retrying",
    };
  return result.stdout.trim() === "linux"
    ? { ready: true, os: "linux" }
    : { ready: false, reason: "The XMP builders require Linux containers" };
}

export const sha256File = (path) =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });

export function dockerCreateArgs({ image, volumes = [], command }) {
  for (const volume of volumes)
    if (volume.source !== WORK_VOLUME || !volume.target.startsWith("/work"))
      throw new Error(`Refusing container mount ${volume.source}`);
  return [
    "create",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "4096",
    ...volumes.flatMap((v) => ["--mount", `type=volume,source=${v.source},target=${v.target}`]),
    image,
    "bash",
    "-euo",
    "pipefail",
    "-c",
    command,
  ];
}

function docker(args, timeout = 600000) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker ${args[0]} failed (${result.status}): ${result.stderr.slice(-4000)}`);
  return result.stdout;
}

export function ensureBuilder(lock, { noCache = false } = {}) {
  const info = inspectDocker();
  if (!info.ready) throw new Error(info.reason);
  const layers = builderPlan(lock.builder.tag);
  if (layers.at(-1).dockerfile !== lock.builder.dockerfile)
    throw new Error("Builder tag and Dockerfile do not match the reviewed build chain");
  for (const layer of layers) {
    console.error(`Building ${layer.tag}${noCache ? " without layer cache" : ""}`);
    execFileSync(
      "docker",
      [
        "build",
        "--quiet",
        ...(noCache ? ["--no-cache"] : []),
        "--tag",
        layer.tag,
        "--file",
        layer.dockerfile,
        "os/live-mk1",
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"], timeout: 1800000 },
    );
  }
  return execFileSync("docker", ["image", "inspect", lock.builder.tag, "--format", "{{.Id}}"], {
    encoding: "utf8",
    timeout: 15000,
  }).trim();
}

// Creates a throwaway container, copies inputs in, runs it, and copies /out
// back into an XMP-owned artifact directory. The container is always removed.
export async function runContainer({ image, volumes = [], copyIn, command, out, timeout }) {
  const id = docker(dockerCreateArgs({ image, volumes, command })).trim();
  try {
    for (const { from, to } of copyIn) {
      if (!/^\/[a-z-]+(\.[a-z.]+)?$/.test(to)) throw new Error(`Refusing copy target ${to}`);
      docker(["cp", from, `${id}:${to}`], 1800000);
    }
    const run = spawnSync("docker", ["start", "--attach", id], {
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    // Collect /out even after a failure so the logs are kept as evidence.
    spawnSync("docker", ["cp", `${id}:/out/.`, out], { timeout: 600000 });
    if (run.error) throw run.error;
    if (run.status !== 0)
      throw new Error(`Container step failed (${run.status}): ${run.stderr.slice(-4000)}`);
    return run.stdout;
  } finally {
    spawnSync("docker", ["rm", "--force", id], { timeout: 120000 });
  }
}
