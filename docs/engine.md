# XMP's engine in C++ and WebAssembly

Since 2026-11-12 the sound of every track in the browser comes from one C++
engine, [`native/include/xmp/rack.hpp`](../native/include/xmp/rack.hpp),
compiled to WebAssembly. It replaced the TypeScript voice rack that ran in the
audio worklet and in offline renders.

## What the engine does

- **Voices:** 32 voices across the tracks.
  - The **pad sampler** has one-shot, gate, loop and chromatic pads, choke groups, a 5 ms fast release and linear interpolation.
  - The **subtractive synth** has sine, and polyBLEP saw and square, oscillators; two one-pole low-pass stages; attack, decay and sustain; and a linear release.
  - **MIDI voices** have channels and are routed from MIDI tracks to the synth or sampler.
- **Parameters:** per-frame smoothing with a 10 ms time constant, including track gains, synth parameters, the master level and live automation.
- **The stereo mixer:** equal-power pan, two sends and two returns. Six original effects: EQ, filter (with a clock-synced step sequence), delay (optionally synced), reverb (a damped comb), distortion and compressor. It also handles the tempo map and the master meter.
- **The shared performance delay**, with per-track sends.
- **Limits:** at most 32 voices, 8 tracks, 16 pads and 4096 parameters. Notes beyond the voice pool are refused, never allocated.

The audio path never allocates, locks or does I/O. Buffers are prepared when a palette is configured.

## How it is built and loaded

- **Build:** `npm run engine:wasm` compiles [`native/src/rack_wasm.cpp`](../native/src/rack_wasm.cpp) with the pinned Zig compiler (`zig cc -target wasm32-wasi`, C library only, no C++ runtime). The result is about 62 KB.
- **Committed module:** the build writes `packages/core/src/generated/xmp-engine-wasm.ts`, the module as base64 plus the hashes of its sources and bytes. A test fails if the committed module is older than the C++.
- **Loading:** [`packages/core/src/engine.ts`](../packages/core/src/engine.ts) decodes and compiles the module once per realm (page, audio worklet or Node), and gives each rack its own instance and memory. The module's only import is the stub `random_get` that wasi-libc asks for at start-up.
- **The `VoiceRack` class** in [`instruments.ts`](../packages/core/src/instruments.ts) keeps its public interface:
  - it validates every command;
  - it maps track and parameter IDs to the engine's numbers;
  - it lays out pads, tracks, the mixer and the delay in the engine's memory;
  - it reads audio, meters and MIDI events back;
  - it runs locally bundled JavaScript machines from the SDK beside the engine. In mixer mode they are interleaved per frame; otherwise they render per block, as before.
- **The audio worklet** applies commands on their exact frame and has the engine render the runs between them.
- **Security policy:** the app allows `'wasm-unsafe-eval'` in `script-src`, which permits compiling WebAssembly and nothing more. This applies to the page, the Device app on the guest and the Live's Device server.

## How it is checked

- **Parity:** [`tests/engine-parity.test.ts`](../tests/engine-parity.test.ts) ran the same command scripts through the engine and through the original TypeScript rack until phase 9 part 5 retired it ([cpp-port.md](cpp-port.md)); it now checks the engine against fingerprints of what it produced while it matched ([`tests/golden.json`](../tests/golden.json)). The scripts cover:
  - every pad mode and choke;
  - all eight synth presets with automation;
  - MIDI routing and the emitted MIDI;
  - every effect, sync, sends, tempo changes and bypass;
  - the shared delay;
  - SDK machines with and without the mixer;
  - palette changes while voices sound;
  - voice-pool refusal.

  Audio must match to within 1e-5. The only differences are last-bit gaps between JavaScript's `Math` and the C library. Voice counts, refusals and MIDI must match exactly. Changing one constant by 0.025% fails five of the scenarios.
- **The existing suites** (311 unit tests and 187 acceptance scenarios) all run on the engine.
- **Native build:** [`native/tests/rack_test.cpp`](../native/tests/rack_test.cpp) builds the same header with the system compiler (`-Wall -Wextra -Wpedantic -Werror`), ready for the Live.
- **Speed:** in Chrome the engine renders 24 synth voices in about 0.21 s of CPU per second of audio. The TypeScript rack took about 0.8 s, so the engine is roughly 3.5× faster.

## The sequencer (2026-11-12)

The sequencer is the C++ port of `groovePosition`, `stepTime`, `notesInWindow`, `timeline`, `eventsAtStep` and `parameterFrame`: [`native/include/xmp/sequencer.hpp`](../native/include/xmp/sequencer.hpp), built as a second, 26 KB module from [`native/src/sequencer_wasm.cpp`](../native/src/sequencer_wasm.cpp).

- **What it decides:**
  - the notes each scene plays: clip cycles, step notes and sequence notes, microtiming, the seven conditions (including fill), and seeded note probability. The probability uses the same FNV hash over UTF-16 IDs as before, so every saved project plays exactly the same notes;
  - their order and their frames under swing;
  - every parameter's value at any position, from automation lanes, step locks, macro and LFO modulation, and live macro offsets.
- **The binding:** [`sequencer-engine.ts`](../packages/core/src/sequencer-engine.ts) lays the scene out for each query and maps the answers back to the project's objects. The public functions in `sequencer.ts` and `index.ts` keep their signatures and validation, so the scheduler, the performance transport, the offline renders, MIDI export and the Device app use the C++ sequencer unchanged.
- **One behaviour change:** notes that start at exactly the same position are now ordered by plain code-unit ID order instead of `localeCompare`. Locale collation can't be reproduced outside a JavaScript runtime, and it decided only which of two simultaneous notes is sent first.
- **Checks:**
  - [`tests/sequencer-parity.test.ts`](../tests/sequencer-parity.test.ts) compared the C++ sequencer with the original TypeScript on randomized projects (now with fingerprints recorded while they matched, [`tests/golden.json`](../tests/golden.json)). Note lists, order, frames, step events and parameter frames must match exactly; only the LFO's `sin` is allowed a 1e-12 tolerance.
  - Changing the every-4 condition, or macro depth by 0.01%, fails the test.
  - [`native/tests/sequencer_test.cpp`](../native/tests/sequencer_test.cpp) builds the same header natively with strict warnings.
- **Speed:** each query is about as fast as the TypeScript version. Most of the cost of `parameterFrame` is the TypeScript parameter registry both of them build.

## The performance transport (2026-11-12)

`PerformanceTransport` is the C++ port of the transport's state machine, [`native/include/xmp/transport.hpp`](../native/include/xmp/transport.hpp). It is built as a third, 8.8 KB module, with one instance per transport.

- **What it does:**
  - which scene and clips are playing, and each clip's anchor;
  - scene and clip launches quantized to the next bar, and cancelling them;
  - stop and its track releases;
  - song mode: a chain of occurrences with repeats, resume from a saved position, loop or stop at the end, and chain edits that take effect when the current occurrence ends;
  - tracks removed by a project edit.
- **IDs:** the binding numbers scene, track, clip and occurrence IDs for the transport's lifetime, so a transport keeps its state across project edits.
- **Same interface:** `slots`, `queuedClips`, `queuedScene`, `sceneId`, `running`, `mode`, `step`, `songOffset` and `clockOrigin` are now read from the C++ state. Snapshots and releases are unchanged. Live overrides (mutes, solos, macros) are kept in TypeScript, where `performanceControls` reads them.
- **Checks:**
  - [`tests/transport-parity.test.ts`](../tests/transport-parity.test.ts) drove the C++ transport and the original TypeScript (now fingerprints recorded while they matched) through random sequences of starts, launches, clip changes, stops, project and chain edits, and clock advances. It requires every observable field, result and error to be identical after each operation.
  - Breaking the loop offset or the clip quantization fails it.
  - [`native/tests/transport_test.cpp`](../native/tests/transport_test.cpp) builds the same header natively.
- **Freshness:** [`tests/wasm-modules.test.ts`](../tests/wasm-modules.test.ts) checks that all four committed modules match their C++ sources.

## The performance controls (2026-11-12)

`performanceControls` and the timing and note checks of `performanceWindow` are the C++ port in [`native/include/xmp/controls.hpp`](../native/include/xmp/controls.hpp). They are built as a fourth module of 7.5 KB from [`native/src/controls_wasm.cpp`](../native/src/controls_wasm.cpp), with one shared instance per page, worklet or Node process.

- **What it decides:**
  - mutes, solos and macro values at a song position, from the saved state, the recorded events up to that position and the live overrides;
  - each macro's offset on its parameters (clamped), and which assignments name a parameter that no longer exists;
  - which tracks are silenced, where a soloed MIDI source keeps its instrument audible and the other way round;
  - the window's tempo-map timing: start frame, clock tempo, and each note's swung frame and length.
- **The binding:** [`controls-engine.ts`](../packages/core/src/controls-engine.ts) lays out a project's controls once per call, or once per window for all its note checks; previously the window rebuilt the controls (and the parameter registry) for every note. Answers come back in JavaScript insertion order, so the returned objects are the same as before.
- **Still TypeScript here:** collecting the window's control positions and sorting its notes.
- **Checks:**
  - [`tests/controls-parity.test.ts`](../tests/controls-parity.test.ts) compared it with the original TypeScript (now fingerprints recorded while they matched) on random projects with MIDI routing, macros, events, overrides, tempo maps and swing: 1,500 control queries, and 1,152 windows with live mutes, all identical, key order included.
  - Breaking the macro offset by 0.01%, or the instrument-solo rule, fails it.
  - [`native/tests/controls_test.cpp`](../native/tests/controls_test.cpp) builds the same header natively.

## Parameter values during a performance (2026-11-12)

`performanceValues`, and the control changes in each window, now resolve parameters in C++.

- **How:**
  - The registry and every parameter's sources are laid out once per window, or once per `performanceValues` call, in the C++ sequencer.
  - At each position, the C++ controls give the macro offsets, and the sequencer resolves every parameter and then each playing clip's lanes, locks and modulation over the same table (`seq_parameter_frame_track`).
  - Previously, TypeScript resolved each parameter, and each position rebuilt the registry, the controls and a one-track project for every playing clip.
- **Same results:** a clip's automation sets its own track's parameters, plus master and return parameters its sequence names, exactly as before.
- **Still TypeScript:** the registry's definitions (IDs, names and defaults, which come from the machine definitions, including SDK machines) and each parameter's sources.
- **Checks:**
  - [`tests/values-parity.test.ts`](../tests/values-parity.test.ts) compares values and windows with the original on 30 random projects (mixes with inserts and returns, assigned sources, macros, clip launches, and sequences on own, master and return parameters): over 10,000 positions, all identical, key order included.
  - Dropping the clip automation, or its anchor, fails it.
  - The native sequencer test checks the one-clip-track frame.
- **Speed:** a window step on the demo project takes about 0.8 ms instead of 4.5 ms with the original TypeScript (about 5.8×), and `performanceValues` about 0.5 ms instead of 1.05 ms.

## The Live plays through the engine (2026-11-12)

The Live session's sound now comes from `rack.hpp`, the engine the browser runs as WebAssembly, built natively for the Live's ARM CPU. [`native/include/xmp/live_engine.hpp`](../native/include/xmp/live_engine.hpp) adapts it to the session. The Live's own `LiveSampler` and `Synth` classes are gone; their banks (`SampleBank`) and presets (`synth_presets`) remain.

- **Sounds:** every take of every velocity layer of the three kits, and of each sampler track's own WAVs, is one engine pad. Pads point at the session's banks: they are not copied or freed. Switching a kit or a track's type picks other pads, with no reconfiguration while playing.
- **Tracks:** each Live track is one engine track, the pad sampler for kit and sampler tracks or the subtractive synth for synth tracks.
- **Timing:** the main thread queues notes and changes with their start frame through a lock-free queue. The audio thread applies them on that frame and has the engine render the runs between them, as the browser's audio worklet does.
- **Decided as before by the session:** the velocity layer, the round-robin take, and the level (track level × velocity curve × pad trim, at the same loudness as before).
- **Decided as in the browser by the engine:** voices, choke groups, the synth and its release, and the 10 ms smoothed tone on sounding synth notes (smoothed only while it moves, to save CPU).
- **The engine for the Live:** `rack.hpp` is now a template on its pad and voice counts. The browser keeps 16 pads and 32 voices (`Rack`). The Live uses one pad per take (up to 11 banks × 16 pads × 64 takes) and 64 voices. Three small hooks used only by the Live: external pads, a track's instrument change, and releasing synth notes by pitch or on Stop.
- **Changes the owner may hear:**
  - choke groups fade in 5 ms instead of 2 ms;
  - a full voice pool refuses new notes, as in the browser, instead of cutting the oldest voice; it has 64 voices for all tracks together, where the Live previously had 32 sampler voices and 16 synth voices per track;
  - the tone knob glides over 10 ms instead of jumping;
  - changing a synth's preset glides sounding notes to the new tone.
- **Checks:**
  - [`native/tests/live_sampler_test.cpp`](../native/tests/live_sampler_test.cpp) runs through the engine and covers exact start frames, levels, layers and takes, choke, the bounded pool, bank switches, the synth, the tone knob, type changes and Stop. [`live_song_test.cpp`](../native/tests/live_song_test.cpp) checks synth timing and bounds.
  - [`tests/live-synth-parity.test.ts`](../tests/live-synth-parity.test.ts) renders each preset through the Live session's path, natively, and through the browser engine. Every preset matches.
  - The session image builds with the Live's ARM compiler (`-Wall -Wextra -Werror`), and `npm run live:session-vm` runs it on the Live-like emulator.

## Still TypeScript, and next

- **Still in `packages/core`:**
  - the parameter registry's definitions and sources, and assembling each window from the C++ sequencer and controls;
  - recording helpers (`NoteTake`, `NoteRepeat`, `AutomationTake`);
  - the project model and its editing functions.

  The Live has its own step sequencer (`live_sequencer.hpp`).
- **The 808 and 909 kits** are generated by a TypeScript port in the browser (`drum-machines.ts`) and by `live_kits.hpp` on the Live. They could be generated by the engine instead.
- **The TypeScript reference rack** can be retired once the engine has been in use for a while.
