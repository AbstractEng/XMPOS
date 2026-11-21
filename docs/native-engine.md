# P04 native engine and software qualification

P04.1–P04.3 run on the Mac. P04.4 has compiled backend ports, selection guards, safe-state and measurement tooling; physical integration and qualification remain pending. The owner explicitly chose to finish software tests without a spare loopback interface. The Force is never used.

## Development profile decision: ADR-P04-001

The final V1 workload specifies sampled and subtractive-synth tracks, insert effects, delay/reverb, physical timing and an eight-hour soak. Those musical processors belong to later phases and are not implemented by this increment. The original V1 stage journey and two physical P04.4 scenarios remain `@planned`. They have not been replaced with mocks or marked passing.

The separately versioned `p04-mac-development-v1` profile exercises eight gain buses, four prepared looping sample voices per bus, a master bus and clipping, at 48 kHz and 256-frame blocks. Voice capacity is 32. Its callback p99 budget is 80% of a block duration. A paced software endpoint captures the actual C++ output into WAV; it is not a physical audio device. Callback maximum duration and overruns are retained, including outliers; software pacing does not prove an OS or device deadline guarantee or analog latency. This profile does not satisfy V1 workload, soak, OS or hardware qualification.

Ten executable P04 software scenarios cover the six original P04.1–P04.3 contracts and four explicitly separate development contracts. `bdd:qualify:implemented` reports their software status while leaving `P04.complete`, `phaseQualified` and `physicalAudioQualified` false. `bdd:qualify:p04` intentionally exits unsuccessfully while the original qualification gates remain pending.

## Engine and sample ownership

`native/src/engine.cpp` contains the entire callback graph: fixed voice slots, eight stack-sized mix buses, sample-clock progression, bounded scheduling arrays and lock-free queues. Immutable graph/sample storage is prepared before processing and owned by the host until its audio thread has joined. Samples are never freed or replaced by a callback. Output is finite stereo in -1..1. The 33rd simultaneous voice is refused deterministically; existing voices continue. Refusal has its own trace/counter and control response.

Dropped trace/acknowledgement telemetry is counted and blocks a clean software run. There are 64 normal commands, 16 critical commands, 64 scheduled normal commands and 16 future critical commands. Producer/consumer ownership is explicit. Atomic index and snapshot types must be lock-free on the compiled target. Full queues reject the newest command. Transport start, note-offs and stop have a reserved lane; transport-generated note-offs do not depend on UI traffic. Stop and backend loss release each active note once, cancel queued future work and retain the immutable project. Reconnect requires the active 48 kHz/256-frame profile, followed by an explicit resume.

Callback audit scopes count allocation, deallocation, mutex-lock, file and network calls. The Mac audit is linked only into these development executables and uses dyld interposition; no environment injection or system security setting is changed. Deliberate canaries perform real malloc/free, mutex, temporary-file and local socket operations and must be observed before zero counts are accepted. Linux uses linker wrappers for calls in the linked application and its C++ allocation entry points; Linux execution has not been verified locally. Hooks cover the listed APIs, not every possible operating-system entry point. Compile-time poison rules and an undefined-symbol check additionally restrict the callback object. This is evidence about this compiled graph, not a general sandbox for arbitrary plugin code.

`native:sanitize` builds separate AddressSanitizer/UndefinedBehaviorSanitizer binaries and runs memory-safety checks. Allocator interposition is disabled in that build so instrumentation systems do not conflict. Sanitized timings/zero hook counts are not used for callback qualification; the ordinary audited build supplies those results.

## Clock and deterministic ordering

The engine owns the musical clock. Its sample counter never depends on client polls. Musical ticks use PPQ 960 and a tempo anchor computed from integer sample positions rather than repeatedly accumulating floating-point intervals. A tempo change at a bar boundary updates the anchor without restarting transport. The fixture checks 24 actual note-on positions around the boundary: 6000-frame sixteenths before frame 96000 and 8000-frame sixteenths afterward. A note spanning the change releases exactly once at frame 128000.

Timestamp zero means the next callback. Nonzero frame commands require two blocks of lead time and at most sixty seconds of lookahead; a command already late when consumed is rejected. Tempo timestamps are musical ticks on a bar boundary. Equal-time normal commands retain arrival order. Safety operations and due note-offs precede pattern note-ons. Future note-offs retain their requested sample position even when the normal queue is full.

## Independent process and IPC

`xmp_engine_host --virtual` owns the graph and a paced audio thread. Its non-real-time control thread handles a private Unix-domain socket in an owned temporary directory, at most sixteen clients, bounded receive/reply buffers, a version handshake and immutable project transfer. No physical endpoint or default device is opened. There is no USB, MIDI, shell or device-deployment command.

Requests are fixed 40-byte little-endian records: magic, protocol version 1, operation, request ID, declared payload size, timestamp, two integer arguments and a finite numeric value. Replies have a fixed 176-byte header; project reads add at most 4096 bytes. Payload limits, opcode/version, ranges, timestamps and references are checked before queue insertion. Slow clients may be disconnected rather than block processing. Pending request slots reserve room for safety commands; recycled client slots cannot receive acknowledgements from an older connection.

An atomic snapshot includes project hash/generation, applied revision, sample/tick position, tempo, playback/safe state, counters and active rate/buffer profile. Compatible clients can fetch the full immutable project in bounded chunks and verify its hash against that snapshot. Prepared development graphs use `xmp-engine-graph` version 1; user songs retain their canonical portable bundle. Project replacement while playing is not implemented: preparation happens before starting the host. Applied acknowledgements are distinct from acceptance, queue refusal, invalid input and voice refusal.

The restart test kills a separate Node control-client process with SIGKILL and starts a new compatible client. It verifies an unchanged project generation, advancing clock, unchanged 96000-frame pattern intervals and exactly matched note-on/note-off traces. This is a real process/IPC test with software audio, not a browser or physical-audio crash test.

## Host backend scope

The compiled CoreAudio port supports explicit built-in output only. It verifies the expected host name and built-in transport before creating an Audio Unit, rejects Akai/Force/MPC/inMusic identities, requires the already-selected 48 kHz/256-frame device profile, and does not change global rate, buffer or default-device settings. It has no input recording path. Device-alive/rate notifications lead to silence and a controlled lost state; a fresh validated backend is needed afterward. No CoreAudio stream was opened during this work.

The optional ALSA port is limited to the software `null` PCM, with exact rate/period checks and a safe-state transition on failed writes. It is compiled only when ALSA development headers/libraries are present. It has not been run on Linux here. General removable-interface playback/capture, hardware negotiation and physical disconnect tests remain P04.4 work. Neither backend port is selectable through the current virtual host CLI.

The realtime callback constraints follow the [PortAudio callback guidance](https://files.portaudio.com/docs/v19-doxydocs-dev/writing_a_callback.html). The guarded Mac port uses Apple's [HAL Output Audio Unit interface](https://developer.apple.com/library/archive/technotes/tn2091/); the optional Linux port uses [ALSA PCM parameters](https://www.alsa-project.org/alsa-doc/alsa-lib/pcm_2pcm_8c.html). Linking these system APIs is not evidence that a physical stream was exercised.

## Loopback analysis

`audio:measure` reads only `artifacts/loopback/capture.wav` and `calibration.json`, writing a report under `reports/loopback`. With no capture/calibration it exits 2 and reports inconclusive with null latency. It never substitutes software callback timestamps or defaults to zero.

The capture contract is mono 48 kHz PCM16, at most 64 MiB. Calibration version 1 records rate/buffer, a hardware-output-to-capture clock ratio/offset, capture start frame, independently measured residual error (at most one frame), provenance flags and 1000–10000 isolated emitted impulse positions. Clock drift beyond 100 ppm, missing trials, ambiguous peaks, excessive pre-trial noise and invalid profiles are inconclusive. The analyzer reports the full latency distribution, nearest-rank p50/p95/maximum and capture/calibration hashes. A known generated 10 ms fixture and a 21 ms p95 failure fixture verify the calculations.

Synthetic inputs stay labeled synthetic. `physicalQualification` is always false in this analyzer: fixture provenance, calibration and the actual path still require review. Software analysis can establish a threshold result; it cannot certify that a file came through physical hardware. The physical loopback and removable-interface scenarios remain unexecuted as requested.

## Run on the Mac

```sh
npm run native:test
npm run native:sanitize
npm run bdd:step -- P04_1
npm run bdd:step -- P04_2
npm run bdd:step -- P04_3
npm run bdd:step -- P04_4  # Software support cases only; excludes physical cases
npm run bdd:p04
npm run bdd:implemented
npm run bdd:qualify:implemented
```

`npm run engine:dev` starts or reconnects a CLI client to an independent native engine with a sixty-second software-capture limit. Commands are `play`, `stop`, `tempo 90`, `state`, `quit` (client disconnect) and `shutdown`. The engine survives client exit. A session manifest points to its private capture/report directory in `reports/engine/session.json`. To play a real project through the software endpoint, first place a portable Studio export at the fixed Mac path `artifacts/engine-project.xmp.json`; otherwise the explicit development fixture is used. No device/backend flags are accepted. This tool does not produce physical speaker output.

## Optional built-in acoustic smoke check

[The separate MacBook acoustic test](acoustic-audio.md) can play an XMP C++ offline-rendered reference through built-in speakers and record six seconds through the built-in mic. It uses its own explicit native HAL helper and local Gherkin profile. It does not connect the browser or engine-dev virtual endpoint to hardware, and cannot close the original P04.4 calibrated loopback/removable-interface gates. Audio-device permission, identities, captures and outcomes have separate evidence.
