# Current project format: version 8

Version 8 lets a pad be multi-sampled: velocity layers of round-robin takes (`pads[].layers`, see [multi-sampled pads](drum-kits.md#multi-sampled-pads-project-format-8)). Version 7 gave a track its own kit of 16 pads. Versions 1–7 open unchanged and sound the same. Both cores (`packages/core/src/index.ts` and `native/include/xmp/project.hpp`) check and migrate every version; `tests/parity/project-parity.test.ts` runs both.

Version 8 now also has an optional, bounded `extensions` area for independently
versioned features. New additive features belong there rather than incrementing
the whole project version. Readers implementing this contract preserve unknown
optional extensions through load, edit, undo/redo and save. Unknown required
extensions fail before the current song changes. See the normative
[extension and compatibility contract](song-files.md#forward-compatible-features).
Existing files without extensions keep their existing representation.

# Current song interchange: bundle version 2

The current download format is `.xmpsong`: version-2 `xmp-bundle` files with optional sample packaging, compact lossless PCM, metadata/audio checksums, and content-based local sample resolution. Browser and Linux Device builds share the implementation. The internal musical model is **project schema version 8**. Legacy `.xmp.json` bundles and raw project JSON remain readable; Save legacy copy writes version 1. See the [current format, workflows and limits](song-files.md).

The sections below record earlier milestones. Their bundle-version-1 description applies to legacy exports and internal recovery snapshots.

# Historical project format: V5 performance

Current V6 adds optional version-1 `mix` state (stereo strips, two insert slots, two send returns and bar tempo map), with up to 512 bounded parameter assignments. Valid V1–V5 projects migrate without enabling a new mix or changing notes/PCM. [P08 semantics and limits](mixing-and-exchange.md). Portable bundle version 1 is unchanged.

V5 adds optional version-1 `performance` state: stable scene occurrences/repeats, end policy, resume offset and clip selection, scoped macros, mute/solo and recorded control events, and bounded preview delay sends. Valid V1–V4 projects migrate without changing their musical content; portable bundle version 1 remains unchanged. [P07 semantics, limits and pending deployment gates](performance.md). Earlier descriptions below are historical.

# Historical project format: V4 sequencing

V4 adds optional version-1 `sequence` objects to clips: stable-ID polyphonic notes with original take metadata, fractional timing, bounded microtiming, probability/conditions, locks, normalized automation lanes and modulation sources. Valid V1–V3 projects migrate with their musical data and original import text intact. Portable bundle version 1 and asset hashing remain unchanged. [P06 limits, semantics and verification](sequencing.md). Earlier format descriptions below are historical.

# Historical project format: V3 instruments and machines

V3 migrates valid V1/V2 projects while preserving their timing, notes, asset PCM and original import text. New optional fields are pad `playback` (mode/root note/choke group), pad `edit` (reverse/normalize), step `note`/`duration`, and track `machine` (id/base/version/bounded state). Omission preserves legacy behavior. Known built-ins validate their state; unavailable IDs/versions/base types retain opaque state and produce silence. Portable bundle version 1 and SHA-256 asset hashing remain unchanged. [Instrument details](instruments.md) and [machine contracts](track-machines.md).

The V2 specification below records the foundation retained by V3; older clients should reject V3 rather than discard new state.

# Project format and recovery

P03's Mac implementation uses project format 2, bundle format 1 and parameter registry version 1. Version-1 JSON remains readable. Migration validates the old schema, preserves track/clip/scene/sample IDs and musical events, and adds seed 0 and empty parameter assignments. Seed 0 retains the original probability keys. Opening records the unchanged original text for recovery. Unsupported versions and broken references fail before session replacement; a concurrent edit also cancels an asynchronous import.

Projects support eight independent tracks, sixteen scenes, sixteen shared pads, up to sixteen clips per track and the original clip lengths (16/32/64). Track/scene selectors expose these lanes in Studio. New sessions have all lanes; **Add tracks & scenes** expands an older session through an undoable edit. Existing notes remain intact. Clip IDs are scoped by their track, matching version 1. Silent scene slots are valid and can receive a pattern through **Create pattern**. This remains a shared sample rack; independent sample racks per track are outside this increment.

Current sampler additions use two versioned capabilities, without changing the
core version: `xmp.extended-samples` v1 is required for larger audio pools;
`xmp.sampler-input` v1 stores optional per-track monitoring and take length.
The extended limits are 1,536,000 frames per sample, 8,000,000 total frames and
96 MiB per portable song. The original limits continue to apply without that
profile. See [song files](song-files.md) for the complete compatibility contract.

## Parameter identities

`master.gain`, `track.<track-id>.gain` and `track.<track-id>.effect.gain` have stable IDs and normalized ranges 0–1. The effect slot is a gain prototype, with 0.5 representing unity. Track and master base assignments must agree with their model fields; commands keep both consistent. Unknown IDs, duplicate assignments, invalid ranges and non-finite sources fail validation before processing.

Resolution replaces the base with automation, replaces that with an active step lock, adds macro and LFO offsets, then clamps to 0–1. Offsets range from -1 to 1. Releasing the lock exposes automation again. TypeScript resolves UI values and prepared events; the independent C++ resolver is checked numerically against the same contract. These are static source assignments and an explicit lock-release API. The registry declares a 10 ms one-pole smoothing time constant. Matching TypeScript/C++ block-advance functions validate their inputs and produce block-size-independent exponential transitions; the browser master uses this registry value. Resolution reports the target before smoothing. Timeline automation and lock duration remain P06 work; continuous per-voice modulation and full native host integration remain later engine work.

## Portable samples

`exportPortable` writes one JSON `xmp-bundle` containing a validated project descriptor and content-addressed assets. A descriptor retains sample ID/name and refers to an `assetHash`; it contains no PCM or filesystem path. Assets contain sample rate and mono PCM. Identical content at the same rate is stored once, even when sample IDs differ. Pads can share a sample and carry independent start-inclusive/end-exclusive slice ranges. Slicing preserves source content.

A `sha256-<64 hex digits>` ID hashes a canonical binary sequence: sample rate as uint32 little endian, frame count as uint32 little endian, then finite mono amplitudes as float64 little endian. Negative zero is normalized to zero. This preserves the existing JSON sample values exactly. Every imported asset hash is recomputed. Duplicate hashes, missing/unreferenced assets and malformed descriptors fail before commit. No archive extraction or path resolution occurs.

The import profile permits 24 MiB of UTF-8 JSON, sixteen assets, 480000 frames per asset and one million total embedded frames. Shape preflight runs before JSON parsing: nesting ≤32, object count ≤150000, array count ≤1024, separators ≤2000000, properties ≤800000, raw strings ≤1024 characters and bare tokens ≤128 characters. Runtime validation then checks exact fields, references, event counts and sample values. This bounds parser/schema amplification and canonical audio allocations. Mac hostile-import acceptance fixtures run in a child process with a 256 MiB V8 heap and a measured 512 MiB peak-RSS ceiling. That measurement describes these fixtures; it is not an embedded memory qualification or a browser heap limit.

## Saves and history

`ProjectSession` owns immutable validated state, a twenty-entry undo/redo history, original import text, dirty status and serialized save requests. A failed save keeps edits and history. Completing an older save never marks newer edits saved. Reopening/importing validates the entire candidate before changing state.

Browser saves prepare the portable package first, then update the current and previous slots in one IndexedDB transaction. A compare check rejects stale tabs rather than overwriting another tab's commit. Loading validates current state and falls back to a validated previous snapshot; damaged storage is retained until a subsequent successful save. A quota/abort error remains actionable and unsaved.

The Mac acceptance file port writes and syncs a pending package, validates it, retains the previous committed package, atomically renames the new commit and syncs the directory. An interrupted child process leaves the old commit available; incomplete pending files never become a project. This tests a process interruption, not power-loss durability on Akai storage. No device filesystem is used.

## Offline interoperability

The stage journey exports a deterministic eight-track/sixteen-scene song, reopens it in an independent Node process and empty Mac directory, prepares its events, and invokes the C++ sampler executable. The native binary hash is recorded. An independent frozen oracle checks nine event positions and every stereo PCM frame, with a two-unit PCM16 tolerance. Probability uses seed 73019; the extra half-probability note at frame 72000 has independently calculated FNV-1a value 0.10757778701372445 and plays.

The core offline port linearly prepares samples at 48 kHz, applies slices and resolved gains, and mixes up to thirty-two bounded voices. The native prepared-song protocol accepts at most sixteen prepared samples, one million frames, 8192 scene events and 2100000 output frames. All buffers and file operations are prepared outside sampler callbacks. It is an offline library adapter, not a native application host or OS image. Browser real-time scheduling still uses Web Audio and its limiter; the offline parity result does not measure browser/device latency.

Run `npm run bdd:step -- P03_1` through `P03_4` for individual substeps, `npm run bdd:p03` for the nine P03 scenarios, or `npm run bdd:implemented` followed by `npm run bdd:qualify:implemented` for current-build Mac gates through P03. The native tools must first be built with `npm run native:test`. OS-VM and USB applicability remains in the shared Gherkin tags, and those deployment qualifications remain pending. All development and evidence capture stay on the Mac; the Force is protected.

P09 keeps core V6 unchanged. The separate `xmp-community-project` version-1 envelope wraps that actual project with per-track package ID/version/hash bindings and expression takes. This workbench format is validated against installed data packages; it is not the ordinary Studio portable-project format. [Community project contract](community-sdk.md).
