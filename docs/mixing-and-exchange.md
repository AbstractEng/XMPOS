# P08 Mac mixing and exchange

This increment adds a stereo software mixer, original reference effects and WAV/MIDI exchange. It runs on the Mac without opening an audio or MIDI device. The production AudioWorklet is tested using virtual output buffers. Physical MIDI synchronization, standalone native effects, a booted OS, USB deployment and calibrated audio loopback remain unqualified. The original P08 physical stage journey and two external MIDI scenarios remain planned. The Force remains passive inventory only; no hardware adapter or Web MIDI access is provided.

## Use Studio

1. Select **Mix**, stop playback and choose **Enable stereo mixing**. Existing projects preserve their old sound until this explicit edit; Undo restores the previous mix.
2. Select a track in the track strip. Track gain and the existing gain effect set its level. Pan uses an equal-power law: hard left `(1, 0)`, center `(√0.5, √0.5)`, hard right `(0, 1)`. Sends A/B tap the stereo signal after track gain, pan and inserts. Both returns go directly to master. Sending between returns or into an upstream track is unsupported, so feedback routes cannot enter the graph.
3. Choose **Effect location**, slot and effect, then **Set effect**. Two ordered inserts are available on each of eight tracks and each of two stereo returns. Fill slot 1 before slot 2. Graph changes require Stop. Save/Open preset stores validated settings, not executable code or audio history. Imported presets receive new local identities; stale automation cannot bind to their replacement accidentally.
4. Effect controls, pan and sends appear in **Notes & automation**. Their stable IDs support existing locks, lanes, LFOs and performance macros. Return automation can live in a track's clip; when several active clips automate the same global return parameter, the last project track with an explicit assignment wins. Continuous parameters smooth over 10 ms. Bypass crossfades separately over 10 ms while history continues processing. Stop releases sources within the existing 5 ms panic policy and leaves tails decaying. Replacing a graph clears its old history. Tempo-synced delay changes its read tap without allocation and retains history; a tempo transition can audibly change its tap.
5. Choose a filter or delay and **Rhythmic filter / delay preset** for the original four-step sixteenth-note filter sequence or eighth-note delay. Filter gestures offset the sequence. Phase follows the transport's musical position. Start resets phase, Resume restores its original musical position, and loss of an explicit virtual clock holds the last tempo. There is no implicit clock-source selection.
6. While stopped, set a tempo change at a named bar. The published map applies at exactly that bar on the next playback, offline render and virtual clock pass. The initial BPM control retains its existing restart behavior. Changes to the map during playback are rejected by the UI. In live looping song mode the map follows elapsed transport position; finite song export requires the end policy **Stop**.
7. **Export scene as WAV** includes its longest selected clip plus two seconds of tails. **Export song WAV** renders the finite chain. MIDI buttons download SMF files, without opening audio. All bytes are rendered before the browser download is requested; the browser owns destination selection. A download-request message is not proof of a successful disk write.
8. **Import MIDI clip** stages a bounded file and lets you choose its nonempty file track. **Replace selected clip with MIDI** explicitly replaces notes and the project tempo map as one undoable edit. A changed revision, track or clip invalidates the staged take. Unsupported non-note channel events are counted and omitted. Sounds, routing, automation and plugins travel in portable projects, not MIDI. Imported notes use pad 1; choose the intended track machine to play them.
9. **Test virtual MIDI clock** captures 192 clock pulses and Start/Stop across 32 sixteenth notes. It selects named in-memory fixtures only. No physical input or output can be selected. Peak L/R and RMS meters display actual post-master, clamped worklet output; clipping is counted before the final clamp. The browser compressor is neutral for the new mixer, so it does not add an undocumented mix stage. Two-bar resampling explicitly folds stereo to mono with `(L + R) / 2`, matching the current mono sample format.

## Effect response contract

Every effect is original, mono-per-channel reference DSP; neither the reverb nor EQ claims a vendor algorithm. All stored numeric controls are normalized 0–1, validated before graph replacement. There are at most twenty effects and two channels. Delay allocates at most four seconds per channel (3,840,000 bytes/effect at 96 kHz); reverb allocates 137 ms. Even twenty delay instances stay below 62 MiB of delay buffers at 96 kHz. Processing uses prepared buffers; no file, network or device operation occurs in DSP.

| Effect     | Declared response                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EQ         | One-pole low shelf; tone maps exponentially 20 Hz–20 kHz, gain −12…+12 dB. Neutral gain is exact unity.                                                     |
| Filter     | One-pole low pass; cutoff maps exponentially 20 Hz–20 kHz, capped at 0.45 × sample rate. Sync uses the stored step sequence plus the cutoff gesture offset. |
| Delay      | Time 0…4 s, minimum one sample; feedback 0…0.75; dry/wet linear blend. Sync division is expressed in sixteenth-note steps.                                  |
| Reverb     | Original damped 137 ms feedback comb; decay maps feedback 0.2…0.85, damping coefficient 0.2, linear dry/wet blend. This is a small reference reverb.        |
| Distortion | Normalized tanh waveshaper with drive 1…20 and linear dry/wet blend.                                                                                        |
| Compressor | Peak follower, 5 ms attack/50 ms release; threshold −48…0 dB, ratio 1…20, makeup 0…12 dB.                                                                   |

Analytic impulse/DC oracles use absolute tolerance `1e-6` (compressor settled response `1e-4`). Reload and worklet/offline comparisons require exact Float32 samples and note frames. Untrusted non-finite parameters, unknown keys and oversized controls reject before replacement; non-finite audio is contained. A 4096-frame/2-second host test is only a broad software hang guardrail. It is not the 256-frame device callback target or latency qualification.

## File contract and limits

WAV is stereo 48 kHz PCM16 with deterministic headers and quantization. The default tail is exactly two seconds; core callers may explicitly choose 0–8 seconds. Tails may remain nonzero at the chosen truncation boundary. Rendering is capped at 2.1 million frames, 32,768 commands, 1,023 finite song steps and 8,192 MIDI notes; oversized or looping songs reject instead of silently exporting a partial song.

MIDI export uses SMF type 1, a conductor tempo track and note tracks at 960 PPQ. Positions, swing and microtiming quantize to the nearest tick (1/240 sixteenth note); durations are at least one tick. Velocities quantize to 1–127; zero-velocity notes are omitted. Tracks use distinct channels by project track index. Legacy sampler pad steps without an explicit note map to notes 36–51; explicit notes, chromatic notes and synth/MIDI notes preserve pitch. Export clips note ends at clip/song ends and recorded mute/solo cleanup. Same-pitch overlaps on a channel reject because ordinary MIDI 1.0 cannot preserve their independent ownership unambiguously. Machine-specific MIDI transformations and controller/pitch/pressure lanes are outside this SMF subset.

SMF import accepts type 0/1 with PPQ 1–9600, running status and note-on-zero as note-off. It rejects SysEx/system data, SMPTE timing, truncated chunks, unterminated notes, conflicting tempos and malformed VLQs. Limits: 1 MiB, seventeen chunks, 32,768 events, 8,192 notes and sixty-five tempo entries. Clip replacement requires ≤1024 notes, ≤64 steps and bar-aligned tempo changes. Meta tempo values are integer microseconds/quarter (200,000–2,000,000), so round-trip BPM can differ by that representation's rounding. Unrelated channel/meta events are counted as ignored. Source references: [MIDI Association SMF specification catalog](https://midi.org/standard-midi-files), [Microsoft MIDI project clock documentation](https://github.com/microsoft/MIDI/blob/main/docs/tools/console/index.md).

For explicit filesystem destinations, use the atomic Mac CLI:

```sh
npm run export -- project.xmp.json output.wav song wav
npm run export -- project.xmp.json output.mid scene mid scene-0
# Add --overwrite only when replacing that destination is intended.
```

The CLI reads a portable project and renders without AudioContext or physical MIDI. It stages a private sibling `.partial` file, syncs it, then commits by same-filesystem rename for approved replacement or an exclusive link for a new file. A declined overwrite, render error or storage failure preserves the previous file; tests inject ENOSPC after staging and verify cleanup. It rejects using the source project as destination. No device paths are used by tests.

## Evidence and pending gates

Run each substep with `npm run bdd:step -- P08_1` through `P08_4`, then `npm run bdd:p08`. Twelve implemented host journeys cover the four substeps and a virtual integrated stage. `npm run bdd:implemented` and `npm run bdd:qualify:implemented` include current-source P08 evidence in CI on macOS and Ubuntu. No physical tests execute in CI.

ADR-P08-001: P07 Mac software evidence permits this Mac increment. The P08 software qualifier requires all implemented journeys and its preceding software gates; `complete`, `phaseQualified`, `physicalMidiQualified` and `formalLoopbackQualified` remain false. The original three physical scenarios stay planned. The prior P07 CUA layout artifact is source-specific; it does not automatically qualify a new build. V6 adds optional mix state and migrates validated V1–V5 projects without enabling or changing their sound. The external specification is still unavailable and has not been reviewed.
