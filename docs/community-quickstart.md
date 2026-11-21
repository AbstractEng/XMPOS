# MPC Live Mk1 community baseline: offline quick start

**Pre-release developer documentation. Public installation is not cleared.** This guide is for the MPC Live Mk1 / ACV8 already running **exactly MPC OS 3.10.1**. It is not a One/One+/One G2/Force procedure. Read [compatibility](compatibility.md) and [known issues](known-issues.md). Keep this source checkout and recovery files available offline before installing.

## Before the first boot

1. Save and back up personal Akai work. Read [installation](install-live-mk1.md) and [return to stock](recover-live-mk1.md) completely. The owner performs physical steps and every flash; installation replaces internal rootfs. The bootloader, its environment and other partitions must remain untouched.
2. Obtain the official signed Gen 1 **3.10.1** updater independently. Prepare the private recovery rootfs, local loader and owner runtime using the versioned install procedure. A public XMP template needs [local USB assembly](live-mk1-owner-runtime.md); it is not directly bootable. Never share the resulting runtime-bearing image or Akai-derived files.
3. Verify source/image/checksum and runtime receipts. First install, XMP boot, no-stick stock handover and full stock restoration still require owner observations against the exact release candidate. These documents and host tests do not substitute for them.
4. Use the complete private kit named in [release status](../RELEASE.md) and the [graphical installer](install-live-mk1.md#graphical-installer-recommended-first-install-route). It prepares both the USB key and local loader/recovery files, performs the fixed stock-unit verification, and asks the owner to confirm each flash with **XMPOS**. Wait for verified USB readback and eject safely. Source-build/CLI preparation is an alternative developer route, not a GUI prerequisite. If upgrading an older development stick, read [updates and rollback](live-mk1-updates.md); preserve projects, samples, configuration, token and a known-good previous image.

## Play, edit, save and reopen

These controls follow the [current control map](device-ui.md). [Gate 2](launch/gate-2.md) records the actual physical observations and their older candidate; these instructions do not claim a new hardware test.

1. Boot the verified XMP stick. Check the expected XMP screen and bridge indicator. Save personal work before using a test project; work on an original demonstration or disposable project copy.
2. Press **MAIN** for Clips. Select a track/scene slot, then use **Edit clip** to open or create its clip. Hold **MENU** and press pad **14** for Steps if needed. On a Kit track, **SHIFT + pad** selects the drum sound; ordinary pads toggle steps. Add a few hits to a disposable clip.
3. Hold **SHIFT** and press **MAIN** for Play. Pads play the selected track. Use **PLAY START** and **STOP** to hear the pattern. A synth pad should release without a stuck note. To extend an occupied clip, use **Overdub**; REC on an occupied clip reports that a clip already exists.
4. Hold **MENU** and press pad **11** for Mix. Touch a track and drag its fader; Undo should restore the change. The four Q-Links depend on view/focus; read their labels rather than assuming MPC OS mappings.
5. Press **STOP**. Wait until the header says **Saved on stick**. If it says **Unsaved changes**, **Saving to stick** or **Save failed**, keep power on and investigate; do not treat it as saved. Native autosave during continuous playback is not claimed.
6. Note the project, clip notes, tempo and one mixer setting. After saving, restart the session or power off normally and boot the same stick. Reopen the same project, compare those settings, then play and stop it. This is the basic persistence check; retain a separate backup before relying on experimental software for personal work.

Physical input sampling is **experimental and unverified**, and is not part of this walkthrough. A software output capture does not test the inputs or physical output quality.

## Stop, update and recover

Stop, wait for **Saved on stick**, then shut down normally before removing the stick. On the Mac, eject the stick safely after any file copy. Do not unplug it while XMP is saving.

Removing the XMP stick allows the installed loader to hand over to Akai's system. That is **stock handover**, not uninstallation. To remove the modified rootfs, the owner follows [the full stock restoration procedure](recover-live-mk1.md) using the verified original image. A failed boot/update is a reason to use the documented recovery route, not to change the bootloader or improvise raw fastboot/SSH commands.

## Develop and get help

Start with [the contribution guide](../CONTRIBUTING.md), [host setup](developer-guide.md) and [offline SDK manual](sdk/README.md). The SDK's instrument/effect packages are bounded data; custom app/UI work is source development, and the SDK does not provide a Live UI plugin loader. The platform foundation is intended for others to build their own instruments and experiences.

For bugs, retain the exact source/SDK compatibility and reproduction and use [project issues](https://github.com/AbstractEng/XMPOS/issues). See [known limits](known-issues.md). The illustrated HTML manual describes browser workflows; its footage and browser storage are not hardware installation or persistence evidence.
