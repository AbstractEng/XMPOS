# P09 community SDK workbench

P09 adds a Mac SDK workbench for original instruments and effects: SDK API 2 / DSP ABI 1 negotiation, deterministic data packages, per-note expression, project-aware transactions and real process failure tests. API-1 pad-sampler examples remain supported. Core projects now use V7; this increment does not deploy an OS, enable physical ports or touch the Force.

The workbench is a command-line developer environment and headless audio preview. It does not add an installer to Studio. The deployed application store, graphical third-party UI host, dynamic native/VST loading and booted OS/USB qualification remain pending. Six original deployed/native-loader Gherkin journeys stay planned; eleven narrower Mac journeys execute now.

## Developer quickstart

Run from the repository root after `npm ci`. Node 24 and the existing pinned project toolchain are required; the same commands are tested on macOS and Linux.

```sh
# Start from a new directory; creation never replaces existing files.
npm run sdk -- new instrument my-tone artifacts/my-tone
npm run sdk -- build artifacts/my-tone artifacts/my-tone.xmpkg
npm run sdk -- test artifacts/my-tone.xmpkg
npm run sdk -- preview artifacts/my-tone.xmpkg artifacts/my-tone.wav

npm run sdk -- new effect my-filter artifacts/my-filter
npm run sdk -- build artifacts/my-filter artifacts/my-filter.xmpkg
npm run sdk -- test artifacts/my-filter.xmpkg
npm run sdk -- preview artifacts/my-filter.xmpkg artifacts/my-filter.wav

npm run sdk -- store-init artifacts/community-store
npm run sdk -- install artifacts/community-store artifacts/my-tone.xmpkg
npm run sdk -- bind artifacts/community-store artifacts/my-tone.xmpkg
npm run sdk -- store-status artifacts/community-store
```

Create the ignored `artifacts` parent first if it does not exist. Preview produces a stereo 48 kHz PCM16 WAV without opening speakers, a microphone or MIDI. `test` checks bounded finite nonzero output; `preview` writes that same half-second fixture. Listen to the resulting file only through an explicitly intended output device. Instrument and effect templates are also checked in under `examples/community-tone` and `examples/community-filter`. The generated `AGENTS.md` gives AI coding guidance; `PARAMETERS.md` lists exact units/ranges/defaults. A package contains neither that guidance nor executable source.

Edit `module.json` for names, version, parameter metadata and capabilities; edit `program.json` for the supported DSP graph. The graph supports an original sine/triangle instrument or virtual-input effect, with gain and a one-pole low pass. Bindings can reference declared parameters. Gain uses linear 0–1 values; cutoff uses 20–20,000 Hz. The sample-rate safety cap is 0.45 × rate. The effect preview feeds an original half-scale impulse. This is a deliberately small interpreter, not a general JavaScript, native, VST or Eurorack runtime.

The package build validates all inputs before creating output. Exact DSP dependencies must match the host-owned `xmp-math@1.0.0` catalog and its SHA-256 digest. Nothing resolves through `NODE_PATH`, global packages, downloads or arbitrary plugin paths. A missing dependency reports its ID and required version. New package/preview outputs use exclusive creation, so an existing file is preserved.

## Contracts and musical ownership

`CommunityManifest` validates IDs, API/ABI, kind, portable architecture, adapter, licence, declared capabilities and up to sixteen parameters with stable IDs, units, ranges and defaults. `negotiateModule` grants only declared, available capabilities. Adapter policy is explicit:

| Adapter             | Mac workbench behavior                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declarative-v1`    | Available: validated data interpreted by locally bundled code.                                                                                             |
| `trusted-native-v1` | Unavailable for imported packages. Native ABI fixture is compiled locally and tested separately. Trusted native code would share its host's address space. |
| `vst3`              | Unavailable until a reviewed host, compatible ABI and licence policy exist.                                                                                |
| `cv`                | Unavailable until a device-specific output/calibration adapter is authorized and qualified.                                                                |
| `audio-input`       | Unavailable until a source adapter is explicitly approved. Effect examples receive an in-memory buffer only.                                               |

`communityMachine(manifest, program)` adapts an instrument to the existing `MachineDefinition`/`MachineProcessor` interface. Locally trusted developers can register it with `MachineRegistry`. The definition uses `community.<module-id>` and the module state version. Shared parameter IDs retain the existing track/machine/version scope. `VoiceRack.expression(trackId, noteId, dimension, value)` forwards an optional expression only when that track's processor and definition both support it; built-ins without that capability reject before delivery. This does not install a package into a running Studio or worklet automatically.

Per-note IDs are positive integers and stay unique within a take. Note-on, note-off and expression carry ordered timestamps in seconds. Pressure/timbre are normalized 0–1; pitch is −48…+48 semitones. Negotiation requires both source and instrument support. Virtual expression fixtures are explicit; keyboard/pointer capabilities are unchanged and do not acquire physical pressure or slide sensors. DSP tests compare the mixed two-voice signal with independently rendered voices to check that expression on one note does not leak to another. No MIDI/MPE conformance is claimed.

Limits: thirty-two voices with reject-newest admission, 256 take events, sixty seconds of take timestamps, eight-second offline preview, 4096-frame maximum processing block and sixteen parameters. Panic releases instrument voices within 5 ms. Effect panic clears its one-pole state. Imported state and program data are validated before creation; existing note values remain unchanged on unsupported or malformed expression. Native C event/parameter structures and negotiation helpers live in `native/include/xmp/community.h`; the compiled fixture verifies versions, metadata, scoped expression and a caller-owned gain callback. It is not a binary loader or proof of the complete native sequencer/effects port.

## Package and project transactions

`.xmpkg` is a bounded JSON archive (1 MiB), not a zip file or installer script. Exactly four UTF-8 entries are accepted: `manifest.json`, `program.json`, `LICENSE`, `PARAMETERS.md`. Unknown/path-traversing entries, missing or mismatched licence notices, non-finite data, code-bearing graph fields, dependency mismatches and integrity failures reject before staging. File and package SHA-256 values verify integrity; they are not publisher authentication, signatures, a malware scan or proof of legal licence provenance. No package paths are extracted or executed.

A `xmp-community-project` version-1 envelope contains the actual V7 XMP project, per-track package ID/version/hash bindings and optional recorded expression takes. Core track machine state contains the native-unit parameter values. The SDK workbench reopens that envelope against the installed packages and checks all references, parameter bounds and note capabilities. An ordinary Studio portable project alone does not carry these package bindings or expression takes. Keep the workbench envelope/store for that workflow.

The store keeps packages and their bound project in one versioned `state.json`. A private sibling staging file is written and synced, then atomically renamed; the parent directory is synced after commit. Generation checks and an exclusive transaction lock prevent stale/concurrent writers from replacing current state. Store roots and state-file symlinks are rejected; platform path aliases are resolved to a canonical root. Imported paths never choose store destinations.

To upgrade, increase the package semantic version and, when renaming state IDs, increase `stateVersion` and add an explicit consecutive rename migration in `program.json`, for example `{"from":1,"to":2,"renames":{"level":"gain"}}`. Point the gain binding and parameter metadata at `gain`. Package versions are immutable. Supported migrations retain existing units/ranges, rename parameter values and scoped automation/locks/modulation/macro IDs, and fill newly added parameters from defaults. Dropped parameters, changed ranges/units, missing migrations and state downgrades reject. More general migrations require a future reviewed policy; imported code is never used as a migration.

```sh
npm run sdk -- install artifacts/community-store artifacts/my-tone-v1.1.xmpkg
npm run sdk -- rollback artifacts/community-store
```

An install transaction stores the previous complete package/project snapshot. Rollback restores it exactly, including automation and takes. Editing/replacing the project clears rollback so later musical edits cannot be silently discarded. A declined/stale change, validation failure or injected ENOSPC before rename preserves the previous committed bytes and removes staging files. Rename is the commit point; a directory-sync failure after it can mean the new valid state has committed with uncertain crash durability. Abrupt process death can leave a named `.partial` file and lock. Locks are never removed automatically: inspect the owned store and confirm no writer remains before manual recovery. Power-loss/recovery qualification belongs to the booted OS milestone.

## Process failures and trust

`CommunityUiSupervisor` launches a fixed trusted UI-model worker as a separate Node process; package code and sample/project contents are never passed to it. The broker exposes bounded parameter messages with a per-session token. It restores only the last acknowledged state, keeps at most 32 pending requests, gives acknowledgements two seconds, startup three seconds and permits eight explicit UI starts per supervisor. V8 old-space is capped at 64 MiB; this is not a total RSS or OS CPU quota. Tests actually terminate the child, restart it with a different PID and confirm that the same independent native virtual engine's clock and audio capture continue.

The worker uses Node's `--permission` with read access only to its fixed source file and no file-write or child-process grants. Tests verify denied writes and child creation. This is a guardrail for trusted code, not a security sandbox against malicious JavaScript; the [Node permission documentation](https://nodejs.org/download/release/v24.20.0/docs/api/permissions.html) states that limitation. Network isolation, process-wide OS quotas and a hostile-code sandbox are not qualified here. Package data cannot invoke worker code, a shell or any physical adapter.

A separate, locally compiled native fixture injects SIGKILL _inside its trusted DSP callback_. The host process really terminates. The parent records `native-audio-host-fault`, no output, zero held notes and no automatic restart. It explicitly records `manifestSandboxContained: false`. This one-shot test host has no hardware/audio device. A real native module in an audio host can take that host down; manifest permissions cannot contain its memory corruption. Production supervision and recovery for a booted OS remain pending.

Run `npm run bdd:step -- P09_1` through `P09_4`, then `npm run bdd:p09`. `npm run native:test` builds the local ABI/fatal fixtures first. All implemented contracts join `bdd:implemented` and CI; the separate stage qualifier reports Mac software checks while leaving the full P09 gate false. ADR-P09-001 permits development against P04/P08 Mac software evidence. Native/VST hosting, graphical/deployed package environments, OS sandbox and USB testing remain open. The Force stays read-only and the unavailable external specification has not been reviewed.

The supported standalone distribution and measured native declarative processor are now available separately: see [Supported SDK and native parity](supported-sdk.md). This does not enable imported native binaries, VST/CV adapters, a deployed installer or general native Studio parity.
