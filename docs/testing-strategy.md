# Acceptance testing strategy

The canonical Gherkin contracts live in `features`. Each of twelve stages has an end-to-end gate, and every one of its four substeps has a successful flow and a failure flow. Stable tags such as `@P06_3` connect the plan, scenarios, implementation work and reports. The feature files use the official [Cucumber Gherkin syntax](https://cucumber.io/docs/gherkin/reference/).

## What runs now

```sh
npm run bdd:plan
npm run bdd:test
npm run bdd:foundation
npm run bdd:qualify
npm run check
```

`bdd:plan` parses every feature with the official parser, verifies the dependency graph, and checks for a stage gate plus positive and negative coverage for every substep. It writes `reports/acceptance/plan-coverage.json`. It checks specification structure and traceability; it does not execute planned behavior.

`bdd:test` runs only the implemented standalone contracts in `00-current-contracts.feature`, using actual project/schema/timing/WAV code and the target-policy boundary. It writes Cucumber JSON, JUnit XML and source/fixture metadata under `reports/acceptance/current`. The sixteen expanded cases are backend contracts, not automated browser journeys or an OS qualification.

`bdd:foundation` executes all eighteen P01/P02 scenarios on the Mac, including both stage journeys. `bdd:step -- P01_1` (through `P02_4`) runs one substep; `bdd:p01` and `bdd:p02` run a whole stage. Each run writes JSON, JUnit, HTML and per-scenario evidence under its own directory in `reports/acceptance`. Reports include a complete Git-visible source-tree hash, composite musical/project fixture hash, target profile and outcome. Source changes during a run make it fail. Re-running preserves earlier evidence namespaces.

`bdd:qualify` accepts P01/P02 only when the latest foundation invocation exited successfully and every required scenario has exactly one passing host record for the current source and fixture. Artifact hashes are checked. P02 also requires P01. Missing, duplicate, stale, undefined, pending, skipped, unsupported or inconclusive records block completion. This command qualifies the Mac foundation only; it cannot certify an OS image or hardware release.

The P01 journey creates an ephemeral Git snapshot of the workspace, clones that recorded commit into an isolated directory, installs dependencies with the documented bootstrap, runs build/unit/native/current-acceptance checks, starts Vite on a loopback port, and round-trips a sixteen-step project through the local persistence port. This is a developer smoke journey with an HTTP server check, not an automated browser UI journey. It leaves the user's Git history unchanged. Logs and reports are retained before cleanup. The missing-toolchain case uses an explicitly synthetic host probe in a child process and verifies its nonzero exit.

The real native fixture adapter invokes the C++ sampler offline; its persistence port validates projects before writing within the scenario directory. The desktop contract adapter uses core WAV encoding and file persistence. Neither is a complete native application or browser driver. Both expose only requested capabilities. A native impulse oracle checks frame position, duration, both channels and PCM amplitude independently, allowing two PCM16 units for quantization. A separate child assertion intentionally fails on frame 25000 instead of 24000, and its failed outcome, capture and difference survive cleanup.

The P02 matrix explicitly exercises **synthetic contract adapters** for desktop, native, OS VM and USB lab. Each result and capture is labeled synthetic and stored separately. Its tiny PNG is a synthetic attachment fixture, not an application screenshot. These contract tests verify reporting and selection; they provide no OS boot, physical control or USB evidence. Real `os-vm` and `usb-lab` requests always return unsupported before discovery. There is no physical adapter or deployment implementation.

Nested synthetic manifests, captures and clean-checkout reports are retained under `evidence/<run>/nested`. Public evidence JSON uses a whitelist and excludes device identifiers and project payloads. Raw local Cucumber reports can contain diagnostic filesystem paths and are development artifacts, not automatically published reports.

`bdd:planned` is a deliberately failing host-only rehearsal of future scenarios. Undefined or pending behavior exits unsuccessfully. It excludes USB, physical hardware, fault injection and update authorization scenarios and writes a separate report directory. There are no generic passing or pending catch-all step definitions. A future feature becomes runnable by implementing real bindings and assertions against its target, then promoting only those covered scenarios to `@implemented`.

`bdd:usb` currently exits with an unsupported-adapter error before discovery or connection. It is a guard, not a functional hardware runner. No physical USB transport, lab agent, deployer or firmware writer has been added by this planning work.

## Independent target lanes

- **Host contract lane:** pure musical code, schemas, policy fixtures, parser/traceability and native library unit tests. No Akai connection is required or opened.
- **Desktop lane:** actual UI actions through a browser/app driver, screenshots, audible signal captures and persistence. Assertions must exercise the UI rather than simply edit the backing model. Cucumber UI bindings remain planned; previous manual browser checks are separate evidence.
- **Native standalone lane:** the native host process with virtual audio and controls. Validate engine semantics, scheduling, IPC, offline rendering and crash handling without the UI or hardware.
- **Booted OS lane:** a self-contained Linux image under QEMU with virtual devices. Boot, run inside the guest, create and reopen a song, exercise service lifecycle and recover disposable VM snapshots. The host Vite server must be stopped, and host developer directories must not be mounted into the guest. VM success proves generic OS behavior, not MPC drivers or bootloader support.
- **USB hardware lane:** an explicitly authorized Live Mk1 running the expected deployed XMP build. Run supported shared contracts through a bounded lab agent and independently collect real audio, timing and control evidence. Protected Force targets are rejected before active contact.

Scenario tags identify applicability, not equivalent evidence. `@native @os_vm @usb_lab` means the shared specification is required separately on those supported targets. A hardware-only scenario additionally requires `@hardware_only` and the named physical fixture. Unsupported capability, missing target or missing capture is not a pass. A host-only scenario uses local files, mocks or reviewed metadata; it cannot contact a device even if its subject is a device authorization rule.

The P02 contract runner chooses exactly one adapter and verifies capabilities before exposing operations; future full application adapters must retain that boundary. Merely adding a tag or environment variable does not implement an adapter. Its required matrix and test-output directories must remain separate. The current `planned` command intentionally selects host-only work until those adapters exist.

## Evidence and completion rules

For every qualifying run, record scenario ID, fixture and package hashes, application/native/image hashes as applicable, source revision, target profile, dependency versions, limits/profile version, timestamps, random seed and outcome. Device identity stays in a private local ledger; public reports use a stable redacted identity. Attach actual captures, logs, screenshots and calibration details relevant to that scenario.

Use passing, failed, pending/undefined, unsupported and inconclusive as distinct outcomes. Manual physical observations remain pending until their named evidence and reviewer are attached. No missing number is converted into zero. Retries retain failed attempts and cannot erase intermittent audio or disconnect failures.

A substep is complete only when both its planned success and failure contracts pass on its required targets, regression tests remain green and its evidence identifies the accepted build. A stage additionally requires its own user journey. A hardware-ready OS release requires every required matrix result on the same candidate build and boot tier. Existing passing unit tests or the current sixteen Cucumber cases do not close any whole stage automatically.

Every implementation PR should run formatting/type/unit/build checks, plan audit and the current regression lane. The future OS and hardware lanes are additional required jobs once implemented. Release qualification must fail for outstanding planned, skipped, unsupported or inconclusive required cases; a green development CI run alone is not a release certificate.

## Fixtures and measurement contracts

P02 materializes immutable original project and impulse fixtures in `acceptance/lib/fixtures.mjs`. Additional signals, note/event traces and workload fixtures remain planned. Each scenario gets its own work directory or VM snapshot. Only disposable lab fixture storage may be written by a hardware scenario. Personal projects, original vendor partitions and production presets are never fixtures.

[The fixture contracts](../acceptance/fixtures.md) specify initial timing, signal, parameter-precedence, effect-response and workload oracles. They identify which choices still need an explicit decision before golden files can be frozen.

`acceptance/qualification-targets.json` proposes V1 budgets: 48 kHz, 256-frame buffers, eight tracks, sixteen scenes, thirty-two qualified voices, an eight-hour soak, p95 analog round trip at most 20 ms and p95 MIDI-clock interval jitter at most 2 ms. These are acceptance targets to validate and approve, not measured promises. The exact effect graph, audio assets, thermal limits, sample-rate conversion behavior and calibration must be frozen before qualification. An unset required limit blocks the relevant gate.

For offline render parity, compare integer event positions and PCM within the specified tolerance. For physical captures, align/calibrate clocks and measure latency, jitter and signal behavior rather than requiring a bit-identical analog waveform. Measure callback deadlines independently from UI responsiveness and average CPU usage. Record thermal throttling and resident memory after the declared warmup.

Fault injection runs in disposable native processes or VM snapshots by default. Update and recovery scenarios are separately tagged and gated. A scenario description does not authorize pulling power, rebooting, replacing files or installing anything on a real instrument.

## P03 project lane

`bdd:p03` runs nine shared musical contracts using only Mac workspaces, pure code, real IndexedDB transaction tests in Vitest, and native C++ offline processing. `bdd:step -- P03_1` through `P03_4` selects each pair of substep scenarios. Shared `@native @os_vm @usb_lab` tags retain their deployment applicability; execution on this Mac does not satisfy future image/hardware lanes.

`bdd:implemented` runs the sixteen regression cases and twenty-seven stage cases through P03 against one source/fixture hash. `bdd:qualify:implemented` requires current-build evidence, preserved artifact hashes, all stage journeys and accepted preceding Mac stages. Its `complete` fields are explicitly Mac implementation gates. P03 reports pending deployment profiles and `releaseQualified: false`; it cannot authorize a release or device operation.

P03 tests actual migration, parameter precedence and C++ parity, SHA-256 deduplication, corruption/size/shape limits, measured hostile-import RSS, a child-process save interruption, quota failure and preserved undo. Additional Vitest cases exercise the browser storage code against [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB), including transaction rollback, validated previous-snapshot recovery and stale-tab conflicts. The synthetic IDB implementation is a pinned development dependency; it is not disk-durability evidence. A separate manual CUA browser journey verifies the real simulator controls, autosave reload, portable download/reopen and non-silent WAV export.

## P04 software versus physical qualification

The implemented lane adds ten software cases: six P04.1–P04.3 contracts and four explicit development/support scenarios. The independent process is real C++, its control clients use real local sockets, and its endpoint is explicitly software audio. Canaries must observe forbidden callback operations before zero counters count as evidence. Sanitizers run separately from allocator interposition.

The full P04 stage journey still requires the final V1 musical workload. Its physical loopback and removable-interface tests remain planned because the owner chose software-only testing. They are excluded from `bdd:p04` and the implemented lane. `bdd:qualify:implemented` reports software checks separately with phase/physical qualification false; `bdd:qualify:p04` exits unsuccessfully. Undefined physical contracts are not converted into passing mocks. [The native engine document](native-engine.md) specifies profiles, bounded IPC, evidence and measurement limitations.

## P10 booted guest lane

The dedicated `bdd:p10` lane boots the independent x86_64 image and executes musical assertions inside Linux. It covers all four P10 substeps and a cold-reboot song journey; host image/release policies remain separately labelled. `bdd:step -- P10_1` through `P10_4` selects each substep. The Ubuntu CI job builds and boots the same generic profile while the Mac/Linux host lanes remain independent. [The standalone OS guide](standalone-os.md) documents exact build reproducibility scope, controls, guest evidence, privacy and pending graphical/native/hardware gates. Generic VM success never closes formal loopback or USB qualification. The older host fixture adapter still cannot attest an OS boot.

## P11 host lab lane

`bdd:p11` and `bdd:step -- P11_1` through `P11_4` execute thirteen host software journeys. They run a real mutually authenticated TLS process over owned Unix sockets, validate bounded fixtures and witness native virtual PCM after control/process loss. These join both host CI jobs. The hardware stage journey and seven physical/review scenarios remain planned. `bdd:qualify:implemented` exposes P11 host checks separately and never promotes them to hardware/deployed-agent qualification. [The lab guide](hardware-lab.md) documents provenance, bounds, credential cleanup and the remaining exact-unit prerequisites. Physical `bdd:usb` remains disabled.

## P12 development reliability evidence

ADR-P12-001 permits scoped Mac and generic VM reliability work while full P10/P11 remain open. [P12 scope and commands](reliability-release.md) distinguish functional measurement completeness from performance success. The native sampler check records real deadline misses and never converts a short run into the eight-hour final-workload gate. Owned VM files support real QEMU save power cuts, corrupt-generation preservation, Ed25519 update preflight and guest-boot health rollback. A controlled interrupted snapshot transaction is narrower than arbitrary power-loss update recovery.

The host CI matrix includes P12 contracts; a separate QEMU lane verifies the implemented VM cases. Full-phase and physical scenarios stay planned. Development manifests require current-source host/P10/P12/soak evidence and always keep hardware readiness and public redistribution false. No Force or MPC operation is authorized by these tests.
