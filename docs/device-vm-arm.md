# Device view in Linux and ARM development builds

The Device interface now runs in Chromium **inside** the offline x86 Linux VM.
A small loopback viewer on the Mac displays hash-checked screenshots from that
guest and sends bounded pointer/key events over the existing virtual serial
channel. The viewer does not run the workstation or its audio engine on the Mac.
This is a headless guest renderer with an interactive screen viewer, not a GPU,
touch-driver or physical-display qualification.

## Try the guest interface

Use Node 24 and Python 3.11 or later. From the repository:

```sh
npm ci
npm run os:emulator       # only if QEMU >= 8.2 is unavailable
npm run os:device:build
npm run os:device
```

Open the `http://127.0.0.1:…` URL printed by the final command. Click the pads,
front-panel buttons and screen controls. For select menus, click the menu and
use arrows/Enter; Tab advances focus. Refresh retrieves another guest frame.
Updates are deliberately on demand, not a video stream. Audio is muted and no
Mac speaker, microphone or hardware API is opened. Ctrl-C in the terminal closes
Chromium and shuts down the VM cleanly.

The same browser Device workflow applies: MENU → Project → New empty song;
MAIN → focus a clip → press the data dial; select a sound and enable steps;
SHIFT + MAIN selects a track and its machine; MENU → Song chain builds the song.
Pad 1 is at bottom left. The logical instrument screen remains 1280×800; the
1600×1000 viewer also includes the virtual controls.

IndexedDB autosave and portable downloads live on an owned file-backed guest
disk under ignored `reports/device-viewer/<image-build-id>/`. Restarting the same
image reuses that disk. A new image gets a separate disk; export project copies
before replacing an image. The viewer's **Open song** and **Save song** buttons
transfer `.xmpsong` files between the Mac and guest. Keep **Package samples**
checked for self-contained copies; **Locate WAV samples** resolves missing audio
for referenced songs. The guest also retains downloads in `/data/downloads`
with unique IDs. Full folder-library synchronization remains future work.
See the [song format and transfer workflow](song-files.md).

## ARM pipeline

```sh
npm run os:arm:build
npm run bdd:device-vm
```

The pinned Zig 0.13 toolchain cross-compiles static **ARMv7 Linux EABI hard-float**
artifacts for Cortex-A17: the sampler test, engine test with Linux callback
interposition, and declarative DSP runner. The build also includes the production
Device assets and their hashes. `artifacts/arm/latest.json` points to the owned
build directory and its manifest. ARM execution uses pinned Alpine `qemu-arm`
inside the isolated Linux VM, using QEMU’s Cortex-A15 ARMv7 model as an instruction-set proxy (not an RK3288 device model). The suite runs sampler, sample-clock tempo,
queue/exhaustion, safe-state, command-validation and callback-audit cases, plus
five DSP fixtures against the TypeScript reference and a malformed-plan check.
The bounded ARM graph renders 48,000 frames with eight tracks and 32 voices;
the full simulated-minute fixture remains in the Mac/Linux native regression.
Each ARM case has its own request and process deadline; emulated callback times
are diagnostic values, not real-time qualification.

This is a userspace development payload. It contains **no MPC kernel, bootloader,
installer, firmware, proprietary plugins or hardware adapter**. The whole Studio
engine has not been ported to native ARM; the guest UI uses the existing browser
prototype backend. Running ARM binaries under QEMU is not a Live Mk1 boot test,
native workstation parity or a physical latency measurement. Boot/recovery,
internal audio, pads, touch, LEDs, storage and battery qualification remain pending.
Nothing in this workflow accesses the Force or deploys to an instrument.

## Regression and evidence

`features/23-device-vm-arm.feature` defines D01–D04: actual guest rendering and
screen transfer, two-track song creation and cold-boot persistence, rejected
invalid/hardware commands, and executable ARM tests/parity. It is part of
`npm run regression` and the `device-arm-regression` GitHub CI job. For faster
Mac/browser-only work, `npm run regression:desktop` retains that subset.

Reports include Cucumber JSON/HTML/JUnit, image/source hashes, screenshots,
guest execution results and shutdown logs under ignored
`reports/acceptance/device-vm/`. Failed guest/browser operations fail the suite;
hardware qualification is always false. The separate graphical profile has 3 GiB
RAM and a 180-second cold-readiness budget; the original P10 1 GiB/60-second
profile is unchanged. Network adapters, host shares and USB passthrough remain off.

New dependencies are frozen in `os/device-inputs.lock.json` with official Alpine
URLs, versions, lengths, hashes and license metadata. Builds use that lock without
resolving rolling indexes or executing APK installation scripts. The explicit
`tools/os/pin-device-inputs.py` maintainer utility refreshes it only from previously
downloaded main/community APK indexes. Initial signatures and public source/notice
redistribution review remain pending; images are local-development-only. Chromium
runs without its process sandbox in this disposable VM; guest network isolation,
read-only bundled assets and bounded controls provide the current lab boundary.

References: [Chrome headless runtime](https://developer.chrome.com/docs/chromium/headless),
[Alpine release branches](https://www.alpinelinux.org/releases/),
[Zig 0.13 toolchain](https://ziglang.org/documentation/0.13.0/).
