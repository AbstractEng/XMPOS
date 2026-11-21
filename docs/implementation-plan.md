# XMP OS implementation and acceptance plan

This plan takes the current desktop preview to an independently bootable music workstation and a measured Live Mk1 hardware release. It contains twelve stages and forty-eight substeps. Every stage has an end-to-end acceptance journey; every substep has a successful flow and a failure flow in Gherkin. The canonical feature files and dependency manifest generate this document, so the prose and tests can be kept in sync.

P12 adds seven Mac and five VM development reliability contracts: measured sampler timing/overload, actual save power cuts, corrupt-generation recovery, signed VM snapshot updates and scoped release evidence. ADR-P12-001 keeps eight-hour final-workload, performance, hardware, UI/native parity and public-release qualification open; see reliability-release.md. P11 adds thirteen Mac host lab contracts for exact-unit prerequisites, typed adapters, mutual TLS sessions, bounded fixtures, native virtual playback after control loss, peer-swap/replay rejection and honest measurement analysis. Its physical stage and seven exact-unit/hardware journeys stay planned under ADR-P11-001; see hardware-lab.md. P10 adds ten executable generic console-OS contracts in a dedicated QEMU lane, including reproducible binary assembly, cold-reboot song persistence, virtual HDA playback, service recovery and diagnostic privacy. ADR-P10-001 keeps graphical UI, continuous native real-time playback, redistribution and hardware gates open; see standalone-os.md. P09 adds eleven Mac SDK workbench, package/expression and failure-recovery journeys. Six deployed/native-loader journeys remain planned. ADR-P09-001 permits this increment against P04/P08 Mac software evidence. P08 adds twelve Mac mix/effects/exchange and virtual MIDI contracts. The original physical stage journey and two external MIDI cases remain planned. ADR-P08-001 permits development against P07 Mac software evidence without physical output. P07 adds ten Mac performance/focus contracts and a separately invoked real-browser viewport audit. Three deployed display/control journeys remain planned. ADR-P07-001 permits development against P06 Mac software evidence. P06 adds thirteen executable Mac sequencing/automation contracts, including a production worklet/offline comparison and a native virtual groove probe. ADR-P06-001 permits Mac development against P05 software evidence; complete native/OS/USB qualification remains pending. P05 adds thirteen executable Mac instrument/machine contracts; its native live, OS and USB deployment gates remain pending. ADR-P05-001 permits development against P04 software evidence without closing the deferred physical gates. P01/P02 have eighteen executable host scenarios, P03 has nine Mac project contracts, and P04 adds six original engine contracts plus four explicitly separate development checks. 33 V1 scenario definitions remain planned, including the final P04 workload journey and physical P04.4 tests. Sixteen additional regression cases cover core behavior and access boundaries. Run `npm run bdd:implemented` and `npm run bdd:qualify:implemented` for current-build Mac evidence. P04 software checks do not close its full phase: physical qualification was explicitly deferred by the owner, and the final V1 synth/effect workload belongs to later increments. Shared OS/USB requirements remain separately applicable. The external specification review remains pending.

[The instrument design charter](instrument-design.md) records Roger Linn primary-source research, LD01–LD08 decisions and implemented versus planned behavior. Nine additional implemented musical-display/help cases run with `npm run bdd:design`. Their host UI tests mock audio; they do not qualify sensors or a deployed device. New future contracts remain explicitly planned.

The optional [MacBook acoustic check](acoustic-audio.md) has separate host analysis contracts (`bdd:acoustic`) and a local physical Gherkin journey (`audio:acoustic`). Built-in speaker/microphone playback cannot close the calibrated P04 loopback gates, and the physical journey is excluded from CI.

## How to execute the plan

1. Reproduce the P01/P02 host foundation using the commands below. Keep source and fixture hashes together and require the stage gates before downstream work. External specification reconciliation and embedded architecture decisions remain open.
2. Implement P03 through P08 in playable increments. Each substep delivers code, real step bindings, fixtures and evidence before its gate is closed. Keep the app usable after every increment.
3. Stabilize the community SDK in P09, then qualify a self-contained Linux image in P10. A generic VM image must boot and make music without Vite, a host application or network access.
4. Begin P11.1 source/documentation research early alongside P01, and prototype the generic image pipeline after P04 to expose boot/build risks early. Full P10 and P11 qualification still depend on the accepted preceding stages. Do not defer feasibility discovery until all music features are built.
5. Perform Live Mk1 deployment and hardware testing only after the exact device, firmware, recovery route, USB capabilities and concrete authorization are recorded. The Force remains passive inventory only. No device operation is authorized merely by appearing in a scenario.
6. Close P12 only when the same candidate has the required standalone and physical evidence. Undefined, pending, skipped, unsupported or inconclusive required tests block qualification. A desktop preview may ship under its own explicitly narrower label.

A substep is complete when its positive and failure contracts pass on every required target, regression tests remain green and evidence identifies the accepted build. A stage additionally needs its own journey below. Dependencies are gates, not estimated calendar dates. Stop and record an architectural/product decision if an interface, resource budget or hardware assumption fails; do not weaken an assertion to declare completion.

## Test targets and budgets

Use separate host-contract, desktop UI, native standalone, booted-OS VM and authenticated USB-lab adapters. Shared tags mean the same contract is required separately on each applicable target, not that one target can stand in for another. Physical audio and controls require independent capture or human evidence. See [testing strategy](testing-strategy.md), [USB lab design](usb-testing.md) and [proposed qualification profiles](../acceptance/qualification-targets.json).

The initial proposed workload is eight tracks, sixteen scenes, thirty-two qualified voices, two insert slots per track, two sends and an eight-hour soak at 48 kHz with a 256-frame buffer. Proposed timing limits include p95 analog round trip of 20 ms and p95 MIDI clock interval jitter of 2 ms. These are product targets to approve and measure, not claims about the MPC. Freeze exact fixture hashes, effect settings, thermal limits and measurement methods before qualification.

## Current verification commands

```sh
npm run bdd:plan   # Parse every feature and verify plan coverage
npm run bdd:test   # Execute implemented standalone contracts
npm run bdd:foundation # Execute P01/P02 on the Mac
npm run bdd:p03 # Execute P03 project contracts on the Mac
npm run bdd:p04 # Execute P04 software contracts
npm run bdd:p06 # Execute P06 Mac sequencing contracts
npm run bdd:p07 # Execute P07 Mac performance contracts
npm run bdd:p08 # Execute P08 Mac mix and virtual MIDI exchange contracts
npm run bdd:p09 # Execute P09 Mac SDK and package contracts
npm run os:build # Assemble the pinned generic Linux guest
npm run bdd:p10 # Boot and test all four P10 substeps and the song journey
npm run bdd:p11 # Mac-only P11 host lab contracts; no hardware connection
npm run release:images # Build both owned generic VM variants
npm run bdd:p12 # Mac and VM development reliability contracts
npm run release:inspect # Inspect scoped development evidence; never publishes
npm run lab:demo # Authenticated local lab process and native virtual audio
npm run bdd:qualify:p10 # Check current-source guest evidence
npm run bdd:layout # Verify an independently captured current-source CUA viewport audit
npm run native:sanitize # Separate native memory-safety checks
npm run bdd:implemented # Execute all implemented Mac contracts
npm run bdd:qualify:implemented # Require current-build Mac evidence through P03
npm run check     # Existing formatting, types, unit tests and build
```

`bdd:planned` deliberately exposes undefined future host-only behavior with a failing exit status. `bdd:usb` deliberately refuses to connect until the future adapter exists. Neither command deploys code. Read the [strategy](testing-strategy.md) before promoting scenarios or adding target adapters.

## P01 Requirements, hardware boundaries and reproducible tools

**Depends on:** No preceding stage.

**Outcome:** A new developer can reproduce the desktop baseline while hardware access remains explicit and bounded.

[Canonical Gherkin](../features/01-foundation.feature) · Stage gate tag: `@P01 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: A new contributor starts the protected desktop workflow
  Given a clean checkout at a recorded XMP commit
  And no physical instrument is a development target
  When the contributor bootstraps the pinned tools and starts the simulator
  And creates, saves and reopens a sixteen-step drum pattern
  Then the reopened pattern and embedded samples match the saved project
  And the native and acceptance checks produce reports for that commit
  And the device-I/O audit records zero device operations
```

### P01.1 Baseline the requirements

**Implement:** Versioned requirement IDs, external specification provenance when supplied, V1 inclusions, exclusions and open decisions.

**Acceptance selector:** `@P01_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P01_1 @implemented @positive
Scenario: Baseline every V1 requirement with explicit provenance
  Given the versioned project requirements and any supplied external specification are recorded with hashes
  When the product baseline is approved
  Then every V1 requirement has an ID, owner, acceptance scenario and source
  And unresolved implementation choices have explicit decision records
```

```gherkin
@P01_1 @implemented @negative
Scenario: An unavailable external specification is not treated as reviewed
  Given the external specification input has not supplied a document
  When a contributor generates the requirements baseline
  Then the external specification review is recorded as pending
  And no requirement is attributed to unseen external specification content
```

### P01.2 Reproduce the development environment

**Implement:** Pinned Node/Python/native dependencies, toolchain doctor and clean-checkout CI.

**Acceptance selector:** `@P01_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P01_2 @implemented @positive
Scenario: Bootstrap a clean Mac or Linux developer host
  Given a supported host with Node 24, Python 3 and a C++17 compiler
  When the contributor runs the documented bootstrap and checks
  Then the lockfile dependencies and isolated native tools are installed
  And the simulator build, unit tests and native tests exit successfully
```

```gherkin
@P01_2 @implemented @negative
Scenario: Report an unsupported toolchain before starting a build
  Given a developer host with Node 20 and no C++ compiler
  When the contributor runs the toolchain doctor
  Then it exits unsuccessfully with the missing prerequisites
  And it does not download drivers or change global system settings
```

### P01.3 Record upstream provenance and licences

**Implement:** Pinned source commits, verified archives, component licence ledger and update review process.

**Acceptance selector:** `@P01_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P01_3 @implemented @positive
Scenario: Review a new upstream source revision
  Given pinned upstream commits and official source archive hashes
  When the update monitor detects a new relevant source revision
  Then it reports the source URL, changed commit and hardware or licence implications
  And the application build continues to use the previously reviewed dependencies
```

```gherkin
@P01_3 @implemented @negative
Scenario: Preserve the reference baseline during an upstream failure
  Given a previously successful upstream reference observation
  When that upstream becomes unavailable or an archive hash is incorrect
  Then the last successful baseline is retained
  And unavailable or unverified material is excluded from qualified build inputs
```

### P01.4 Establish target-specific access policies

**Implement:** Protected Force identity, passive inventory profile and explicit future Live Mk1 lab authorization contract.

**Acceptance selector:** `@P01_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P01_4 @implemented @positive
Scenario: Inspect cached host metadata without contacting the Force
  Given a fixture containing cached Akai Force USB metadata and a serial number
  When the contributor selects passive inventory
  Then only product, manufacturer, vendor ID and product ID are reported
  And the device-I/O audit records zero opened device handles and zero transfers
```

```gherkin
@P01_4 @implemented @negative
Scenario: A USB cable does not authorize a Force modification
  Given an Akai Force is present in the target inventory
  When a workflow requests deployment, reboot, MIDI output or a device command
  Then target policy rejects the request before opening a device connection
  And no mode, setting, storage or firmware change is attempted
```

## P02 Executable acceptance harness and target adapters

**Depends on:** P01.

**Outcome:** One acceptance specification can verify independent desktop, native, booted-OS and authorized USB targets with truthful reports.

[Canonical Gherkin](../features/02-test-harness.feature) · Stage gate tag: `@P02 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: Qualify the same musical behavior independently on supported targets
  Given a versioned musical fixture and its expected audio and project results
  And test doubles for desktop, native, OS VM and USB lab adapters advertise distinct capabilities
  When the adapter-contract matrix runs with an explicit fixture target per run
  Then each fixture target produces separate assertions, captures and build identity marked as synthetic evidence
  And a desktop result is never substituted for an OS boot or hardware result
  And any missing required target prevents qualification
```

### P02.1 Build scenario runners and isolated fixtures

**Implement:** Cucumber bindings, deterministic fixtures, per-scenario worlds, cleanup and process exit propagation.

**Acceptance selector:** `@P02_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P02_1 @implemented @positive
Scenario: Run two scenarios with isolated musical state
  Given two scenarios start from the same immutable project fixture
  When the first scenario changes a pattern and the second loads its fixture
  Then the second scenario receives the original pattern
  And both scenarios clean up their own processes and temporary files
```

```gherkin
@P02_1 @implemented @negative
Scenario: Propagate a real assertion failure to CI
  Given an expected audio capture contains a kick at sample 24000
  When the target produces the kick at sample 25000
  Then the timing assertion fails and the test process exits unsuccessfully
  And the actual capture and timing difference remain attached to the failed report
```

### P02.2 Define target adapters and capability preflight

**Implement:** Typed adapters, required capabilities, fail-closed target selection and no implicit transport fallback.

**Acceptance selector:** `@P02_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P02_2 @implemented @positive
Scenario: Select an adapter with a complete capability match
  Given the requested target is the native standalone adapter
  And the selected scenario requires offline render and project persistence
  When preflight validates the scenario requirements
  Then the native adapter is selected without any USB discovery
  And only its declared operations are available to step definitions
```

```gherkin
@P02_2 @implemented @negative
Scenario: Refuse an unsupported capability instead of falling back
  Given a hardware-only scenario requires physical pad sensor input
  And the selected target is a desktop simulator
  When preflight validates the scenario requirements
  Then the scenario is reported as unsupported and not passed
  And the runner does not replace physical input with a simulated pad event
```

### P02.3 Capture evidence and qualification results

**Implement:** JUnit/JSON/HTML reports with build, fixture, profile, timing, logs, screenshots and capture provenance.

**Acceptance selector:** `@P02_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P02_3 @implemented @positive
Scenario: Preserve sufficient evidence to reproduce a failure
  Given an authorized test session with a build, fixture and target identity
  When an acceptance scenario completes
  Then the report records its scenario ID, target profile, build hash, fixture hash and outcome
  And relevant logs, screenshots, event traces and audio capture hashes are attached
  And public reports redact device identifiers and personal project data
```

```gherkin
@P02_3 @implemented @negative
Scenario: A missing measurement cannot satisfy a threshold
  Given a scenario requires an analog round-trip latency measurement
  When the loopback capture is absent or its clock calibration is invalid
  Then the scenario is reported as inconclusive and qualification fails
  And no zero latency or default passing value is recorded
```

### P02.4 Integrate CI and stage completion gates

**Implement:** Plan-to-test traceability, regression lane, required target matrix and failures for undefined/pending/missing evidence.

**Acceptance selector:** `@P02_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P02_4 @implemented @positive
Scenario: Complete a stage using all of its required evidence
  Given every substep has passing scenarios for its required target profiles
  And the stage journey has passed on the same candidate build
  When the stage gate evaluates the evidence manifest
  Then the stage can be marked complete with links to its reports
  And downstream stages receive the accepted build and interface versions
```

```gherkin
@P02_4 @implemented @negative
Scenario: Planned or skipped work cannot make a release green
  Given a stage has an undefined, pending, skipped or unsupported required scenario
  When a contributor requests stage completion or release qualification
  Then the request fails with the missing scenario and target IDs
  And syntax-only validation is not reported as implemented behavior
```

## P03 Project model, assets and universal parameters

**Depends on:** P02.

**Outcome:** A musician can reopen a complete project with stable track, clip, scene, asset and parameter identities.

[Canonical Gherkin](../features/03-projects.feature) · Stage gate tag: `@P03 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: Reopen an eight-track song on an independent target
  Given a musician has eight tracks, sixteen scenes, samples and parameter assignments
  When the musician exports a portable project and opens it on another supported target
  Then track, clip, scene, asset and parameter identities are preserved
  And rendering the same seeded song produces the expected event trace and audio within the render tolerance
  And the project does not depend on a developer workstation path
```

### P03.1 Version and migrate the musical project model

**Implement:** Eight independent tracks, sixteen scenes, validated references, migrations and explicit resource bounds.

**Acceptance selector:** `@P03_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P03_1 @implemented @positive
Scenario: Migrate an older valid project without losing music
  Given a version-1 project with known notes, scenes and samples
  When the musician opens it in the next supported project-format version
  Then a validated migration preserves the musical event trace
  And the original file remains available for recovery
```

```gherkin
@P03_1 @implemented @negative
Scenario: Reject an incompatible or broken project before replacing current state
  Given the musician has unsaved changes in a valid project
  When the musician opens a future-version project or one with a missing clip reference
  Then an actionable validation error is shown
  And the current project and its unsaved changes remain intact
```

### P03.2 Create the parameter registry

**Implement:** Stable IDs, ranges, units, smoothing and precedence of base values, automation, locks, macros and modulation.

**Acceptance selector:** `@P03_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P03_2 @implemented @positive
Scenario: Resolve all parameter sources in a documented order
  Given a normalized parameter has base 0.2, automation 0.4 and a step lock of 0.7
  And its macro adds 0.1 and its LFO adds -0.2
  When the engine resolves the parameter for the locked step
  Then the effective value is 0.6 within 0.000001
  And the UI, offline render and native engine report the same effective value
```

```gherkin
@P03_2 @implemented @negative
Scenario: Reject unknown parameters and non-finite values
  Given a running project has registered parameter identities and ranges
  When a command addresses an unknown parameter or supplies a non-finite value
  Then the command is rejected before reaching DSP processing
  And existing parameter values and audio playback remain valid
```

### P03.3 Manage portable sample assets

**Implement:** Content-addressed assets, bounded decoding, relative references, missing-file resolution and portable bundles.

**Acceptance selector:** `@P03_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P03_3 @implemented @positive
Scenario: Move a project containing a shared sample between targets
  Given two pads reference one content-addressed sample
  When the musician packages and reopens the project in an empty workspace
  Then both pads resolve the same verified sample content
  And duplicate sample data is not required in the package
```

```gherkin
@P03_3 @implemented @negative
Scenario: Bound damaged or hostile asset imports
  Given an import exceeds the profile size limit or contains a corrupt sample hash
  When the musician attempts to import it
  Then the import fails before committing project or asset changes
  And memory use remains inside the declared import budget
```

### P03.4 Make editing and persistence recoverable

**Implement:** Transactional save, autosave, recovery snapshots and undo/redo across all project edits.

**Design principles:** [LD08](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P03_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P03_4 @implemented @positive
Scenario: Recover the last committed state after an interrupted save
  Given a musician edits a pattern, a sample slice and an effect parameter
  When the save process is interrupted before its atomic commit
  And the application restarts
  Then the previous committed project or a validated recovery snapshot is offered
  And no partially written project is silently treated as valid
```

```gherkin
@P03_4 @implemented @negative
Scenario: Preserve edits when storage is full
  Given the musician has unsaved project changes
  And the project storage fixture reports no free space
  When the musician saves the project
  Then save status remains unsaved and the storage failure is explained
  And undo history and the previous committed project remain available
```

## P04 Native audio host and deterministic transport

**Depends on:** P03.

**Outcome:** The audio engine runs independently of the UI with bounded real-time processing and measurable output.

[Canonical Gherkin](../features/04-audio-engine.feature) · Stage gate tag: `@P04 and @stage_gate`.

### Stage acceptance journey

```gherkin
@planned @stage_gate @positive @native @os_vm @usb_lab
Scenario: Keep a song playing while the user interface restarts
  Given the declared V1 workload is playing through the native audio host
  When the UI process crashes and is restarted
  Then the audio event clock continues without a missing or duplicated event
  And the UI reconnects to the current project and transport position
  And the measured audio remains within the active qualification profile
```

### P04.1 Implement the bounded native engine

**Implement:** Audio graph, prepared buffers, sample ownership, voice stealing and allocation/lock instrumentation.

**Design principles:** [LD08](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P04_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P04_1 @implemented @positive @native @os_vm @usb_lab
Scenario: Render a prepared voice graph without real-time allocation
  Given sample buffers and thirty-two voices are prepared before playback
  When the engine renders a one-minute multitrack fixture
  Then callback instrumentation observes zero allocations, locks and file or network operations
  And every output sample is finite and inside the declared output range
```

```gherkin
@P04_1 @implemented @negative @native @os_vm @usb_lab
Scenario: Handle voice exhaustion predictably
  Given all voices in the active profile are in use
  When another note arrives
  Then the documented voice-stealing or refusal rule is applied deterministically
  And no buffer overrun, unbounded allocation or engine crash occurs
```

### P04.2 Implement the clock and event scheduler

**Implement:** Sample-timestamped events, tempo changes, transport start/stop and deterministic offline/live ordering.

**Design principles:** [LD03](instrument-design.md#decisions-and-acceptance-traceability), [LD05](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P04_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P04_2 @implemented @positive @native @os_vm @usb_lab
Scenario: Apply a tempo change at a scheduled musical boundary
  Given a song plays at 120 BPM with notes that span the next bar
  When the musician queues 90 BPM for the next bar
  Then event times follow the old tempo before the boundary and the new tempo afterward
  And active notes receive exactly one note-off without a transport restart
```

```gherkin
@P04_2 @implemented @negative @native @os_vm @usb_lab
Scenario: Reject a malformed timestamped command
  Given the engine has a validated finite event queue
  When a command has an invalid timestamp, unsupported version or oversized payload
  Then that command is rejected with a bounded error response
  And previously queued musical events keep their order
```

### P04.3 Separate UI and engine processes

**Implement:** Versioned bounded IPC, command validation, backpressure, state snapshots and UI restart recovery.

**Design principles:** [LD05](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P04_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P04_3 @implemented @positive @native @os_vm @usb_lab
Scenario: Reconnect a client to authoritative engine state
  Given an engine is running a project while no UI client is connected
  When a compatible UI client completes the version handshake
  Then it receives an atomic project and transport snapshot
  And subsequent commands acknowledge the applied state revision
```

```gherkin
@P04_3 @implemented @negative @native @os_vm @usb_lab
Scenario: Prevent UI traffic from blocking the audio thread
  Given a client floods the control channel beyond its declared queue capacity
  When the engine applies backpressure
  Then excess commands are rejected or coalesced by the documented policy
  And callback deadlines and transport note-off processing remain within budget
```

### P04.4 Integrate host audio backends

**Implement:** Mac/Linux audio interfaces, rate negotiation, underrun monitoring, disconnect handling and loopback measurements.

**Acceptance selector:** `@P04_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P04_4 @planned @positive @native @usb_lab @physical_measurement
Scenario: Measure an actual audio path rather than a software timestamp
  Given an approved audio loopback fixture and a calibrated capture clock
  And the target uses the sample rate and buffer size declared by its profile
  When a known impulse is emitted and captured through that physical path
  Then the report contains the measured latency distribution and capture hash
  And the p95 analog round-trip latency is at most the profile limit
```

```gherkin
@P04_4 @planned @negative @native @usb_lab @fault_injection @physical_measurement
Scenario: Recover from loss of an optional audio interface
  Given playback is using a removable test audio interface
  When that interface is disconnected
  Then the engine enters its documented safe audio state without corrupting the project
  And reconnecting requires validated device and sample-rate negotiation
```

## P05 Playable sampling, synthesis and audio capture

**Depends on:** P04.

**Outcome:** A musician can select audio/MIDI machines per track, sample an input, build a kit, play a synth and resample the result in the Mac preview; OS/USB qualification remains separate.

[Canonical Gherkin](../features/05-instruments.feature) · Stage gate tag: `@P05 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: Capture a sound and turn it into a playable song part
  Given a musician starts with an empty project and an approved test input
  When the musician records a sample, trims it and assigns slices to pads
  And adds a bass patch from the subtractive synthesizer
  And resamples the combined performance and saves the project
  Then reopening restores the samples, slice assignments and synth preset
  And the rendered performance contains the expected sample and synth events
```

### P05.1 Complete the sampler and browser

**Implement:** Sixteen velocity-sensitive pads, preview, one-shot/gate/loop playback, chromatic pitch and choke groups. Playable defaults and explicitly declared velocity/pressure capabilities. Extensible audio/MIDI track-machine identities, versioned state, parameter metadata, trusted factories and unavailable-machine preservation.

**Design principles:** [LD01](instrument-design.md#decisions-and-acceptance-traceability), [LD04](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P05_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P05_1 @implemented @positive
Scenario: Play velocity-sensitive samples with explicit playback modes
  Given a kit contains one-shot, gated, looping and chromatic pad assignments
  When the musician plays the documented note-on and note-off fixture
  Then each assignment follows its playback and choke-group rules
  And captured amplitude and pitch match the velocity and note expectations
```

```gherkin
@P05_1 @implemented @negative
Scenario: Stop looping and gated voices when their owner disappears
  Given a looping pad and a gated pad have active voices
  When the track is removed or the transport receives panic
  Then all owned voices release within the documented release interval
  And no unowned or permanently sustained voice remains
```

```gherkin
@P05_1 @implemented @positive @instrument_design
Scenario: Play immediately with a declared input capability profile
  Given the default kit is loaded and the source declares note and velocity input only
  When the musician plays the supplied velocity fixture without opening an editor
  Then each hit uses the captured velocity and the declared velocity curve
  And pressure, pitch-slide and timbre-slide controls are unavailable rather than simulated
```

```gherkin
@P05_1 @implemented @positive @machine_extension
Scenario: Add a trusted custom track machine through the public registry
  Given a developer defines an original audio machine with a versioned state and parameter schema
  When the developer registers it and a musician selects it on one track
  Then its custom processor produces the expected audio and its state survives project save and reopen
  And other tracks keep their own machine identities
```

```gherkin
@P05_1 @implemented @negative @machine_extension
Scenario: Preserve an unavailable machine without running project-supplied code
  Given a project contains an unknown machine and a future machine-state version
  When a musician reopens the project without that machine installed
  Then its state is preserved and its track stays silent without substituting another machine
  And invalid built-in state and duplicate machine registration are rejected
```

```gherkin
@P05_1 @implemented @positive @machine_extension
Scenario: Keep MIDI tracks silent while emitting only virtual routed note events
  Given a MIDI machine has an explicitly configured virtual output fixture
  When notes are played and then the transport receives panic
  Then the virtual trace contains matching note-ons and note-offs on the selected channel
  And no physical MIDI or device adapter is opened
```

### P05.2 Add non-destructive waveform editing

**Implement:** Trim, crop, reverse, normalize and manual slicing with visible waveform boundaries and undo.

**Design principles:** [LD07](instrument-design.md#decisions-and-acceptance-traceability), [LD08](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P05_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P05_2 @implemented @positive
Scenario: Edit slices without destroying the original recording
  Given a recorded waveform contains four transients at known sample offsets
  When the musician trims, reverses, normalizes and manually slices the recording
  And undoes and redoes those operations
  Then slice boundaries and playback agree with the selected sample offsets
  And the original asset hash remains unchanged
```

```gherkin
@P05_2 @implemented @negative
Scenario: Reject invalid slice boundaries and silent normalization
  Given a waveform contains a silent region
  When an edit requests an end before its start or normalizes that silent region
  Then invalid boundaries are rejected and silence remains finite silence
  And no edit introduces NaN, infinity or out-of-range sample reads
```

### P05.3 Implement the first synthesizer

**Implement:** Bounded polyphonic subtractive synth, ADSR, filter, voice release, preset browser and recall.

**Design principles:** [LD07](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P05_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P05_3 @implemented @positive
Scenario: Recall an expressive polyphonic synth patch
  Given a synth patch has oscillator, ADSR and filter settings
  When the musician plays overlapping notes at different velocities and saves the patch
  And reloads it in a new project
  Then the same seeded note fixture produces audio within the synth render tolerance
  And note releases respect the saved envelope settings
```

```gherkin
@P05_3 @implemented @negative
Scenario: Bound synthesis overload without losing transport control
  Given a synth receives more notes than its qualified voice budget
  When the voice policy and overload handling are applied
  Then processing remains bounded and all samples are finite
  And transport stop still releases all synth voices
```

### P05.4 Record and resample audio

**Implement:** Explicit input arming, monitoring, bounded recording, internal resampling and interrupted-take recovery.

**Acceptance selector:** `@P05_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P05_4 @implemented @positive
Scenario: Record an explicitly armed input and resample the internal mix
  Given the musician has selected a test input and enabled monitoring
  When the musician arms recording and captures exactly two bars
  And separately resamples the internal master bus
  Then the input take and resampled take have the expected lengths and routing
  And recording does not start before the explicit arm and start actions
```

```gherkin
@P05_4 @implemented @negative @fault_injection
Scenario: Recover a take after input loss or a recording-space limit
  Given recording is active against a bounded temporary take
  When the input disappears or the recording storage budget is exhausted
  Then the recording stops with an actionable status and a recoverable valid take
  And existing project assets are neither overwritten nor deleted
```

## P06 Sequencing, expression and automation

**Depends on:** P05.

**Outcome:** A musician can record and edit expressive patterns with predictable automation and note lifetimes.

[Canonical Gherkin](../features/06-sequencer.feature) · Stage gate tag: `@P06 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: Record and edit a complete expressive pattern
  Given a musician has a drum kit and a polyphonic synth track
  When the musician records notes, quantizes selected notes and edits note lengths
  And adds microtiming, probability, parameter locks and recorded automation
  And duplicates the pattern and saves the project
  Then reopening preserves all note and expression data
  And live and offline event traces agree for the same seed and transport state
```

### P06.1 Complete step and real-time note entry

**Implement:** Sixteen to sixty-four steps, polyphonic notes, note lengths, quantization, duplicate/copy and recording. Preserve original timestamps and velocity; reversible timing correction and pressure-aware clocked note repeat with fixed-velocity fallback.

**Design principles:** [LD01](instrument-design.md#decisions-and-acceptance-traceability), [LD03](instrument-design.md#decisions-and-acceptance-traceability), [LD04](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P06_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P06_1 @implemented @positive
Scenario: Combine step entry and real-time overdubbing
  Given a sixty-four-step clip contains an existing chord
  When the musician enters pad steps and overdubs another chord in real time
  And quantizes only the newly selected notes
  Then existing notes retain their original timing and lengths
  And original take timestamps and played velocities remain available after timing correction
  And undo removes only the selected overdub transaction
```

```gherkin
@P06_1 @implemented @negative
Scenario: Shorten a clip while notes cross its new boundary
  Given a sixty-four-step clip has sustained notes beyond step sixteen
  When the musician shortens it to sixteen steps during playback
  Then notes outside the new loop follow the documented truncation and note-off rules
  And no stuck note or out-of-range event remains after the transition
```

```gherkin
@P06_1 @implemented @positive @instrument_design
Scenario: Shape note-repeat dynamics with pressure on clocked repeat ticks
  Given a virtual source declares pressure and holds one note at repeat velocity 0.5
  And its pressure fixture is 0.2 at tick zero, 0.8 at tick one and 0.4 at tick two
  When note repeat runs at sixteenths with pressure mapped directly to velocity
  Then the repeated notes have velocities 0.2, 0.8 and 0.4 at the engine's exact tick timestamps
  And releasing the note stops repeats and undo removes the recorded repeat pass as one edit
```

```gherkin
@P06_1 @implemented @negative @instrument_design
Scenario: Use a declared repeat velocity when pressure is unavailable
  Given a source declares no pressure capability and repeat velocity is explicitly set to 0.6
  When the source holds a note for three repeat ticks and then disconnects
  Then all three repeated notes use velocity 0.6 without fabricated pressure samples
  And the disconnect cancels future repeats and releases every owned note
```

### P06.2 Add groove and per-step variation

**Implement:** Swing, microtiming, seeded probability and explicit conditional-trigger semantics. Musical swing ratios with exact triplets, reversible take rendering and acknowledged native boundary changes without clock restart.

**Design principles:** [LD02](instrument-design.md#decisions-and-acceptance-traceability), [LD03](instrument-design.md#decisions-and-acceptance-traceability), [LD05](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P06_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P06_2 @implemented @positive
Scenario: Repeat seeded probability and conditional triggers
  Given a clip has a recorded random seed and explicit first-cycle and fill conditions
  When the musician replays the same number of cycles with the same fill actions
  Then triggered events match the expected seeded trace exactly
  And swing and microtiming preserve the defined bar boundaries
```

```gherkin
@P06_2 @implemented @negative
Scenario: Bound microtiming near loop boundaries
  Given events have the minimum and maximum supported microtiming offsets
  When the clip crosses its loop boundary at the fastest supported tempo
  Then events obey the documented wrap or clamp rule exactly once
  And no event is duplicated or assigned a negative processing timestamp
```

```gherkin
@P06_2 @implemented @positive @instrument_design
Scenario: Change groove at a boundary without restarting the engine clock
  Given the native engine is playing a recorded take at straight timing with an active sustained note
  When the musician queues exact triplet swing for the next bar
  Then old events finish under the old groove and the new bar uses exact 2:1 pairs
  And the sample clock, active note and original take timestamps remain continuous
  And selecting straight timing again restores the unswung take without a new recording
```

```gherkin
@P06_2 @implemented @negative @instrument_design
Scenario: Reject an invalid groove update while keeping the accepted performance
  Given the engine has acknowledged a valid queued swing change
  When an update supplies a non-finite ratio or an unsupported groove version
  Then that update is rejected and the last acknowledged change remains scheduled
  And no duplicate hit, lost note-off or transport restart occurs
```

### P06.3 Add parameter locks and modulation

**Implement:** Per-step locks, defined release/reset rules, LFO/macros and parameter-source precedence.

**Acceptance selector:** `@P06_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P06_3 @implemented @positive
Scenario: Release a parameter lock to the correct underlying value
  Given automation sets filter cutoff and one step temporarily locks that parameter
  When playback enters and then leaves the locked step
  Then the locked step uses its lock and the next step resumes the underlying automated value
  And macro and LFO offsets follow the registry precedence rules
```

```gherkin
@P06_3 @implemented @negative
Scenario: Remove a modulation source while it is active
  Given an LFO and a macro target the same registered parameter
  When the LFO module is removed during playback
  Then its contribution is removed without leaving a stale modulation value
  And the parameter smoothly resolves from the remaining sources
```

### P06.4 Record and edit automation

**Implement:** Touch/latch/write modes, automation lanes, undo and transport-safe note/automation reset.

**Acceptance selector:** `@P06_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P06_4 @implemented @positive
Scenario: Record touch automation without overwriting untouched sections
  Given a clip has an existing automation lane in touch mode
  When the musician moves an encoder for one bar and releases it
  Then only the touched interval is replaced and playback returns to the previous lane afterward
  And undo restores the complete previous lane
```

```gherkin
@P06_4 @implemented @negative
Scenario: Stop during an active automation write
  Given automation is being written while a sustained note is playing
  When the musician stops transport
  Then the recorded segment is finalized as one recoverable edit
  And note-off and parameter-reset events are applied without leaving write mode armed
```

## P07 Scenes, arrangement and live performance

**Depends on:** P06.

**Outcome:** A complete eight-track, sixteen-scene song can be composed, performed, saved and replayed.

[Canonical Gherkin](../features/07-performance.feature) · Stage gate tag: `@P07 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: Perform and reopen an eight-track sixteen-scene song
  Given a musician has eight tracks and sixteen scenes
  When the musician creates a scene chain with repeats, performs mutes and records macros
  And saves, closes and reopens the song
  Then the scene chain, clip selections and performance automation are preserved
  And replaying the song produces the expected transitions and event trace
```

### P07.1 Launch independent clips and scenes

**Implement:** Eight-track scene grid, queued launch/cancel, clip-relative start and explicit empty-slot behavior.

**Acceptance selector:** `@P07_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P07_1 @implemented @positive
Scenario: Launch a long clip from its first step on a new scene
  Given a sixteen-step clip is playing and the next scene selects a sixty-four-step clip
  When the musician queues that scene for the next bar
  Then the new clip starts from step zero at that boundary
  And independent clips on other tracks obey the declared restart or continue policy
```

```gherkin
@P07_1 @implemented @negative
Scenario: Cancel a queued launch and honor empty scene slots
  Given a scene launch is queued and another scene has an empty track slot
  When the musician cancels the queued launch and later launches the other scene
  Then the canceled launch never occurs
  And the empty slot follows the documented stop, continue or silence rule
```

### P07.2 Build scene chains and song mode

**Implement:** Scene order, repeat counts, pattern lengths, reliable transitions and song position recall.

**Design principles:** [LD07](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P07_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P07_2 @implemented @positive
Scenario: Replay a scene chain with mixed clip lengths
  Given a song contains sixteen-step and sixty-four-step clips and explicit scene repeat counts
  When the musician plays the song from its beginning
  Then scene changes occur at the expected absolute musical positions
  And the final scene follows the configured end or loop behavior
```

```gherkin
@P07_2 @implemented @negative
Scenario: Edit a song chain while its current scene is playing
  Given the current scene appears twice in the song chain
  When the musician removes the later occurrence and reorders a future scene
  Then the active scene completes under the documented edit-boundary policy
  And song position resolves to a valid next occurrence without a transport crash
```

### P07.3 Add performance controls

**Implement:** Mute/solo, macro assignments, note cleanup and predictable tail behavior during transitions.

**Design principles:** [LD05](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P07_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P07_3 @implemented @positive
Scenario: Perform track mutes and macros with predictable tails
  Given drum and synth tracks are playing through a shared delay send
  When the musician mutes the drum track, solos the synth and moves a macro
  Then newly triggered events and effect tails follow the documented mute and solo rules
  And the macro controls only its assigned parameter identities
```

```gherkin
@P07_3 @implemented @negative
Scenario: Remove a track referenced by a performance macro
  Given a performance macro controls parameters on a selected track
  When the musician deletes that track and later moves the macro
  Then stale assignments are removed or clearly marked unavailable
  And no other track receives the deleted track's control events
```

### P07.4 Complete touch and hardware-oriented workflows

**Implement:** Seven-inch layouts, consistent pad/encoder/transport mappings, focus behavior and accessible error recovery. Contextual Help with focus recovery and no project/transport mutation.

**Design principles:** [LD05](instrument-design.md#decisions-and-acceptance-traceability), [LD06](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P07_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P07_4 @planned @positive
Scenario: Complete the main music flow on a seven-inch layout
  Given the interface is displayed at the target device's verified resolution
  When a musician browses a sound, edits a pattern, launches a scene and opens the mixer
  Then every primary control remains visible, focusable and reachable without overlapping targets
  And pad, encoder and transport actions retain consistent meanings across views
```

```gherkin
@P07_4 @planned @negative
Scenario: Recover from an error dialog during performance
  Given a musician is performing with a hardware control focused on a track parameter
  When a sample import fails and its error dialog is dismissed
  Then focus returns to a valid control with an explicit parameter assignment
  And the next encoder action cannot accidentally alter a different track
```

```gherkin
@P07_4 @planned @positive @instrument_design
Scenario: Read help during performance and return to the same musical control
  Given a musician is playing a scene with a sound parameter focused
  When the musician requests contextual help using the target's documented Help action
  And closes help after a view redraw
  Then the engine clock, queued scene, project revision and undo history are unchanged
  And focus returns to the original control identity or an explicit safe fallback
  And the next encoder movement cannot change a different track's parameter
```

```gherkin
@P07_4 @implemented @positive @preview_profile
Scenario: Navigate the declared Mac preview views with virtual controls
  Given Studio runs in an isolated DOM under the declared Mac preview profile
  When the musician browses a sound, edits notes, selects a scene and opens Mix in the preview
  Then the primary preview controls retain their view and parameter identities
  And no hardware display or input capability is inferred from the DOM check
```

```gherkin
@P07_4 @implemented @negative @preview_profile
Scenario: Restore or safely clear a virtual encoder assignment after an import error
  Given Studio runs in an isolated DOM under the declared Mac preview profile
  When a sample import fails while a virtual track encoder is assigned and views redraw
  Then dismissal restores the same parameter or explicitly clears the unavailable assignment
  And the next virtual encoder movement cannot alter another track
```

```gherkin
@P07_4 @implemented @positive @preview_profile
Scenario: Read help after a redraw without changing preview performance state
  Given Studio runs in an isolated DOM under the declared Mac preview profile
  When the musician requests Help on a focused sound parameter and closes it after a redraw
  Then the clock anchor, queued launch, project revision and undo depths are preserved
  And focus and the next virtual encoder action retain their original parameter identity
```

```gherkin
@P07_4 @implemented @positive @manual_layout @preview_profile
Scenario: Audit primary targets in the actual 1280 by 800 Mac browser viewport
  Given a current-source browser audit of the declared Mac performance layout
  When the primary target rectangles are checked across Play, Sounds, Pattern, Perform and Mix
  Then measured targets are reachable without overlap and have visible focusable controls
  And the audit keeps physical display and hardware control qualification pending
```

## P08 Mixing, effects, MIDI and exchange

**Depends on:** P07.

**Outcome:** A musician can mix a song, synchronize external equipment and export audio and MIDI without state loss.

[Canonical Gherkin](../features/08-mix-midi-export.feature) · Stage gate tag: `@P08 and @stage_gate`.

### Stage acceptance journey

```gherkin
@planned @stage_gate @positive
Scenario: Mix a song and exchange audio and MIDI with another workstation
  Given a song uses eight tracks, two inserts per track and two shared sends
  And an explicitly approved MIDI fixture is connected
  When the musician synchronizes playback, mixes the song and exports WAV and MIDI files
  Then the WAV contains the expected routing, automation and effect tails
  And reimporting the MIDI reproduces note positions, lengths and tempo information
```

### P08.1 Build the mixer and routing graph

**Implement:** Volume/pan, two inserts per track, two shared sends, master bus, metering and route validation.

**Acceptance selector:** `@P08_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P08_1 @implemented @positive
Scenario: Mix track levels, stereo position and shared sends
  Given test tones are assigned to distinct tracks and known pan positions
  When the musician changes volume, pan and send levels
  Then measured channel levels match the declared pan law and gain mapping
  And the master meter reflects the actual routed output
```

```gherkin
@P08_1 @implemented @negative
Scenario: Reject an unsupported feedback route
  Given a route would create an unqualified cycle in the audio graph
  When the musician attempts to connect it
  Then the route is rejected before replacing the active graph
  And playback continues through the previous valid routing
```

### P08.2 Implement the V1 effect set

**Implement:** EQ/filter/delay/reverb/distortion/compressor, presets, bypass behavior and bounded processing costs. Playable rhythmic presets with clock-synchronized divisions, explicit phase and clock-loss policies.

**Design principles:** [LD07](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P08_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P08_2 @implemented @positive
Scenario: Recall effect chains with automation and tail state rules
  Given a chain contains EQ, filter, delay, reverb, distortion and compressor fixtures
  When the musician saves and reloads its presets and automates bypass
  Then each effect matches its reference response within its declared tolerance
  And bypass and tail behavior match the documented transition policy
```

```gherkin
@P08_2 @implemented @negative
Scenario: Contain an invalid DSP parameter or oversized effect allocation
  Given an effect receives a non-finite parameter or requests a delay beyond its memory budget
  When the engine validates that change
  Then the effect change is rejected or safely bypassed without non-finite output
  And unrelated tracks continue within the callback budget
```

```gherkin
@P08_2 @implemented @positive @instrument_design
Scenario: Play a rhythmic effect preset in time with the song
  Given a declared effect preset uses a sixteenth-note filter sequence and eighth-note delay
  When the musician changes tempo at an acknowledged bar boundary and records a macro gesture
  Then sequence ticks and delay divisions follow the engine's musical clock under the preset's phase policy
  And the saved preset and gesture reproduce the same offline response within the declared tolerance
```

```gherkin
@P08_2 @implemented @negative @instrument_design
Scenario: Keep a synchronized effect bounded when its clock source disappears
  Given an effect follows an explicitly selected clock source
  When that source disappears during a sustained note
  Then the effect follows its documented hold-last-tempo or stop policy without an implicit port switch
  And all output remains finite and panic still releases the note within the declared limit
```

### P08.3 Integrate MIDI ports and clock

**Implement:** Explicit port routing, input/output, transport/clock sync, reconnect and stuck-note recovery on approved fixtures.

**Acceptance selector:** `@P08_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P08_3 @planned @positive @midi_fixture
Scenario: Synchronize an explicitly selected external MIDI fixture
  Given the musician has selected approved input and output ports without any Force port
  When the musician starts, changes tempo and stops under the declared clock-master mode
  Then the external fixture follows transport and tempo within the profile timing limits
  And captured MIDI events include the intended notes and final note cleanup
```

```gherkin
@P08_3 @planned @negative @midi_fixture
Scenario: Reconnect without sending notes to an unintended device
  Given the selected MIDI fixture is playing sustained notes
  When it disconnects and another MIDI device occupies its previous port position
  Then the old route is invalidated rather than reassigned by list position
  And output remains disabled until the intended fixture is explicitly revalidated
```

```gherkin
@P08_3 @implemented @positive @virtual_fixture
Scenario: Synchronize the explicitly selected virtual MIDI fixture
  Given approved virtual input and output identities are selected
  When the virtual master starts, changes tempo at a bar and stops a sustained note
  Then its capture has twenty-four clocks per quarter and correctly timed transport and cleanup
  And the result declares physical MIDI timing unqualified
```

```gherkin
@P08_3 @implemented @negative @virtual_fixture
Scenario: Invalidate a virtual route after disconnect without index-based reassignment
  Given a selected virtual output owns a sustained note
  When it disconnects and another fixture takes its previous list position
  Then no packet reaches the replacement and the old route stays disabled
  And only explicit revalidation of the intended identities can restore output
```

### P08.4 Export portable audio and MIDI

**Implement:** Stereo song/scene WAV and MIDI files with timing, tails, overwrite handling and round-trip checks.

**Acceptance selector:** `@P08_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P08_4 @implemented @positive
Scenario: Export deterministic scene and song files
  Given a song has a seeded probability trace, tempo changes and a final reverb tail
  When the musician exports the selected scene and the entire song
  Then the stereo WAV headers, durations, event alignment and tails match the export contract
  And the MIDI export preserves the supported notes, velocities and tempo map
```

```gherkin
@P08_4 @implemented @negative
Scenario: Preserve existing exports when rendering or storage fails
  Given a valid export already exists at the selected destination
  When a new export runs out of storage or the musician declines overwrite
  Then the previous valid file remains unchanged
  And partial output is removed or clearly identified without a success message
```

```gherkin
@P08_4 @implemented @positive @studio_ui
Scenario: Edit a mix and stage MIDI through the Studio without opening audio
  Given the Studio is open with audio disabled
  When the musician enables stereo mixing, edits pan and an insert, and imports MIDI
  Then the clip replacement requires an explicit action and retains undo support
  And exporting MIDI or testing virtual clock never enables audio or physical MIDI
```

## P09 Community SDK, packages and application isolation

**Depends on:** P04, P08.

**Outcome:** A developer can build, test, package and install an original instrument without rebuilding the OS.

[Canonical Gherkin](../features/09-sdk.feature) · Stage gate tag: `@P09 and @stage_gate`.

### Stage acceptance journey

```gherkin
@planned @stage_gate @positive @os_vm @usb_lab
Scenario: Build and use an original community instrument without rebuilding the OS
  Given a contributor starts from the documented instrument template
  When the contributor adds parameters, tests the instrument and creates a package
  And a musician installs it into an authorized XMP application environment
  Then it receives the same musical control contract as the built-in instruments
  And a project using it reopens with the same parameter and preset state
  And the underlying OS image hash is unchanged
```

### P09.1 Stabilize application and DSP contracts

**Implement:** Versioned TypeScript/native APIs, manifests, parameter metadata and compatibility negotiation. Stable note identity and negotiated optional per-note expression, without implying MIDI/MPE conformance. Extend the P05 machine envelope with reviewed native/VST/CV/input-bus host adapters and explicit isolation/compatibility contracts.

**Design principles:** [LD04](instrument-design.md#decisions-and-acceptance-traceability), [LD06](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P09_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P09_1 @planned @positive @native @os_vm @usb_lab
Scenario: Negotiate compatible application and DSP APIs
  Given a module declares a supported API version, architecture and parameter schema
  When the host validates and loads it
  Then its parameters have stable identities, units, ranges and defaults
  And the module receives only its declared host capabilities
```

```gherkin
@P09_1 @implemented @negative @host_only
Scenario: Reject a module with incompatible or undeclared privileges
  Given a package requests an unknown API, wrong architecture or undeclared device access
  When a musician tries to load it
  Then validation rejects it before running module code
  And the running project and existing modules remain unchanged
```

```gherkin
@P09_1 @implemented @positive @standalone @instrument_design
Scenario: Route supported expression to one stable note identity
  Given a virtual input and an instrument both declare per-note pressure, pitch and timbre
  And two overlapping voices have distinct stable note identities
  When the input changes only the first note's expression and the project records the take
  Then only that voice changes and the second voice retains its expression values
  And save and reopen preserve note ownership, timestamps and supported expression dimensions
```

```gherkin
@P09_1 @implemented @negative @host_only @instrument_design
Scenario: Reject expression capabilities that the source or instrument does not provide
  Given a module accepts velocity but does not declare per-note pitch or pressure
  When an input requests those unsupported dimensions
  Then capability negotiation reports them unavailable before delivery
  And existing notes keep their values without channel-wide expression leaking across voices
```

```gherkin
@P09_1 @implemented @positive @host_only
Scenario: Share musical contracts between the Mac SDK and a compiled native ABI fixture
  Given a supported portable manifest declares its parameter units and optional expression
  When the SDK negotiates it and the locally compiled native ABI probe runs
  Then both contracts retain stable note ownership and reject incompatible versions
  And native, VST, CV and physical-input package adapters remain unavailable
```

### P09.2 Ship examples and local developer tools

**Implement:** Instrument/effect templates, simulator previews, build/package commands, docs and AI coding guidance.

**Acceptance selector:** `@P09_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P09_2 @implemented @positive @host_only
Scenario: Complete the documented developer quickstart
  Given a clean supported development environment
  When a contributor follows the quickstart to create an instrument and an effect
  Then both examples build, run their behavioral tests and preview without an Akai connected
  And the generated packages include manifests, licences and parameter documentation
```

```gherkin
@P09_2 @implemented @negative @host_only
Scenario: Report a missing dependency during packaging
  Given an example references a DSP library absent from its declared dependencies
  When the contributor builds the installable package
  Then packaging fails with the unresolved dependency and its required version
  And it does not silently use a globally installed copy
```

### P09.3 Validate and manage packages

**Implement:** Integrity, ABI/dependency/licence checks, project-aware upgrades and transactional package rollback.

**Acceptance selector:** `@P09_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P09_3 @planned @positive @os_vm @usb_lab
Scenario: Upgrade and roll back a package used in a project
  Given a saved project uses a package with a known state version
  When the musician installs a compatible upgrade and later rolls it back
  Then parameter and preset state is migrated or restored by the package contract
  And package and project changes commit transactionally
```

```gherkin
@P09_3 @planned @negative @native @os_vm @usb_lab
Scenario: Reject a corrupted or path-traversing package
  Given a package has a mismatched hash, missing licence or an escaping asset path
  When the musician requests installation into the test package store
  Then validation rejects the package before executing code or committing files
  And files outside the package store and all device firmware remain untouched
```

```gherkin
@P09_3 @implemented @positive @host_only
Scenario: Upgrade and roll back a community package transaction on the Mac
  Given a Mac package store contains a bound project with a known parameter state
  When a compatible package renames that parameter and the musician rolls back
  Then the upgrade migrates state and automation and rollback restores the exact previous snapshot
  And a stale writer or staged storage failure preserves the committed project
```

```gherkin
@P09_3 @implemented @negative @host_only
Scenario: Reject unsafe package data before changing the Mac package store
  Given an owned Mac store and an outside sentinel file exist
  When corrupt, unlicensed, incompatible and path-traversing packages request installation
  Then every invalid package is rejected before committing files or executing code
  And the outside sentinel, committed store and protected devices remain unchanged
```

### P09.4 Contain application failures

**Implement:** UI process isolation, least-privilege capabilities, resource limits and a documented trusted-native-plugin policy.

**Design principles:** [LD08](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P09_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P09_4 @planned @positive @desktop @os_vm @usb_lab @fault_injection
Scenario: Recover an application UI crash independently of audio
  Given an instrument UI runs in an isolated process
  When its UI crashes while the engine is playing
  Then the engine follows the documented continuing-audio policy
  And the musician can reopen the UI with its last acknowledged state
```

```gherkin
@P09_4 @planned @negative @native @os_vm @usb_lab @fault_injection
Scenario: Treat a native DSP crash as an explicit host fault
  Given a trusted native DSP module executes inside the audio host process
  When it crashes in an isolated test host
  Then the supervisor records the host fault and enters the documented safe recovery state
  And the report does not claim that a manifest sandbox contained the native crash
```

```gherkin
@P09_4 @implemented @positive @host_only @fault_injection
Scenario: Restart a real UI child while the independent virtual engine continues
  Given the community UI is a separate child and the native virtual engine is playing
  When the UI acknowledges a parameter and then crashes
  Then the same engine process and musical clock continue with finite captured audio
  And a new UI child restores its last acknowledged state with denied writes and child creation
```

```gherkin
@P09_4 @implemented @negative @host_only @fault_injection
Scenario: Report a fatal callback injection as a native host fault
  Given a locally compiled trusted native DSP fixture runs in an isolated test host
  When its DSP callback terminates that host
  Then the supervisor reports a host fault with no output and no automatic note restart
  And it explicitly reports that a manifest sandbox did not contain the crash
```

## P10 Standalone bootable XMP operating system

**Depends on:** P09.

**Outcome:** XMP boots and makes music without a development server, network connection or attached computer.

[Canonical Gherkin](../features/10-standalone-os.feature) · Stage gate tag: `@P10 and @stage_gate`.

### Stage acceptance journey

```gherkin
@implemented @stage_gate @positive
Scenario: Make and reopen a song entirely inside a booted offline OS image
  Given the candidate XMP image is booted on the generic supported VM board
  And the development server, network and host application services are unavailable
  When a musician creates a beat, adds a synth, arranges scenes and saves the song
  And cleanly shuts down and reboots the VM
  Then the song reopens and exports valid non-silent audio from inside the image
  And the booted build hash and virtual-device profile are recorded
```

### P10.1 Choose the Linux distribution and reproducible image pipeline

**Implement:** Architecture-specific rootfs, pinned recipes, source/SBOM manifests and vendor-component inventory.

**Acceptance selector:** `@P10_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P10_1 @implemented @positive
Scenario: Rebuild a standalone image from declared inputs
  Given the distribution recipes, toolchain, sources and asset hashes are pinned
  When two clean qualified builders produce the same target image
  Then the reproducible artifact hashes match under the documented reproducibility scope
  And the source manifest, SBOM and development notice ledger accompany the artifact
```

```gherkin
@P10_1 @implemented @negative
Scenario: Stop a build with an unresolved vendor redistribution dependency
  Given an image requires a vendor component without reviewed redistribution terms
  When a public distributable image is requested
  Then the public-image gate fails with the component and provenance gap
  And no proprietary application or firmware payload is silently added to the release
```

```gherkin
@P10_1 @planned @positive @public_distribution
Scenario: Qualify public image redistribution and independent source builds
  Given every redistributed component has reviewed terms, complete notices and matching corresponding source
  And two independent builder environments have pinned and qualified compiler toolchains
  When both environments build the public candidate from those sources
  Then the candidate hashes match within the declared cross-builder scope
  And the public image gate accepts the reviewed source and notice bundle
```

### P10.2 Implement boot and service lifecycle

**Implement:** Audio/application startup, persistent data layout, watchdogs, clean shutdown and boot diagnostics. A playable default kit and first-beat journey without setup wizards, measured on the booted image.

**Design principles:** [LD01](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P10_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P10_2 @implemented @positive
Scenario: Start and stop services in a reliable order
  Given the OS has separate engine, UI and persistent-data services
  When it boots and later receives a clean shutdown request
  Then the engine is ready before the UI reports playable status
  And saves are flushed before the persistent-data volume is closed
```

```gherkin
@P10_2 @implemented @negative @fault_injection
Scenario: Recover a failed UI service without a boot loop
  Given the UI repeatedly fails during startup on a disposable VM data volume
  When its restart budget is exhausted
  Then the supervisor exposes a bounded diagnostic recovery state
  And the project volume remains recoverable without an endless restart loop
```

```gherkin
@P10_2 @implemented @positive @instrument_design
Scenario: Reach a first beat without a setup wizard or development tools
  Given the offline OS boots with its original default kit and a qualified virtual audio path
  When the engine reports ready and the musician taps a pad and starts a recording pass
  Then audible pad feedback and the recording metronome require no sound assignment or editor navigation
  And no network login, development server or module installation is required
  And boot-to-ready time and the first-beat action trace are recorded against the frozen target profile
```

### P10.3 Qualify the image in an emulator

**Implement:** Generic QEMU machine, virtual audio/control adapters, headless tests, UI tests and fault-injection snapshots.

**Acceptance selector:** `@P10_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P10_3 @implemented @positive
Scenario: Run shared musical contracts inside the booted root filesystem
  Given QEMU boots the candidate image with virtual audio and controls
  When the OS acceptance adapter runs the shared project and render fixtures
  Then the assertions execute inside the booted image rather than on the host simulator
  And captures identify the emulated board and virtual devices
```

```gherkin
@P10_3 @implemented @negative
Scenario: Do not qualify MPC drivers from a generic VM result
  Given the generic VM passes every virtual-audio and control scenario
  When a qualification report is generated
  Then Live Mk1 pads, internal codec, battery, USB mode and boot recovery remain unqualified
  And the report lists the required physical-device evidence separately
```

### P10.4 Package offline operation and diagnostics

**Implement:** On-image content/SDK metadata, offline projects, optional disabled-by-default lab agent and local diagnostic export.

**Acceptance selector:** `@P10_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P10_4 @implemented @positive
Scenario: Operate offline with the lab service disabled
  Given the standalone development image contains its own sounds and required runtime packages
  And its optional lab agent is disabled by default
  When the OS starts without network or USB connections
  Then a musician can create, save and export a song using local resources
  And no lab control listener is started
```

```gherkin
@P10_4 @implemented @negative
Scenario: Export useful diagnostics without leaking personal projects
  Given the image has a crash log and a project containing personal audio and identifiers
  When the musician exports a diagnostic bundle
  Then it contains build, service and error evidence with documented redaction
  And personal audio, credentials and raw device identifiers are excluded by default
```

## P11 Live Mk1 bring-up and USB-connected hardware tests

**Depends on:** P01, P02, P10.

**Outcome:** A specifically authorized Live Mk1 running deployed XMP can be qualified from the computer over USB and keep playing when disconnected.

[Canonical Gherkin](../features/11-usb-hardware.feature) · Stage gate tag: `@P11 and @stage_gate`.

### Stage acceptance journey

```gherkin
@planned @stage_gate @positive @usb_lab @hardware_only
Scenario: Test a deployed Live Mk1 over USB and continue playing after disconnect
  Given a specifically authorized Live Mk1 is running the reviewed XMP lab build
  And a documented USB transport and authenticated lab session identify that exact target
  When the host loads the bounded eight-track test fixture and runs its song journey
  And captures actual internal audio through an approved physical loopback fixture
  And the USB cable is disconnected while playback continues
  Then the device keeps its local transport and project state without the host computer
  And reconnecting retrieves results for the same build and device only
  And the Force has received no device connection or command
```

### P11.1 Prove the device, boot and recovery prerequisites

**Implement:** Exact model/firmware mapping, stock-hardware evidence, recovery plan and supported USB topology; Force remains inventory-only.

**Acceptance selector:** `@P11_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P11_1 @planned @positive @host_only
Scenario: Review device-specific deployment and recovery evidence before lab work
  Given stock observations identify the Live Mk1 model and its installed firmware
  And the device-specific boot, recovery and USB capabilities have supporting evidence
  When the proposed deployment is reviewed against that exact device
  Then its reversible or recoverable steps and remaining risks are explicit
  And lab authorization names the device, operations, build and session lifetime
```

```gherkin
@P11_1 @implemented @negative @host_only
Scenario: Refuse hardware work when the USB or recovery path is unproven
  Given a stock device has no verified XMP boot or USB test transport
  When the host requests a hardware qualification session
  Then it reports the missing capability and does not open a command session
  And it does not enable SSH, USB gadget mode, rooting or a firmware update as a fallback
```

```gherkin
@P11_1 @implemented @positive @host_only
Scenario: Prepare a blocked exact-unit dossier from pinned reference research
  Given the pinned official and community hardware research catalog
  When a new Live Mk1 bring-up dossier is reviewed without stock observations
  Then firmware, board, boot, recovery, USB and owner evidence remain explicit prerequisites
  And neither upstream board defaults nor source archives authorize device access
```

```gherkin
@P11_1 @implemented @negative @host_only
Scenario: Reject evidence borrowed from another firmware or device
  Given a complete synthetic exact-unit review dossier
  When a boot receipt is rebound to another firmware and alias
  Then that receipt cannot satisfy the target prerequisites
  And even a complete dossier cannot enable a physical adapter
```

### P11.2 Integrate Live Mk1 hardware adapters

**Implement:** Verified internal audio, pad velocity, touch, encoders, transport, MIDI, battery and storage adapters. Qualify optional sensor dimensions individually rather than inferring pressure or gesture support.

**Design principles:** [LD04](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P11_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P11_2 @planned @positive @usb_lab @hardware_only @manual
Scenario: Verify real controls and device services against measured fixtures
  Given the lab build reports the exact Live Mk1 board and adapter versions
  When a physical actuator or recorded human procedure presses every pad at known force levels
  And operates touch, encoders, transport, MIDI and battery-powered playback
  Then sensor events, velocity curves and physical audio match the hardware acceptance profile
  And pressure and continuous gesture dimensions are enabled only when the exact sensors have measured support
  And human observations remain pending until their signed evidence is attached
```

```gherkin
@P11_2 @planned @negative @usb_lab @hardware_only @fault_injection
Scenario: Handle an unavailable hardware service without fabricating support
  Given an isolated hardware test fixture withholds a required codec or battery reading
  When the device starts its adapters
  Then it reports the missing service and enters the documented safe operating state
  And the hardware qualification result cannot pass using simulator values
```

```gherkin
@P11_2 @implemented @positive @host_only
Scenario: Normalize declared control events in the host adapter model
  Given versioned host fixtures for pads, touch, encoders, transport and battery
  When every pad velocity and the touch surface corners are normalized
  Then the normalized values follow the declared bounds and preserve event timestamps
  And control events retain simulator provenance without inferred sensor dimensions
```

```gherkin
@P11_2 @implemented @negative @host_only
Scenario: Keep missing codec and battery services unavailable
  Given host adapter reports omit internal audio and battery
  When adapter readiness is evaluated
  Then the model enters safe recovery and names both missing services
  And simulator readings and unsupported pressure cannot qualify hardware
```

### P11.3 Deploy an opt-in lab agent and authenticated USB transport

**Implement:** Reviewed device-specific deployment followed by an isolated USB link, target/build attestation, typed commands and bounded fixture storage.

**Acceptance selector:** `@P11_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P11_3 @planned @positive @usb_lab @hardware_only
Scenario: Authenticate a bounded lab session over the verified USB transport
  Given an authorized XMP lab image already exposes a verified isolated USB link
  When the host verifies device identity, build hash, protocol version and session challenge
  Then only typed status, fixture and test operations declared for that session are enabled
  And fixture writes are confined to the disposable lab namespace with explicit size limits
  And no arbitrary shell, firmware-write, global filesystem or deployment operation is exposed
```

```gherkin
@P11_3 @implemented @negative @host_only
Scenario: Block the protected Force and stale or mismatched lab authorization
  Given preflight receives a Force identity or an expired or mismatched target authorization
  When a USB lab session is requested
  Then policy rejects it before attempting a USB handshake or opening device handles
  And neither a generic allow flag nor a matching vendor ID can bypass the rejection
```

```gherkin
@P11_3 @implemented @positive @host_only
Scenario: Mutually authenticate the opt-in host lab prototype
  Given an isolated host lab bench with a real native virtual-audio engine
  When a fresh TLS session binds the host, simulator, build and approved fixture
  Then its identity proof is bound to the fresh channel and session lifetime
  And only granted typed operations and disposable fixture identifiers are accepted
```

```gherkin
@P11_3 @implemented @negative @host_only
Scenario: Reject tampered fixtures and replayed control frames
  Given an authenticated host lab session with an approved fixture
  When a fixture hash, destination identifier or command shape is tampered with
  Then the agent rejects each request without staging or dispatching it
  When an accepted control frame is replayed
  Then the session closes and its pending commands cannot cross a reconnect
```

```gherkin
@P11_3 @implemented @negative @host_only
Scenario: Refuse an unapproved host certificate and mismatched session identity
  Given an isolated host lab bench with a real native virtual-audio engine
  When another trusted-CA client certificate attempts to authenticate
  Then the agent refuses the unapproved host identity without engine actions
  And expired grants and mismatched build identities cannot open a lab command session
```

### P11.4 Run hardware qualification and USB failure tests

**Implement:** Shared musical contracts, actual control/audio measurements, disconnect/reconnect, target-swap prevention and standalone operation checks.

**Acceptance selector:** `@P11_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P11_4 @planned @positive @usb_lab @hardware_only @physical_measurement
Scenario: Collect genuine hardware timing and audio evidence
  Given the qualified Live Mk1 workload is running with calibrated audio and MIDI capture fixtures
  When the host runs the shared musical contracts and physical timing measurements
  Then results include the hardware build, workload, capture calibration and actual measurement distributions
  And each required analog, control and MIDI limit in the selected profile is evaluated independently
```

```gherkin
@P11_4 @planned @negative @usb_lab @hardware_only @fault_injection
Scenario: Prevent reconnect and target-swap errors during a test
  Given a lab session is active on an authorized Live Mk1
  When its USB cable disconnects and a different device reconnects at the same host port
  Then the host invalidates the old session and sends no replayed or queued commands
  And only reauthorization of the original target can resume control
  And the original device's local playback is independent of host connectivity
```

```gherkin
@P11_4 @implemented @positive @host_only
Scenario: Keep native playback alive when the lab process exits
  Given an authenticated host lab session playing the approved fixture
  When the host lab agent process exits
  Then the independent native engine keeps advancing with the same project
  And its virtual capture contains audio without claiming physical output
```

```gherkin
@P11_4 @implemented @negative @host_only
Scenario: Refuse a replacement peer at the same local lab address
  Given an authenticated host lab session playing the approved fixture
  When a different simulator certificate replaces the original at the same socket address
  Then the pinned host rejects the new peer before test commands are enabled
  And old commands are neither replayed nor redirected to the replacement
```

```gherkin
@P11_4 @implemented @negative @host_only
Scenario: Keep calibration gaps and simulator measurements out of hardware qualification
  Given independent metric fixtures include passing, failing and missing captures
  When analog, control and MIDI distributions are evaluated separately
  Then missing or control-round-trip evidence remains inconclusive rather than zero
  And passing simulator distributions leave formal physical qualification pending
```

## P12 Reliability, recovery, updates and V1 release

**Depends on:** P10, P11.

**Outcome:** An independently reproducible V1 release has passing standalone and hardware evidence and a recoverable update path.

[Canonical Gherkin](../features/12-release.feature) · Stage gate tag: `@P12 and @stage_gate`.

### Stage acceptance journey

```gherkin
@planned @stage_gate @positive @os_vm @usb_lab @update_authorization
Scenario: Qualify the musician and developer V1 journeys on one candidate release
  Given the candidate release has approved standalone and Live Mk1 qualification profiles
  When a musician installs by the approved path and makes, performs, saves and exports a song offline
  And a developer builds a new instrument, tests it and installs its package on that environment
  And the required long-session and recovery scenarios complete
  Then every stage gate and required target has passing evidence for the same release build
  And source, licences, compatibility, update and recovery instructions match the shipped artifacts
```

### P12.1 Qualify performance and long sessions

**Implement:** Declared workload, eight-hour soak, latency/jitter/memory budgets and measured overload behavior.

**Design principles:** [LD08](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P12_1`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P12_1 @planned @positive @native @os_vm @usb_lab
Scenario: Sustain the declared V1 workload for eight hours
  Given the qualification workload specifies eight tracks, thirty-two voices and the exact effect graph
  When it plays for eight hours with scheduled edits, saves and scene changes
  Then the engine reports zero xruns and no missing or duplicated expected events
  And measured callback deadline, memory-growth and timing budgets stay within the target profile
  And physical hardware targets also satisfy their recorded thermal limits without throttling
```

```gherkin
@P12_1 @planned @negative @native @os_vm @usb_lab @fault_injection
Scenario: Shed an explicitly overloaded workload without losing saved work
  Given the workload exceeds the target's measured DSP capacity
  When the engine applies its documented overload policy
  Then it reports the overload and bounds processing instead of hiding missed deadlines
  And transport stop and project save remain available
```

```gherkin
@P12_1 @implemented @positive @host_only
Scenario: Record a bounded wall-clock sampler development soak
  Given the frozen sixty-second thirty-two-voice sampler development profile
  When the independent native engine runs with scheduled tempo edits and saved checkpoints
  Then duration, callback counters, memory and bounded capture evidence are measured
  And every observed timing violation keeps the strict performance gate failed
  And a short sampler run cannot qualify the eight-hour V1 workload or hardware
```

```gherkin
@P12_1 @implemented @negative @host_only
Scenario: Refuse incomplete or relabeled soak evidence
  Given a short, incomplete or deadline-violating sampler report
  When it is evaluated as long-session qualification
  Then missing durations, measurements and strict timing violations are reported
  And no fabricated eight-hour or hardware pass is issued
```

```gherkin
@P12_1 @implemented @negative @host_only
Scenario: Preserve virtual stop and saved state during voice overload
  Given an owned native virtual engine at its thirty-two-voice capacity
  When sixty-four additional virtual voices are requested
  Then excess demand is explicitly refused and transport stop remains available
  And the original project snapshot still saves with its known identity
```

### P12.2 Test project and system recovery

**Implement:** VM fault injection, corrupt-data handling, restore drills and any separately authorized hardware recovery rehearsal.

**Design principles:** [LD08](instrument-design.md#decisions-and-acceptance-traceability).

**Acceptance selector:** `@P12_2`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P12_2 @implemented @positive @os_vm @p12_vm @fault_injection
Scenario: Recover from a VM power interruption during save
  Given a VM snapshot contains a known committed song and a pending edit
  When virtual power is interrupted during an atomic save and the image reboots
  Then a valid committed project or validated recovery snapshot is restored
  And the result includes the exact injected failure point and recovered asset hashes
```

```gherkin
@P12_2 @implemented @negative @os_vm @p12_vm @fault_injection
Scenario: Preserve the original data when every recovery candidate is invalid
  Given a disposable VM fixture contains corrupt project and recovery files
  When the musician requests recovery
  Then the application reports that no candidate can be validated
  And it preserves the original files for export instead of overwriting them with an empty project
```

```gherkin
@P12_2 @planned @positive @usb_lab @hardware_only @fault_injection @update_authorization
Scenario: Recover a Live Mk1 save after an approved physical power interruption
  Given an exact Live Mk1 has approved recovery evidence and device-specific fault-test authorization
  When an authorized operator interrupts a save using the reviewed hardware procedure
  Then the independently booted target restores a validated committed generation
  And project and asset hashes identify the recovered data without relying on VM results
```

```gherkin
@P12_2 @planned @negative @usb_lab @hardware_only @fault_injection @update_authorization
Scenario: Preserve invalid recovery generations on the exact Live Mk1
  Given an authorized disposable Live Mk1 data fixture has no valid committed generation
  When the deployed application requests recovery
  Then it preserves the original files and offers the reviewed recovery export path
  And no empty project replaces saved data without separate explicit approval
```

```gherkin
@P12_2 @implemented @positive @os_vm @p12_vm @fault_injection
Scenario: Recover the published generation after a VM power interruption
  Given a VM snapshot contains a known committed song and a pending edit
  When virtual power is interrupted after the primary directory sync
  Then the new committed generation reopens with its recorded asset hashes
  And the result includes the exact injected failure point and recovered asset hashes
```

```gherkin
@P12_2 @implemented @positive @os_vm @p12_vm @fault_injection
Scenario: Open a validated previous snapshot without overwriting a corrupt primary
  Given a VM has two committed generations and a corrupt primary fixture
  When the owned VM cold boots into project recovery
  Then it opens the validated previous generation read-only
  And the corrupt primary remains available for explicit recovery export
```

### P12.3 Build reversible updates and release artifacts

**Implement:** Verified images/packages, compatibility checks and transactional update/rollback suited to the verified boot layout.

**Acceptance selector:** `@P12_3`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P12_3 @planned @positive @os_vm @usb_lab @update_authorization
Scenario: Update through the verified target-specific transaction and roll back
  Given the exact target has an approved update path and a previously validated release
  When an authorized update installs the candidate and its health check fails
  Then the update mechanism restores the previous bootable application and compatible project state
  And the report records the target-specific transaction rather than assuming A/B partitions exist
```

```gherkin
@P12_3 @planned @negative @os_vm @usb_lab @update_authorization
Scenario: Reject a corrupted or wrong-model release before writing it
  Given a release artifact has an invalid signature, hash, model or dependency set
  When an authorized operator requests its installation
  Then preflight rejects it before any image or system-data write
  And the currently installed release remains bootable and unchanged
```

```gherkin
@P12_3 @implemented @positive @os_vm @p12_vm @fault_injection
Scenario: Roll back an unhealthy VM candidate and promote a healthy retry
  Given signed compatible VM images and a committed project on an owned data disk
  When a candidate boots with a failed UI health check
  Then the known-good image pointer and data snapshot are unchanged
  When a VM update is interrupted after cloning and before promotion
  Then reopening the transaction preserves the known-good active snapshot
  When the signed candidate passes its fixed guest musical health checks
  Then the candidate is promoted and reopens the same project after a cold boot
  And the update receipt identifies the generic VM transaction without claiming an MPC partition layout
```

```gherkin
@P12_3 @implemented @negative @host_only
Scenario: Reject unsafe VM release capsules before staging writes
  Given an owned VM capsule-policy fixture and a pinned release signer
  When signatures, component bytes, target models or dependency versions are invalid
  Then capsule preflight rejects each request before creating an update store
  And known-good source bytes remain unchanged
```

### P12.4 Complete musician and developer release journeys

**Implement:** Offline install/create/perform/save/export/module-install journeys, documentation and a signed-off evidence/redistribution checklist.

**Acceptance selector:** `@P12_4`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.

```gherkin
@P12_4 @planned @positive @host_only
Scenario: Publish only an evidence-backed release candidate
  Given all required scenario and target results are linked to one candidate artifact hash
  And its sources, notices, dependency rights and recovery documentation have been reviewed
  When the maintainer evaluates the release gate
  Then the release manifest names supported hardware and measured limits accurately
  And optional, unavailable or manually unverified capabilities are clearly excluded
```

```gherkin
@P12_4 @implemented @negative @host_only
Scenario: A green simulator cannot conceal a missing hardware qualification
  Given all simulator tests pass but the Live Mk1 hardware lane is missing or inconclusive
  When the maintainer requests a hardware-ready V1 release
  Then release qualification fails with the missing hardware evidence
  And an explicitly labeled desktop preview may be evaluated separately
```

```gherkin
@P12_4 @implemented @positive @host_only
Scenario: Generate a scoped development candidate manifest
  Given complete current-source host and generic VM development evidence
  When the maintainer evaluates development preview readiness
  Then only the supported generic VM console and recovery scope is listed
  And physical hardware, public redistribution and full V1 performance remain pending
```

```gherkin
@P12_4 @implemented @negative @host_only
Scenario: Reject stale and mismatched candidate evidence
  Given development evidence names another source or image build
  When the maintainer evaluates development preview readiness
  Then development readiness fails with the mismatched evidence
  And no hardware or public release is authorized
```

## Maintaining the plan

Edit `acceptance/plan.json` and the canonical `.feature` files, run `npm run bdd:plan`, then regenerate this document with `npm run bdd:docs`. The plan auditor checks syntax, unique IDs, dependency cycles and success/failure/gate traceability. It never converts a planned scenario into passing implementation evidence.
