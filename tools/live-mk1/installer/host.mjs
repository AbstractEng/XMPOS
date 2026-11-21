import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pythonRun } from "./runtime.mjs";
import { validateUsbVolume } from "./usb.mjs";

const exec = promisify(execFile);
export const supportDirectory = () =>
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "XMP OS Installer")
    : join(homedir(), "Library/Application Support/XMP OS Installer");
export function openBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw Error("Local installer URL required");
  return spawn(process.platform === "win32" ? "explorer.exe" : "/usr/bin/open", [url], {
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}
export async function pickHostFile(kind, resources) {
  if (process.platform === "win32") {
    const r = await exec(
      join(resources, "host-helper.exe"),
      [kind === "updater" ? "pick-updater" : "pick-loader"],
      { windowsHide: true, timeout: 600000 },
    );
    return JSON.parse(r.stdout.trim() || "null");
  }
  const script =
    kind === "updater"
      ? 'POSIX path of (choose file with prompt "Choose the official MPC Gen 1 3.10.1 Updater.app" of type {"com.apple.application-bundle"})'
      : 'POSIX path of (choose folder with prompt "Choose the verified XMP loader folder")';
  try {
    return (await exec("/usr/bin/osascript", ["-e", script], { timeout: 600000 })).stdout.trim();
  } catch (e) {
    if (e.stderr?.includes("(-128)")) return null;
    throw e;
  }
}
export async function usbVolumes(resources, root = null) {
  if (process.platform === "win32") {
    const r = await exec(
      join(resources, "host-helper.exe"),
      root ? ["inspect-usb", root] : ["list-usb"],
      { windowsHide: true },
    );
    const v = JSON.parse(r.stdout);
    return root ? validateUsbVolume(v) : v.map(validateUsbVolume);
  }
  const r = pythonRun(
    ["-I", join(resources, "mac-volumes.py"), ...(root ? ["inspect", root] : ["list"])],
    { encoding: "utf8", timeout: 20000 },
  );
  if (r.error || r.status !== 0)
    throw Error(r.error?.message || r.stderr || "Cannot read USB volume metadata");
  const v = JSON.parse(r.stdout);
  return root ? validateUsbVolume(v) : v.map(validateUsbVolume);
}
export async function labelUsb(volume, resources) {
  validateUsbVolume(volume);
  if (["XMP", "XMPPROBE"].includes(volume.label)) return volume;
  if (process.platform === "win32")
    await exec(join(resources, "host-helper.exe"), ["label-usb", volume.mountPoint], {
      windowsHide: true,
    });
  else await exec("/usr/sbin/diskutil", ["renameVolume", volume.deviceId, "XMP"]);
  const all = await usbVolumes(resources);
  const selected = all.find((v) => v.deviceKey === volume.deviceKey);
  if (!selected) throw Error("Could not reconnect to renamed USB key");
  return selected;
}
export async function ejectUsb(volume, resources) {
  const actual = await usbVolumes(resources, volume.mountPoint);
  if (actual.deviceKey !== volume.deviceKey) throw Error("Selected USB key changed");
  if (process.platform === "win32") {
    await exec(join(resources, "host-helper.exe"), ["open-usb", volume.mountPoint], {
      windowsHide: true,
    });
    return {
      ejected: false,
      instruction: "Use Eject in File Explorer, then move the USB key to the MPC.",
    };
  }
  if (!/^disk\d+$/.test(actual.wholeDisk || "")) throw Error("USB disk identity unavailable");
  await exec("/usr/sbin/diskutil", ["eject", `/dev/${actual.wholeDisk}`]);
  return { ejected: true };
}
