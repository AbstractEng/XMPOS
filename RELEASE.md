# XMP OS — community source baseline

**A playable instrument. A foundation for your own.**

Created by **[sandeshm](https://github.com/sandeshm)** at
**[Abstract Engineering](https://abstracteng.com/)**.
XMP OS is a clip-based music workstation and an open-source framework for custom
instruments, interfaces, apps and workflows on standalone music hardware.

[Try the web client](https://abstracteng.com/xmpos/) · [Read the manual](https://abstracteng.com/xmpos/manual/) · [Build with XMP](CONTRIBUTING.md)

## In this repository

- The shared C++ core and native touchscreen, used on the Live, emulator and browser.
- Project storage, sequencing, audio, hardware adapters and source-build tools.
- SDK manuals, original examples, offline tooling and the regression/workflow suites.
- Installation/recovery instructions and third-party notices/source requirements.
- A [2:07 hardware demonstration](https://github.com/AbstractEng/XMPOS/releases/download/showcase/XMP-OS-Beat-Final-Share.mp4), with the opening clip edits preserved.

The [developer guide](docs/developer-guide.md) describes the tested build route;
[SDK examples](docs/sdk/examples.md) show what to customize first. The recorded
source checks passed **615 application tests, 37 native tests and 20 parity tests**.
The shared Device workflow passed **86 actions**, matched **17 native/browser
screenshots**, loaded seven kits/32 synth presets and restored autosave after reload.
The current source includes the MENU navigation fix after slicing a sample.

The files were exported into a new repository without earlier Git history or
objects. [PUBLIC-SOURCE.json](PUBLIC-SOURCE.json) records the source identity.
The 234 runtime files match the tested source exactly; repository links and
release documentation were updated for this source home. Required upstream
licence attribution remains intact.

<a id="staged-hardware-downloads"></a>

## Hardware availability

Initial hardware is **MPC Live Mk1 / ACV8, already on exactly MPC OS 3.10.1**.
One/One+ are planned ports, One G2 is separate, and Force is excluded.
The Intel macOS installer completed its owner-operated Live Mk1 rehearsal on
21 November: installation, XMP boot, playback, save/reopen, stock boot without
the key and full restoration to 3.10.1 passed. The unchanged distribution check
also passed against the matching private evidence and component/source bundle.

The **0.1.0-dev.20261121.2 installer kits remain draft**, as requested. They include
the MENU fix and prepare **Acid Circuit** on a fresh USB key: boot XMP and press
**PLAY** to hear the song. Existing startup projects, recovery files, named
projects and samples are preserved. Fresh-key demo playback passed the shared
native Device audio test; the physical rehearsal used a preserved project.

| Installer host | Current validation |
| --- | --- |
| Intel macOS 13.4.1+ | Exact packaged app and owner install/play/save/reopen/restoration passed |
| Apple Silicon macOS 13.5+ | Native arm64 build, architecture audit, UI startup and simulated install/restore passed; laptop test pending |
| Windows x64 | Packaged updater/USB/demo/preservation/install/restore simulations passed; physical driver/flash qualification pending |

Mac apps are ad-hoc signed, not notarized; Windows is unsigned. Each kit carries
its own exact installer source closure, notices and checksums. Platform builds
have different installer source hashes; the XMP session template is shared.
[Current installer identities](INSTALLER-CANDIDATE.json) supersede the
[older candidate record](HARDWARE-CANDIDATE.json) for these packages.

Each owner supplies the signed official **3.10.1 updater** independently. Build
and assembly tooling produces the loader, stock recovery and runtime-bearing USB
image locally. Akai updater/rootfs/runtime files, owner images and verification
profiles are not repository or media-release downloads. The public media release contains the demonstration video. The new installer
downloads remain draft until a separate publication decision.

Read [installation](docs/install-live-mk1.md), [recovery](docs/recover-live-mk1.md),
[compatibility](docs/compatibility.md), [known issues](docs/known-issues.md) and
[the baseline checklist](docs/launch/baseline-release.md) before hardware work.
Stop and wait for **Saved on stick** before restart or power-off. Browser/emulator
results do not qualify physical latency, input sampling or production reliability.

## Contribute

[Start here](CONTRIBUTING.md), [open an issue](https://github.com/AbstractEng/XMPOS/issues)
or [send a pull request](https://github.com/AbstractEng/XMPOS/pulls).
[Security reporting](SECURITY.md) is separate from public bug reports.
Narrated tutorial video files, private voice tooling, conversations, owner device
files and internal campaign materials are excluded. Published tutorials remain
available through the manual.

Original XMP code is [Apache-2.0](LICENSE), with third-party terms and corresponding
source requirements documented in [licensing](docs/licensing/README.md).
