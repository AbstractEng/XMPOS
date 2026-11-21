# MPC Live Mk1: local preparation and first installation

**Private release staging.** Use only a candidate with matching distribution, compatibility, bridge and installation evidence. Publication remains on hold until the owner releases it. Agents do not flash. The owner's execution boundary is in `AGENTS.md`.

## What is downloaded and what stays local

The complete private GUI kits are listed in [current release status](../RELEASE.md#staged-hardware-downloads). Extract the entire kit and start with `START-HERE.txt`. They include the embedded template, installer, source/notices and offline instructions. These private installer kits are separate from the fixed eight-file template pack below; neither staging nor a GUI simulation supplies current physical clearance.

A public XMP package may contain only the reviewed XMP `system.img`, corresponding source, third-party notices, these instructions, the XMP licence, a release manifest and checksums. The package builder requires review records bound to those exact bytes and current owner installation/recovery observations. A `containsVendorFiles: false` flag is not a redistribution approval: the legacy development session statically links third-party software and includes licensed fonts. That static image is blocked from public packaging. The selected public template must use the owner-local dynamic runtime profile.

Each owner obtains Akai's official **Gen 1 MPC OS 3.10.1 updater** independently. It is not in the XMP download. Match the package manifest's `localUpdater.imageSha256` to the updater's embedded `Update.img`; do not substitute another version just because its app signature is valid. Review records also name the starting/restored MPC OS version. Only Live Mk1 / ACV8 already running **3.10.1** is supported. Newer and older firmware are excluded. The owner uses Akai’s updater to reach that version; XMP does not update firmware as an installation prerequisite.

The locally generated loader rootfs and extracted stock recovery rootfs contain Akai material. Keep the updater, `Update.img`, both rootfs images, their ledgers, device logs and credentials local. They must never enter a public archive, Git commit, press kit or CI upload. Removing the USB stick boots Akai through the installed loader; that is **stock handover**, not removal of the modified rootfs.

## Graphical installer: recommended first-install route

The Intel Mac installer prepares **both** the removable FAT32 USB key and the
local loader/recovery files, then asks the owner to install the loader. No
terminal, Docker or separate Python/Node installation is needed. Windows x64
has the same interface but remains a preview: physical Windows USB driver and
flash qualification has not been performed. Apple Silicon is unqualified.

1. Save work and back up the Live and USB key. Start the Live in official
   **3.10.1**, with the XMP key out. Obtain the matching official updater yourself.
2. Open the installer, choose the updater and click **Prepare installation
   files**. The app verifies its signature and pinned payload, builds/audits
   the loader locally, and assembles a private USB image from the XMP template
   and owner-local runtime files. Keep all generated images private.
3. For a fresh Live, enable Developer Mode on the device yourself. In **Verify
   stock Live**, enter its displayed local IPv4 address, tick the read-only
   verification acknowledgement and verify. Enter the SSH password only in the
   native secure prompt (or use an existing owner-installed key). The installer
   reads fixed identity/version/root mount/partition metadata; it does not change
   the stock system. It measures that unit's rootfs capacity and records hashed
   identity aliases locally. It never borrows another owner's partition size.
4. Connect the removable FAT32 USB key to the computer. Refresh, select it,
   confirm the key/backup and click **Prepare USB key**. Wait for the SHA-256
   readback result, then safely eject. Existing projects, samples, token and
   previous images are preserved. A private verification profile accompanies
   the key; do not share it or your assembled image.
5. Accept Google's terms and install the connection tools. Shut down the Live;
   keep the key out. Hold **FULL LEVEL + ERASE + PAD BANK C/G** while powering
   on, then connect USB-B. Click **Check Live and image**. The measured stock
   identity must match this fastboot unit, with the qualified bootloader/profile.
   Missing product/size replies alone are acceptable only with that verified
   same-unit stock measurement. Unknown/mismatched facts stop installation.
6. Review the acknowledgements, type **XMPOS** exactly and click **Install loader**
   yourself. Keep mains/USB connected through completion. Only rootfs is written.
7. Power off, insert the prepared key and boot XMP. Verify play/edit, Stop,
   **Saved on stick**, restart and reopen. Prove no-stick stock handover and full
   restored-stock 3.10.1 using the recovery procedure. Removing the key does not
   uninstall the loader.

A first-use check on 18 November used fresh host state without a historical
report or fastboot pin, then passed a real fastboot dry run. The six physical
installation/recovery observations remain the owner's separate recorded proof.
One tested unit establishes the minimum Live Mk1 route, not a multi-unit survey.
The first stock check uses the host's OS-provided OpenSSH Client; on Windows it
may need enabling under Optional Features. Passwords and host keys stay local.

## Prerequisites and preparation on the Mac

The supported model/firmware is Live Mk1 / `inmusic,acv8`, exactly 3.10.1; all other models/versions stop installation. The source checkout’s `docs/compatibility.md` contains the full matrix and offline preflight. Run `npm run live:preflight -- <local-observations.json>` before an owner rehearsal. It reviews saved observations and local host metadata without contacting hardware; it does not replace file authentication, live identity/capacity checks or the release gates. Unknown rootfs capacity and unqualified models stop the procedure. MPC One/One+ are planned ports only; the Live tool must never be used to test them.

Use the matching versioned source checkout and the host/Docker prerequisites in `docs/developer-guide.md` (repository paths in this document refer to that checkout). The graphical previews accept the official macOS `.app` or Windows `.exe` respectively; Linux installer support is not claimed. Confirm the exact unit is Live Mk1 / ACV8 and the starting firmware/bootloader/stick combination has a reviewed compatibility record. The Force and other MPC models are excluded.

Before installation the owner saves work and makes their normal Akai project/storage backups. Installing the loader replaces the internal **rootfs partition**, even though XMP sessions store their changes on USB. It is not a zero-write USB live boot. Bootloader, its environment, partition table and other internal partitions are outside the procedure.

1. Read `RECOVERY.md` before beginning. Keep the official updater and verified original rootfs available offline on the Mac.
2. Verify the XMP download through the release's authenticated publication channel and checksum/signature procedure. Checksums alone establish integrity, not publisher identity; obtain the checksums through the maintainer-controlled HTTPS release home. Detached signing is not a minimum-baseline requirement.
3. Unpack into a fresh directory. Do not mix releases. For a complete GUI kit, check `DOWNLOAD.json` and `SHA256SUMS`, then follow the graphical route above. The source-build template pack instead has `manifest.json`, `SHA256SUMS` and the fixed eight-file allowlist; the remaining commands in this section describe that developer route.
4. Prepare the recovery image locally, without connecting an instrument:

   ```sh
   npm run live:prepare-stock -- "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app"
   ```

   This checks the app signature/inMusic team, Live-compatible AZ01 rootfs/xz payload and its embedded hash, then bounds decompression and hashes the original ext4. Every call compares any existing cache to a fresh extraction. A mismatch stops; it does not overwrite a recovery image. Compare its `updaterImageSha256` with the public manifest before proceeding.
5. Build the loader locally:

   ```sh
   npm run live:loader-image -- "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app" --host
   ```

   The Mac host route builds its pinned local filesystem tools and the loader without Docker. The builder verifies signature/payload again and requires the reviewed matching kernel inputs. Its manifest must show only `boot/boot.scr.uimg` changed, the expected updater image hash, a clean filesystem audit and U-Boot boot files in block group 0. Do not flash if any differ. Never distribute this output.
6. Prepare owner-local runtime files on the Mac:

   ```sh
   npm run live:prepare-runtime -- "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app" artifacts/owner-runtime-3.10.1
   ```

   It accepts only the pinned signed updater and verifies each extracted file. No instrument is contacted. Keep this directory private.
7. Build and assemble locally, using the matching source checkout’s `docs/live-mk1-owner-runtime.md`:

   ```sh
   npm run live:dynamic-image -- artifacts/owner-runtime-3.10.1 --host
   npm run live:assemble -- artifacts/live-mk1/dynamic-template-EXAMPLE artifacts/owner-runtime-3.10.1 artifacts/owner-system
   ```

   Substitute the template directory printed by the build. For an already reviewed public download, start from that template directory and run only assembly, without `--emulator`; developer helpers are not included in the public ZIP. Use that option only for the separate local emulator lane. The output directory must be new. Assembly verifies the template and every runtime file, creates a private USB `system.img` and binds its hash to the public template/updater/runtime lock. Never publish that private image. Run the ARM runtime and complete candidate checks before proceeding; public installation remains gated. Only the final verified private image goes to `xmp/system.img`, using the owner's chosen stick/file manager or the authorized bridge. Never copy an internal-rootfs image there. Use only the corrected reviewed bridge; an earlier bridge needs an owner USB-copy upgrade while powered off. Do not push through its faulty promotion path.

## Prepare the removable stick

Use the owner's dedicated FAT32 USB stick, labelled **XMP** (or XMPPROBE), mounted on the Mac with exactly one such volume present. Do not use internal MPC storage or request storage/controller mode on another instrument. With the Live powered off, run:

```sh
npm run live:bridge -- prepare-stick
```

This creates `xmp/bridge.token` with a fresh per-stick secret, or reconnects using that stick’s existing token. It writes no system image and contacts no instrument. Never share the token. Copy only the verified private owner image to `xmp/system.img`; keep its matching manifest and checksums on the Mac, and preserve a known-good previous image on upgrades. Safely eject the stick before connecting it to the Live. Do not copy the loader/stock rootfs into `xmp/system.img`.

## Owner-only first install

The private graphical installer prepares both the USB key and the MPC loader. On Intel macOS, double-click `artifacts/installer/XMP OS Installer.app`. The Windows x64 preview uses `XMP OS Installer.exe` beside its resources folder; physical Windows driver/flash qualification is pending. No terminal, Python, Node or Docker installation is required on the owner's computer.

For a fresh key, USB preparation adds **Acid Circuit**, the original 128 BPM acid-house demo. After boot, press **PLAY** to hear its complete arrangement. Existing startup projects, legacy patterns, edit journals and recovery saves are preserved; named projects and samples are never replaced.

1. Choose the official Gen 1 **3.10.1** updater for the host platform and click **Prepare installation files**. Signature, exact payload and stock recovery checks run locally. The bundled XMP-only template is combined with runtime files extracted locally from that updater. Completed files are reverified and reused; insufficient disk space stops preparation without replacing recovery files.
2. Connect a removable FAT32 USB key, refresh, select it and confirm the backup checkbox. Click **Prepare USB key**. The installer verifies the copied `xmp/system.img`, preserves projects, samples, token and prior images, and does not format the key. Safely eject it before moving it to the MPC.
3. Accept Google's linked terms and click **Install connection tools**. This installs computer communication tools, not files on the key or MPC.
4. With the key out and the Live in documented update mode, click **Check Live and image**. Review the operation, check the owner acknowledgements and type **XMPOS**. Click **Install loader** yourself. This step writes only the MPC's rootfs; it does not write the USB key. First-use identity pinning happens under the same confirmation; there is no second typed phrase.

Each stage names its destination and shows an animated activity indicator; USB copying also reports measured byte progress. Installation and stock recovery delegate to the guarded flash tool; agents never click a real write. The Mac preview is ad-hoc signed and Windows is unsigned. Public component/source clearance and platform signing remain open. Owner-generated loader, recovery and runtime-bearing images must stay private. See `tools/live-mk1/installer/REBUILD.md` and `docs/launch/gate-1-owner-checklist.md`.

Bootloader 0.4 on the observed Live returns “Variable not implemented” for `product` and `partition-size:rootfs`, sometimes with exit status zero. The flash tool treats `FAILED` as failure regardless of exit status. For these two explicitly unimplemented queries, a private hash-verified saved boot report may establish this same unit's ACV8/RK3288 identity and measured mounted-rootfs capacity. The report's serial must match the currently connected unit, and the bootloader must still be 0.4. Unknown units, missing or changed evidence, conflicting reported values and transport failures still stop. No universal capacity or guessed product is substituted. The report and receipt stay outside the app and public archives. A general first-install route for units without saved measurements remains to be qualified before public installer distribution.

The following CLI route remains available for developers:

The owner performs every physical step and flash, on the reviewed mains-power/cable setup. The existing tool has no bootloader/partition-table write route. Do not add generic fastboot/SSH instructions to work around a refusal.

1. Enter the Live's fastboot update mode using the documented owner procedure (FULL LEVEL + ERASE + PAD BANK C/G during power-on, or the reviewed official update-mode menu route).
2. In that mode the owner runs `npm run live:flash -- status`, confirms exactly one Live is reported and the pinned identity matches. Identity ambiguity, a Force identity, unknown/non-ext4 rootfs or unreadable capacity must stop the write.
   The tool records the unit serial from `fastboot devices` privately and compares it on subsequent commands. A legacy record containing only firmware fields is unpinned: the owner must complete the existing typed first-use confirmation again before the next write. Status/dry-run never enrols a unit. On a genuinely first installation, the offline preflight can record `firstUseOwnerConfirmationPlanned: true`; that is preparation intent, not a device pin or permission for an agent to flash.
3. Preview the locally built loader: `npm run live:flash -- loader`. This still queries hardware but sends no write. Read the exact rootfs image SHA-256 and size, and match them to the loader manifest.
4. **Owner only:** `npm run live:flash -- loader --write`. The owner supplies the tool's first-use identity confirmation if needed and its typed flash confirmation. Allowed writes are exactly unlock → `flash rootfs` → reboot. No erase, environment reset, bootloader or other-partition command is permitted.
5. With the prepared stick, confirm XMP boots, identifies the correct board, shows the expected candidate and bridge indicator, and can save/reopen an original test song. Record the source/system/loader/updater hashes and observation evidence locally. Do not infer success merely from the flash command completing.
6. Shut down normally, remove the stick and confirm the normal MPC screen/version appears. This proves the loader's stock handover on this unit. Complete the **full stock restoration rehearsal** in `RECOVERY.md` before signing off first installation for release.

Use `docs/distribution-review.template.json` and `docs/installation-evidence.template.json` as pending templates. Their null/pending values deliberately fail the package gate. Record actual observations and hash the local evidence files; do not relabel VM/synthetic evidence as a physical rehearsal. The public package contains only an aggregate owner-evidence receipt hash, not identity hashes, screenshots, serials or raw logs.

## Basic play, save and reopen (offline)

After the candidate’s verified XMP boot, use a disposable project copy rather than personal work. MAIN opens Clips; choose a track/scene slot and Edit clip. MENU + pad 14 opens Steps. On a Kit track, SHIFT + pad selects the drum sound and ordinary pads toggle steps. SHIFT + MAIN opens Play; PLAY START and STOP control playback. MENU + pad 11 opens Mix. These are XMP mappings, not MPC OS mappings.

Make a small edit, press STOP, and wait for **Saved on stick**. Autosave during continuous playback is deferred. **Unsaved changes**, **Saving to stick** and **Save failed** are not completed saves; keep power on and investigate. Note the clip notes, tempo and one mixer setting, then restart the session or shut down normally and boot the same stick. Reopen the project and verify those settings and playback. Stop and wait for Saved on stick before shutdown/removal; safely eject after Mac file copies.

Physical input sampling remains experimental and unverified. The known timing limit includes late-note events in a diagnostic soak; no clean eight-hour stress test, physical latency or production reliability is claimed. Browser/VM results do not qualify hardware. The source checkout’s `docs/known-issues.md` records the scope and issue route.

## Updates and fallback (offline)

The corrected Mac bridge preflights the adjacent owner manifest, exact 3.10.1 profile, filesystem/runtime pins and image hash before opening hardware. It refuses the earlier unsafe bridge. Stop and save before transfer; leave controls idle. A successful push retains the previous image; **reboot** loads a new image while **restart** only restarts the mounted session. A failed transfer/promotion is not permission to reboot.

For the first corrected-bridge upgrade, stop, wait for Saved on stick, power off, and move the USB stick to the Mac. Preserve projects, samples, configuration, `bridge.token` and a known-good previous image. Verify the newly assembled owner image/manifest, copy it via a temporary file, verify the copy, preserve the old active image as `system.img.previous`, and replace `xmp/system.img`. Clear `.fallback-tried` only after this deliberate repair/upgrade, eject safely, then boot. Full source instructions are `docs/live-mk1-updates.md`.

Automatic fallback makes one checked, synced restore from the previous image and reboots only after restoration succeeds; a failure halts for owner USB recovery. Removing the stick uses stock handover. Full uninstallation requires the owner’s verified stock-rootfs restoration in the accompanying **RECOVERY.md** (source: `docs/recover-live-mk1.md`), not an improvised bootloader/partition command.
