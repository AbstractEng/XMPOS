# MPC Live Mk1: return to stock

**Owner-operated, candidate-specific rehearsal.** Agents may verify images, test fake transports and run emulation. `AGENTS.md` says the owner runs every flash. A VM test or historical successful restoration cannot prove a fresh physical candidate.

## Stock handover versus stock restoration

- A normal shutdown and boot without the XMP stick should hand over to Akai's own init and MPC app. The modified loader rootfs remains installed. This is not a full return to stock.
- Full restoration replaces that rootfs with the **unchanged original** from the same reviewed, code-signed official Gen 1 updater. The bootloader, its environment, partition table and other internal partitions remain outside XMP's allowed writes.

The launch rehearsal starts and returns to **MPC OS 3.10.1** on Live Mk1 / ACV8. The general authenticated stock recovery tool retains its existing recovery capabilities; this launch policy does not remove historical recovery routes.

## Recovery preparation, before installing XMP

Keep the owner-obtained official updater and a verified stock rootfs on the Mac, available without internet. In the matching source checkout:

```sh
npm run live:prepare-stock -- "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app"
```

This performs no device discovery, mount, flash or execution of firmware. It validates the signed app's inMusic team, checks the embedded container/partition hash and Live target, and extracts original bytes with a fixed size bound. It re-extracts and compares every existing cached rootfs before using it. A corrupt cache is refused and preserved for investigation. Do not edit a hash/manifest to bypass a mismatch.

Retain its local receipt with `updaterImageSha256`, `compressedPartitionSha1`, original rootfs SHA-256 and size. Match the updater hash to the candidate's public manifest. These are integrity/provenance checks, not proof that the device will boot.

## Owner-only restoration

1. Save work if the unit is responsive. Shut down normally; keep the XMP stick out for the restored-stock boot.
2. Enter the documented fastboot update mode using the reviewed button combination/menu. The owner may instead use Akai's own official updater on the matching supported version; follow Akai's instructions for that route.
3. With the XMP tool, the owner first previews:

   ```sh
   npm run live:flash -- restore-stock "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app"
   ```

   This queries identity/rootfs geometry but sends no write. It authenticates the updater again and verifies a fresh extraction against the cached recovery file. Confirm the displayed rootfs SHA-256 equals the preparation receipt. A device/identity/capacity/hash refusal is a stop, not a request for raw fastboot commands.
4. **Owner only**, after reviewing that concrete preview:

   ```sh
   npm run live:flash -- restore-stock "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app" --write
   ```

   The typed confirmations remain mandatory. The tool sends only the authorized unlock, `flash rootfs <verified original>` and reboot. Never use erase, format, resetenv, update-bootloader, flash-bootloader or another partition. Agents do not run this command.
5. Observe a cold boot without the stick, the official MPC interface and the expected restored MPC OS version. Check the owner's ordinary project/storage availability. A successful transport result alone is insufficient. Stop promotion if this fails; do not change the bootloader/environment or improvise a recovery command.
6. Record the result against the exact source/system image, locally generated loader, updater and original stock-rootfs hashes. Keep device identity and raw logs local. The owner installation evidence must contain all five ordered observations, including XMP boot, no-stick handover and restored-stock boot.

The launch gate remains open until the owner has completed this rehearsal on the exact candidate/unit. Existing historical recovery records and a software-only test run remain separately labelled.
