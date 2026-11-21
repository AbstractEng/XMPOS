# Current candidate: owner physical checklist

**Pending for 0.1.0-dev.20261121.** This is the remaining physical rehearsal for
the candidate in [HARDWARE-CANDIDATE.json](../../HARDWARE-CANDIDATE.json), not a
request to power on now. The earlier six-step success applies to an older
candidate. Keep the hardware release draft until its qualification is complete; source publication is separate. Only the owner flashes.
Live Mk1 / ACV8 on exactly stock 3.10.1 only; Force and other models are excluded.

1. **Prepare and verify on the host.** Extract the complete private Intel Mac
   kit named in [release status](../../RELEASE.md), verify its checksums and read
   [installation](../install-live-mk1.md) and [recovery](../recover-live-mk1.md).
   Back up personal work and USB contents. Independently supply the official
   signed 3.10.1 updater; prepare the local loader, recovery and USB image in the
   GUI. Retain their actual manifests/hashes privately. Do not substitute an old
   owner image or a simulated identity profile.
2. **Verify this stock unit.** When available, start in official 3.10.1, keep the
   XMP key out, enable Developer Mode yourself and use the GUI's fixed read-only
   verifier with the displayed local IPv4. Enter credentials only in its secure
   prompt or use an existing owner SSH key. Prepare the removable FAT32 USB key,
   wait for verified readback and safely eject. Preserve projects and backups.
3. **Owner installs the loader.** Follow the GUI's connection-tools step. Save,
   shut down and enter update mode with FULL LEVEL + ERASE + PAD BANK C/G while
   powering on. Connect USB-B, keep the XMP key out and run Check Live and image.
   Stop on a refusal. After checking identity/image/acknowledgements, type
   **XMPOS** and click Install loader yourself. Keep mains/USB connected. Never
   use raw fastboot commands or change the bootloader/other partitions.
4. **Boot and check music/persistence.** Boot the prepared key and verify the
   current session identity, not a fallback previous image. Use an original
   disposable project: briefly play/edit, check pads/controls/touch/listening,
   Stop and wait for **Saved on stick**. Restart/reopen, compare the edit and play
   again. Physical input sampling is outside the verified baseline. Record
   applicable enabled update/fallback observations through the existing guarded
   workflow; agent access remains subject to the recorded owner authorizations.
5. **Prove stock handover.** Stop, wait for saved, shut down normally, remove
   the key and boot. Confirm the normal Akai interface. This is handover through
   the loader, not removal of the modified rootfs.
6. **Prove full restoration.** With the key out, use the documented recovery
   route and verified original 3.10.1 rootfs. The owner confirms any write with
   **XMPOS**. Cold-boot without the stick; confirm MPC OS **3.10.1**, ordinary
   project/storage availability and no unexpected behavior.

Retain actual observations and matching logs/manifests privately. Do not publish
serials, IPs, tokens, credentials or personal projects. Record the starting and
restored versions, loader install, exact XMP boot/save/reopen, handover and full
restoration. The maintainer binds these to current component/source clearance
and runs the unchanged package gate. Emulator results and a successful flash
transport do not substitute for owner observations.
