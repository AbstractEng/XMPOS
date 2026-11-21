# P10 standalone OS development profile

P10 now boots a self-contained Linux music console on a generic x86_64 QEMU board. The guest creates a beat, adds the original subtractive synth, arranges two scenes, saves to its ext4 disk, shuts down, cold-boots and exports the same stereo WAV. The engine and original sounds run inside the image. There is no Vite server, host application runtime, network interface, host share or USB passthrough in the guest.

This increment implements a serial music console and service lifecycle prototype. The UI child currently exercises readiness and restart isolation; it is not the graphical Studio or a touch interface. Offline core rendering and short ALSA pad/metronome playback are available. A continuous native real-time sequencer, native DSP parity, graphical UI, deployed SDK sandbox, MPC drivers and formal physical loopback remain pending. Passing this profile cannot qualify a hardware OS release.

## Build and use on the Mac

Use Node 24, Python 3.11 and the normal repository toolchain (`npm ci`, `npm run bootstrap`). The old Intel Mac in development uses a locally compiled QEMU 8.2.10 because its Homebrew platform has no supported current QEMU bottle. Install Xcode command line tools and Homebrew `glib`, `pixman`, `pkg-config` first. `npm run os:emulator` builds the pinned QEMU source in an owned temporary directory without spaces, using pinned Meson 1.2.3 and the existing CMake/Ninja environment. It disables physical audio, USB, networking acceleration and graphical backends. A newer supported Linux host may install QEMU >= 8.2 through its package manager; the actual version is recorded in every boot report.

```sh
npm run os:emulator  # Mac source-build fallback; can take several minutes
npm run os:fetch     # Download and verify the exact locked Alpine inputs
npm run os:build     # Bundle the guest core and assemble kernel + initramfs
npm run os:console   # Boot the independent virtual music console
```

Console commands are `pad 0`, `record`, `beat`, `synth`, `arrange`, `save`, `export`, `status`, `diagnostics`, and `shutdown`. Pad and metronome output goes to an owned virtual WAV capture, so this profile is silent on the Mac speakers. The console retains a separate file-backed disk for each image build under `reports/os-console/<build-id>`. A new build receives a new disk and preserves older sessions. No migration or device deployment is performed. Ctrl-C requests a clean guest shutdown.

The kernel/initramfs and build manifest are under `artifacts/os/p10`. The image builder assembles archives in memory; it never mounts a host volume, creates host device nodes or runs upstream package installation scripts. The launcher only opens validated regular files in owned workspace report/artifact directories. There are no arbitrary QEMU flags or physical target options.

## P10.1: fixed inputs and reproducibility

`os/inputs.lock.json` freezes the Alpine 3.23.8 x86_64 base and 38 package archives, including Linux, BusyBox, musl, Node, ALSA and ext4 tools. Each download has an HTTPS origin, exact version, byte length and SHA-256. Upstream package signatures were not independently verified during the initial freeze; this is explicitly recorded. The normal build never consults a rolling package index. `tools/os/pin-inputs.py` is an explicit maintainer tool using a separately downloaded APKINDEX to propose a new reviewed lock, not part of normal builds.

The reproducibility contract is **two fresh bundler/assembly processes on the same declared builder profile using the locked upstream binaries**. It compares bundled application, kernel, compressed and uncompressed initramfs hashes. Archive order, ownership, inode numbering, gzip time and source epoch are fixed. This is not a claim that independently compiling Alpine, QEMU or every compiler on different machines produces identical binaries. Python/zlib and Node/Vite versions remain part of the recorded builder environment. Each image embeds its repository source hash and build ID; stale images are refused by acceptance.

A separate public-distribution/source-build Gherkin contract remains planned. The image includes a package inventory from both the base APK database and overlays, XMP/Zod entries, source/provenance manifest and development notice ledger. **Public binary redistribution is blocked** pending complete corresponding-source and license/notice review. The ledger is useful development metadata, not a completed redistribution audit. Unknown/proprietary vendor dependencies fail the release gate; no Akai application, firmware or factory sounds are included. CI uploads test evidence, not a distributable OS image.

## P10.2: services, storage and first beat

PID 1 mounts guest proc/sys/devtmpfs, loads virtio/ext4/HDA drivers and mounts the owned virtual data disk. Formatting is allowed exactly once for a newly created disk via a consumed initialization token. A later unrecognized filesystem enters recovery instead of being reformatted.

The supervisor waits for persistent storage, then starts the engine and UI lifecycle child. Project saves write a temporary portable bundle, fsync it, rename it and fsync the directory. Clean shutdown saves and flushes before unmounting ext4. The startup-fault scenario exhausts three restart attempts, exposes recovery after the fourth failure and then verifies the existing project after a normal boot.

The guest initializes the emulated HDA Master control, which otherwise starts muted, with a bounded wait for asynchronous HDA probing. This never changes a Mac or Akai mixer. The original kit needs no assignment: one pad command plays a short sample and `record` plays a metronome into virtual Intel HDA. Captures verify nonzero stereo PCM at 48 kHz. This checks guest driver/output plumbing, not a physical speaker, sensor or analog latency. The frozen two-vCPU/1024-MiB TCG profile has a 60-second readiness limit, including recovery; it must not be relaxed after a failed run.

## P10.3: guest tests and qualification boundaries

```sh
npm run bdd:step -- P10_1  # Rebuild and redistribution policy
npm run bdd:step -- P10_2  # Services, startup fault, first beat
npm run bdd:step -- P10_3  # Guest shared impulse/render and qualification boundary
npm run bdd:step -- P10_4  # Offline use and diagnostic privacy
npm run bdd:p10           # All ten scenarios, including cold-reboot song journey
npm run bdd:qualify:p10   # Recheck current-source evidence and capture hashes
```

Run `os:build` after any source change. The canonical `features/10-standalone-os.feature` has executable bindings in `acceptance/os/vm.steps.mjs`. Its shared impulse project imports the same core model/render modules used on the Mac; the numerical assertions actually execute inside the booted Linux guest. The independent oracle requires a half-scale impulse at frame 24000 in a 96000-frame stereo render. Host checks also inspect the returned PCM/header and record the kernel, board, runtime, emulator and candidate hashes.

Host image-policy cases are labelled separately from actual `os-vm` journeys. Each VM scenario gets an owned disposable disk and boot logs/WAV captures. The suite reuses a scenario's disk only for its own cold reboot. Reports are in `reports/acceptance/P10/run-*`; substeps have separate report namespaces. No full disk images enter CI artifacts. A dedicated Ubuntu CI job builds and boots the guest; the existing Mac/Linux jobs continue all host/native checks. `bdd:implemented` stays a Mac contract lane and does not silently count host tests as guest execution.

The dedicated P10 qualifier checks actual guest evidence and leaves `phaseQualified`, physical audio and MPC driver qualification false. The older pure fixture adapter/evidence gate still refuses OS/USB attestation; only this dedicated booting adapter supplies generic VM evidence. Live Mk1 pads, codec, battery, USB modes and boot recovery require separate device-specific authorization and physical evidence. The Force remains passive host inventory only and is never opened by these tools.

## P10.4: offline behavior and diagnostics

QEMU uses `-nodefaults`, no NIC, no host shares and file-backed virtual audio. The guest checks `/sys/class/net`, mounted filesystem types and TCP listeners before reporting readiness. Only loopback is present, the optional lab agent is disabled and no control socket listens. Local serial controls work without login, package installation or external sounds. The virtual serial port disables canonical line buffering so bounded project requests larger than 4 KiB arrive intact; Node validates complete packets with explicit size limits.

Diagnostics use an allowlist of build identity, bounded service events and bounded generic error codes. They omit project data, audio, credentials, raw device identifiers and arbitrary exception text. The Gherkin privacy test loads an original sampled fixture carrying distinctive project/audio canaries, rejects credential/device canaries in an invalid request, crashes the UI child, then verifies the exported diagnostic bundle contains none of them. These synthetic privacy fixtures do not use personal recordings.

## ADR-P10-001

The P09 Mac software gate permits this generic console image increment against the shared core. P04 formal loopback, native real-time parity, graphical/deployed SDK behavior and hardware requirements remain open dependencies for a full phase/release. The independent boot, ext4 durability and guest musical contracts provide useful implementation evidence without claiming those outstanding gates passed. P11 research may proceed, but no Akai deployment action is supplied or authorized by P10.

Primary build references: [Alpine release artifacts](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/), [Alpine package artifacts](https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/), [QEMU source releases](https://download.qemu.org/), [QEMU direct Linux boot](https://www.qemu.org/docs/master/system/linuxboot.html), and [QEMU invocation and virtual-device options](https://qemu-project.gitlab.io/qemu/system/invocation.html).
