# XMP: performance and efficiency audit (2026-11-15)

An audit of where XMP spends time, memory and disk: the C++ core and engine, the Live session, the browser, and the build and test loop. It lists findings in order of importance, each with what was measured, the cause and a fix. The audit itself changed no code; most findings were fixed the same day, and [what was fixed](#what-was-fixed-2026-11-15) lists each with its new measurement.

## How it was measured

- **Project:** Night Shift (`artifacts/demo/night-shift.xmpsong`): 6 tracks, 5 scenes, 16 samples, 58 parameters, a mix.
- **Machine:** this Mac (Intel i7-9750H), natively compiled at `-O2`, and Node for the browser's code. The Mac was busy with an emulator run (load average about 28), so times are CPU time used, not wall-clock, and are best read as relative sizes. They may be up to twice what an idle Mac would show.
- **The Live** has a much slower processor (a 32-bit ARM Cortex-A17). Nothing here was timed on the Live itself, which was switched off; where the Live matters, the finding says what to measure there.
- **Method:** small benchmark programs against the repository's own headers, and the macOS `sample` profiler for the two hot paths. A one-line trial fix was timed on a scratch copy of the headers.

## Summary

| #   | Finding                                                              | Measured                                                      | Where it hurts                         | Fix size |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- | -------- |
| 1   | Every playback step reloads every parameter, quadratically           | 36 ms per step natively; 28 ms in WebAssembly                 | Live timing headroom, browser, renders | Small    |
| 2   | Every browser edit rebuilds and re-sends all sounds to the worklet   | 220 ms per edit, for an edit that takes 1.8 ms                | Browser editing                        | Small    |
| 3   | A SOUND knob click re-checks the whole project                       | 15 ms per click; 4 ms to refresh the knob panel               | Live knob feel                         | Small    |
| 4   | The Live loads a sample folder at start that project mode never uses | 3.7 s of a 4.1 s start; about 74 MB                           | Live start-up, memory                  | Small    |
| 5   | Each save rewrites the whole song, samples included                  | 1.3 MB per save (137 ms on the Live)                          | Stick wear, larger projects            | Medium   |
| 6   | The Live reports no load figures                                     | None exist                                                    | Finding 1 cannot be confirmed on it    | Small    |
| 7   | The bridge sends screenshots and images uncompressed                 | 45 s per screenshot; 4.5 min per image                        | Test loop on the Live                  | Medium   |
| 8   | Per-sample maths in the engine that could be cached                  | Engine is about 3% of one core here                           | Live headroom with many voices         | Medium   |
| 9   | Test and build loop: long serial emulator runs, no clean-up          | About 65 min per emulator run; 11 GB of artifacts; 14 GB free | Development speed, the Docker hang     | Medium   |
| 10  | The browser's start-up bundle carries the core as text               | 1.45 MB chunk                                                 | First load                             | Small    |

What is already efficient is at the end.

## What was fixed (2026-11-15)

Measured the same way as the audit, on a less busy Mac (so compare each "before" taken at the same time, given here, not the audit's own figures).

| #   | Change                                                                                                                                                                        | Before                            | After                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | The parameter registry and each parameter's sources are prepared once per project (`Performance::prepared`), not for every step                                               | 36 ms per step                    | 0.5 to 0.7 ms per step                                                             |
| 1   | The same, for a 15.5 s render of Night Shift                                                                                                                                  | 7.1 s of CPU                      | 0.9 to 1.1 s (the engine)                                                          |
| 2   | The browser sends the worklet its sounds only when a sample or pad changed, and does not parse a checked project again                                                        | 77 ms per edit                    | 7.6 ms per edit                                                                    |
| 3   | A SOUND knob click writes its one value without re-checking the project; the panel builds the registry once                                                                   | 15 ms a click, 4.2 ms             | 0.25 ms a click, 0.3 ms                                                            |
| 4   | The Live opens the project first and reads the pattern mode's sample folders only when there is none                                                                          | 3.7 s of a 4.1 s start            | To be timed on the Live                                                            |
| 6   | The Live reports load: `audioLoad`, `audioWorstMs`, `stepMs`, `stepWorstMs`, `lateNotes`, `lateWorstMs` in the bridge's status, and a closing "load:" line in the session log | None existed                      | To be read on the Live                                                             |
| 7   | Screenshots are run-length encoded on the Live (an older bridge still answers with raw pixels)                                                                                | 4 MB, about 45 s                  | To be timed on the Live                                                            |
| 8   | The engine keeps each coefficient (`Kept` in `rack.hpp`) until its input changes; the sine is computed only for sine oscillators                                              | `exp`, `pow`, `sin` per sample    | Once per change; same output bits                                                  |
| 9   | `npm run engine:wasm` skips modules whose sources are unchanged; old emulator runs and images are pruned before each new one (`npm run live:prune`)                           | All five rebuilt; nothing removed | Only changed modules; the newest 3 runs and 4 images, pointers and cited runs kept |

- **In the browser (WebAssembly),** a step's window went from 9.6 ms to 3.3 ms at the same sitting; most of what is left is passing the project across to the core.
- **Checked by:** the native tests, the TypeScript tests with their recorded fingerprints (the engine's output is bit-identical), and the parity suite.
- **Fixed afterwards, the same day:**
  - **Finding 4, second half:** the audio thread no longer runs the pattern mode's engine while a project is open.
  - **Finding 5:** an edit that changes no sample is saved as `project.edits`: one line naming the `project.xmpsong` it belongs to, then the song without its audio. The whole `project.xmpsong` (what the browser opens) is written when a sample changes and when the session ends. At start `project.edits` is used only when it names the `project.xmpsong` that is there, so a song copied onto the stick is never overridden by older edits.
  - **Finding 7, images:** the Mac sends an image without its empty 4 KiB blocks (about 4 MB of 24 MB); the Live still checks the whole image's SHA-256 before it replaces the one on the stick.
  - **Finding 9:** `npm run live:session-vm -- --only project` (or `pads`, `seq`, `tracks`, `bridge`) boots only those sessions; such a run marks itself partial.
  - **Finding 10:** the core's bytes are imported when the core is loaded, so they are a chunk of their own (1.24 MB) fetched beside the start-up script; the largest start-up chunk went from 1.45 MB to 224 KB.
- **Not done:**
  - **Finding 1's last step:** the evaluator is still built per step (0.5 ms); keeping it between steps is no longer urgent.
  - **Finding 4:** the pattern mode's engine and its three synthesized kits are still prepared at start (only its processing is skipped).
  - **Finding 10:** the core is still carried as base64 text, not a `.wasm` file compiled while it downloads.
- **Checked on the Live (2026-11-16, build `fc63e4f`):**
  - **Start-up:** the session is ready **0.74–0.89 s** after it starts, down from 4.2 s; the project opens at 0.73–0.81 s.
  - **Load while playing Night Shift:** audio load 0.18, worst audio block 0.97 ms, step 1.07 ms (worst 4.63 ms), no late notes, no xruns; output peak −12.6 dBFS, as before.
  - **Screenshots:** about **15 s** each with RLE, down from about 45 s.
  - **Regression pass** (`tools/live-mk1/live-regression.mjs`, no sampling): 21 of 21 on the second run. The first run, the first playback after a cold boot, recorded 4 s of silence while playing; it did not repeat after a session restart (first and second playback both at −12.6 dBFS). Not explained yet.
  - **Split save:** an edit writes `project.edits` (29–32 KB in about 50 ms); the session end writes the whole song, and the next start refuses the now stale `project.edits` ("from an earlier save"). When the whole song comes out byte-identical (an edit undone), the old `project.edits` still matches and is applied, which gives the same song.
  - **Not yet checked:** the image push time (no push since the stick copy).

## 1. Every playback step reloads every parameter (the largest finding)

- **Measured:** one step's window (`play::performance_window` plus its commands) takes **36 ms** natively for Night Shift, worst 42 ms. Through WebAssembly in Node it takes 28 ms. Rendering 15.5 s of Night Shift takes 7.1 s of CPU, and the profiler puts **88% of that in this path**; the sound engine itself is about 7%.
- **Cause:** `performance_window` builds a new `Evaluator` for every step (`performance.hpp:642`). Its `load` calls `load_parameters` (`play.hpp:251`), which calls `parameters::sources` once per parameter, and `sources` rebuilds the whole parameter registry each time (`parameters.hpp:145`). That is 58 registries of 58 entries per step, each made of freshly allocated strings: the profile is mostly `malloc`, `free` and string appends.
- **Why it matters:**
  - **The Live:** the player calls this once per step on the main thread (`live_player.hpp:318`), 100 ms ahead of the audio. A step at 124 BPM lasts 121 ms. The recording taken from the Live on 2026-11-15 shows notes on the 121 ms grid over four seconds, so it keeps up with Night Shift today, but by an unknown margin, and the cost grows with the square of the parameter count: eight tracks with effects would be several times dearer. If the main thread falls behind, notes play late without any message (finding 6).
  - **The browser:** this is the cause of the "Faster playback windows in WebAssembly" to-do in [future.md](future.md).
  - **Offline renders and exports** take about half of real time, nearly all of it here.
- **Fix:**
  - **First step, trialled:** pass the registry that `load_parameters` already holds into `sources`. One line each in `parameters.hpp` and `play.hpp` took the step from 36 ms to **7.2 ms** (five times faster), with the same results.
  - **Full fix:** keep the `Evaluator` (the loaded parameter table) between steps and reload it only when the project, the playing clips or the controls change. What is left after the first step is still this reload (`machine_parameter` and `Registry::get` building strings), so the full fix should bring a step well under a millisecond.
  - The existing parity and fingerprint tests cover this path, so either change is checked by them.

## 2. Every browser edit rebuilds and re-sends all sounds to the audio worklet

- **Measured:** `prepareInstruments` on Night Shift takes **220 ms**; 157 ms of that is `ProjectSchema.parse` checking the whole project again, sample by sample. The edit that triggered it (a step toggle through the core) takes 1.8 ms.
- **Cause:** `StudioAudio` posts `prepareInstruments(project)` to the worklet on every project change (`apps/studio/src/audio.ts:238`), whatever changed. The palette holds every pad's audio, so each edit also copies all sample audio across to the worklet. The code already knows whether the samples changed (`samplesChanged`, used on the line before) but does not use it for the palette.
- **Fix:** send the pads' audio only when a sample or a pad changed; otherwise send only tracks, gains and parameters. Drop the `ProjectSchema.parse` inside `prepareInstruments` for projects that came from the core, which are already checked.

## 3. A SOUND knob click re-checks the whole project (new on 2026-11-15)

- **Measured:** one click of a SOUND knob (`live_edit.hpp` `sound_knob`) takes **15 ms** natively, where a TRACK level click takes under 0.01 ms. Refreshing the knob panel on the SOUND page takes 4.2 ms, against 0.004 ms for the TRACK page.
- **Cause:** `sound_knob` goes through `parameters::set_parameter`, which validates the whole project and builds registries; the panel refresh calls `sound_knob` four times, each building the registry. A turn of a knob is many clicks, so on the Live this will feel slow and can starve the player of main-thread time while music plays (finding 1 shares that thread).
- **Fix:** build the track's sound parameters once per panel refresh; for a turn, write the one assignment directly (as `track_knob` writes level and pan) and validate once when the turn ends, or apply at most one change per screen frame.

## 4. The Live loads a sample folder at start that project mode never uses

- **Measured (session-015 on the Live):** the session is ready at 4.1 s; **3.7 s** of that is "samples: track 3, 169 files on 16 pads, 386.8 s", loaded before the project is opened. 387 seconds of mono audio is about 74 MB as 32-bit samples.
- **Cause:** the older pattern mode's sample folder is read whenever it exists on the stick, and its engine is prepared, even when a project is found and the pattern mode is never shown. Both engines then run in every audio block (`live_session.cpp:298`).
- **Fix:** open the project first; load the pattern mode's folder and prepare its engine only when there is no project. The Live would then be ready in well under a second.

## 5. Each save rewrites the whole song, samples included

- **Measured:** every save writes the full 1.34 MB song (137 ms on the Live, on a background thread), two seconds after an edit, even when only a step changed. The samples are most of the file and almost never change.
- **Why it matters:** wear on the owner's stick, and it grows with per-track kits and recorded samples (the format now allows 128).
- **Fix:** save the project and its samples apart on the stick: the song file with references (the format's "referenced" mode, which the browser already reads and writes) plus one file per sample, written only when that sample is new.

## 6. The Live reports no load figures

- **Found:** the bridge's status has no measure of load. Its `cpu` field is the processor core the audio thread is pinned to, not a load. Nothing records how long a step's window takes, how full the command queue is, or whether a command reached the audio thread after its frame was due (a late note).
- **Fix:** count late commands in `ProjectSound`, time each `fill`, and measure the audio thread's time per block; report them in `status` and at the end of the session log. That turns finding 1 into a number on the Live and guards it afterwards. The on-device regression pass (`tools/live-mk1/live-regression.mjs`) can then fail on late notes.

## 7. The bridge sends screenshots and images uncompressed

- **Measured over the FTDI cable (921600 baud, about 92 KB/s):** a screenshot is 4 MB of raw pixels and takes about 45 s; pushing a 24 MB session image takes 4.5 minutes.
- **Fix, in order of value:**
  - Run-length encode the screenshot on the Live: the interface is flat colours, so it should shrink twentyfold or more with a few lines of C.
  - Send the image without its empty space: the image is a fixed 24 MB file system, mostly zeros. Run-length encoding zeros, or sending only blocks that differ from the image already on the stick, would cut most of it.
  - Try a higher speed: the cable's chips support up to 3 megabaud.

## 8. Per-sample maths in the engine that could be cached

- **Found in `rack.hpp`:**
  - each synth voice computes `exp` for its filter coefficient on every sample (line 735), and `sin` even for saw and square waves, where the result is then replaced (line 729);
  - each effect computes `exp` for its bypass smoothing on every sample (line 120), and filters, equalisers and compressors call `pow`, `exp` and `log10` per sample;
  - each mixer strip computes `cos` and `sin` of its pan per sample (line 201);
  - each voice looks its track up by a linear search per sample (`index_of`).
- **Measured:** the engine is small here, about 3% of one core for Night Shift. It will be a larger share on the Live, and it grows with voices and effects.
- **Fix:** keep each coefficient and recompute it only when its input changes (the cutoff, the pan, the knob value). The same arithmetic gives the same bits, so the recorded fingerprints still apply. Worth doing after finding 6 shows the audio thread's real load on the Live.

## 9. The test and build loop

- **Measured:**
  - An emulator run takes about 65 minutes: five sessions in a row, the project session alone up to 40 minutes. It cannot share the Mac with another run.
  - A session image build recompiles everything each time (3 to 5 minutes).
  - `npm run engine:wasm` rebuilds all five modules, though each module's source hash is already known.
  - Nothing is cleaned up: each emulator run keeps about 0.6 GB. `artifacts/` was 25 GB this morning, was cut to 9 GB by hand, and is 11 GB again; `reports/` is 1.7 GB; Docker's data is 5.5 GB. The disk has 14 GB free, and Docker stopped responding today at 1.7 GB free.
- **Fix:**
  - Let the emulator script run one named session (most changes touch only the project session), and keep the full run for merges.
  - Keep only the last few runs and images automatically (and the ones the docs cite).
  - Skip WebAssembly modules whose source hash has not changed.
  - Now that the bridge works over the cable, use the on-device pass (about 10 minutes) for interface changes, and the emulator for what the Live cannot show.

## 10. The browser's start-up bundle

- **Measured:** the largest script chunk is 1.45 MB, mostly the project core's WebAssembly (0.9 MB) carried as base64 text and decoded at start; the worklet's bundle is 226 KB.
- **Fix:** ship the core as a `.wasm` file compiled while it downloads, or load it after the first paint. Small gain; do it with other browser start-up work.

## Smaller notes

- **`parameters::sources`, `value` and `registry` each rebuild the registry** (0.5 ms for Night Shift). Besides finding 1, anything that asks for several parameters pays this each time. A registry passed in, or kept per project, fixes the family.
- **A full check of a project** (`project::canonical`) takes 11.7 ms here for Night Shift. It runs after structural edits on the Live (keeping a sample, capturing a song, a preset), which is fine for one-off edits, but should stay out of anything repeated per click or per step.
- **A full repaint of the Live's screen** takes 44 ms here, so likely over 100 ms on the Live, once per page change. Per-frame drawing is cheap (below).

## What is already efficient

- **Edits through the core:** 0.03 ms natively and 1.8 ms through WebAssembly for a step toggle on Night Shift, because documents share their unchanged parts.
- **Opening and saving:** 212 ms to open and 106 ms to save the song here.
- **The Live's drawing:** 0.02 ms for a frame where nothing changed and 0.8 ms per frame while playing, since only changed regions are redrawn.
- **The audio thread:** it does not allocate, lock or touch files, and the owner's 15-minute session on the Live had no dropouts.
- **The Live's interface model:** rebuilding the board after an edit takes 0.04 ms.

## Suggested order

1. Finding 1's first step (two lines), then finding 6 so the Live can report its own numbers.
2. Findings 3 and 4, which the owner will feel directly on the Live.
3. Finding 2 for the browser, then finding 1's full fix (which also closes the playback to-do).
4. Findings 9 and 7 to shorten the test loop, then 5, 8 and 10.
