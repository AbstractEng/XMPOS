# Build and assemble the 3.10.1 owner-local image

This is the native **MPC Live Mk1 / ACV8** route for a machine already running **MPC OS 3.10.1**, with a loader built from that exact updater. Build/assembly commands run on the Mac and never contact an instrument, mount an image, select a USB volume or flash. Public release clearance and owner installation/recovery qualification remain separate gates.

## Prerequisites

Use the matching source checkout with Node 24 and Python 3.11+. Run `npm ci` and `npm run bootstrap`. Put `mke2fs` from e2fsprogs on `PATH` (on macOS, `brew install e2fsprogs`, then use that installation's `sbin`; an existing compatible Android platform-tools `mke2fs` also works). The tool records the image-tool version, creates regular files only and inspects their contents after creation.

For Docker builds, run `npm run live:setup:build`. Alternatively **`--host` builds directly on the Mac**, using the existing hash-pinned Zig 0.13.0 compiler and four pinned Debian ARM development packages from `os/live-mk1/host-toolchain.lock.json`. Those packages supply headers and startup objects only: the extractor does not install packages, run their scripts or copy their runtime libraries/static archives. Netfilter headers with case-colliding names are excluded from extraction on macOS; they are unrelated to XMP and remain in the pinned packages. Source/package notices, compiler receipt, actual commands, objects and link maps stay in the build directory for review.

Fetch reference sources with `npm run refs:sources`; font inputs are fetched/verified by the build. Obtain Akai's official Gen 1 3.10.1 updater independently. Signature, embedded payload hash, rootfs hash and individual runtime-file hashes must all match the checked-in pin. The updater filename is not a version check.

## Prepare, build, assemble

```sh
npm run live:prepare-runtime -- "/path/to/MPC (Gen 1) 3.10.1 Updater.app" artifacts/owner-runtime
npm run live:dynamic-image -- artifacts/owner-runtime --host
```

Omit `--host` to use the isolated, network-disabled Docker cross builder. The build prints a new `artifacts/live-mk1/dynamic-template-…` directory and writes `latest-dynamic-template.json`. It compiles init, session and bridge as ARM hard-float dynamic ELF executables and creates a **public template** `system.img` containing only XMP executables, generated font data/notices and release metadata. It is **not bootable until local assembly**. Runtime libraries/configuration are never copied into that template.

Using the printed template directory:

```sh
npm run live:assemble -- artifacts/live-mk1/dynamic-template-EXAMPLE artifacts/owner-runtime artifacts/owner-system --emulator
```

The output directory must be new and inside `artifacts/`. Nothing is overwritten or copied to USB. The assembler verifies the actual template filesystem and ELF dependencies, runtime receipt and every pinned runtime file before writing. It copies only the approved files into a temporary tree, creates `system.img`, reads it back and compares every file with its exact inputs. Use `--emulator` only with a local source-built template; a public eight-file download omits the developer helpers and is assembled without that option. Optional `--emulator` creates `system-emulator.img` with separately hash-bound XMP emulator helpers; the Live session binary is identical. Temporary trees are removed. A failure leaves diagnostics, removes incomplete images/manifests and preserves the previous pointer.

The output manifest is **private**: `xmp-live-mk1-owner-session-image`. It binds template image/manifest hashes, runtime lock, signed updater/rootfs, preparation receipt, source and final images. `latest-owner-session-image.json` is distinct from the public-template and legacy development pointers. **Never publish this output or its runtime directory.** Only its verified private `system.img` eventually goes onto the owner's stick as `xmp/system.img`, after candidate qualification. Device deployment remains through the authorized bridge or owner procedures in `AGENTS.md`.

## Automated validation

```sh
npm run check
npm run parity
npm run inventory:test
npm run native:test
npm run live:runtime-vm -- artifacts/live-mk1/dynamic-template-EXAMPLE artifacts/owner-system
npm run live:session-vm -- --image-dir artifacts/owner-system
```

The runtime test needs the pinned ARM QEMU (`npm run live:emulator`) and an existing verified kernel build (`npm run live:kernel:build`). An optional third directory argument selects a verified local kernel build. It boots the owner-local library set in a guest initramfs, with no network, USB passthrough or physical audio. Original XMP test code exercises the ELF loader/glibc, C++ allocation/exceptions/unwinding, threading/TLS, math and ALSA configuration. It does not test audio drivers or the complete session workflow.

The full session VM uses the owner-assembled emulator image and the existing stick-loader/controller/audio tests. That harness still needs Docker for FAT media construction/extraction. A runtime-test pass is distinct from that full regression and physical qualification. VM logs/results retain the exact template/private-image/probe/kernel hashes; building/assembly alone leaves `abiExecutionTested: false`.

The installation evidence schema is version 2. `publicTemplateSha256` identifies the distributed template; `sessionImageSha256` identifies the **private image actually booted**. `ownerAssemblyManifestSha256` binds the local `owner-assembly.json`; `runtimeLockSha256` must match the pin. The review gate validates those links, alongside loader/stock receipts and the owner's five physical observations. No simulator result can become owner installation evidence.

## Rebuild and replace libraries

Objects, startup objects, unstripped XMP binaries, commands and maps are retained. The public/USB session executable omits debug information; the local full binary remains available for relinking. Bridge status reports hashes of the mounted session executable, bridge and libc so tests can distinguish a successful candidate boot from fallback. The Docker link uses explicit shared SONAMEs with `-nodefaultlibs`; the host route invokes LLD with explicit objects/shared libraries and no automatic runtime selection. Both link to the owner's runtime and record an inherited ELF search path of `/lib`, so the stock loader resolves the USB image's flattened library directory without its original rootfs cache or `/lib` symlink. The auditor requires that exact search path. The C++ math compatibility header exposes standard classification overloads for the existing C-style calls; it introduces no runtime code or callback work.

The official installer remains pinned for reproducibility. Developers may rebuild the open source tools and locally assemble a modified ABI-compatible runtime; these checks do not revoke library modification rights. Final compiler/header/startup-code notices and corresponding-source review are still required before public release. See [component review](licensing/README.md) and [relink instructions](licensing/STATIC-LINKING.md).
