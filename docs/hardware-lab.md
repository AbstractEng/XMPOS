# P11 host lab foundation

P11 adds a Mac-only foundation for future Live Mk1 bring-up: a pinned research catalog and exact-unit dossier, typed control/service contracts, an authenticated local lab process, bounded test fixtures and independent native-engine disconnect tests. It supplies no physical USB transport, deployed agent, driver, installer or device operation. The Force remains passive host inventory only.

The original physical P11 stage journey and seven hardware/review scenarios remain planned in `features/11-usb-hardware.feature`. Thirteen separate implemented host scenarios exercise the software foundation. A green host result cannot qualify Live Mk1 pads, its codec, battery, touch, encoders, MIDI, storage, boot recovery or USB modes.

## Commands

```sh
npm ci
npm run doctor             # Includes the OpenSSL/LibreSSL certificate-tool probe
npm run native:test        # Builds the independent virtual-audio engine
npm run lab:research       # Checks pinned local research; no network or device discovery
npm run lab:review         # Reports the missing exact-unit prerequisites; exits 2
npm run lab:demo           # Real TLS lab process + native virtual audio; no physical I/O
npm run bdd:step -- P11_1
npm run bdd:step -- P11_2
npm run bdd:step -- P11_3
npm run bdd:step -- P11_4
npm run bdd:p11            # All 13 host journeys
npm run bdd:implemented
npm run bdd:qualify:implemented
```

No instrument connection is required. `lab:demo` stages the original eight-track fixture, starts the native engine, disconnects control, checks frame/project continuity and nonzero PCM after disconnect, and reconnects through a fresh authenticated session. It saves an original virtual capture and a redacted summary in `reports/lab-demo`. These commands open only owned temporary files and Unix sockets; they never enumerate or open USB/MIDI/HID endpoints, probe network ports or choose default audio devices. Temporary TLS credentials are removed when the workspace closes and never copied into reports.

## P11.1: prerequisites without inferred compatibility

`hardware/reference-catalog.json` records exact repository commits, source paths and SHA-256 values. It references the official inMusic G1 source archive, the openAZ0x MPC board recipe/status and a community model table. Reference-only facts remain distinct from observations of the owner's instrument.

The [community model table](https://github.com/TheKikGen/MPCLiveXplore-libs/blob/df1be83ec209a1e8be63759bb05fa217b4f0d0ae/src/deprecated/tkgl_anysnd.c) associates ACV8 with MPC Live and ACVA with MPC One. The [pinned openAZ0x recipe](https://github.com/openAZ0x/meta-az0x/blob/a8cb6d992402cb9bd6dd5eecf73b04dad2fb4f64/conf/machine/az01-mpc.conf) uses a generic ACVA device-tree default; this is not identification of a Live Mk1. Its [MPC status is unverified on hardware](https://github.com/openAZ0x/meta-az0x/blob/a8cb6d992402cb9bd6dd5eecf73b04dad2fb4f64/README.md). The [official published sources](https://github.com/inmusic-software/az0x-open-source/tree/ea21ffce863f48cfa138f053bfd5788daa752a6b) establish provenance, not recovery, firmware compatibility or an authorized boot mechanism. No upstream code or vendor payload is incorporated into the lab implementation.

The audit verifies locally available content and reports unavailable content explicitly. CI checks committed pin/catalog consistency without downloading missing reference payloads. Neither unavailable nor verified reference content counts as exact-unit evidence.

Copy `hardware/target.example.json` into an ignored file such as `artifacts/live-mk1-target.json` to prepare private observations, then run `npm run lab:review -- artifacts/live-mk1-target.json`. Use an opaque alias, never a serial number. The schema requires model, stock firmware, board, proposed build and boot tier. Each reviewed receipt binds its alias, model, firmware, board and build hash; receipts from another target or firmware cannot fill a prerequisite. Required kinds are stock observation, boot, recovery, isolated USB topology and owner authorization.

Even a structurally complete dossier returns `deviceAccessAuthorized: false` and `activeAdapterAvailable: false`. It is a proposal for device-specific review, not an execution token. This repository has no device deployment commands. The exact unit, supported recovery path, concrete operations and separate owner authorization must be established before any active hardware experiment, as required by `AGENTS.md`.

## P11.2: explicit adapter contracts

`packages/lab/src/adapters.ts` defines bounded fixture events for sixteen pads, touch coordinates, four encoders, transport and battery observations. Velocity zero is release; other velocities normalize by 127. Touch coordinates normalize using the declared surface bounds; invalid coordinates are rejected. These are host contract fixtures, not reverse-engineered hardware packet drivers.

Required service reports name internal audio, pads, touch, encoders, transport, MIDI, battery and storage. Missing codec or battery information enters `safe-recovery`; it is never replaced with a plausible simulator reading. All readings retain their provenance. Pressure and continuous gestures remain unqualified rather than being inferred from pad velocity or unrelated sensor dimensions. The future physical measurements and operator procedures stay planned.

## P11.3: opt-in local authentication prototype

The lab process is a separate Node 24 process using a fixed, private Unix socket. It requires `--host-simulator` and an owned temporary workspace. There is no TCP listener, USB backend, automatic discovery, fallback SSH/gadget setup or physical target flag. The P10 image is unchanged and still boots with its lab service disabled.

The prototype uses standard TLS 1.3 with a disposable local CA and mutual client/server certificates. Both sides verify certificate pins; the host checks the server name. A fresh challenge and TLS-exporter HMAC bind the asserted simulator identity, source build, approved fixture, protocol, session ID, operation list and lifetime to that connection. Reconnect creates a new challenge and session. These assertions demonstrate the host protocol; they are not measured boot attestation or a device credential provisioning system. Production identity provisioning and deployment remain planned.

The versioned grant accepts only `host-simulator`, with a maximum five-minute lifetime. A physical model or independent-image boot claim is rejected. Allowed operations are status, stage, load, named start/stop actions, render and results. They expose no shell, reboot, firmware, driver, arbitrary file path or installation API. Native actions acknowledge applied engine revisions; a loaded fixture must match the independent engine's project hash.

Frames have a four-byte length prefix and a 512-KiB limit, enforced before body allocation. Fixture text is limited to 256 KiB, four opaque fixture IDs and 1 MiB total per session. Staging requires the approved SHA-256 and a canonical validated eight-track project. Filesystem paths, tampered hashes, duplicate fixture IDs, ungranted operations, oversized data and extra command fields are rejected. Eight pending commands and 64 commands per minute bound processing; sequence numbers reject replay. Private namespaces are discarded on disconnect. Only render-result metadata persists in the same simulator process for authenticated retrieval.

The source separates control from rendering. TLS, parsing, hashing and project preparation run outside native audio callbacks. The existing C++ engine continues on its own clock after socket loss or lab-process exit. No scripting runtime, allocation, file or network work is added to its callback.

## P11.4: continuity and honest evidence

The host scenarios verify continued native frame advancement, unchanged project identity and actual nonzero virtual PCM after control disconnect or agent exit. They also replace a simulator certificate at the same Unix socket address and verify the pinned host refuses it. Closed sessions reject commands immediately; no pending command queue is replayed after reconnect.

Reports record source/fixture/native-binary hashes, applied revisions, native audit counters and capture hashes. They identify `host-lab-development-v1`, `owned-unix-tls` and virtual audio. This does not prove a physical cable disconnect, an internal codec, pressure, battery operation or analog latency.

`packages/lab/src/measurements.ts` independently analyzes proposed analog, control and MIDI limits using nearest-rank p95, matching the existing draft budgets: 20 ms analog, 10 ms control dispatch and 2 ms MIDI jitter. Required counts are 1,000 analog trials, 1,000 control trials and 10,000 MIDI intervals. Missing calibration/counts or control-round-trip data return inconclusive/null rather than zero. Calibration hashes are references, not independently verified calibrations. Every result remains analysis-only with hardware/formal-loopback qualification false, even if simulator values fall inside a budget. Reviewed physical captures, clock calibration, thermal/soak evidence and device procedures remain required.

## ADR-P11-001

P01/P02 and P10's generic VM milestone permit this host lab increment. The P10 GUI/native real-time/public-distribution gates remain open. Host CI executes all thirteen P11 contracts and keeps the original physical stage gate planned. The separate P10 CI job continues booted-image testing. P11's qualifier reports `hostSoftwareChecksPassed` while leaving full phase, physical USB, deployed-agent and hardware qualification false. `bdd:usb` still refuses every physical connection.
