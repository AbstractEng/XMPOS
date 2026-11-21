# Supported SDK 0.1.0 and native parity

The supported distribution is a self-contained npm tarball, built locally from reviewed source. It carries the Node CLI, compiled ESM API, TypeScript declarations, native C sources, a compatibility manifest, Apache-2.0 licence and the pinned MIT-licensed Zod dependency. It can be installed offline outside the repository without an OS checkout, workspace symlinks or Vite. It is not published to the public npm registry.

Support profile: Node 24, macOS/Linux with a C99 compiler for native parity. Module API 2 and DSP ABI 1 are unchanged; project compatibility is declared in the installed `compatibility.json` and must match the core project emitted by the SDK store/bind workflow. The native profile supports the existing declarative sine, triangle and virtual-input/one-pole effects at 48 kHz, up to one second, 256 prepared events and 32 voices. No imported executable module, physical input, VST, CV or hardware adapter is enabled. The generic VM is x86_64 Linux; this is not an MPC ARM toolchain or device deployment.

The tarball bundles the [offline SDK manual](sdk/README.md), [community reference](community-sdk.md), [API/lifecycle reference](sdk/reference.md), [runnable examples](sdk/examples.md) and [repository/Docker setup guide](sdk/repository-setup.md). Custom native apps use the separate source checkout; the standalone SDK does not provide a native UI/module loader.

## Contributor quickstart

A maintainer builds a new distribution directory:

```sh
npm ci
npm run sdk:pack -- artifacts/sdk/release-001
```

In a new, empty contributor directory outside the XMP checkout, initialize a Node project and install the resulting local tarball (replace the path with your actual distribution location):

```sh
npm init -y
npm install --offline --ignore-scripts /absolute/path/to/xmp-sdk-0.1.0.tgz
./node_modules/.bin/xmp doctor
./node_modules/.bin/xmp version
./node_modules/.bin/xmp new instrument my-tone my-tone
./node_modules/.bin/xmp build my-tone my-tone.xmpkg
./node_modules/.bin/xmp test my-tone.xmpkg
./node_modules/.bin/xmp preview my-tone.xmpkg my-tone.wav
./node_modules/.bin/xmp parity my-tone.xmpkg my-tone-parity
./node_modules/.bin/xmp conformance conformance-results
```

Use `new effect my-filter my-filter` for the effect template. Outputs must not already exist. `doctor` checks Node/platform/compiler without opening hardware. `parity` compiles only the SDK's fixed C sources, not code from the package, renders its default preview using the native processor and JavaScript reference, and compares the results. The Node CLI also retains the validated local package-store, bind, upgrade and rollback commands documented in the community SDK guide. No package is installed into a running Studio automatically.

The ESM API is available through `import { buildPackage, referenceParity, compareParity } from '@xmp/sdk'`. Type declarations cover the existing machine, sequencing and community package interfaces, plus the parity plan/result. `compatibility.json` identifies supported versions, limits and source hash. Core public contracts use semantic compatibility; changing an API/ABI or processing semantics requires a new negotiated version and migration policy, not an unannounced replacement. Until 1.0, use the exact SDK version and retain package hashes.

## What the parity runner proves

`conformance` exercises five named fixtures: sine/release, triangle/polyphony/expression/parameter changes, effect impulse, 33rd-voice refusal, and a swung note boundary. The timing fixture has an independent 7440-frame oracle at 120 BPM and 62% swing. Every event acknowledgement, event frame, final active-voice count and PCM frame is compared. One-frame event errors and wrong voice admission fail even if the sound is nearly identical. Non-finite, truncated or out-of-range audio is rejected.

Absolute PCM error must be at most 2e-6 and RMS error at most 2e-7. Those versioned tolerances cannot be relaxed through command flags. Both renderers produce mono machine output; preview WAVs duplicate it to stereo. This does not qualify stereo buses, the full synth/effects graph, a native musical sequencer, callback deadlines, physical latency or hardware drivers. Prepared event delivery and the independent musical oracle are checked separately from audio similarity.

The native renderer uses a bounded binary input protocol and a fixed-storage DSP processor. Validation, allocation, file I/O and compilation happen outside processing. It accepts local basenames only, rejects non-regular/symlink inputs and preserves existing output files. No hardware library, default audio output or device protocol is linked.

## Booted VM parity

```sh
npm run sdk:toolchain
npm run sdk:parity:vm
npm run bdd:sdk-supported
npm run bdd:sdk-supported:vm
```

The optional VM compiler is pinned Zig 0.13.0, downloaded from ziglang.org with exact archive sizes and SHA-256 values into ignored build storage. It cross-compiles only the owned native conformance renderer for generic x86_64 Linux/musl. The existing frozen QEMU profile boots a separate development image containing that binary; networking, host shares and USB passthrough remain disabled.

The VM suite renders the same five fixtures with both the JavaScript reference and actual compiled Linux native binary inside the guest. PCM comparisons execute inside the guest to keep serial responses bounded; guest reference PCM/event hashes must exactly match the host reference. The runner checks host-native PCM separately and checks image/source/binary identities and retaining boot logs and comparison reports under `reports/parity-vm`. A host-only run cannot stand in for this booted evidence. Public OS image redistribution and physical qualification remain pending.

The Gherkin contract is `features/19-supported-sdk.feature`. The manual-only CI workflow defines contributor/native checks on macOS and Linux and a separate booted-VM job; those lanes are not automatic qualification of a new candidate. No Force or MPC connection is needed or authorized.

## Implementation and acceptance steps

| Step | Deliverable                                                               | Gherkin coverage                                                                     |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| S01  | Self-contained distribution, doctor, compatibility and typed API          | Offline clean install; invalid version/target rejection                              |
| S02  | Contributor scaffold → build → test → preview → native parity             | Instrument and effect quickstarts; existing-output preservation                      |
| S03  | Compiled fixed-storage DSP, independent oracles and numerical comparisons | Five fixtures; one-frame, PCM and voice-state mismatch rejection                     |
| S04  | Current-source booted Linux reference/native execution                    | Fifteen comparisons, native binary/image identity and malformed guest-plan rejection |

Each host case is included in the existing macOS/Linux acceptance CI; the VM case has a separate job and is never counted as host-only evidence. Generated tarballs, compiler archives, guest images and personal audio are excluded from source control.
