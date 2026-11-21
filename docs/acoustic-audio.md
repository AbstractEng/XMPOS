# MacBook speaker and microphone acoustic check

This is an optional, local, six-second playback check using the MacBook's actual built-in speakers and microphone. It does not use the Force, another Akai, an interface, a virtual loopback driver, the browser's microphone API or a system default audio route. It leaves formal P04 loopback, latency, jitter, fidelity, sustained-load and device qualification pending.

## Run

```sh
npm run bdd:acoustic                   # Synthetic analysis and selection contracts; no device I/O
npm run audio:acoustic -- --inspect    # Build/test helper, inspect only the two fixed built-in identities
npm run audio:acoustic                # Actual local playback and microphone recording with Gherkin
```

The real run is Mac-only and refuses CI. macOS may ask for microphone access for XMP Acoustic Check or its responsible host application. Permission must be granted before either audio stream is opened. Denial or unavailable input produces an inconclusive result; it never starts speaker playback as a fallback. No permission bypass or automatic System Settings change is included.

The test uses the current built-in speaker level; it does not change the system volume, default devices, device rates or buffer settings. An inaudible/muted speaker or noisy environment can prevent verification. Microphone input is never monitored back to the speakers. Capture stops automatically, and all results stay in an ignored, owner-only `reports/acoustic/run-*` directory. `reports/acoustic/latest.json` identifies the latest attempt. Recordings may contain nearby room sound; they are not uploaded or committed.

## Signal and actual path

The fixed `macbook-acoustic-v1` profile creates eight original 120 ms sine-envelope samples at 540, 910, 1330, 720, 1090, 1690, 820 and 1490 Hz. A two-bar 120 BPM XMP project schedules them at steps 0, 3, 8, 10, 16, 21, 24 and 28. Master level limits the reference peak to 0.2; native input rejects references above 0.25. The source is original generated content, not vendor material.

The project uses the normal `prepareScene` contract and the actual C++ XMP sampler's offline song renderer to create a four-second stereo PCM16 reference at 48 kHz. A separate native HAL helper plays that prepared file through the built-in speakers while capturing the first built-in microphone channel. This verifies XMP-rendered audio through a physical Mac acoustic path. It does not verify the browser's live transport or a live C++ engine/IPC stream.

The helper directly resolves only `BuiltInSpeakerDevice` and `BuiltInMicrophoneDevice` through Core Audio UID translation. It does not enumerate external audio devices, query default devices, open generic port lists or inspect Akai devices. Both JS and native guards require built-in transport, live MacBook identity, the exact role/UID, bounded channel counts and a supported current rate. Identity and rate are checked again before initialization, before starting and after capture. There is no headphone, USB, Bluetooth, AirPlay, aggregate or virtual-device fallback.

Current device rates between 32 and 96 kHz are accepted without changing them. Reference PCM is resampled outside the output callback to the actual speaker rate. The microphone WAV records its actual input rate. Output and input callbacks use prepared buffers; filesystem writes and analysis occur after streams stop. Bounded capture has independent wall-clock timeouts. Callback errors, timestamp discontinuities, changed identity, incomplete capture or failed cleanup cannot yield a passing result.

## What passes

The detector uses 40 ms Hann windows with 5 ms hops and separate frequency projections for the eight known notes. The first quarter-second establishes an ambient baseline; output begins after at least half a second of received microphone frames. Detection requires coherent energy above the fixed minimum RMS, ten times the baseline band power and 15% of the observed band peak, with a sustained detection of at least 40 ms.

Every expected note must be detected in order. After removing a common alignment offset, note positions and successive intervals must each agree within 40 ms. That is a deliberately coarse musical smoke-test budget, frozen before the physical run. Silence, missing or reordered notes, a 120 ms delayed note, noise-only input, clipping, truncated capture and non-finite data have explicit failure/inconclusive contracts. This is not a general click, distortion or every-dropout detector.

The report retains the detected note frequencies and relative timing, peak level, callback counters, chosen built-in identities/rates, source/profile/helper/reference/capture hashes and outcome. The common alignment offset includes recording/start timing and acoustic effects. It is explicitly **not a latency measurement**. `latencyMs` and `jitterMs` remain null; `formalLoopbackQualified` and `physicalAudioQualified` remain false even on a pass. A physical pass cannot close P04's existing gates.

## Gherkin and CI separation

[The acoustic feature](../features/14-acoustic-audio.feature) has host-only contracts and a separate `@acoustic_mac` physical journey. `bdd:implemented` and `bdd:acoustic` exclude that physical tag. The actual run uses its own Cucumber profile and bindings, with JSON, JUnit, HTML, device metadata, a WAV and a measurement report under its owned session. The ordinary host-only lifecycle cannot label microphone work as zero-device-I/O evidence.

Synthetic cases remain synthetic input tests. Only the separate local command can run the real microphone journey. A record identifies its scope as MacBook acoustic playback; it cannot substitute for OS, USB or calibrated loopback evidence.

The native helper follows Apple's [HAL input procedure](https://developer.apple.com/library/archive/technotes/tn2091/), [built-in transport identity](https://developer.apple.com/documentation/coreaudio/kaudiodevicetransporttypebuiltin) and [microphone authorization API](https://developer.apple.com/documentation/avfoundation/avcapturedevice/requestaccess(for:completionhandler:)). Raw HAL is used rather than the voice-processing audio unit; room, speaker and microphone processing still prevent this test from certifying engine fidelity.
