# MPC Live Mk1 boot screen

The owner approved **Emerald Current** on 18 November 2026. XMP session init
displays it after the existing stick loader hands over to the XMP system image,
before launching the bridge and session. It remains until the native interface
draws. There is no artificial delay or invented progress percentage. Error
screens and previous-image recovery retain their existing behavior.

This is the XMP userspace boot screen. The preceding kernel/loader display is
unchanged, so it does not require a loader flash. It also does not change Akai's
stock boot screen when the stick loader hands over to stock MPC OS.

## Artwork and packaging

The approved composition is
`brand/xmp/boot/emerald-current-2026-11-18/mpc-live-mk1-emerald-current.png`.
The self-contained runtime master is `os/live-mk1/assets/boot-screen.rgb`:
8-byte `XMPBOOT1` magic, little-endian uint32 width and height, then packed
RGB888 pixels (1280 × 800, 3,072,016 bytes total). Metadata pins both hashes.
To regenerate this encoding, use Pillow to convert the approved PNG to RGB,
prepend `b'XMPBOOT1' + struct.pack('<II', 1280, 800)`, and append `image.tobytes()`.
No resizing or color transformation is applied.

`live:dynamic-image` and the legacy `live:session-image` validate and include
the asset at `/usr/share/xmp/boot-screen.rgb` in the read-only system image.
Owner assembly preserves it and audits its hash. Browser Device and Studio,
including the Chromium Device in development images, show the approved PNG
while the interface loads. Fast starts give the artwork half a second on
screen after decoding, with a 1.2-second cap for loading the artwork itself.
The browser copy at `apps/studio/src/assets/emerald-current.png` uses the same
PNG bytes. Browser acceptance tests check them against the approved hash.

## Runtime boundaries

The renderer checks the board before opening the framebuffer, refusing Force
and ada2 identities. Dummy-virt is accepted only in an emulator build. It
validates the exact file length/header, framebuffer layout, channel fields,
stride, offsets and mapped bounds. The Live's physical 800 × 1280 panel uses
rotation 270: canvas `(x,y)` maps to `(y,1279-x)`. Landscape 1280 × 800 and
RGB565 are also supported for emulation. Unknown layouts fail closed. Missing
artwork uses a solid XMP emerald background; startup still continues.

Only the framebuffer is written. The artwork is opened read-only from the
session image. No device control, audio, firmware, bootloader or internal-storage
operation is added. Rendering runs before the audio engine starts.

## Verification and rollout

`npm run native:test` includes a full-pixel rotation/format round trip, padding
and offset preservation, malformed input rejection and protected-board checks.
`npm run inventory:test` covers image assembly and rejects modified artwork.
The build manifests record the selected artwork and its SHA-256.

On 18 November the native and sanitizer checks passed; rendered pixels matched
the approved PNG exactly. Both session-init variants compiled for ARM with
warnings treated as errors, linked to the verified owner-local runtime and
passed the ELF dependency audit. The main check passed 505 tests; the Python
inventory/image suite passed 38 tests, all 34 native tests passed, and all
16 parity tests passed. Local evidence is under
`artifacts/live-mk1/boot-screen-verification/` (not committed).

A complete new ARM system-image build and boot remain unverified: Docker was
unresponsive and no local ARM emulator was available. No hardware installation
was performed during this integration.

Install through the existing verified system-image workflow on the owner's
USB stick or the authorized control bridge. Physical flashing remains owner-only;
this integration does not flash or install itself on any instrument.
