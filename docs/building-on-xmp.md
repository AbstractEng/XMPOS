# Building a downstream C++ application

Add `xmp-os/native` with CMake and link the documented `xmp::` targets. C++17 is
the minimum. `XMP_BUILD_TESTS` defaults on only for a standalone upstream build;
downstream applications get libraries without upstream executables/tests.

- `xmp::headers`: project, sequencing, transport, files and other portable core APIs.
- `xmp::dsp`, `xmp::engine_rt`, `xmp::host_audio`: native DSP/engine and host backend.
- `xmp::rt_audit`: callback audit support.
- `xmp::live_platform`: `xmp/live_platform.hpp` supplies a local framebuffer/input
  emulator using the same parser, layout and Canvas as the device session, with
  PPM capture. The library compiles on the Mac and ARM Linux.
- `xmp::live_contracts`: portable controller/card policy headers.

`xmp/live_platform_linux.hpp` owns Screen, Controller, Touch and verified PCM
open/close operations. The original Live session consumes these same resources.
Linux consumers also need ALSA headers/linkage. Entry points retain the Live
board/card checks; controller output is restricted to the recorded identity and
startup bytes. No resources open merely by linking the target. Musical processing,
thread policy and application-level storage paths remain the application's job.

## Build and package a downstream session

Reuse `tools/live-mk1/downstream-build.mjs`'s `buildDownstreamSession({directory,
target})`. It snapshots reviewed source, cross-builds the requested CMake target
with the supplied ARM toolchain in a network/device-isolated container and
returns a manifest containing the ELF path/hash, ABI and builder identity.
The downstream project supplies `cmake/toolchains/live-mk1.cmake`.

Pass that manifest as `buildSessionImage({program})`. The existing image builder
validates the program name, SHA-256 and static ARM hard-float ELF before packaging,
then verifies that the installed binary still matches. It preserves the existing
init, stick layout, verified libraries, bridge, rollback and image manifests.
The no-argument API continues to build the original XMP session.

`testDownstreamSessionInVm` boots such an image through the existing loader,
Live-like QEMU machine and USB twin. The downstream probe accepts the same
`--log`, `--conf`, `--pattern` launch arguments. When ready in the emulator it
creates `/tmp/xmp-downstream-ready`; the twin waits before injecting pads. For
framebuffer evidence it saves a landscape PPM at the supplied log path plus
`.ppm`. This uses the guest's actual mapped framebuffer; QMP's display may remain
inactive with this kernel and is not accepted as sole UI evidence.

The report checks selected-pad logs, guest framebuffer capture, bounded PCM
capture, controller-output policy and the unchanged stand-in internal disk.
The default QEMU recording backend is stereo even though the emulated audio card
advertises six outputs; it does not qualify routing on outputs 3–6.

These are existing XMP build/VM tools and require Node 24 and Docker plus the
pinned upstream compiler/kernel/loader/ALSA/font inputs. Downstream application,
module and acceptance-binding logic remains C++; its native CMake build needs
no Node or TypeScript. No new deployment tool is introduced. Images remain on
the development machine; actual device use still follows AGENTS.md.
