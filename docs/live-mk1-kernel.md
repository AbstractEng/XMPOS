# Official Akai kernel and MPC Live Mk1 support

XMP builds the **official inMusic az01 Linux kernel** for the MPC Live Mk1 from Akai's published G1 sources and boot-tests it on the Mac. The kernel build/boot tools operate on the Mac and emulation. Physical rootfs writes use the separate owner-operated flash tool under `AGENTS.md`; the Force is protected. See [distribution and local installation](live-mk1-distribution.md) before preparing any install image.

## What the official source says about the Live Mk1

The pinned archive is `linux-az01-6.18.44+git-r0-patched.tar.xz` from `inmusic-software/az0x-open-source` branch `mpc-g1/3.10`, SHA-256 `be712ecc…`. Its device trees identify the products by inMusic code:

| Code     | Product                         | Evidence in the official source                                                   |
| -------- | ------------------------------- | --------------------------------------------------------------------------------- |
| **ACV8** | **MPC Live (Mk1)** — XMP target | 7-inch panel at 270°, `ti,bq40z50` SBS battery, USB5537 hub config "MPC Live Hub" |
| ACV5     | MPC X                           | 10-inch panel at 90°, no battery, "MPC X Hub"                                     |
| ACVB     | MPC Live Mk 2                   | separate tree                                                                     |
| **ADA2** | **Force (protected)**           | "Force Hub"; XMP refuses it everywhere                                            |

Two Live trees exist: `rk3288-az01-mpc-acv8.dtb` (RK3288) and `rk3288-az01-mpc-acv8-c.dtb` (RK3288-C). Which one the owner's unit needs is unknown until it arrives (planned LK08).

Notable hardware facts from the tree and `az01_defconfig`:

- The kernel is **PREEMPT_RT** with a 1000 Hz tick: the official kernel is already real-time.
- The Live has **no on-board I2S codec**. Audio, pads and controls sit behind the internal USB5537 hub as USB devices, so audio uses the standard `snd-usb-audio` driver.
- Power: `inmusic,az01-power` (mains) plus an SBS battery on I²C3. inMusic drivers: `az01-power`, `az01-fan`, a UAC2 gadget (`f_uac2_az01`).
- Display: MIPI-DSI panel `urt,umo-p076md-t` with an Ilitek or Sitronix touch controller.

## Build and test on the Mac

Docker Desktop must be running. The builder image is Debian bookworm pinned by digest. Containers run with no network, no capabilities, no devices and no host directories. Files move in and out with `docker cp`, and the kernel tree lives in XMP's own `xmp-live-mk1-work` volume, which is case-sensitive as the kernel requires.

```sh
npm run live:kernel -- verify-source   # check the archive against its pin
npm run live:kernel -- build           # zImage + both ACV8 DTBs (~30 min first time)
npm run live:kernel -- boot            # boot that zImage on QEMU's ARM virt board
npm run live:emulator                  # qemu-system-arm 8.2.10 from the pinned source
npm run live:g1-userspace              # G1 ALSA, libgpiod and libusb tools from official sources
npm run live:alsa-engine               # XMP continuous engine linked against the G1 alsa-lib
npm run live:device:build              # ARMv7 Device image on the official kernel
npm run live:device                    # open it in the Device viewer
npm run live:probe-image -- "<Akai updater.app>"  # step 4 probe image (local; contains Akai firmware)
npm run live:probe-vm                  # probe and report mode on the ARM board: card, protected disk
npm run live:uboot-test                # probe boot script and stock fallback under a real U-Boot
npm run live:loader-image -- "<Akai updater.app>" # stick loader image (local; contains Akai firmware)
npm run live:loader-vm                 # loader on the ARM board: no stick, XMP stick, empty stick
npm run live:session-image             # XMP session system image for the stick (XMP code only)
npm run live:session-vm                # Live-like emulator: the exact Live session binary, the Live twin, bridge
npm run live:bridge -- status          # control bridge to the Live (XMP stick + USB-B cable); see the device plan
npm run live:emulator                  # rebuild qemu-system-arm (applies os/live-mk1/qemu-*.patch)
npm run clean:artifacts -- [--delete]  # prune old build and test outputs
npm run live:flash -- status           # read-only: the Live in update mode (owner-authorized tool)
npm run bdd:live-mk1:host              # Gherkin contracts that need no container
npm run bdd:live-mk1                   # all implemented Live Mk1 contracts
```

**Build** applies `az01_defconfig`, then the add-only [virt fragment](../os/live-mk1/xmp-virt.config). The tool audits the merged config and fails if any official option changed. It verifies both DTBs by content: ACV8, the MPC Live Hub, the SBS battery and 270° rotation. Outputs go to `artifacts/live-mk1/kernel-*/` with a manifest. They are never bootloaders, update images or flashable media.

**Boot** runs the same zImage on the Mac's own `qemu-system-arm` (QEMU 8.2.10, built from the pinned source by `npm run live:emulator`) on the generic `virt` board with `highmem=off`. That option is needed because the 32-bit az01 kernel has no LPAE and cannot reach QEMU's default PCIe window above 4 GiB. The RAM-only initramfs holds [a small probe init](../os/live-mk1/guest-init.c), XMP's static ARMv7 sampler and engine tests, and the G1 tools described below. The boot test records the kernel version and real-time status, runs every test, and plays an original 440 Hz tone through G1's `aplay` into an emulated USB Audio Class device. The host checks the captured WAV.

Measured on this Mac: the kernel boots in about 7 seconds and all seven engine tests pass natively. The tone arrives at RMS 0.333; a half-scale sine should give 0.354.

## G1 hardware userspace from Akai's sources

`npm run live:g1-userspace` cross-builds the hardware-facing userspace that the official G1 release ships. Every archive is verified against the official catalog hash before extraction:

| Archive                                 | Tools built (static ARMv7, hard-float)                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `alsa-lib-1.2.11` + `alsa-utils-1.2.11` | `aplay`/`arecord`, `amixer`, `alsactl` plus ALSA configuration                       |
| `libgpiod-2.1.3`                        | `gpiodetect`, `gpioinfo`                                                             |
| `libusb1-1.0.27`                        | `listdevs`                                                                           |
| `alsa-state-0.2.0`                      | G1's `asound.conf`: this is the stock Yocto file and contains **no MPC mixer state** |

They are linked statically against Debian's armhf glibc so they run in any XMP ARM root filesystem. G1 itself links glibc 2.39 dynamically and uses systemd 255. This tooling does not rebuild glibc or systemd, so the init system and C runtime differ from the Live's.

## Continuous XMP engine on the official audio stack

`npm run live:alsa-engine` cross-builds `xmp_alsa_engine`, a static ARMv7 program. It links XMP's native engine against the **official G1 `alsa-lib`**, hash-verified and built in the same locked-down container. It renders the prepared host graph in 256-frame blocks on a real-time thread and writes 48 kHz stereo to an explicitly numbered ALSA card (`plughw:N,0`).

It has no default device, no card discovery and no MIDI or USB path. Cards whose procfs identity names an Akai or inMusic product, or Akai's USB vendor ID, are refused by `native/include/xmp/card_policy.hpp`, which has a native test.

The boot test runs it twice through the kernel's `snd-usb-audio`:

| Run                                                              | What it shows                                      | Measured (QEMU ARM, Mac)                                                                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timing graph: one original 20 ms burst per quarter note for 20 s | Continuous delivery and musical timing, end to end | 960,000 frames in 20.02 s; 0 underruns; 0 late renders (worst 4.6 ms); `SCHED_FIFO` and locked memory; 0 audit faults. The host capture shows 40 beats at a mean spacing of 0.49968 s. |
| 32-voice development graph for 10 s                              | Behaviour when the CPU cannot keep up              | Completes and records its late renders and underruns (8 late, worst 20.8 ms in one run). Underrun recovery keeps it playing.                                                           |

The emulated Cortex-A15 is far slower than the Live's RK3288, and per-beat jitter in the capture (up to about 12 ms) includes QEMU's USB audio and WAV batching. These runs prove the engine, the G1 ALSA library and the kernel driver work together continuously. They do not qualify the Live's timing.

## Device interface on the official ARM kernel

`npm run live:device:build` assembles an ARMv7 Device image from:

- the official az01 kernel;
- pinned Alpine 3.23 armv7 packages (202 entries in [the lock](../os/live-mk1/arm-device-inputs.lock.json)) for Node 24 and Chromium;
- XMP's Device app and native ARM tests;
- the G1 tools under `/opt/g1`, which come first on `PATH`.

`npm run live:device` opens it in the existing serial Device viewer. The VM uses profile `device-qemu-armv7-az01-v1`: 2 vCPUs, 2 GiB RAM, a 512 MiB file-backed data disk, and USB audio on xHCI with output to an owned WAV file.

Measured: the guest is ready in about two minutes under ARM emulation. Chromium renders Device view with pad 1 at the bottom left, and XMP's ARM engine runs natively (`native-armv7-official-az01-kernel`). The read-only `hardware-probe` command reports the az01 real-time kernel and the USB audio card via the G1 tools, and classifies the VM as a development host.

The official configuration builds in IPv6 SIT, so the kernel always creates a `sit0` fallback tunnel. The guest's isolation check tolerates exactly that device, and only while it is a down SIT interface; any other non-loopback interface still stops the guest.

## Runtime hardware discovery

[`os/guest/hardware.ts`](../os/guest/hardware.ts) is XMP's read-only hardware probe. It can only read and list paths under `/proc` and `/sys`. It reports the battery, mains supply, USB audio card, DSI connector and touch input, and names whatever the Live Mk1 tree promises but the system lacks. On a Force identity it stops after reading the two identity files and refuses to run.

## What this does not prove

The QEMU `virt` board does not emulate the RK3288, the panel, pads, battery or hub. Its Cortex-A15 executes the same ARMv7 instruction set as the Live's Cortex-A17, but not with its timing. The USB audio device is QEMU's, not the Live's internal interface. A green run proves the following:

- the official kernel source builds reproducibly and boots on ARM with PREEMPT_RT;
- G1's own ALSA, libgpiod and libusb tools work against that kernel's drivers;
- XMP's engine and Device interface run on top of it. It does not prove anything about the owner's unit. Booting on the real Live Mk1 (planned LK09) needs exact-unit identity, a recovery route and a written, owner-approved plan naming the device.

Binary redistribution of the kernel requires the GPL corresponding-source offer and a release review; the artifacts stay local.
