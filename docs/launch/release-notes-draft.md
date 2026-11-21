# XMP OS 0.1.0-dev.20261121

**From a loop to somewhere new.**

XMP OS is an open-source music workstation and framework for the **MPC Live Mk1**.
This community developer baseline brings together a playable clip-based instrument
and the foundation for your own instruments, interfaces, apps and workflows.

[Try the web client](https://abstracteng.com/xmpos/) · [Read the manual](https://abstracteng.com/xmpos/manual/) · [Build with XMP](../../CONTRIBUTING.md)

## In this release

- Shared native C++ touchscreen across the Live, emulator and browser via WebAssembly.
- Pad-driven kit/synth playing, clip and scene workflows, sound shaping and mixing.
- Transport, pad, track-bank and Q-Link feedback, plus the saved sampler-loop level fix.
- One graphical installer that prepares the USB key and local loader/recovery files.
  Every device write is owner-confirmed with **XMPOS**.
- Offline SDK docs, original examples, component notices and full source/relink materials.

## Hardware profile

**MPC Live Mk1 / ACV8, starting from exactly MPC OS 3.10.1.**
The source includes the graphical installation and USB-preparation tooling.
Packaged hardware installers remain a separate release while the latest source
is rebuilt and receives its affected physical checks. [Release information](../../RELEASE.md)
tracks hardware availability. Owners independently supply the signed official
updater; Akai-derived files and owner images stay local.

## Built to be extended

XMP supplies the audio, sequencing, hardware-control, project and build foundation
so contributors can concentrate on the interface, instruments and experience.
Use the [SDK manual/examples](../sdk/README.md) for declarative instruments/effects,
or the [source development guide](../developer-guide.md) for custom apps and UI.

## Validation record

The recorded clean build passed 612 application, 37 native, 20 parity, 52 inventory,
25 packaging and 18 installer tests, plus types/production build. SDK acceptance
passed 8 scenarios/56 steps. The shared Device workflow passed 86 common actions,
17 screenshot comparisons and autosave reload. Three ARM binaries relinked exactly
from the supplied materials, and the owner-local runtime probe passed. Both
packaged installers passed their declared host simulations.

[Release status](../../RELEASE.md) retains the exact candidate/source identities,
physical qualification status, ARM diagnostic findings and publication checklist.
[Known issues](../known-issues.md) records practical limits. These records travel
with the release; older candidate observations remain scoped to their exact builds.

<details>
<summary><strong>Full hardware compatibility reference</strong></summary>

<!-- BEGIN GENERATED COMPATIBILITY -->
Public hardware installation is not yet cleared. Live Mk1 is the tested candidate; One models are planned ports.

| Model              | Board         | Status                                                            | Starting firmware                                          |
| ------------------ | ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| MPC Live Mk1       | inmusic,acv8  | Hardware-tested candidate; public installation pending            | 3.10.1 only                                                |
| MPC One (original) | inmusic,acva  | Planned port; installation disabled; no XMP hardware tests        | Gen 1 3.10.1 proposed; not qualified                       |
| MPC One+           | inmusic,acva2 | Planned port; installation disabled; no XMP hardware tests        | Gen 1 3.10.1 proposed; not qualified                       |
| MPC One G2         | Unverified    | Separate Gen 2 port; installation disabled; no XMP hardware tests | Separate Gen 2 firmware family; never use this Gen 1 image |
| Akai Force         | inmusic,ada2  | Protected; excluded from all installation and device testing      | None                                                       |

Stop installation when any required fact is unknown, differs or is ambiguous. Keep the instrument on stock firmware; do not substitute a Live image, bypass a guard or probe another model with Live tools.
<!-- END GENERATED COMPATIBILITY -->

</details>

[Abstract Engineering](https://abstracteng.com/) · [Web client](https://abstracteng.com/xmpos/) · [Manual](https://abstracteng.com/xmpos/manual/)
