# Rebuild inputs and status

This is a source review kit for the native Live Mk1 session. It is not a completed corresponding-source offer for an approved binary. `review.json` identifies the archived Git commit and content hash. `sources/xmp.tar.gz` contains that committed repository tree; the font release ZIPs, stb header and patched ALSA archive are hash-verified build inputs. Font release ZIPs are the actual TTF inputs, not a claim to include font designers' preferred editable sources. OFL does not require providing those design sources.

The old `session-image-WMG1w2` identifies source hash `d3cb323cfd537d54533737c10905ec2c00ef741da6abf4533fe058ff88bf509f`. This kit does not establish a matching tree/toolchain for that image. Do not use it to approve that binary.

## Existing static development build

On a supported Mac, extract `sources/xmp.tar.gz` into an empty directory. Use Node 24, Python 3.11+ and a responsive Linux Docker daemon. Run `npm ci`, `npm run bootstrap`, `npm run live:setup:build`, then restore the verified font ZIPs/header into `references/archives/fonts/` and the ALSA archive into `references/archives/akai-mpc-g1-3.10/`. `npm run refs:sources` fetches the additional pinned G1 sources currently required by the builder. `npm run live:session-image` runs the legacy static development recipe; it is intentionally ineligible for public packaging.

The exact configure/compiler/link flags are in `tools/live-mk1/session-image.mjs`; builder layers and Debian snapshot/digest are under `os/live-mk1/`. Fonts regenerate through `tools/fonts.mjs` and `native/tools/font_atlas.cpp`. `npm run check`, `npm run parity`, `npm run inventory:test` and `npm run native:test` are the host checks. `npm run live:emulator` and `npm run bdd:live-mk1:emulated` exercise the ARM image. No hardware is accessed by these build/test commands.

A fresh build is still necessary: the existing image does not record the exact cross-toolchain source packages or unstripped object/link map inputs. The container recipe is useful for rebuilding new code, but does not prove bit-for-bit equivalence to an older image. Docker is currently unresponsive on the review host and was left running at the owner's request.

## Selected public design: owner-local 3.10.1 runtime

The supported machine is the MPC Live Mk1 / `inmusic,acv8`, already running exactly MPC OS **3.10.1**. The Mac installer accepts only an inMusic-signed updater whose embedded `Update.img` matches `os/live-mk1/mpc-runtime.lock.json`. The filename is not a version check. Firmware updates remain owner-operated using Akai's official updater.

Available now:

```sh
npm run live:prepare-runtime -- "/path/to/MPC (Gen 1) 3.10.1 Updater.app" artifacts/owner-runtime-3.10.1
```

This extracts a fresh, hash-checked local runtime tree without mounting the image, executing updater contents or contacting a device. Each output file is checked against the lock. The receipt records dependency/version-table checks and explicitly leaves execution validation false. The output is private and must not be published. The original updater/stock cache remains local for recovery.

The dynamic build and local assembler are now implemented: see [the current build/assembly commands](../live-mk1-owner-runtime.md). The earlier review archive is historical; generating a new source kit still does not constitute release clearance. Remaining candidate requirements:

1. Build the XMP init, session and bridge as ARM hard-float dynamic ELF files using the extracted runtime. Ensure interpreter `/lib/ld-linux-armhf.so.3`, select the intended libraries explicitly and inspect each `DT_NEEDED`, required symbol/version and linker map. Debian build headers/startup objects still need their own provenance review; newer runtime versions alone do not prove ABI compatibility.
2. Keep **all** owner libraries and ALSA configuration out of the public template. The template's manifest must identify `runtimeMode: "owner-local-3.10.1"`, `runtimeLibrariesIncluded: false`, and `mpcOsVersion: "3.10.1"`. These fields require a reviewed build; manually editing a legacy manifest is not a conversion.
3. Add local assembly of those verified files into a new USB `system.img`, with a private manifest binding public-template hash, updater hash, runtime-lock hash and final image hash. Do not copy the owner's runtime into release/source archives. The assembler is implemented; qualification and corresponding-source completion remain required.
4. Run the dynamically linked candidate in ARM emulation, including controller/audio regressions, then obtain the owner-operated installation and return-to-stock evidence. A privately assembled image requires a different image hash from the public template; version-2 release evidence now records that explicit binding.

XMP's current authorization does not allow mounting the internal rootfs to read libraries during a session. Keep runtime files on USB. Newer/older MPC OS versions, Force and other MPC models are outside this launch baseline. Recovery tools may still restore other authenticated stock images; this policy must not remove a working recovery route.

## Current Mac route and candidate source kit

This route avoids Docker for the loader, dynamic session and local assembler. It does not declare any unexecuted Docker/other-host path qualified. From the exact clean committed source with Node 24, Python 3.11+, Xcode command-line tools/make and local mke2fs:

```sh
npm ci
python3 tools/live-mk1/licensing-inputs.py --fetch
npm run live:prepare-runtime -- "<official signed Gen 1 3.10.1 Updater.app>" artifacts/owner-runtime
npm run live:dynamic-image -- artifacts/owner-runtime --host
npm run live:loader-image -- "<official signed Gen 1 3.10.1 Updater.app>" --host
npm run live:assemble -- artifacts/live-mk1/<printed-template> artifacts/owner-runtime artifacts/owner-system
python3 tools/live-mk1/source-review.py artifacts/candidate-source --template artifacts/live-mk1/<printed-template>
```

Use the concrete printed paths. The output directories must be new. Existing tool helpers fetch hash-pinned Zig, font/stb and build-interface inputs; the owner independently supplies the updater. The host loader bootstraps pinned e2fsprogs under ignored build/, never installs tools globally and never contacts an instrument. It reads/edits regular artifact files only; ledger and filesystem checks refuse extra changes. Its image contains Akai firmware and remains private.

The candidate source kit adds exact glibc/GCC source archives, Debian patches and cross-build wrappers from host-source.lock.json. Actual used header sources are selected from compiler dependency records. relink-materials.tar.gz contains original objects, maps and normalized command arrays; no owner DSOs are included. Recover Debian startup/header packages with the recorded hashes or rebuild them with their supplied Debian source/wrapper recipes on Linux. Rebuilding those upstream packages is distinct from rebuilding XMP using the pinned package inputs.

Run check, parity, inventory:test and native:test, plus live:runtime-vm against the matching private owner image and verified kernel build. These host/VM commands do not prove first installation or stock restoration. Final publication still requires the owner receipts and actual clearance bindings. See STATIC-LINKING.md for object-level relinking and modification scope.
