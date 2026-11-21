# Live Mk1 image updates and recovery

The developer baseline supports the MPC Live Mk1 (`inmusic,acv8`) on exactly MPC OS **3.10.1**, with runtime files extracted locally from the owner's signed updater. The owner image and runtime are private. Public templates cannot boot without local assembly.

The production bridge starts automatically and uses the FTDI null-modem cable. The USB-B gadget is disabled. Its `1209:0001` ID is reserved for private tests, not a public product allocation; the emulator's `dummy_udc.2` remains a private test path.

## First upgrade from the earlier bridge

The earlier bridge's image replacement could report success after a storage failure. The corrected Mac tool refuses to push through that implementation. Bootstrap the corrected image using the stick on the Mac:

1. Stop playback and recording. Wait for **Saved on stick**, then power off the Live.
2. Move the test USB stick to the Mac. Preserve its `xmp/projects`, samples, configuration and `bridge.token`. Keep a separate backup of personal work.
3. Use the freshly assembled owner `system.img` and its adjacent `manifest.json`. Verify the image with the command below. Copy it to a temporary file on the stick, verify that copy against the manifest, preserve the existing active image as `system.img.previous`, then replace `xmp/system.img` with the verified copy. These are owner file-copy steps; no flash or internal-storage access is required.
4. Remove `xmp/.fallback-tried` if present, safely eject the stick, reconnect it to the Live and boot XMP. Keep the previous image available until the new session passes its checks.
5. Connect the FTDI cable. The bridge hello must advertise `imageUpdateProfile: "xmp-owner-image-v1"`; status must show stopped playback/recording and `saveState: "saved"` before another update.

From the repository, verify an assembled image without contacting any device:

```sh
node --input-type=module -e 'import {verifyOwnerImage} from "./tools/live-mk1/verify-owner-image.mjs"; const r = await verifyOwnerImage(process.argv[1]); console.log(r.sha256)' /absolute/owner/system.img
```

## Subsequent bridge updates

```sh
npm run live:bridge -- push /absolute/owner/system.img
```

Before opening a device, the CLI validates the owner manifest, exact target/OS/runtime profile, bounded regular files, size and SHA-256. The filesystem audit verifies the source marker, three dynamic ARM executables, session hash, complete pinned runtime and file allowlist. The exported push function repeats this preflight. A matching checksum alone is insufficient. The default image pointer is `latest-owner-session-image.json`.

Stop and save before updating, and leave the controls idle during transfer. The device checks session state before and after transfer, the profile, checksum and ext4 envelope. It writes and syncs the staged image, copies the active image to a temporary backup, syncs and atomically replaces the previous image, then atomically replaces the active image. It checks write, close, sync and rename results. FAT requires a full backup copy rather than a hard link, so leave room for the staged image and another 32 MiB backup in addition to the images already present. A failed completion sync attempts rollback and reports failure. Any failure requires inspection before rebooting; success is never inferred from a partial transfer.

After a successful push, use `reboot` to boot the new image. `restart` only restarts the session in the currently mounted image. If a new session fails, init creates and syncs a one-attempt marker, copies the previous image into a temporary file and checks the atomic replacement and directory sync before unmounting and rebooting. The previous image is retained. A failed restore halts with recovery instructions instead of rebooting. The marker is reset only by a new verified promotion, so elapsed time cannot cause an automatic fallback loop.

If automatic recovery fails, power off and inspect the stick on the Mac. Preserve the previous image, restore a verified known-good `system.img`, and clear the fallback marker only after that deliberate repair. Removing the stick uses the existing stock handover route; stock firmware restoration remains an owner step under Gate 1.

## Secrets and verification limits

`prepare-stick` creates a new random token on each new stick and reuses the selected stick's existing valid token when reconnecting. It updates the Mac copy only after the stick token is durable. Never publish a token or a runtime-bearing image.

Host regression tests execute the production C transaction and transfer code with local files and injected I/O faults, plus actual Mac handshake/token code. They prove checked control flow and refusal behavior. They do not simulate a physical FAT power cut or replace a Live boot/update/recovery rehearsal. Integrity hashes must be obtained through the maintainer's trusted release home; they do not authenticate a publisher by themselves.
