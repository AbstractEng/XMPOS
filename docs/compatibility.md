# Hardware compatibility and installation preflight

The developer prerelease is available through the reviewed graphical installer. The canonical record is `os/compatibility.json`. The runtime file hashes remain in `os/live-mk1/mpc-runtime.lock.json`; builders reject disagreement between these records. Regenerate these tables with `npm run compatibility:docs`; `npm run compatibility:docs:check` and the unit suite reject stale copies.

<!-- BEGIN GENERATED COMPATIBILITY -->
XMP OS 1.0.0 is available for Live Mk1. See release status for installer host qualification. One models are planned ports.

| Model              | Board         | Status                                                            | Starting firmware                                          |
| ------------------ | ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| MPC Live Mk1       | inmusic,acv8  | 1.0.0 community release; Intel install/recovery verified          | 3.10.1 only                                                |
| MPC One (original) | inmusic,acva  | Planned port; installation disabled; no XMP hardware tests        | Gen 1 3.10.1 proposed; not qualified                       |
| MPC One+           | inmusic,acva2 | Planned port; installation disabled; no XMP hardware tests        | Gen 1 3.10.1 proposed; not qualified                       |
| MPC One G2         | Unverified    | Separate Gen 2 port; installation disabled; no XMP hardware tests | Separate Gen 2 firmware family; never use this Gen 1 image |
| Akai Force         | inmusic,ada2  | Protected; excluded from all installation and device testing      | None                                                       |

Stop installation when any required fact is unknown, differs or is ambiguous. Keep the instrument on stock firmware; do not substitute a Live image, bypass a guard or probe another model with Live tools.
<!-- END GENERATED COMPATIBILITY -->

## Installation environment

The declared build host is **Intel macOS 13.4.1, Node 24.14.0, Python 3.11, Zig 0.13.0 and mke2fs 1.47.2**. The current clean-checkout host build, owner-local assembly, ARM runtime and packaged GUI simulations passed. The current Intel Mac candidate passed owner installation, play/save/reopen, stock handover and full restoration on 21 November. See [release status](../RELEASE.md) for exact identities and test limits. Windows x64 is physically unqualified. Native Apple Silicon macOS 13.5+ passed packaged automated checks; its laptop test is pending. Linux installers are unqualified. Docker is a separate optional build lane, not a GUI installation prerequisite or physical qualification.

Saved Live observations show **ACV8, plain RK3288, bootloader 0.4**. RK3288-C is not physically qualified. This bootloader can omit product and rootfs-size replies. The GUI's fixed read-only stock verifier now measures each unit's rootfs capacity on exactly stock 3.10.1 and binds its identity to the later fastboot serial. Missing getvar fields are acceptable only with that valid same-unit verification. Unknown or mismatched identity/capacity still stops installation; there is no universal capacity fallback or borrowed owner profile. The exact current generated/installed loader must be bound to its own manifest and physical observations.

Use the correct model's mains adapter and a reviewed USB-B data cable for owner-operated fastboot installation. The tested bridge uses the **FTDI USB-NMC-2.5M null modem (0403:6001)** from Live USB-A to the Mac. Live standalone USB-B does not reach its OTG gadget controller. Do not confuse the bridge cable with the installation cable. The exact installation cable/hub and power receipt remains to be captured.

The stick loader uses **FAT32/vfat**, label **XMP** or **XMPPROBE**, on a removable USB stick. Capacity and free space must be checked for the selected key; another unit's historical observation is not a substitute. exFAT, NTFS, internal eMMC and internal SD are outside this loader route. Akai's recommendations for stock MPC storage do not qualify XMP's loader.

The candidate sets **provisional** preparation budgets of **8 GB stick capacity, 256 MiB stick free and 8 GiB workspace free**. These are conservative planning thresholds, not measured final requirements or a qualified maximum capacity. Confirm them in a clean rehearsal including backup images, extraction, build tools and sample/project headroom. Check actual free space on the installation host before preparation; an older machine-space snapshot is not a current compatibility fact.

## Offline preflight

```sh
cp docs/install-preflight.example.json reports/my-install-observations.json
# Fill only from actual local verification and already-authorized observations.
npm run live:preflight -- reports/my-install-observations.json
```

The checked-in example deliberately fails. Null capacity and false review flags represent missing evidence, not values to change to make the command pass. `loaderBytes` must come from the exact verified loader manifest. For first use, `firstUseOwnerConfirmationPlanned: true` records that the owner will enrol the actual unit through the flash tool's typed prompt; it does not claim an existing serial pin. Subsequent operations must match that pin. Legacy firmware-only records also need owner enrolment. Keep private receipts under ignored `reports/`, with no serials or hostnames committed.

The preflight reads a bounded local JSON file and local host metadata only. It never discovers, connects to, opens, mounts, formats, flashes or queries an instrument. It checks model, firmware, board/revision, pinned identity observation, bootloader, rootfs capacity, supplied updater verification observations, USB layout/space, host profile, workspace, power/cable and recovery preparation. It reports specific stops and a compatibility-record hash. Exit 0 means supplied observations match the candidate profile; **publicInstallationAllowed remains false** in this legacy offline helper: it never authorizes a release or device write. Use the published GUI route and its authenticated updater/same-unit checks. Supplied observations are not authenticated evidence. Existing updater signature/hash checks, flash-tool device identity/capacity checks and owner-only typed confirmations still apply. This does not gate stock restoration or separately authorized MPC plugins.

The README, manual, release-notes draft and product-page HTML fragment share the generated matrix. `docs/launch/product-compatibility.html` is local copy for the future product page; publication/route integration remains R13. No website was deployed by R02.

## Why One needs its own port

The pinned inMusic kernel sources identify original One as **ACVA / inmusic,acva** (`rk3288-az01-acva[-c].dts`) and One+ as **ACVA2 / inmusic,acva2** (`rk3288-az05-acva2.dts`). These are RK3288 Gen 1 platforms with 270-degree panel rotation. Their device trees use **inmusic,acva-audio / inmusic,acva-audio-codec**, rather than the Live's USB audio card. Matching CPU and screen size does not establish matching controller, audio or recovery behavior.

Source provenance: [inMusic's published kernel repository](https://github.com/inmusic-software/az0x-open-source), branch `mpc-g1/3.10`, commit `ea21ffce863f48cfa138f053bfd5788daa752a6b`; archive SHA-256 `be712eccd9fc33251d2c0682ee0e9ca7ba64752550a1387155f788c2ac45d7bd`, recorded in `os/live-mk1/kernel.lock.json`. Source paths are under `arch/arm/boot/dts/rockchip/`; declarations are design evidence, not XMP hardware results. The signed Gen 1 3.10.1 stock rootfs also contains those DTBs, inspected locally without mounting or executing it.

Akai describes the original [One](https://support.akaipro.com/en/support/solutions/articles/69000816149-akai-pro-mpc-one-frequently-asked-questions) and [One+](https://support.akaipro.com/en/support/solutions/articles/69000831945-akai-pro-mpc-one-frequently-asked-questions) as quad-core, 2 GB models. [One G2](https://support.akaipro.com/en/support/solutions/articles/69000879145-mpc-one-g2-frequently-asked-questions) has redesigned internals and an eight-core CPU, and [Akai's firmware downloads](https://www.akaipro.com/downloads-and-support/downloads/firmware/mpc/) distinguish Gen 2 firmware. G2's exact board ID, ABI and audio/controller design are not verified here. Never reuse the Live Gen 1 loader/runtime on it.

See [the One port and community qualification plan](launch/mpc-one-port.md). No hardware allowlist or device authorization is expanded by this roadmap.
