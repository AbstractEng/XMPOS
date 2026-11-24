// Host registry/WMI observations explain an empty fastboot list. They never
// establish an MPC identity or permit an installation or a driver change.
// AOSP AdbWinApi/fastboot enumerates this interface class, not friendly names.
const androidInterface = "{f72fe0d4-cbcb-407d-8814-9ed673d0dd6b}";
const guidPattern = /^\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}$/i;
export function windowsConnectionMessage(rows) {
  if (!Array.isArray(rows) || rows.length > 32) throw Error("Invalid Windows USB metadata");
  for (const row of rows) {
    if (
      !row ||
      typeof row.name !== "string" ||
      row.name.length > 256 ||
      typeof row.service !== "string" ||
      !/^[\w.-]{0,128}$/.test(row.service) ||
      !Number.isInteger(row.problemCode) ||
      row.problemCode < 0 ||
      row.problemCode > 65535 ||
      typeof row.usbId !== "string" ||
      !/^VID_[0-9A-F]{4}&PID_[0-9A-F]{4}$/i.test(row.usbId) ||
      (row.interfaceGuids != null &&
        (!Array.isArray(row.interfaceGuids) ||
          row.interfaceGuids.length > 32 ||
          row.interfaceGuids.some((g) => typeof g !== "string" || !guidPattern.test(g))))
    )
      throw Error("Invalid Windows USB metadata");
  }
  if (rows.some((r) => /force|ada2/i.test(r.name)))
    return "Windows lists a Force. Disconnect it and all other MPCs; connect only the Live Mk1. No device identity has been verified.";
  const candidates = rows.filter((r) => /mpc\s*live/i.test(r.name));
  if (candidates.length > 1)
    return "Windows lists multiple MPC Live USB entries. Disconnect other MPCs and check Device Manager before retrying. No device identity has been verified.";
  if (!candidates.length)
    return "Windows does not list an MPCLive USB entry. Check its USB-B data cable, port and update mode. A generic or unrecognised entry may still appear in Device Manager.";
  const row = candidates[0];
  const prefix = `Windows lists MPCLive (${row.usbId}; driver service: ${row.service || "none"}; problem code: ${row.problemCode}), but fastboot cannot see it. `;
  if (row.problemCode === 28 || (row.problemCode === 0 && !row.service))
    return `${prefix}The update-mode USB driver is missing. Installing connection tools downloads fastboot; it does not install a Windows device driver. Check this entry in Device Manager and use Akai's official driver/support instructions. No driver or MPC storage was changed.`;
  if (row.problemCode !== 0)
    return `${prefix}Windows reports a device/driver problem. Check this entry's status in Device Manager. No driver or MPC storage was changed.`;
  if (
    row.service.toLowerCase() === "winusb" &&
    Array.isArray(row.interfaceGuids) &&
    !row.interfaceGuids.some((g) => g.toLowerCase() === androidInterface)
  )
    return `${prefix}WinUSB is present, but its registry metadata does not list the Android USB interface used by Google's fastboot. Akai's updater uses a different USB library, so visibility there does not prove fastboot compatibility. A compatible driver/interface binding needs verification. No driver or MPC storage was changed.`;
  return `${prefix}The installed driver may not expose the interface required by Google's fastboot, or another application may hold it. Close the official updater and other MPC utilities, then check the entry's driver and hardware IDs in Device Manager. The MPCLive name alone does not prove compatibility. No driver or MPC storage was changed.`;
}

export async function inspectWithConnectionDiagnostics(
  inspect,
  { platform = process.platform, readMetadata, log = () => {} },
) {
  try {
    return await inspect();
  } catch (error) {
    if (platform !== "win32" || error.code !== "XMP_NO_FASTBOOT_DEVICE") throw error;
    let message;
    try {
      message = windowsConnectionMessage(await readMetadata());
    } catch {
      // Do not expose an exception containing device instance paths/serials.
      log("Windows USB metadata unavailable; inspect MPCLive in Device Manager.");
      throw error;
    }
    log(message);
    throw Object.assign(new Error(message, { cause: error }), { code: error.code });
  }
}
