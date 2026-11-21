# Acceptance fixture contracts

The P02 seed fixture in `acceptance/lib/fixtures.mjs` is implemented: one second of stereo output at 48 kHz, a half-scale impulse at frame 24000, both channels equal, otherwise silence, with a two-unit PCM16 tolerance. The entire PCM capture is checked against independent constants. A deterministic demo project is freshly parsed per scenario. Their composite hash identifies the fixture version; generated files and captures live in ignored evidence directories.

The broader musical fixtures below remain planned contracts. Do not derive expected output by calling the same implementation being tested. Freeze the actual generated files, canonical settings and hashes before using them for qualification.

## Small deterministic signals

- **Impulse:** mono, 48 kHz, 96000 frames; sample 0 equals 0.5 and all other samples equal zero. Use known offsets for sampler, delay and routing assertions.
- **Sine:** mono, 48 kHz; 1000 Hz, amplitude 0.25, phase zero, two seconds. Compare steady-state amplitude, channel routing and frequency against independently calculated values.
- **Stereo identification:** left 440 Hz and right 880 Hz, each at amplitude 0.25. Validate stereo preservation, intentional downmixing, channel swaps and pan behavior. The current preview intentionally downmixes imported audio; any V1 stereo support must be an explicit versioned change.
- **Four transients:** four separated impulses at sample offsets 0, 12000, 24000 and 36000. A slice spans a start-inclusive/end-exclusive range. Crop/reverse changes a derived asset or edit recipe, not the source hash.
- **Silence and malformed data:** finite zero samples; truncated WAV; unsupported headers; NaN/infinite PCM; oversized decompressed data; missing hashes; path traversal; conflicting project IDs. Each is an isolated fixture with a declared expected error category.

## Timing and note lifetime

At 120 BPM with a sixteenth-note grid, step offsets are 0, 6000, 12000 and 18000 samples at 48 kHz. Sixteen steps occupy exactly 96000 samples. Swing 0.5 delays each odd step by 3000 samples without moving the next even step or bar boundary. This matches the current core swing contract.

Schedule a new scene at a declared bar boundary. Its first clip event has clip-relative offset zero even when the global position is not divisible by that clip's length. Store both absolute and clip-relative positions in traces. Every accepted note-on has exactly one corresponding release/cancellation under the documented stop, mute, deletion and loop policies.

Define microtiming in signed sample offsets derived from musical ticks. Choose and record wrap versus clamp behavior in P06 before implementation; tests at both loop edges must assert that exact decision. Conditions such as first cycle, fill and every-Nth cycle have explicit cycle numbering and reset behavior.

Probability fixtures record seed 73019, clip/track/event identities and reset/seek state. Store the expected event trace independently and verify repeatability, probability zero and probability one. Repeatability alone is insufficient to prove the chosen distribution; a separate fixed statistical fixture checks the generator within a declared tolerance.

## Parameter precedence

Use normalized parameter P with range 0 to 1: base 0.2, automation 0.4, active step lock 0.7, macro offset +0.1 and LFO offset -0.2. Proposed resolution is base, automation replacement, lock replacement, additive macro, additive modulation, clamp, then declared smoothing. The target before smoothing is 0.6. At lock expiry, the underlying automation resumes without stale lock state. Unknown IDs and non-finite values are rejected. Freeze the lock lifetime and per-track versus per-voice scope in the P03.2/P06.3 decision before implementation.

## Effect response oracles

Freeze effect topology and settings before storing golden renders. Initial proposed fixtures are:

- Gain 0.5 maps finite input 0.5 to 0.25; bypass maps it to 0.5.
- A unity-gain pan law has declared center and endpoint gains. Test those numbers; do not infer the law from whichever output appears.
- A second-order Butterworth low-pass at 1000 Hz has its steady-state cutoff response at approximately -3.01 dB, with a proposed 0.2 dB response tolerance after settling.
- A parametric EQ fixture at its center frequency adds the specified 6 dB within a proposed 0.2 dB tolerance.
- A 24000-sample delay with feedback 0.5, dry zero and wet one produces its first impulse at sample 24000 and the next at 48000 at half the amplitude, within the declared render tolerance.
- A tanh distortion fixture with drive 2 compares a bounded amplitude sweep with an independent `tanh(2*x)` oracle within a proposed 0.00001 float tolerance.
- A steady-state compressor with threshold -18 dBFS and ratio 4:1 maps a -6 dBFS input to approximately -15 dBFS after attack, within a proposed 0.5 dB tolerance. Attack/release use additional envelope fixtures.
- Reverb uses a frozen algorithm/seed and declared decay setting. Measure impulse decay and tail cutoff against that setting; do not declare an arbitrary convolution or generated tail equivalent.

These are proposed product contracts. Record any topology or tolerance change before replacing the expected oracle. Tail/bypass, automation smoothing and resource-budget fixtures apply in addition to frequency or amplitude checks.

## Full-song and soak workload

The qualification workload has four sampler tracks and four basic subtractive-synth tracks, sixteen scenes, at most thirty-two active voices, EQ and filter inserts on each track, and shared delay and reverb sends. Freeze actual notes, sample data, synth/effect settings, scene repeats, automation and save schedule in a fixture manifest. Use a four-scene short journey for frequent smoke checks and the complete eight-hour schedule for release qualification.

Do not treat thirty-two voices, every effect's most expensive settings, and eight tracks as separately tested maxima that can necessarily run together. The qualified combined workload and its limitations must be published. If hardware cannot meet it, make a product-scope decision and version the profile before retesting.

## Physical and fault fixtures

Record real wiring, device and capture sample rates, calibrated latency, clock drift, trigger method and ambient conditions. Physical pad tests cover all sixteen pads and a frozen velocity-force procedure; UI command injection is a separate test. MIDI fixtures name an approved loopback/measurement device and never a Force port.

Use disposable processes and VM disks for disk-full, corrupt-save, service-crash, upgrade-health and power-loss fixtures. Bound every fault's duration and cleanup. A hardware fixture needs its own operation-specific authorization; a Gherkin tag or inclusion in this document is not that authorization.
