import { spawnSync } from "node:child_process";
import { join } from "node:path";
export function toolPath(path, platform = process.platform) {
  if (platform !== "win32" || !/^[A-Za-z]:[\\/]/.test(path)) return path;
  return `/cygdrive/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`;
}
export function pythonRun(args, options = {}) {
  const resources = process.env.XMP_INSTALLER_RESOURCES;
  const windows = process.platform === "win32" && resources;
  const program = windows ? join(resources, "image-tools/bin/python3.12.exe") : "python3";
  return spawnSync(program, ["-B", "-I", ...(windows ? args.map((s) => toolPath(s)) : args)], {
    ...options,
    windowsHide: true,
  });
}
