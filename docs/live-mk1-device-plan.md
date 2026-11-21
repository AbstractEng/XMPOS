# Live Mk1 integration profile

This is technical integration guidance, not an individual device diary or an
authorization to operate an instrument. Follow the [compatibility profile](compatibility.md),
[installation](install-live-mk1.md), [recovery](recover-live-mk1.md) and
[distribution boundary](live-mk1-distribution.md).

## Qualified family and boundaries

The initial profile is MPC Live Mk1 / inMusic ACV8, plain RK3288, exactly
MPC OS 3.10.1. A fresh stock verifier measures each unit's identity/rootfs
metadata; the later fastboot identity must match. Unknown boards, firmware,
bootloader, rootfs geometry or conflicting facts stop installation. No fixed
partition size may stand in for that measurement.

Only the documented rootfs-only tool may perform an owner-confirmed flash.
Never touch the bootloader, environment, partition table or other partitions.
Prepare recovery from the owner's signed/pinned updater first. Do not share
updater, stock rootfs, generated loader or owner-assembled runtime images.

## Boot and session architecture

The owner-local loader preserves Akai's kernel/device tree and changes the
reviewed boot script only. It loads an XMP system image read-only from removable
USB; runtime changes and persistence remain on that key. No-stick handover
mounts the command-line root read-only with no journal replay solely to start
stock init. It is a handover, not removal of the loader.

XMP sessions retain exact board/controller/audio identities, bounded controller
message allowlists, the -12 dBFS output ceiling and USB-only storage boundaries.
The fixed-command bridge requires the exact profile and a per-stick token.
No arbitrary shell, firmware update API or inbound LAN service is supplied.

## Development and qualification

Use host tests, the emulator and native/browser parity fixtures before any
owner-authorized hardware session. Retain exact source/binary/image hashes
and redacted results privately. Qualification does not transfer automatically
to a new candidate. One/One+ are separate ports; Force is excluded.

See [release status](../RELEASE.md) for which source and downloads are staged.
