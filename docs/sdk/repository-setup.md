# Full XMP source and Docker setup

The standalone SDK builds declarative instruments/effects and source-built tools using its public API. Developing XMP's full native app, UI or OS requires the matching source checkout. This package does not contain a full Linux distribution, Docker daemon, compiler installation or proprietary Akai updater.

Start with `docs/developer-guide.md` for test lanes and platform boundaries. The Live Mk1 touchscreen is implemented in `native/include/xmp/live_ui.hpp` and `live_workbench.hpp`. The browser compiles it to WebAssembly and provides a virtual panel, audio and storage adapter. Run `npm run engine:wasm` after editing the C++ touchscreen, then `npm run native:test`, `npm run build` and `npm run test:device` to replay the same Project workflow against the two builds.

The web build and dynamic Live image include the same seven kits and 32 synth presets from the checkout. The kit builder verifies the checked-in samples and keeps the CC0 notices with them. In **Sound → Load kit**, turn the data dial to see the next list page. On a synth track, **Sound → Next presets** switches between two 4×4 banks of 16 presets.

Hold **Menu**, then press pad **5** or tap **Project**. Pads **13–16** select **New**, **Open**, **Save**, and **Save As** in that order. In the New confirmation, pad **13** cancels and pad **14** confirms. In the Save As dialog, type the name on screen, then press pad **14** to save. **Save** writes the active project. **Save As** keeps a separate, named copy in **Browse → Projects**. The Live stores these copies in `xmp/Projects` on the USB stick. The web client stores them in this browser's library.

## Host prerequisites

Use Node 24, npm, Python 3 and a C/C++17 compiler. On the supported Mac build host, QEMU's build also needs `pkg-config`, GLib and pixman development libraries. SDK work and the tested Mac userspace build do not need Docker. The separate container lane requires an independently installed/running Docker daemon. The full updater-processing path uses macOS `.app` signature verification; it is not a Linux host-support claim.

```sh
npm run bootstrap
npm run doctor
```

`bootstrap` uses `npm ci`, installs the pinned CMake/Ninja tools in `.venv` and checks the host compiler.

### Optional Docker environment

Skip this subsection for SDK-only or Mac userspace work. For the separate kernel/full-session container lane:

```sh
npm run live:setup -- doctor
npm run live:setup -- build
```

`live:setup doctor` checks Docker with a bounded timeout and reports the fixed image dependency chain. `live:setup build` builds the base, userspace and image-tooling layers in order. Add `--no-cache` after `build` for a clean Docker-layer build. It opens no device and changes no system settings.

Dockerfiles are under `os/live-mk1/`. The artifact build containers have no network, physical devices, host directory mounts, Linux capabilities or privilege escalation. Initial image construction/downloads need network access. The base image and Debian archive snapshot are pinned; record the resulting image IDs and package versions with candidate evidence. Kernel work uses an XMP-owned Docker volume.

## Community hardware launch route: Mac host

The initial model is Live Mk1 / ACV8 already on exactly MPC OS 3.10.1. One models are planned ports and Force is excluded. Public installation is not cleared by these instructions. The owner obtains the signed 3.10.1 updater independently; updater contents, derived loader and runtime-bearing images stay private.

The tested Mac userspace route builds dynamically against owner-local runtime files and does not need Docker:

```sh
npm run live:prepare-runtime -- "/absolute/path/MPC (Gen 1) 3.10.1 Updater.app" artifacts/owner-runtime
npm run live:dynamic-image -- artifacts/owner-runtime --host
npm run live:assemble -- artifacts/live-mk1/dynamic-template-EXAMPLE artifacts/owner-runtime artifacts/owner-system
```

Use the printed template path and new output directories. Assembly uses local `mke2fs`; the image/runtime are audited without mounting firmware or contacting hardware. Run `live:runtime-vm` with the template, owner-image directory and an existing verified kernel directory after preparing the pinned ARM QEMU. The repository's `docs/live-mk1-owner-runtime.md` and `docs/install-live-mk1.md` give exact prerequisites, qualification and owner-only installation/recovery. A build or runtime probe is not a physical session/driver test. Native saves require Stop and **Saved on stick** before restart; physical input sampling remains unverified.

The Docker-dependent full-session VM and kernel lane below are separate development paths. They are not qualified by the tested Mac userspace route. Do not use a legacy static image as a public hardware release.

## Legacy container and full-emulator development lane

From a checkout with no inherited build/artifact directories:

```sh
npm run refs:sources
npm run live:kernel -- verify-source
npm run live:kernel -- build
npm run live:emulator
npm run live:g1-userspace
npm run live:alsa-engine
npm run os:arm:build
npm run live:kernel -- boot
npm run live:session-image
```

`refs:sources` fetches only the reviewed source commit and verified open-source archives, without a prior `refs:pull`. The ARM emulator bootstrap prepares its own input directory, pinned Meson and QEMU source; it skips optional Docker probes. It builds the patched host QEMU, with physical audio/USB passthrough disabled. Docker cross-compiles the ARM payload; QEMU runs it on an emulated board. There is no hardware qualification implied.

For the complete loader/session acceptance lane, obtain the reviewed official updater independently, keep it local, and follow the repository's `live:loader-image` / `bdd:live-mk1` instructions. This is a separate explicitly labelled prerequisite. Never copy an Akai-derived rootfs into a distributed SDK or source archive.

## Automated verification

```sh
npm run check
npm run parity -- --maxWorkers=1
npm run inventory:test
npm run native:test
npm run bdd:sdk-supported
npm run bdd:p09
npm run bdd:live-mk1:host
```

Run browser and generic VM checks as documented in the source guide. `npm run bdd:live-mk1` uses assertions over the emulated Live behavior and writes Cucumber/evidence reports. A direct `live:session-vm` run supports the fixed `--only` sessions for diagnosis; required semantic failures must be checked before treating it as a pass. Do not count unexecuted sessions as successful.

Builds and tests record source identity; freeze the checkout while they run. Preserve manifests, report summaries and failed-step logs. The source guide describes SDK/API migration, callback constraints, test-report paths and setup troubleshooting. A full release needs the candidate-specific clean-checkout report in addition to these instructions.
