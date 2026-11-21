# Minimum community hardware release

**Status updated 21 November 2026.** Release an experimental open-source baseline
that others can extend with interfaces, instruments, apps and workflows. The
original 20–22 November target is a planning window, not permission to waive
required clearance. [Current status, downloads and exact evidence](../../RELEASE.md)
take precedence over dated receipts. Initial scope: Live Mk1 / ACV8, stock MPC OS
3.10.1, one unit and the reviewed Intel Mac route. Windows is a physical-install
preview; One/One+ are planned ports; One G2 is separate; Force is excluded.

## Five release gates

### 1. Distribute, install and recover — R01, R02, R03

**Passed for the current Intel Mac route.** Exact identities and platform limits
are recorded in [INSTALLER-CANDIDATE.json](../../INSTALLER-CANDIDATE.json).
Installer downloads are published as a developer prerelease with owner approval.

- [x] Stage XMP-only template, both installer kits, notices, corresponding source
  and checksums privately. Verify every kit member and uploaded file digest.
- [x] Finish current exact-file component/source/installer clearance. Keep Akai
  updater, stock/loader rootfs and runtime-bearing owner images private.
- [x] Bind current owner-local 3.10.1 preparation, install, XMP boot, no-stick
  stock handover and full restoration observations. Check applicable enabled
  image-promotion/fallback routes; pass the unchanged distribution gate.

Use the [current owner checklist](current-owner-checklist.md), not old artifact
paths or hashes. Identity, capacity, hash, rootfs-only and owner-execution guards
remain. Unknown required facts stop installation.

### 2. Play and save — R04, R05, R06

**Current software workflow and owner play/save/reopen passed.** Shared
Device and ARM one-track save/cold-reopen evidence is recorded in
[release status](../../RELEASE.md). [17 November owner checks](gate-2.md) are
historical. Emulator audio does not qualify hardware latency or inputs.

- [x] On this candidate, play, save, restart/reopen a small project and verify
  persistence. The owner confirmed these checks; earlier controls/touch evidence
  remains scoped to its tested build.
- [x] Label physical input sampling experimental/unverified and exclude it from
  the verified baseline. Retain −12 dBFS playback and USB-only session writes.

Fix known unsafe behavior and blocking/reproducible basic save loss; document
other bugs. Continuous-playback autosave and production reliability are not claimed.

### 3. Build and retain device boundaries — R07, R08, R09, R10

**Required host/build/boundary checks passed; full ARM diagnostics incomplete.**
The current clean build, relink, runtime and applicable negative-test evidence
is summarized in [release status](../../RELEASE.md). [Gate 3's earlier remediation](gate-3.md)
remains a historical record. Do not relabel the six-track capture or screenshot
timeouts as passing tests.

- [x] Build on one documented host with declared source/inputs; retain check,
  parity, inventory, native, installer and runtime evidence and known failures.
- [x] Bind source, images, pins, source/notices and checksum records to the kit.
- [x] Retain per-stick tokens, exact-board handshake, fixed bounded commands,
  Force refusals, stick-only writes, checked promotion/fallback and private logs.

Manual checks suffice; automatic CI, Docker, detached signing and extra hosts are
not requirements when a complete tested alternative supplies the selected route.
Existing package/tool gates remain mandatory. Triage known diagnostic failures
and explicitly retain or defer their workload scope before the final decision.

### 4. Explain how to use and contribute — R11, R12, R17

**Documentation/SDK delivered and current release status reconciled.** Historical
[Gate 4 evidence](gate-4.md) is supplemented by the current SDK acceptance and
packaged source/notices; this is not a new physical rehearsal.

- [x] README: purpose, status, compatibility, install/recovery, known issues,
  licence, contribution links and canonical release status.
- [x] Offline install/recovery, basic play/save and developer build/test route.
- [x] One original customization example and SDK/manual delivery verified on
  the declared host. Distinguish declarative SDK modules from source-built UI/apps.

### 5. Make it accessible — R13, R14

**Community source and installer prerelease are public in the fresh XMPOS repository.** [Gate 5](gate-5.md)
separates source/media access from the pending hardware release.

- [x] Audit the fresh-history community source and stage complete hardware kits
  with notices/source, essential docs, known issues and checksum ledgers.
- [x] After clearance and separate publication approval, publish the cleared
  source/artifact set and verify actual anonymous links, size/hash/content type.

## Maintainer go decision — no separate R number

This is the final approval after the five gates, not a sixth engineering gate.

- [x] Owner authorized publication after reviewing the current scope. The maintainer
  watches initial GitHub issues and retains control of release withdrawal.

Dates do not waive redistribution, installation/recovery, device guards or known
unsafe behavior. Recheck affected paths when candidate bytes change; reuse only
matching unchanged evidence. No hardware operation or publication is authorized
by this checklist.

## Community follow-up

Extended soak, formal latency/headroom, exhaustive sampling/control/fault matrices,
more units/hosts, incomplete optional Docker/VM paths, automatic CI, formal
signing/notarization, new-user studies, site polish and One ports are follow-up.
**R15–R16** press/Instagram campaigns are optional after release. There is no new
website, media campaign, paid support model or support SLA requirement.
