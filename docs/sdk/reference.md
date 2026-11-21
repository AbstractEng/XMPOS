# SDK API and runtime contract

Use the ESM exports from `@xmp/sdk`; its `types/sdk/src/index.d.ts` and linked declaration files are the complete typed export inventory. This chapter describes the supported extension surfaces and their ownership rules. For exact manifest/graph schemas and transaction semantics, see the [community reference](../community-sdk.md).

## Package API

- `CommunityManifest.parse(input)` checks the API-2 module identity, version, parameters, capabilities and dependency metadata. `ModuleManifest` is the older API-1 teaching contract; it is not a replacement for API-2 package negotiation.
- `negotiateModule(manifest, profile?)` accepts only supported declared capabilities and adapters. The default portable development profile permits `declarative-v1`, with no physical access.
- `ProgramSchema.parse(input)` validates a graph's shape; `validateProgram(manifest, program)` also validates its bindings, kind and migrations. `validateState` requires exactly the declared parameter set and values within bounds; `migrateState` applies explicit consecutive rename migrations and fills new defaults.
- `await buildPackage(manifest, program, licenseText)` validates the module, graph, dependencies and licence and returns the bounded data archive. `await parsePackage(text)` / `await validatePackage(input)` verify it before use. No received code executes.
- `parameterDocumentation(manifest)` produces the parameter table shipped by the CLI. Retain stable IDs and units across compatible versions.

## Offline sound and parity

- `renderCommunity(manifest, program, state, events, seconds)` returns mono float PCM from the trusted interpreter. The preview WAV duplicates that mono stream to stereo; it is not a stereo-bus conformance claim.
- `await packagePlan(package)` produces the bounded fixed-processor conformance plan. `referenceParity(plan)` returns PCM, event acknowledgements and active-voice state. `compareParity(reference, native)` compares them under the immutable tolerances in `parityScope`.
- `xmp parity package.xmpkg new-report-directory` builds only SDK-owned C source and compares the native render with the reference. `xmp conformance new-report-directory` exercises five independent fixtures. The output directory must not exist. Inspect `passed` plus event and voice comparisons; similar audio alone is insufficient.
- The native profile is 48 kHz, up to 48,000 render frames, 256 prepared events and 32 voices. The broader interpreter preview is bounded separately by the community contract. Do not infer supported hardware/real-time rates from offline renders.

## Instruments and host lifecycle

`communityMachine(manifest, program)` adapts a validated instrument to the exported `MachineDefinition` / `MachineProcessor` contracts. Trusted source-built hosts may register it with `MachineRegistry`. This does not install it into a running app or native Live session automatically.

The host negotiates capabilities and prepares state/buffers before processing, supplies stable note IDs and ordered note/control events, processes into caller-owned buffers and calls panic when stopping or losing the controlling client. Consult the bundled type declarations for method signatures. Native processing must never allocate, lock, perform file/network I/O or invoke a scripting runtime. The offline JavaScript interpreter is a development reference, not permission to invoke JavaScript on the Live audio thread.

Per-note expression uses `pressure`/`timbre` in 0–1 and pitch in −48…+48 semitones. IDs are positive integers, scoped to a take. Negotiation must confirm both source and instrument support before expression delivery. Unsupported expression is refused, not silently converted into hardware capability. Voice admission refuses the 33rd simultaneous voice; panic releases instrument voices within 5 ms and clears effect filter state.

## Sequencing and project workflows

The SDK exports typed helpers such as `NoteTake`, `AutomationTake`, `NoteRepeat`, `appendNotes`, `quantizeNotes`, `duplicateClip`, `editChain`, `PerformanceTransport`, `performanceWindow` and MIDI destination helpers. These operate on validated project data and musical time; they do not open physical ports. Their declarations specify arguments and return types. Whole-app UI/storage integration requires a source checkout.

`bindCommunity`, `CommunityProjectSchema` and related project helpers retain the core project with exact package ID/version/hash bindings and expression takes. The CLI's store commands commit package and bound-project state together, with generation checks, atomic replacement and rollback. An ordinary `.xmpsong` does not itself carry every SDK workbench binding. See the [community reference](../community-sdk.md) before exchanging store/project data.

`compatibility.json` declares the supported project version, matching the project emitted by the current store/bind path. Module API 2 and DSP ABI 1 are separate version dimensions. Keep exact pre-1.0 SDK/package hashes. Changes to IDs, units, ranges, processing semantics, API or ABI require the matching compatibility/migration policy and tests; editing metadata alone cannot make old data compatible.

## Errors and limits

CLI commands return structured JSON on success and a nonzero status on invalid input or execution failure. ESM validators/builders throw or reject. Handle errors at the UI/control boundary; preserve the previous valid musical state. New output files/directories are exclusive and never silently replace existing work.

Examples of expected refusals: unsupported API/adapter, undeclared graph binding, wrong dependency hash, unknown/colliding state parameter, missing migration, non-finite value, oversized archive, bad integrity hash, incompatible project binding and existing output destination. Display a useful explanation instead of enabling a fallback device or executing received code.

Manifest limits include 16 parameters, 8 declared dependencies and bounded identifiers; packages accept four prescribed entries within 1 MiB. The community reference specifies per-event and processing bounds. A hash proves integrity against the compared value; it is not a publisher signature or malware review. Imported native/VST/CV modules, arbitrary UI modules and device adapters are unavailable in this profile.
