# Hardware distribution boundary and owner-local installation

The downloadable XMP system and the locally generated Akai-derived loader are separate artifacts. Current loader/probe manifests explicitly forbid redistribution. A session image's historical `containsVendorFiles: false` field means no proprietary Akai assets; it does not say that third-party notices, source and static-linking review are complete.

**Current status:** the complete hardware kits are staged privately for 0.1.0-dev.20261121. Their final exact-file clearance and affected physical checks remain pending. The 18 November package-gate pass below is historical. See [release status](../RELEASE.md).

## Selected launch baseline and runtime policy

Only MPC Live Mk1 / ACV8 **already running MPC OS 3.10.1** is supported. The updater, rootfs and individual runtime file hashes are pinned in `os/live-mk1/mpc-runtime.lock.json`. Loader creation and release installation evidence refuse other updater/version baselines. General stock recovery and the separately authorized MPC plugin wrapper retain their existing scope.

Each owner extracts shared libraries and ALSA configuration from their own signed updater with `live:prepare-runtime`. The 87-file extraction is available; it never mounts an image, executes vendor code or reads a device. Keep the resulting runtime on USB and private. XMP does not mount internal storage to borrow its installed libraries.

**Implemented:** [dynamic build, local USB assembly and ARM runtime testing](live-mk1-owner-runtime.md), with installation evidence binding the public template to the private image actually booted. Version 3 also binds a separately built loader to its own source and exact manifest. The host recipe now pins startup/header sources and supplies matching objects/maps/used headers through the candidate-aware source kit; the older frozen candidate's [final clearance and owner physical installation evidence passed](launch/gate-1-clearance.md). Publication remains on hold. See [the host component assessment](licensing/owner-local-review.md). The existing session builder remains a legacy static development lane and cannot produce a public package under this policy. See the [component review](licensing/README.md).

## Public artifact contract

`npm run live:release -- check <session-directory> <review-directory>` checks a candidate without creating a package. `pack` additionally takes a **new** directory under `artifacts/` and creates a local ZIP plus its checksum receipt. Neither command uploads, flashes, discovers a device or changes repository visibility.

The **template pack produced by this public packer** has exactly eight top-level files:

| File                          | Purpose                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `system.img`                  | The reviewed XMP public template, excluding owner runtime; not directly bootable    |
| `THIRD-PARTY-NOTICES.txt`     | Reviewed notices for the actual image and corresponding sources                     |
| `corresponding-source.tar.gz` | Reviewed XMP/component source, build and relink materials                           |
| `INSTALL.md`                  | Matching first-install instructions                                                 |
| `RECOVERY.md`                 | Matching stock handover/restoration instructions                                    |
| `LICENSE`                     | XMP's licence; third-party terms remain separate                                    |
| `manifest.json`               | Sanitized version, target, source/payload identities and review/evidence references |
| `SHA256SUMS`                  | Integrity hashes for the other seven files                                          |

The packer selects named files, never archives a build/source directory recursively. It excludes sibling emulator images, standalone binaries, private logs and owner evidence even when present beside valid inputs. It rejects loader/probe/stock manifests, legacy ambiguous proprietary-asset declarations, oversized/non-ext4 session payloads, symlinks, changed hashes, pending reviews and incomplete/simulated owner observations. Staged copies are rehashed; the large source archive is streamed directly to avoid a duplicate staging copy. Every archived member is read back and compared with its reviewed size and SHA-256. An existing output directory is preserved.

**Always owner-local:** the official updater `.app`, embedded `Update.img`, extracted stock rootfs, modified loader/probe rootfs, vendor-derived `/boot` files, partition images, private credentials and raw device reports. Do not rename them to `system.img` to work around the boundary. An archive assembled by this tool is a packaging result, not proof that every other hardware release gate has passed or that a publisher signature exists.

## Complete private installer kits

The staged Mac/Windows kits include the installer itself, its source/notices and
the session source/instructions. The XMP-only template is embedded inside the
installer. Their outer ZIPs are not the eight-file output above and have not
passed this public `pack` gate. Each kit supplies `DOWNLOAD.json` and a member
checksum ledger; the separate [download manifest](../HARDWARE-DOWNLOADS.json)
records exact kit/input hashes. Private packaging preserves the audited installer
bytes and does not convert pending reviews or synthetic tests into clearance.
Before any public installer-kit distribution, bind the complete actual file set,
installer closure and required source/notices to the current approved review;
also satisfy the existing exact-template/physical-evidence gate. Owner-supplied
Akai files and generated runtime images remain excluded from every public form.

## Review inputs

Copy the two pending templates into a new ignored review directory under `artifacts/` or `reports/`. Do not commit the completed private installation record or raw evidence. Templates intentionally fail the gate until an actual reviewer/owner supplies the missing records.

`clearance.json` must bind the exact session manifest, source identity, system image, notices, corresponding-source archive, updater image and installation receipt. Its approved review reference is an HTTPS record that must become publicly accessible alongside the release. A private staging reference does not satisfy Gate 5 anonymous-access checks. The component list must include XMP, libc startup code, compiler runtime/startup/header review and both fonts, plus every additional actual shipped component. Owner-extracted shared libraries/configuration are excluded, not represented as publicly shipped components. ALSA source remains in the review kit for build interfaces and legacy review. Each row names its version, licence, upstream source URL, a regular `sources/<file>` inside the source archive and that file's SHA-256. The source archive also contains nonempty `BUILDING.md` and `STATIC-LINKING.md` describing rebuilding and the reviewed relinking materials/process. The reviewer resolves the actual component terms; the tool checks bindings and structure, not legal sufficiency.

The source archive audit is streamed and bounded. It rejects unsafe/duplicate paths, links, obvious updater/rootfs files and missing or mismatched component sources. It never extracts or executes supplied code. The image is separately read without mounting: a strict filesystem allowlist rejects shared libraries/configuration or extra files, and the three XMP executables must use the expected dynamic interpreter/dependencies and compatible version tables. Nested archives and the actual compiled code still need the recorded review; this scanner is not a substitute for that review.

`installation.json` is a **local owner attestation**, not a generated test result. It binds source, public template, private booted system image, owner assembly manifest, runtime lock, local loader, updater, original stock rootfs and private hashed device identity. Five ordered observations must pass: install loader rootfs, boot XMP from USB, boot Akai without USB, restore the stock rootfs and boot restored stock. Each references a present, hash-verified local log/text/JSON/PNG. The review directory also holds `loader-manifest.json` from the local loader build and `stock-receipt.json` captured from the authenticated preparation command; their source/updater/loader/original-rootfs hashes must agree with the owner record. The raw container-helper cache receipt alone is not signed-updater verification. Starting/restored MPC OS versions must both be exactly 3.10.1. Version-2 evidence separately identifies the public template and final private image; version 3 additionally requires the loader's own source hash and exact manifest hash, without relabelling the session source. In both versions, the local `owner-assembly.json` must match its hash, runtime lock, source and updater. Synthetic/missing/stale observations cannot qualify. The public manifest retains an aggregate evidence hash and explicitly says the actions were not independently witnessed by the tool; no raw identity/log is shipped.

The older frozen candidate passed the actual package gate on 18 November; see [the exact clearance and scope](launch/gate-1-clearance.md). A no-vendor flag alone still cannot qualify another candidate. Existing historical observations remain historical. The new first-install route was checked through fresh read-only stock verification and a no-write fastboot dry run; the prior six physical installation/recovery observations were supplied by the owner.

## Local updater route

Follow [first installation](install-live-mk1.md) and [return to stock](recover-live-mk1.md). Prepare and verify stock recovery on the Mac **before** installation, using the owner's independently obtained reviewed updater. The restore path compares an existing cache with a fresh bounded extraction, so an altered cached rootfs cannot silently become the image sent by the flash tool.

`buildProbeImage` now records XMP source identity and can enforce `expectedUpdaterImageSha256` for a release orchestration caller; the standalone loader CLI additionally enforces the pinned 3.10.1 updater. Check the loader manifest's updater hash against the public manifest. Signature/container validation remains required. The `--host` loader route builds pinned filesystem tools locally and audits the signed stock copy without Docker; the separate Docker route remains available when its prerequisites work. Never distribute the generated loader to simplify onboarding.

Physical flashing remains solely through `tools/live-mk1/flash.mjs`, run by the owner under `AGENTS.md`. The command allowlist and typed confirmations are retained. The unit serial is pinned privately after owner first-use confirmation; legacy records without one cannot identify a unit and require enrolment again. Every fastboot read command is logged, and bootloader-prefixed replies are parsed without accepting conflicting values. Partition type/capacity must be readable and valid before any write. These documents do not authorize a Force operation, bootloader/environment change, another partition, raw shell or new hardware adapter.

For a fresh local review directory, capture the signed preparation receipt without npm's banner:

```sh
node tools/live-mk1/stock-image.mjs "/absolute/path/to/reviewed/Updater.app" > artifacts/local-review/stock-receipt.json
```

Create that directory first and use a new output filename. Copy the loader's `manifest.json` there as `loader-manifest.json`; keep both local. No real review or physical receipt is generated from the templates.
