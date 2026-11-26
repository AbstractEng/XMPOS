# Windows installer: MPC visible, fastboot empty

The 23 November 2026 tester report describes an MPC shown as **MPCLive** in
Windows 11 while the installer cannot detect it in update mode, on two PCs.
The tester's USB driver details and installer log have not been obtained, so
the particular driver's failure has not been reproduced on physical Windows.

## Confirmed installer defect and correction

The connection-tools step downloads Google's hash-pinned Platform-Tools. It
does **not** install or validate a Windows USB device driver. Previously, an
empty `fastboot devices` response always said “No device in update mode”, even
when Windows could see MPCLive. That observation cannot establish whether the
MPC is in update mode or whether its driver is compatible with fastboot.

The empty-list refusal now carries `XMP_NO_FASTBOOT_DEVICE` and explains the
driver possibility. During the GUI's read-only inspection, Windows additionally
reads present PnP entries through the existing native host helper. It reports:

| OS observation                              | Installer explanation                                                |
| ------------------------------------------- | -------------------------------------------------------------------- |
| MPCLive, code 28; or code 0 with no service | Missing update-mode device driver                                    |
| MPCLive with another nonzero problem code   | Windows device/driver problem                                        |
| MPCLive, code 0 and a driver service        | Possible interface incompatibility or another app holding the device |
| No MPCLive name                             | Check cable, port, update mode and unrecognised entries              |
| Multiple MPCLive entries or a Force entry   | Disconnect other instruments and inspect Device Manager              |

A WinUSB entry whose registry metadata lacks the Android interface GUID gets a more specific interface-registration diagnosis. An unreadable registry key remains unknown rather than being classified as missing.

The hash-pinned official Windows 3.10.1 updater imports `libusb-1.0.dll`; the hash-pinned Google Platform-Tools 37.0.1 fastboot imports `AdbWinApi.dll`. Inspection of the archives confirms this transport difference, without executing either binary. The AOSP Windows fastboot implementation enumerates Android interface GUID `{F72FE0D4-CBCB-407D-8814-9ED673D0DD6B}`. This is evidence for an interface-binding compatibility risk, not proof of the Reddit tester's installed driver.

This reads host WMI and registry metadata only. It does not open USB devices, install or
replace drivers, restart devices, or run another fastboot command. Device
instance paths and serials are omitted. PnP metadata never establishes an MPC
identity or enables a write. All model, per-unit, image and confirmation guards
remain in the existing flash tool. A failed check leaves no write preview.

## Repairing an existing WinUSB registration

The Windows installer now offers **Set up the MPC connection → Windows sees the
Live but cannot connect? → Repair Windows connection**. Use it after verifying
the Live in stock MPC OS, or importing that unit's verification profile from
its prepared USB key. The repair requires an explicit checkbox and Windows
administrator approval; it never runs automatically during inspection.

This handles a healthy, existing WinUSB driver whose app interface is missing.
It does not install or replace a driver. It matches exactly one update-mode
`09e8:403b` device against the saved, hash-verified ACV8 unit report, refuses
other instruments or ambiguous selections, and adds only Google's fastboot
GUID to that device's `Device Parameters\DeviceInterfaceGUIDs` multi-string
value. Existing GUIDs and the singular `DeviceInterfaceGUID` value are
preserved. Both value names are read during diagnosis. The helper rechecks the
unit and the registry snapshot after elevation, refusing changed state.

Before elevation, the previous values, original registry types and snapshot
fingerprint are saved in the private installer's
`live/reports/live-mk1/windows-usb-backups/` folder. A failed or cancelled repair
never retries automatically or creates a flash preview. For manual rollback,
use the matching backup to restore only the plural registry value's original
type and contents (remove it if it was originally absent); preserve all other
device settings. Reconnect the same device afterward.

After a successful repair, disconnect and reconnect the Live's USB-B cable to
the same computer port, then select **Check Live and image**. The normal unit,
image and owner confirmation checks still apply. Missing drivers and drivers
reporting an error are refused rather than replaced. Secure Boot and driver
signature enforcement stay enabled.

Microsoft documents adding a device interface GUID to an existing WinUSB
registration and reconnecting the device; AOSP's Windows fastboot uses the
Android interface GUID listed above. See [Microsoft's WinUSB installation
instructions](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/winusb-installation)
and [AOSP's Windows fastboot enumeration](https://android.googlesource.com/platform/system/core/+/refs/heads/main/fastboot/usb_windows.cpp).

## Administrator prompt does not appear

A follow-up report on 25 November describes installer 1.0.1 stopping after
“Requesting administrator approval,” with no prompt in Chrome or Edge. The
browser only sends the local action; the native Windows helper requests UAC.
The previous generic error obscured the stage and Windows error code.

The 1.0.2 helper writes UTF-8 directly to its redirected output streams. It no
longer sets `Console.OutputEncoding`, which calls the console code-page API
and can throw when the graphical launcher has no console. Its UAC launch uses
the fixed helper path, its own working directory and a normal visible window.
Only the existing `winusb-apply` action and verified hex hashes cross elevation.
Device identity and registry snapshot checks still run before and after approval.

The installer now distinguishes cancelled approval (Windows 1223), denied
approval (5), a request that could not launch, an elevated child that failed,
changed device/registry state, denied registry access, and timeout. Only fixed
error codes and bounded numeric Windows codes enter the operation log; private
OS messages, paths and serials do not. No failed repair retries automatically.

Console-free startup is covered by the compiled Windows regression test: it
launches the actual helper with `CreateNoWindow`, redirected output and an
unsupported action, and requires the normal argument refusal. This test opens
no device, changes no registry and requests no elevation. The installer and
Gherkin regressions cover a missing prompt separately from cancellation and
verify that neither result enables a flash.

## Information to request from the tester

Ask for the installer version, the **Operation log**, and Device Manager's
MPCLive **General → Device status**, **Driver → Provider/version**, and
**Details → Hardware IDs**. Do not ask for serials, SSH passwords or project files.

This read-only PowerShell command works without a new installer or Node:

```powershell
Get-CimInstance Win32_PnPEntity |
  Where-Object { $_.Present -and $_.PNPDeviceID -like 'USB\*' -and $_.Name -match 'MPC\s*Live' } |
  Select-Object Name, Service, ConfigManagerErrorCode, HardwareID |
  Format-List
```

With a rebuilt installer, the equivalent bounded native helper query is:

```powershell
.\resources\host-helper.exe update-mode-info
```

Close the official updater and other MPC utilities before repeating **Check
Live and image**. The full official updater is not a diagnostic command: it
can perform a firmware installation. Do not tell a tester to run a firmware
update, replace drivers with a generic tool, disable driver signing, or use raw
flash commands as a detection workaround. Establish the actual driver and
hardware IDs first. A command-line flash still needs the same functioning
Windows USB transport.

## Windows 11 testing from an Intel Mac

### Read-only Live Mk1 test, 24 November 2026

The owner's Live Mk1 reproduced the visible-device/empty-fastboot symptom in
the Windows 11 x64 QEMU VM. Before passthrough, the Mac's guarded `status`
matched the saved unit pin and verified hardware observation. Only that exact
update-mode device was attached under AGENTS.md authorization 10.

The compiled Windows helper returned `MPC Live`, `VID_09E8&PID_403B`, service
`WINUSB`, problem code `0`, and an empty `interfaceGuids` list. Google's
hash-verified Platform-Tools 37.0.1, executed through the existing guarded flash
tool's read-only `status`, returned `XMP_NO_FASTBOOT_DEVICE`. The new diagnostic
correctly explained the missing Android interface registration. No driver was
installed or replaced, and no MPC storage, firmware or bootloader was changed.

The owner then approved the narrowly scoped registration repair, recorded as
an amendment to AGENTS.md authorization 10. The Windows-compiled native helper
and the installer's repair module backed up the original settings, obtained
administrator approval and added only the Android fastboot interface GUID.
After detaching and reconnecting that exact Live through QEMU, the same
hash-verified Google fastboot and guarded `status` check succeeded, matching
the expected identity, saved unit pin and verified hardware observation.

This verifies the repair against the owner's physical Live in the Windows VM;
it does not establish the Reddit tester's driver configuration or qualify the
fix on a physical Windows PC. No flash was performed. These changes are included in the rebuilt
[installer 1.0.1](https://github.com/AbstractEng/XMPOS/releases/tag/v1.0.1)
for Windows x64, alongside updated Mac packages.
The software-only Windows run passed 29 tests, skipped one symlink test that
requires additional privileges, and compiled the C# host helper successfully.
The additional Windows repair/diagnostic tests passed 11 tests and skipped one
symlink privilege test; native C# policy tests also passed. On the Mac, all 36
installer tests and the LK18 regression scenario passed.

Use a Windows 11 **x64 virtual machine** in VMware Fusion or UTM's QEMU backend.
Keep a clean snapshot so the installed-driver and missing-driver states can be
compared. Windows licensing is separate from the VM application.

1. First test startup, file preparation and simulated install/restore with no
   physical USB device attached to the guest. The packaged server supports
   `resources\node.exe resources\server.mjs --simulate`; simulation does not
   substitute for the Windows driver test.
2. Run `npm ci`, `npm run live:installer:test` and the C# compilation command
   from `tools/live-mk1/installer/build-windows.mjs` in a Windows checkout.
   These regression tests use fake fastboot responses and do not open hardware.
3. For a separately arranged physical test, the owner connects only the Live
   Mk1's update-mode USB device to the guest. The Force must stay disconnected
   and must never be captured by a broad automatic USB filter. Use the guarded
   installer inspection only, stopping before confirmation or installation.
4. Record PnP metadata and the inspection result, including missing-driver,
   working-driver, disconnected/reconnected and another-updater-open cases.
   USB passthrough itself can introduce problems; confirm any remaining failure
   on a physical Windows 11 PC before claiming driver qualification.

Ordinary Windows containers are not a Windows 11 desktop. `dockur/windows`
runs Windows in a QEMU VM managed by a container. Its documented accelerated
setup needs KVM, and Docker Desktop on macOS is not supported for that setup.
A native Mac VM avoids that extra layer, particularly for USB tests.

Sources: [Microsoft's container requirements](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/system-requirements),
[dockur/windows requirements and USB passthrough](https://github.com/dockur/windows),
[VMware's free Fusion announcement](https://blogs.vmware.com/cloud-foundation/2024/11/11/vmware-fusion-and-workstation-are-now-free-for-all-users/),
[UTM Windows guide](https://docs.getutm.app/guides/windows/),
[UTM USB limits](https://docs.getutm.app/guest-support/sharing/usb/),
[Windows PnP metadata](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-pnpentity),
[fastboot's Windows interface enumeration](https://android.googlesource.com/platform/system/core/+/refs/heads/main/fastboot/usb_windows.cpp).
