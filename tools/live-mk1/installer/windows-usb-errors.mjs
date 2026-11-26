// Only fixed native error codes cross into the browser. OS exception messages
// can include the install path, account name or a USB instance serial.
const messages = {
  XMP_UAC_CANCELLED:
    "Windows administrator approval was cancelled. No repair was applied; click Repair Windows connection again when ready to approve it.",
  XMP_UAC_DENIED:
    "Windows blocked the administrator request before the repair could start. Check whether your account can approve administrator requests, then try again. Do not disable Windows security protections.",
  XMP_UAC_LAUNCH_FAILED:
    "Windows could not open the administrator approval request. Extract the entire installer ZIP to a local folder and launch XMP OS Installer.exe from there, then try the repair again.",
  XMP_UAC_CHILD_FAILED:
    "The administrator helper started but could not complete the repair. Reconnect the verified Live and inspect it again; the previous registration is backed up. No automatic retry.",
  XMP_USB_DEVICE_CHANGED:
    "The verified Live is no longer the only healthy update-mode device. Check its USB-B cable and update mode, disconnect other instruments, then inspect it again.",
  XMP_USB_SNAPSHOT_CHANGED:
    "The Live's Windows USB registration changed since inspection. Inspect the Live again before retrying the repair.",
  XMP_USB_REGISTRY_DENIED:
    "Windows denied access to this Live's USB registration. The repair needs administrator approval; no driver was replaced. Check your account or managed-PC policy.",
  XMP_USB_REPAIR_FAILED:
    "The Windows USB repair could not complete. Check the verified Live connection and inspect it again; no automatic retry.",
  XMP_USB_HELPER_TIMEOUT:
    "The Windows USB helper timed out. Check for a pending Windows administrator prompt, then inspect the Live again before retrying. No automatic retry.",
};

export function windowsUsbFailure(error) {
  let detail;
  try {
    const line = String(error?.stderr ?? "").trim();
    if (line.startsWith("XMP_WINDOWS_USB_ERROR ") && line.length <= 512)
      detail = JSON.parse(line.slice("XMP_WINDOWS_USB_ERROR ".length));
  } catch {
    // Unknown output remains private; it is never copied into the browser log.
  }
  if (Object.hasOwn(messages, detail?.code)) {
    const nativeCode = detail.nativeCode;
    const suffix =
      Number.isSafeInteger(nativeCode) && nativeCode > 0 && nativeCode <= 65535
        ? ` (Windows error ${nativeCode}.)`
        : "";
    return Object.assign(Error(messages[detail.code] + suffix), { code: detail.code });
  }
  if (error?.killed || error?.code === "ETIMEDOUT")
    return Object.assign(Error(messages.XMP_USB_HELPER_TIMEOUT), {
      code: "XMP_USB_HELPER_TIMEOUT",
    });
  return Object.assign(
    Error(
      "The Windows USB helper could not start or returned an invalid response. Extract the entire installer ZIP to a local folder and launch XMP OS Installer.exe from there. No automatic retry.",
    ),
    { code: "XMP_USB_HELPER_FAILED" },
  );
}
