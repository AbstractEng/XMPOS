# P05 Mac instruments, machines and recording

P05 implements the musician workflow on the Mac and in the standalone core renderer: playable sampler modes, non-destructive editing, a polyphonic subtractive synthesizer, explicit recording and internal master resampling. [Track machines](track-machines.md) provide the requested extensible audio/MIDI foundation. No Force or Live adapter exists. P04's formal loopback and full workload gates remain pending.

## Software scope decision: ADR-P05-001

The owner requested the next phase while leaving formal physical loopback pending. P05 development therefore depends on the passing P04 **software** contracts; this is not permission to mark the full P04 stage complete. P05 Mac software contracts can pass independently. OS-image, USB, native live instrument parity, physical monitoring/latency and full phase qualification remain separate pending gates. Canonical shared scenarios retain their OS/USB applicability; a host result cannot substitute for either.

## Play and edit

Open Studio's **Instruments & recording** section. Select a machine per track: sampler, subtractive synth, MIDI, or an original developer example. Built-in sampler modes are one-shot (note-off does not truncate the sound), gate, loop-until-release, and chromatic (linear-interpolated pitch relative to the root MIDI note). Set the first pad note and play strength, then hold a pad or a mapped computer key. Pads map to sixteen successive chromatic MIDI notes, starting at C3 (48) by default. Pointer/key release ends gated/looping voices; blur, stop and Panic clean up notes. Button/keyboard-accessibility activation provides a finite half-second audition.

Choke groups 1–8 release other voices in the shared kit group over five milliseconds. Group zero is independent. The built-in pool admits 32 simultaneous voices and refuses the newest excess voice deterministically. Normal sample release, track removal and panic use a five-millisecond fade; synth note-off follows its saved release envelope. Custom processors own their documented note/voice policy.

The waveform shows the original asset with the selected frame range. Trim/crop set a non-destructive playback window. Reverse and normalize operate on that window; normalization leaves silence as finite zero. Manual slice boundaries assign successive pads to ranges in the same asset. Original asset content is unchanged, and each action participates in Undo/Redo. Project sound selection reuses an existing asset. WAV import is now a bounded pure decoder and opens no AudioContext: mono/stereo PCM16/24/32 and float32 RIFF WAVs are supported, with stereo downmixed to mono. Compressed/unsupported WAV formats fail explicitly.

## Synth and playback

The subtractive machine provides sine and polyBLEP saw/square oscillators, a bounded two-pole low-pass tone filter and linear ADSR. Patches can be edited, exported and reopened.

Five later controls, all optional in a patch and automatable like the others, make the classic genre sounds possible. At their defaults the synth plays exactly as before, so older projects sound the same:

| Control                        | Range       | What it does                                                                          |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| Resonance (`resonance`)        | 0–1         | The filter rings at its cutoff (a resonant state-variable low-pass)                   |
| Filter envelope (`env-amount`) | 0–6 octaves | How far the cutoff opens at each note's attack; harder hits open it further (accents) |
| Filter decay (`env-decay`)     | 0.01–2 s    | How fast the filter envelope closes                                                   |
| Detune (`detune`)              | 0–50 cents  | A second oscillator above the first, for chorus, supersaws and Reese basses           |
| Glide (`glide`)                | 0–1 s       | Each note slides from the track's previous note (acid slides, portamento leads)       |

There are 32 original presets on four pages of eight (`synthPresets` in `packages/core/src/instrument-schema.ts`; the Live uses the same list from `native/include/xmp/synth_presets.hpp`, and `tests/synth-presets.test.ts` checks the two match):

- **Classic:** Warm bass, Soft key, Bright lead, Pluck, Soft pad, Sub bass, Organ, Brass (the original eight).
- **Pop & rock:** Pop piano, Electric piano, Rock organ, Power lead, Synth strings, Picked bass, Pop pluck, Ballad pad.
- **Electronic & dance:** Supersaw, Trance pluck, Reese bass, Big room lead, Chip lead, Synthwave bass, Arp synth, Dark pad.
- **House & acid:** Acid bass, Acid square, Acid squelch, Organ bass, Chord stab, Deep bass, Rave stab, Filter pad.

In Studio the preset menu groups them by page. On the Device and Live Sound pages, the top two rows of pads choose from the current page; − and + (or the page buttons in the browser, or touching the page line on the Live) turn the page. Step note and duration controls provide pitched sequencing; real-time note recording and detailed quantization remain P06 work.

The shared `VoiceRack` implements sampler and synth behavior for offline rendering and Studio's bundled AudioWorklet. UI scheduling retains the prototype's lookahead/stall behavior; the worklet consumes bounded note commands on audio sample frames and reserves direct off/panic handling. This browser JS engine is not evidence that the embedded C++ callback or its budgets now implement synths. The legacy C++ song/engine preparation path rejects advanced instrument projects rather than silently rendering them as one-shot drums. Existing sampler-only projects retain their native offline path and PCM regression checks.

## Record and resample

1. Choose **WAV test input** and a local WAV, or **Built-in MacBook microphone** in the local Mac development server.
2. Enable **Monitor input levels** and Arm. Arming validates a two-bar duration, source rate and remaining project budget; it opens no microphone stream. Monitoring is a peak meter, not audible microphone return to speakers.
3. Press Start recording. A WAV input is streamed through the real bounded take accumulator. A Mac input uses the native HAL helper and exact built-in microphone UID/transport checks. It opens no output stream, changes no default device, and never enumerates or opens an Akai.
4. Review the complete or interrupted take, then Keep take. No project is modified by recording alone. Download take preserves a captured result if the project changed meanwhile. Keeping it is one undoable edit; stale destinations are rejected.
5. Resample two bars of master captures sampler/synth output after master gain into a new asset on the selected pad. It runs without opening an audio device.

Two bars are eight beats at the tempo captured when arming. The current asset limit is ten seconds/480000 mono frames, and the project limit is two million frames. Slow tempos or insufficient space reject arming before recording. An input shorter than two bars produces an interrupted recoverable take. Input/storage faults retain a valid temporary take where frames exist; existing projects are not committed or overwritten by those faults. Native partial files remain under ignored, owner-only `reports/recordings` directories. No microphone recording is uploaded or committed.

The Mac endpoint exists only in the loopback Vite development server. It checks local host/remote address/origin, rejects arbitrary operations or file/device paths, limits requests to 512 bytes, allows one active capture and caps retained sessions at 16. The helper is built by `npm run native:test`. CI and non-Mac profiles refuse real capture. Production static bundles keep WAV-input recording and resampling but have no native microphone service. Packaging that host service into the standalone OS/application remains future work.

## Project format and verification

Project version 3 adds optional playback/edit descriptors, step note/duration and versioned track-machine state. Valid V1 and V2 inputs migrate without changing notes, timing or PCM; the original import is retained for recovery. Portable bundle version 1 continues to contain hash-verified deduplicated assets. Old clients may reject V3 explicitly; they are not expected to discard unknown machine state.

```sh
npm run bdd:step -- P05_1
npm run bdd:step -- P05_2
npm run bdd:step -- P05_3
npm run bdd:step -- P05_4
npm run bdd:p05
npm run check
npm run native:test
npm run bdd:implemented
npm run bdd:qualify:implemented
```

P05 Gherkin tests assert real generated PCM, octave pitch, velocity ratios, choke/note cleanup, immutable asset hashes, undo, deterministic synth recall, overload refusal, take ownership, interrupted recovery, saved project reopening and custom/MIDI machine behavior. Additional DOM/worklet/service tests exercise production handlers and device rejection without opening audio. Physical Mac recording is a separate optional target; it does not promote formal loopback or OS/USB qualification.
