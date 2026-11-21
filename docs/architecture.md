# Architecture through P09 Mac software

The first increment separates testable musical state from platform I/O. The Mac simulator, offline C++ ports and an independent native engine process run today. Physical audio and embedded qualification remain pending.

## Project contract

`packages/core` owns the version-5 `xmp-project` with validated version-1/2/3/4 migration contract. Tracks hold clips; clips contain pad events; scenes select clips by track ID. Each event stores step, velocity and probability. Pad assignments reference samples by stable IDs. The schema validates identity uniqueness, clip boundaries, reference integrity, amplitude ranges and resource limits.

Portable bundle version 1 separates sample descriptors from verified SHA-256 assets and deduplicates shared mono PCM. The 24 MiB import cap, structural preflight and one-million-frame audio budget bound this parser. See [format and recovery](project-format.md).

## Audio and transport

The simulator schedules sample-frame note commands into a bundled AudioWorklet against `AudioContext.currentTime`, with a 100 ms lookahead and a 25 ms scheduling poll. Its shared VoiceRack provides sampler, synth and machine processing; simple legacy playback has a buffer-source fallback when worklets are absent. Advanced machines explicitly require the worklet. Pure step-to-time math applies swing without cumulative drift. Probability is reproducible from event identity and loop position. The UI playhead follows scheduled audio time using animation frames.

Missed events after a UI stall are skipped and counted. Hidden tabs stop playback. These choices make a development preview observable, but do not establish hardware real-time performance. Tempo changes currently restart playback; swing queues at the next bar and retains the clock anchor. Scene launches occur at a sixteen-step bar and begin the selected clip from its first step.

The browser and offline WAV renderer share event/timing code. The separate C++ engine uses a fixed array of thirty-two voices and caller-owned audio buffers, with no allocation, locking, scripting or I/O in `trigger` and `process`. Samples must remain alive and use the host rate. The independent P04 host provides bounded timestamped command queues and prepared immutable project transfer; its development workload and software capture do not establish physical backend qualification. Browser and native sound behavior are not yet identical.

## Application development

The experimental TypeScript SDK validates module metadata, API version, parameter ranges and the small preview permission vocabulary. The example instrument maps simulated pad events to a host. The native gain header is an experimental C ABI example. There is no dynamic module installer, binary loader or untrusted code execution path.

The independent C++ host now exposes bounded versioned Unix-socket IPC, lock-free control queues, atomic snapshots and a sample clock that continues across client crashes. Its current endpoint is a paced software capture. Guarded host-backend ports and physical measurement tooling are separate; [the native engine specification](native-engine.md) records what was tested and which qualification gates remain pending. A module manifest by itself is not a security boundary.

## Hardware boundary

The browser exposes no USB/MIDI/HID/serial integration. Vite serves a Permissions-Policy denying those APIs as additional protection. The host's selected audio output still determines where browser sound plays.

The optional Python inventory reads the existing macOS USB registry or Linux USB sysfs metadata. It does not open device handles, inspect mounted volumes, send USB requests, or infer modification authorization from a product ID. There is no writable adapter to accidentally enable.

## Upstream references

The official inMusic G1 branch supplies published open-source component archives; it does not supply Akai's proprietary workstation application. openAZ0x's checked-out BSP still marks its MPC target unverified on hardware and uses a vendor kernel by default. Granola is a useful independent-application reference targeting MPC One. Historical Hakai code and MPC-LiveXplore are research inputs, not installation prerequisites for XMP desktop development.

All upstream checkouts are excluded from the production build and npm workspace. Never copy code solely because it is publicly readable: inspect the licence and the specific dependency chain first.

## Instrument interaction and future expression

[The design charter](instrument-design.md) links research to LD01–LD08 decisions. Musical swing conversion lives in `packages/core/src/groove.ts`; it maps the existing stored delay to a 50–75% pair ratio without altering `stepTime` or older projects. Exact triplets store `1/3`. Studio uses the same conversion for slider input, labels and presets.

Contextual help lives in the browser layer and receives DOM access only. It has no project-session or audio reference. Its nonmodal panel remembers a control for focus recovery, handles F1/Escape before performance shortcuts, and suppresses shortcuts originating inside the panel. Automated UI contracts use isolated DOM, mocked audio/storage and a failing audio-device constructor; real browser layout and hardware behavior need separate evidence.

Future P06 recording must preserve original timestamps and velocities separately from timing correction. Repeat scheduling and acknowledged swing transitions belong to the native sample clock, not UI timers. P09 expression events must carry stable note identity and negotiated optional dimensions; P11 adapters must measure which sensors actually exist. No project-v2 expression schema, MPE transport or hardware capability is implemented by this design update.

## Optional MacBook acoustic diagnostic

The built-in speaker/microphone [acoustic check](acoustic-audio.md) is a separate explicit native tool. It plays a bounded XMP offline reference through two specifically resolved built-in HAL devices and captures six seconds locally, with no default-device selection or input monitoring. Its physical Gherkin profile is excluded from host/CI execution. Studio's microphone denial policy remains in place; no browser capture permission or Akai adapter is added. Acoustic detection never qualifies latency or the P04 hardware gates.

## Track machines and P05 development

A track's optional machine envelope identifies an audio/MIDI base, stable type ID, supported state version and bounded JSON state. The common registry supplies capabilities, parameter metadata, defaults and trusted processor factories. Missing or incompatible types preserve their state without execution or a sound fallback. [Machine architecture](track-machines.md) documents the audio and virtual-MIDI examples and future native/VST/CV adapters.

The V3 core and worklet share the bounded built-in voice implementation; the existing C++ engine remains a separate P04 implementation. Legacy native preparation refuses advanced instrument projects, so old one-shot rendering is never misreported as synth/native parity. The local recording service uses the existing fixed-UID HAL helper in input-only mode. Its local-origin, request/session and frame bounds are independent of the browser's microphone policy, which remains denied. [P05 guide](instruments.md) records exact supported flows and pending deployment gates.

## P06 sequencing

Versioned clip sequences preserve raw takes while edits supply timing/variation, locks, modulation and hold-interpolated automation. The Studio scheduler and offline renderer share windowed timeline and parameter resolution functions. The worklet applies bounded timestamped note/control commands, gesture ownership and source resets. A production-worklet virtual capture checks PCM and applied event frames independently of a browser audio device. Native operation 12 applies a validated groove change at a bar without a clock or voice reset; the full native sequencer/automation port remains pending. [Detailed semantics](sequencing.md).

## P07 arrangement and performance

The pure PerformanceTransport owns occurrence identity, frozen active durations, launch intents and per-track anchors. Studio and offline rendering consume the same bounded performance windows. Timestamped owner release and gate commands protect note lifetime; the original bounded shared delay keeps return history independent of source gates. A separately captured real-browser viewport audit complements DOM focus/virtual-control tests, while deployed display/control journeys remain planned. [P07 scope and policies](performance.md).

## P08 stereo graph and exchange

Optional V6 mix state prepares a bounded stereo graph in `StereoMixer`; `VoiceRack` supplies separate track contributions from built-in and registered custom machines. The same graph executes in the bundled worklet and offline performance renderer. Global musical-time mapping schedules bar tempo changes, controls and rhythmic effect phase. MIDI file parsing and exchange are pure core functions; the only clock adapter is a named in-memory fixture. The atomic filesystem export sink is a host tool. Studio stages imports and preserves revision/selection ownership. See [the P08 contract](mixing-and-exchange.md); no new physical adapter or native/OS/USB qualification is implied.

## P09 community workbench

The SDK keeps API-1 compatibility and adds a separate API-2 manifest and DSP ABI-1 musical contract. Trusted local code interprets a bounded declarative oscillator/input/gain/filter graph; imported data never supplies executable callbacks. The bridge retains the P05 machine interface and adds negotiated, note-scoped expression. A community-project envelope binds the actual V6 project to exact package hashes and expression takes. The host store commits package/project snapshots together. A fixed child-process UI model has a bounded parameter broker and acknowledged-state restart; a separate fatal native callback fixture reports host failure without a sandbox claim. See [P09 usage and limits](community-sdk.md). A graphical installer, dynamic native/VST hosting and a deployed OS sandbox remain pending.
