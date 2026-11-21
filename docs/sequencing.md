# P06 Mac sequencing, expression and automation

P06 implements sequencing in the standalone TypeScript core, Studio scheduler and production AudioWorklet on the Mac. Its thirteen Gherkin journeys cover note entry, overdub, repeat, quantization, variation, locks, modulation, automation and save/reopen. A separate native virtual-engine probe verifies queued groove changes. No device adapter or hardware output is added.

## Software scope: ADR-P06-001

The owner requested the next phase after passing P05 Mac software checks. Development therefore depends on P05 software evidence, while P04 formal loopback and P05 native live/OS/USB qualification remain pending. P06 software evidence cannot close those gates or its own deployment gates. The native engine currently implements the groove-boundary change, not the full new note model, machines and automation. Advanced projects continue to be rejected by the legacy native preparation path.

## Play and record

Open **Notes & automation**, choose the desired track in the track strip and its pattern in the panel. Existing pad steps remain editable above. Add a chord by entering comma-separated MIDI notes, zero-based position and length. Each note has a stable identity, so chords can share a pad and timestamp. Select note rows before quantizing, restoring played timing, changing length/variation or deleting notes. Duplicate copies the complete pattern and selects the new clip in the current scene; sixteen clips per track remain the limit.

**Record note pass** starts transport when stopped, or overdubs the remaining current clip cycle when already playing. Play pads/keys, then Finish or Stop. The pass is one undoable transaction; original positions, durations, timestamps relative to the pass cycle and played velocities remain available. Timing correction uses the original position, never compounds repeated rounding, and affects only selected notes. No input-latency compensation or external MIDI/MPE capture is claimed.

Shortening a clip drops notes whose starts are outside the new loop, truncates crossing durations, and trims automation/locks. Studio panics current voices and queued commands without restarting transport. Original take metadata stays intact. Blur/hidden-tab/Stop releases owned input and finalizes active passes. Concurrent project edits prevent a stale destination commit; **Download captured pass** preserves the latest note or automation draft as bounded local JSON. Draft re-import is not yet provided; it remains a recovery/export artifact.

Clocked repeat uses the chosen division and explicit repeat velocity on Mac keys/pointer. Pressure is unavailable on these sources. The virtual input API can negotiate pressure and sample it on repeat ticks; its Gherkin fixture checks 0.2/0.8/0.4 rather than inventing sensor input. Release, disconnect or Stop cancels repeat ownership. Missed ticks are skipped after a stall; repeat processing is bounded per scheduling call. Captured repeats commit with the note pass.

## Groove and variation

Microtiming supports ±0.49 sixteenth steps. It clamps each onset to `[0, clipLength − 1/960]` inside that event's own cycle; it never wraps a hit into a second cycle. Durations truncate at the loop boundary. Fractional onsets use piecewise-linear swing across each eighth-note pair; exact triplets use the ratio 2:1 and even bar boundaries stay fixed.

Probability is reproducible from the saved seed, project/track/clip/note identity and cycle. Legacy pad-step probability retains its old keys. Conditions are `always`, `first`, `not-first`, `fill`, `not-fill`, `every-2` and `every-4`; the latter two fire on zero-based cycles divisible by two/four. **Fill held** is an explicit virtual toggle. A change affects unscheduled events; the prototype's existing 100 ms lookahead still applies.

Swing changes queue for the next sixteen-step bar and preserve the sample-clock anchor and held voices. Invalid updates preserve the last accepted groove. Tempo changes in the browser still restart the preview clock. Native IPC adds operation 12 (`groove`): version 1 in `a`, zero `b`, finite swing 0–0.5 in `value`, a bar tick timestamp within the next thirty bars. An accepted update is acknowledged with status `ok` while pending; application increments the revision and emits trace kind 5. Stop/backend loss cancels it. The native probe checks exact sample frames and held-note continuity across straight → triplet → straight with invalid replacement attempts.

## Locks, modulation and automation

The parameter selector includes master/track gain and automatable installed-machine parameters. Machine identities contain track ID, machine ID, state version and parameter ID. Lanes for unavailable/replaced machines remain saved and inactive. They never bind to a similarly named control in a replacement. Automation uses normalized values mapped to the machine's documented units; MIDI channel and the example transpose quantize their discrete targets for new notes. Existing notes keep their channel/pitch for matching note-offs.

A lock lasts its integer sixteenth step. Its replacement value overrides the automation lane, then macro and LFO offsets are added and clamped to 0–1. Removing a source removes its contribution; controls resolve through a 10 ms one-pole smoother. Lanes use hold interpolation between ordered points. LFOs are sine offsets with explicit cycles per clip and phase. Controls are scheduled every quarter-step (sixty-fourth note), plus exact lane points, with audio-sample smoothing. This is the declared prototype modulation rate, not audio-rate modulation.

Touch records only touched intervals and restores the old lane on release. Latch starts on the first touch and holds through Finish/Stop. Write replaces the recorded interval from its start. A live gesture owns its parameter even when previously queued automation commands arrive; Touch release restores the underlying lane. Stop commits one undoable edit, ends gesture ownership, releases voices and resets runtime parameter sources. Multiple master-target contributions follow saved track order; later tracks replace earlier automation/lock values, while each track's macro/LFO sum is clamped before precedence resolves. Prefer a single master lane for predictable editing.

A sequence is version 1, with ≤1024 notes, ≤256 locks, ≤32 lanes of ≤256 ordered points, and ≤16 modulation sources per clip; projects permit ≤8192 new notes. All values and boundaries are validated before project replacement. Over-budget edits fail without replacing the current project; captured drafts remain downloadable. Existing sample/project byte budgets still apply.

## Developer integration and verification

Project V4 adds optional clip `sequence` data. Valid V1/V2/V3 inputs migrate with their musical values intact; portable bundle format stays version 1. The legacy step model stays separate for compatibility. The SDK exports note/take/repeat/automation contracts. Trusted machines opt into `automation: true` and implement `setParameter(id, value)`; built-in synth/MIDI and both original examples provide this. Definitions without that opt-in retain manual controls and have no sequencer parameter targets.

Run each substep with `npm run bdd:step -- P06_1` through `P06_4`, then `npm run bdd:p06`. The end-to-end journey executes the actual bundled AudioWorklet with virtual buffers and compares its PCM and applied note frames against offline rendering. It does not open AudioContext, an audio device or a hardware transport. `npm run check`, `npm run native:test`, `npm run native:sanitize`, `npm run bdd:implemented` and `npm run bdd:qualify:implemented` provide regression evidence. CI runs software checks on macOS and Ubuntu; formal physical loopback, complete native playback, OS VM and USB qualification remain separate.
