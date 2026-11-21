# P07 Mac arrangement and performance

P07 provides independent clip playheads, queued launch/cancel, song chains, mute/solo, versioned macro assignments and recorded performance controls in the standalone core and Mac Studio. Its ten software Gherkin journeys include a production AudioWorklet/offline PCM comparison. A separate explicitly invoked browser audit checks the declared 1280×800 preview profile. The three original deployed display/control journeys remain planned.

## Scope decision: ADR-P07-001

The owner requested the next phase after passing P06 Mac software checks. P07 depends on that software evidence; it does not close P04 formal loopback, the complete native instrument/performance port, booted OS or USB qualification. The declared preview viewport is a software test target, not a verified physical Akai display profile. Virtual encoder tests do not establish hardware mappings or sensor support. No new device operation is authorized or implemented.

## Launch and arrange

Choose Perform, then **Enable performance preview** while stopped. This undoable edit adds version-1 performance state without opening audio. Choose a track and clip, then Queue clip or Stop track. During playback, changes commit at the next unscheduled sixteen-step bar. A scene launch restarts all selected clips from step zero; empty scene slots stop their owners. A single-clip launch restarts that track while others retain their anchors. Source voices release at the boundary; shared delay history continues. Cancel removes uncommitted launch intent. The existing 100 ms lookahead means an already committed boundary cannot be canceled retroactively.

Scene intent supersedes queued clip intents; a clip intent cancels queued scene intent and preserves other queued tracks. Manual launches leave song mode. While stopped, clip choices prepare a saved performance selection for Play. They do not change the source scene's clip map. Stop saves the audible selection and song position; saved selections are reapplied to manual scene playback. The editor's scene map and sounding override remain distinct: choose the track/clip explicitly when editing an independently launched pattern.

Add scene occurrences to a chain, set repeats, and choose Stop or Loop. Each occurrence has its own stable ID, even when the same scene appears twice. A scene cycle lasts the longest clip, at least sixteen steps; shorter clips repeat inside it. Repeat counts multiply this duration. Future chain edits apply when the active occurrence completes under its original duration and repeat count. If its ID survives, its successor comes from the edited chain; if removed, the first surviving old successor is used, followed by the configured end policy. Missing references and duplicate IDs are rejected before project replacement.

Play song begins at the first occurrence; Resume uses the saved occurrence and offset, preserving clip phase and recorded control state. A song loop resets the recorded-control timeline. Manual moves latch over recorded controls until Stop. Rearranging a chain keeps recorded performance events at their absolute song-step positions; it does not silently move those events to another time.

## Mute, solo, macros and tails

Performance mute and solo control source admission. Muting or excluding a track releases its owned notes, pairs virtual MIDI note-offs and discards already queued hits for that owner; unmuting does not resurrect those discarded hits. Parameter gain changes use the existing 10 ms smoothing. Delay returns are shared and continue to decay after their source is muted, solo-excluded, stopped or replaced. Stop releases sources while the worklet's existing return tail continues; no driver latency qualification follows from this behavior.

The original shared preview delay is a bounded send/return, with 0.25–8 steps of delay, feedback 0–0.75, return 0–1 and explicit per-track sends. Its buffer is allocated before processing. Changing delay time or tempo clears that preview buffer; changing send/feedback/return preserves it. It is included to exercise P07 tail semantics. P08 still owns the full routing graph, insert/send architecture and effect set.

A macro contains stable parameter IDs and signed normalized amounts. Its midpoint 0.5 adds zero; endpoints contribute ±amount. Contributions join P06 macro precedence before clamping, rather than overwriting unrelated controls. Installed automatable machine identities include their type and state version. Missing/replaced targets are inactive and labeled unavailable. Deleting a track prunes its macro assignments, performance events, selection, solo/mute/send references and parameters. Other tracks retain their IDs and receive no substitute control events.

Record performance controls while a scene or song is playing. Mute, solo and macro movements stay temporary until Finish/Stop commits the pass as one undoable edit. Capture is bounded to 2048 events, sorted by musical position. A concurrent project edit prevents a stale commit; Download performance draft retains the captured JSON. Draft re-import is not provided in this milestone. The browser remains a lookahead prototype; live controls clear stale queued parameter commands and update their current value without resetting the clock.

## Compact views and scoped controls

Play, Sounds, Pattern, Perform and Mix keep the same pad/transport meanings. All panels restores the development layout. The compact preview keeps project actions, Help and virtual encoder controls in the view toolbar. Detailed editors and the large clip matrix remain scrollable rather than shrinking touch targets. No native controller, HID, USB or MIDI port is opened by these views.

Focus a registered parameter, then use the virtual encoder ± controls. Assignment is stored by parameter and track identity. Discrete machine parameters may declare a native-unit step; MIDI channel and transpose expose one-unit increments. Help receives DOM access only. Closing Help or an import error resolves the original scoped control after a redraw, or explicitly clears its assignment and focuses Help. An unavailable control never falls through to the currently selected track. Error dialogs trap focus and make the background inert while audio continues independently.

## Formats, limits and evidence

Project V5 adds optional performance state. Valid V1–V4 files migrate without changing notes, PCM or timing; portable bundle format remains version 1. Limits are eight tracks, sixteen scenes, sixty-four chain occurrences, sixteen repeats/occurrence, eight macros with sixteen assignments each and 2048 recorded controls. Resume offsets are validated against their occurrence. The offline preview retains its 2.1-million-frame and command budgets and rejects oversized renders explicitly; this is not unrestricted long-song export.

Run `npm run bdd:step -- P07_1` through `P07_4`, `npm run bdd:p07`, `npm run check`, native/sanitizer checks, and the full implemented regression/gate commands. CI runs software scenarios on macOS and Ubuntu. The stage journey saves/reopens the actual portable project and compares production worklet PCM, applied note frames, transition positions and muted-source behavior against the standalone renderer.

`npm run bdd:layout` is separate from CI. It requires a current-source CUA audit under ignored `reports/verification/p07/layout.json`, actual viewport dimensions, measured visible/focusable primary rectangles and screenshot hashes for all five compact views. It fails if absent or stale. This audit concerns the declared active primary targets; detailed controls remain reachable through scrolling and their DOM workflows. It leaves physical display, hardware encoder/pad mappings, OS/USB and formal loopback qualification pending.
