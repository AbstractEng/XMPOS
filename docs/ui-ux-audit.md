# XMP UI and workflow audit

2026-11-15 · Working tree based on `ccf3107` · Original audit with implementation follow-up below. The observations describe the pre-change UI.

XMP has a strong visual foundation: the emerald, ivory and gold palette, clip-first structure, pad layouts and native Q-Link column make it feel like an instrument. The biggest improvements are direct editing, clearer focus and playback state, and giving the musical editor more of the screen. Adding the TODO features to the current layouts without reorganizing them would compound the differences between the Live and browser workflows.

## Scope and evidence

This is a host rendering and source audit, with browser interaction checks. It does not establish physical touch accuracy, audio latency, subjective hardware feel, or every possible project/error state. No hardware was contacted. Existing working-tree changes were left intact. Requirements came from the repository's UX documents and `docs/future.md`; the pending external specification was not reviewed.

## Findings in priority order

P1 means a core workflow obstruction; P2 means significant clarity, efficiency or consistency work. These are design priorities, not security severity scores.

### U01 · P1 · Visible native information frequently cannot be edited by touch

**Observed:** `ui::hit()` handles clip cells, some track headers, Play pads, steps/notes, mixer selection/mute/solo, Song rows and Browse rows. It has no targets for the header tempo, Q-Link values, Menu cards, the Sound page or the Sample waveform. Touching mixer level/pan/send information selects the track; it does not edit the displayed parameter. See [`live_ui.hpp`](../native/include/xmp/live_ui.hpp), `Hit`, `hit`, `strip`, `sound_view` and `mix`; and [`live_session.cpp`](../native/src/live_session.cpp), `touch_at`.

**Change:** give every editable value a consistent tap action. Tap a numeric value for a bounded editor with value, unit, range, fine/coarse adjustment, reset, commit and cancel. Tap a name for rename or selection. Tap an assignment for its picker. Tapping a meter or health indicator opens relevant detail rather than pretending the measurement itself is editable. Physical knobs keep working; touch selects the same semantic parameter.

**Acceptance:** tempo, selected step velocity/chance, repeats, track level/pan/sends, sample boundaries and sound assignments can each be changed from the thing displayed. Commit is one undoable edit; cancel preserves the previous value; values do not jump when switching to a hardware knob.

### U02 · P1 · Sample and Song promise manipulation the input path cannot deliver

**Observed:** the design describes dragging sample boundaries and song blocks. `Touch::feed()` emits a completed new touch-down, without a move/up gesture stream. Song hits select a block; the Sample page has no touch hit target. Existing sample editing and block movement are hardware operations. This is a gap between the design and implementation, not a failed physical-device test.

**Change:** add bounded down/move/up gestures with shared geometry for painting and hit testing. Sample handles need enlarged invisible targets, time readouts and fine adjustment. Song needs a drag handle, insertion preview and autoscroll. One drag produces one undo entry; transport keeps running where supported. Long-press options must be implemented before they are advertised.

### U03 · P1 · Selecting a note can erase the note being inspected

**Observed:** native `roll_touch()` selects a pitch/step and issues `toggle_step`. Device `stepPress()` toggles an entry. Studio requires Shift-click to select an active drum step without removing it. This makes velocity/expression editing depend on knowing a modifier before touching the note.

**Change:** adopt explicit Draw and Select tools for detailed editing, with a clear active tool. In Select, tap an existing hit to inspect it; use Erase or a visible delete action to remove it. Keep the hardware pads' fast step-toggle behavior. Support pad note selection followed by one or several step presses, matching the melodic-entry TODO.

### U04 · P1 · Browser and native controls teach different habits

**Observed:** browser Shift+Main opens Track; native Shift+Main opens Play. Browser A–D select scene windows; native A–D select tracks. Browser Q1–Q4 start with track/master/swing/tempo in a bottom row; native has contextual pages in a right column. Browser Copy requires confirmation; native Copy is undoable without that dialog. Browser has separate Scenes and Mute pages and lacks the native Sound and Sample pages. Sources: [`device/live-mk1.ts`](../apps/studio/src/device/live-mk1.ts), [`device/navigation.ts`](../apps/studio/src/device/navigation.ts), [`device/view.ts`](../apps/studio/src/device/view.ts), native `Ui::button()` and [`live-ux.md`](live-ux.md).

**Change:** make the Device preview follow the current native control contract, including Menu grouping, pad roles, Q-Link placement, Copy and recording semantics. Studio can have a richer desktop layout, but track/clip/pad identity and musical commands must agree. Update the older `device-ui.md`, which still describes some superseded model limitations.

### U05 · P1 · Sound selection does not yet form a complete sound-editing workflow

**Observed:** native Sound shows kit names or eight synth presets. Its cards have no touch targets; kit sample replacement/editing remains pending, and MIDI Sound does not expose a complete routing editor. The native board's kinds are Kit, Synth, MIDI and Other, while the UX brief specifies a separate Sampler experience. Device selects machines with a dropdown. Studio has deeper controls, but sample, step-note and recording controls share one large panel.

**Change:** tap the track's machine label for a pad-backed machine picker. Within Sound, present a machine-specific body: Kit pad assignment plus Edit/Replace; Sampler waveform plus chromatic/slice mode; Synth preset plus oscillator/filter/envelope controls; MIDI destination/channel. Treat separate native Sampler behavior as an implementation dependency to verify, not an existing capability. Reuse the same sample editor for a new take and an existing pad sample. Show whether a kit is shared before an assignment affects other tracks; new local edits should isolate the track consistently.

### U06 · P1 · A committed sound change may not become audible while playing

**Observed:** `live-ux.md` explicitly says changed sounds are taken by the Live engine while stopped or when it stops. The native Sound presentation does not distinguish the sounding version from a changed preset/parameter awaiting engine application. This conflicts with the desired fluid, uninterrupted editing experience.

**Change:** show `Pending sound change · applies on Stop` for the present engine behavior. Then prepare sound changes outside the audio callback and apply at an appropriate safe boundary if the engine supports it. Keep the old sound audible while preparing; never imply instant audition before that works. Include cancellation and Undo of pending changes.

### U07 · P2 · The browser chassis sacrifices too much readable screen area

**Measured:** at 1440 × 1000 the logical 1280 × 800 display is scaled to **0.539**, about 690 × 431 rendered pixels. A 22 px logical label is therefore about 12 screen pixels. The outer pads duplicate much of Play/Clips while squeezing their useful content.

**Change:** make a screen-focused desktop layout the default, with an optional hardware schematic for learning. Give the editor the available window, and retain compact pad/transport controls alongside or below it. Use native-sized screenshots when reviewing logical layout; assess rendered size separately. Do not equate logical 64 px buttons with 64 px browser touch targets after scaling.

### U08 · P2 · Important Device actions fall below internal scroll boundaries

**Measured:** the Device content region has 576 logical pixels of height. Captured scroll heights are Clips 590, Track 623, Library 713 and Project 688. Library's audition/load/kit controls sit after its result list. The four-row Clips home needs a small scroll even before more features are added.

**Change:** remove static instructional paragraphs from the main content flow, keep destination and primary actions fixed, and scroll only the content that benefits from scrolling, such as library results. All four clip rows, the selected target and record/launch state must fit together. Put legacy save/export settings in a secondary disclosure.

### U09 · P2 · Native Steps leaves valuable editor space unused

**Observed:** drum Steps uses two rows of large cells ending around y=439, with guidance around y=464 and a largely empty lower area before the status line at y=742. Native melodic rows are **32 px high**, smaller than the project's 44 px primary-control target; this is a geometry observation, not a touch compliance certification.

**Change:** spend the spare lower region on the selected hit's velocity lane and compact expression inspector. Display Velocity, Chance, Condition and Locks with clear selection and reset. Show recording quantize/strength separately from launch quantize. Melodic editing should offer vertical zoom and generous hit regions or a precision editor, with octave navigation. Keep step-page and clip-length controls visible.

### U10 · P2 · Clip performance needs persistent launch and focus context

**Observed:** native Clips displays a 4 × 4 window, despite the design's reference to an 8-track overview. It does provide selected and playing states and launch progress. However, the toolbar mainly gives range text; launch quantize, stop rows, fill, capture and off-window activity need a home as the TODO features arrive.

**Change:** show a compact performance toolbar with launch quantize, capture state and stop-all. Separate focused, playing, queued, recording and empty with symbols/text as well as color. Add per-track stop and scene launch affordances. Offer an eight-track overview with the current 4 × 4 pad window outlined; retain the larger cells as the detail view. For 16 tracks, page track groups explicitly rather than shrinking 16 columns onto the display. Show activity outside the current window.

### U11 · P2 · Mixer values look editable but are mostly selection labels

**Observed:** native Mix already fits eight strips and exposes mute/solo by touch. The emerald vertical bar is based on track volume, **not measured audio output**. Pan and sends are tiny repeated rows. Effects are in the audio model and UX design but lack a native effect-editing route on this page. Device Mix and Mute are simple track cards; Studio requires enabling its deeper mix section.

**Change:** make the volume bar a real touch fader with a visible handle, label its role, and keep measured signal meters distinct if added. Tap pan/send values to edit. Use a selected-track inspector for sends, inserts and return effects; preserve the eight-track overview. Allow return selection explicitly. Do not label a level setting as a signal meter.

### U12 · P2 · Song loses arrangement context and editable targets

**Observed:** native Song shows five list rows; tapping selects a block, while repeats, scene and order use knobs. Device Song appends/removes entries but lacks comparable in-row repeats/reorder controls. Capture exists natively and is already marked done in the TODO list.

**Change:** keep the scene-chain model primary: row number, scene name, repeat count, bar range, selected/playing state and capture state. Tap repeats to edit, tap scene to replace and use a drag handle to reorder. Make Append/Replace capture choices explicit and undoable. Keep capture armed/active visible while visiting Clips. A per-track timeline remains an open product decision; do not build navigation around it yet.

### U13 · P2 · Browse needs a destination-first layout before it grows

**Observed:** native Browse currently lists five project-pool sounds with selection and a target-pad knob, rather than external files/projects/kits. Device has a searchable metadata library, but target/action controls and results compete vertically. Neither should present future project/kit browsing as already implemented.

**Change:** one overlay with Projects / Kits / Samples categories, persistent `Load to Track … / Pad …`, search, results and a pinned audition/load row. Separate highlight, audition and assignment. Show duration/type/folder as useful secondary information, and keep unavailable/loading/missing states actionable. Preserve the invoking view and target on return. Content hashes should make moved projects resolve sounds rather than expose hash jargon to musicians.

### U14 · P2 · Studio organizes capabilities more than musical tasks

**Observed:** All panels is the initial Studio view. Pattern combines the drum step editor with note entry and automation forms. Sounds combines machines, pad mapping, waveform editing, step-note editing and recording. Perform mixes clip launching, arrangement and macros, with the actual clip grid under a disclosure. Repeated track/clip selectors and setup controls consume attention before the musical surface.

**Change:** open the last workspace or Clips on first use. Use a persistent compact project/transport/track context and a large central surface. Move sound editing into Sound, note expression into Steps, and detailed automation/effects into a contextual inspector. Make the clip matrix primary in Perform. Put diagnostics, virtual MIDI tests, legacy formats and engine setup in secondary controls. Enable required musical capabilities automatically where valid rather than making users understand backend activation.

### U15 · P2 · Save, playback and scope information need a stable location

**Observed:** Device save state is appended to the outer host note, outside the simulated display. Native header health indicators are five unlabeled dots. Project/track/clip names can be long; the native header lays left and right text independently, without reserving a shared collision-free boundary. Several screen bodies repeat static help also present in the status line.

**Change:** persistent compact project save state, track/clip/pad breadcrumb and transport mode; expandable health details with text for faults. Give title and transport fixed layout constraints and an intentional truncation policy with full-name access. Show selection separately from the clip currently sounding. Put static instructions behind Hold Shift/help, retaining transient recording, load and error messages in the status line.

## Every screen and recommended role

- **Native Clips:** the home performance surface; launch/stop/record with visible quantize and pad-window location. Preserve current clip progress and one-playing-slot behavior.
- **Native Play:** performance pads and current track sound; show octave, recording quantize and overdub target. Avoid duplicating Play and kit Sound without an editing distinction.
- **Native Steps, Kit:** step grid plus hit inspector and velocity lane; new-step defaults clearly separate from edits to an existing step.
- **Native Steps, melodic:** piano roll with Select/Draw, pad note entry, velocity and zoom; visible range and offscreen-note indicators.
- **Native Sound, Kit:** selected pad sample, waveform summary, Edit/Replace, tune/level/decay/choke; keep pad audition immediate.
- **Native Sound, Synth:** preset browser plus editable sound sections and a custom/pending state; preserve a playing-pad area.
- **Native Sound, MIDI:** destination, channel, note range and connection status; actual output still follows repository hardware guards.
- **Native Sampler:** define and verify its distinct machine/playing/editing route before presenting it as complete.
- **Native Sample:** input state/meter, record readiness, waveform, handles and keep/discard destination; source selection reserved for future resampling. Explain that sampling currently waits for playback to stop and lasts at most ten seconds.
- **Native Mix:** eight tracks, touch faders, mute/solo and a selected-channel/return effects inspector.
- **Native Song:** scene chain with repeats/bar ranges and capture status; direct reorder and scene replacement.
- **Native Browse:** one reusable destination-aware overlay; project pool is current scope, broader library is future work.
- **Native Menu:** keep the existing Track/Project grouping; make visible cards respond to taps and show current destination.
- **Device Clips / Play / Steps / Track:** align with native actions; screen-focused browser layout, machine picker and direct expression editing.
- **Device Library:** results scroll independently; target and audition/load stay visible.
- **Device Scenes / Mix / Mute:** fold scene launching into Clips and mute/solo into Mix to reduce mode switching, while keeping shortcuts.
- **Device Song:** parity with native scene-chain operations and capture status.
- **Device Project:** clear save/open/new/export hierarchy, visible packaging choice and missing-sample recovery; legacy formats secondary.
- **Device Menu:** mirror native Track/Project grouping and destinations.
- **Studio Play:** immediate playable instrument plus obvious path to edit the selected sound.
- **Studio Sounds:** focused machine/sample editor; recording as a related task rather than a permanently expanded form.
- **Studio Pattern:** large grid/roll with one context inspector; automation as a selectable lane.
- **Studio Perform:** clips first, chain second, macros in a performance strip.
- **Studio Mix:** channel overview and selected-channel effects; exchange/export kept reachable but secondary.
- **Studio All panels:** retain as an optional overview/debugging view, not first-use workflow.
- **Help / file recovery / manual:** contextual, non-obscuring guidance with focus restoration; disclose capability differences accurately. Missing-sample recovery has useful existing UI and should retain the current song until resolution succeeds.

## Layout and interaction contract for the next iteration

Use the native shell as the baseline: a 72 px header, 140 px right Q-Link column, 58 px status area and 1140 × 670 page area. These existing proportions already reserve roughly 25% of the screen for context/controls; reclaim space inside each page before adding more permanent chrome. The column should stay beside the physical knobs.

1. **Header:** project/save status, page and track/clip focus, position, tappable tempo and transport/record state. Reserve width for both ends and test long names.
2. **Task toolbar:** only current-task controls, such as launch quantize in Clips, note/page/length in Steps, or input/destination in Sample.
3. **Primary musical surface:** largest region; no explanatory paragraphs displacing pads, steps or waveform handles.
4. **Context inspector:** fit into existing spare space or a temporary sheet; do not add a permanent third sidebar to the Live. Reuse numeric editors and assignment pickers across pages.
5. **Q-Link column:** current page once, then four named values; each value tappable. Indicate existing-hit versus new-hit defaults explicitly. A continuous knob turn/drag is one history action.
6. **Feedback:** gold for focus/editing, emerald for playing/active, red for recording or faults, combined with text/icons. Distinguish queued changes from applied changes. Use readable mixed case for names and short uppercase section labels only.

Proposed target sizes are 44 px minimum and preferably 48–56 px for primary touch controls, following the repository's existing 44 px design target rather than claiming certification. Keep primary values around 24–32 px and ordinary native labels around 20–22 px where they fit. Validate at physical size with the owner; use spacing and hierarchy instead of packing more tiny labels into every cell.

## TODO integration and implementation order

**First: repair the interaction foundation.** Shared parameter editors, touch gesture phases, non-destructive selection, focus identity, Undo grouping and the browser/native control contract. Integrate the `Undo for every edit` and `Hold Shift for help` TODOs here. A new feature should use these foundations rather than inventing another control pattern.

**Second: finish sound-to-pattern.** Pad machine picker; Kit Edit/Replace; a shared sample editor; Synth sound sections; melodic pad entry; per-hit velocity; recording quantize with strength. Put step chance/conditions, parameter locks and Fill into the same Steps surface. Chance is already available through native knobs: the remaining work includes richer presentation, conditions and faster access, not starting chance from scratch. Q-Link pages, new-step defaults, Menu grouping, Sound presets and jam capture are already implemented and should not be re-added as missing work.

**Third: finish performance-to-song.** Launch quantize in Clips, track/all stop, relaunch, persistent capture state and editable chain blocks. Keep one-step undoable scene/clip variations. Delay the per-track timeline until the open product decision is resolved.

**Fourth: finish library and project continuity.** Browse projects/kits/samples; searchable metadata; content-addressed sounds; staged project loading with per-track readiness and cancellation. Reserve a project-transfer action/status for the bridge feature, but implementation must resolve direction and authorization: AGENTS.md forbids sending recordings/live input off the Live, and Wi-Fi does not authorize an inbound server. Do not silently bundle recorded inputs into transfer or create a new Wi-Fi listener. Existing allowed fixed-command tools remain the hardware boundary.

**Later:** resampling uses the Sample source selector; audio/NAM/SDK tracks use machine-specific Sound bodies; 16 tracks use explicit groups/banks. Network setup belongs in device settings with owner confirmation for chosen networks/pairing. Keep these features out of the main performance screen until implemented. Speed budgets should test real interaction latency and loading feedback; existing performance-audit timings must not be reused as new UI measurements.

## Workflow acceptance scenarios

- **Make a beat:** choose a machine on pads → choose/audition a kit → place steps → tap velocity to adjust → Undo → record with explicit quantize strength → save. No hidden Studio detour.
- **Replace one drum sound:** select track/pad → Replace → audition → Load → trim/tune in the same editor → return to the same clip; unrelated tracks stay unchanged after Undo and reopen.
- **Write a melody:** play/select a pad note → enter several steps → select a note without deleting it → change length/velocity/chance → switch octave while preserving context.
- **Capture a jam:** arm capture in Song → launch clips/scenes in Clips with visible quantize → stop one track → finish capture → edit block repeats/order → Undo capture as one action.
- **Sample:** show playback restriction before arming → record a synthetic input in emulation → trim with handles/fine controls → audition → keep to the displayed pad or cancel. Physical input recording remains owner-operated.
- **Mix:** adjust fader directly → pan/send via displayed values → choose insert/return → bypass/Undo while keeping the selected track visible.
- **Open/move projects:** retain the current project during failed/missing-sample load; show progress and playable-track readiness; preserve packaged versus referenced-sample choice. Transfer tests must use non-recorded synthetic assets and authorized routes only.
- **Stress the layout:** 8 tracks × 16 scenes, 64 steps, dense melodic notes, long Unicode names, empty library, missing assets, recording/capture/queued states, narrow browser windows and 200% desktop zoom. Confirm no header overlap and no clipped primary actions.

## Validation record

The capture scripts are host-only evidence helpers, stored in ignored artifacts rather than new product test infrastructure. Browser checks include step toggle/Undo, machine selection, scene-chain append, library search and expanded editor states. Automated rendering does not prove usability; the redesigned workflows still need an owner playtest at the Live's physical screen size.

Validation completed successfully:

- `npm ci`: completed; zero dependency vulnerabilities reported.
- `npm run check`: passed, including 60 test files / 363 tests, TypeScript and production build. Biome reported 40 existing warnings; Vite reported its large-chunk warning.
- `npm run parity`: passed, 9 files / 16 tests.
- `npm run inventory:test`: passed, 10 tests; these are utility tests, not device inventory access.
- `npm run native:test`: passed, 32 tests, including the interface and real-time symbol guards.
- Host native painter: compiled and rendered 12 states successfully; no device/audio APIs called.
- Browser audit: 27 captures plus the manual entry; no page exceptions. Confirmed Device step toggle/Undo, synth/MIDI selection, Song append and search; inspected expanded Studio mixing, performance and help. The local Vite server emitted existing public-asset import warnings. No physical sound, recording, drag or latency qualification is implied.

Logs and measurements are in the ignored audit artifact directory. The capture scripts ran against the current working tree, including pre-existing changes; these results are not a clean-commit release qualification.

## Implementation follow-up · 2026-11-15

The redesign is implemented in the native interface, browser Device and Studio. The original findings above are retained as the before-state, rather than rewritten as though the old gaps still describe the current product.

| Finding | Delivered change                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01     | Bounded value sheets, rename and named assignment choices; shared touch/knob semantic edits. Health opens labelled detail.                                                                                                    |
| U02     | Down/move/up/cancel input, sample handles, cancellable drafts, song dragging/autoscroll, one committed edit per gesture.                                                                                                      |
| U03     | Select/Draw and explicit Delete; touching an existing hit preserves it. Physical step pads retain fast toggling.                                                                                                              |
| U04     | Main/Shift+Main, track banks, Menu groups, contextual right Q-Link column and immediate undoable Copy aligned. The current backend differences are documented in device-ui.md.                                                |
| U05     | Pad-backed Kit / Sampler / Synth / MIDI picker; shared existing/new-sample editor, isolated replacement, synth ms/Hz values, internal MIDI routing choices. Chromatic Sampler replacements keep its single-sound note layout. |
| U06     | Native graph edits explicitly show Pending / applies on Stop. Prepared live graph swaps remain engine work.                                                                                                                   |
| U07     | Screen-first Device default; optional hardware teaching layout. Measured scale rises from 0.539 to 1.022 at 1440 px width.                                                                                                    |
| U08     | All primary Device views, populated sample/synth/MIDI and effects views fit the 670 px page region in the captured states. Browse results and effect lists have their own bounded scrolling.                                  |
| U09     | Velocity lane, direct expression/condition/lock inspector, recording-strength control and eight 44 px melodic rows. Native entry frames the first saved pitch when a note has not already been chosen.                        |
| U10     | Persisted launch grid (immediate/beat/bar/2/4 bars), track/all stops, scene launches, focus/playing/queued labels and eight-track overview.                                                                                   |
| U11     | Touch faders with visible handles, pan/send editors and track/return insert editors with bypass/remove/Undo. Level settings remain distinct from signal meters.                                                               |
| U12     | Scene/repeat editors, bar ranges, drag/button reorder and explicit Append/Replace capture.                                                                                                                                    |
| U13     | Destination-first categories/search/actions, browser WAV metadata/bundled kits/project opening and bounded native stick sample/kit/project browsing. Failed loads retain the current project.                                 |
| U14     | Last workspace restored; first use opens Perform. Clip matrix primary, explicit step tools, details folded by task, recording separated, model preparation automatic without opening audio.                                   |
| U15     | In-display save state, real native queued/completed/failed write feedback, constrained names, contextual Shift/help and labelled health detail.                                                                               |

Melodic pads now default to **C major** in Device, Studio and native UI. Chromatic and harmonic minor remain selectable in Device/native. Existing project pitches are unchanged. Continuous edits preserve a single Undo entry, canceled gestures restore Redo, and sample edits keep their source intact until Keep.

Native rendering checks also caught and fixed a toolbar clipping the bottom clip row and roll repainting over the expression inspector; a production-painter regression test now covers the latter. Numeric dialog keyboard focus, Escape, invalid bounds, sample dragging, melodic note entry, locks, FX installation/Undo, machine selection, library search and Studio workspace persistence were exercised in Chromium. All browser page-error collections were empty.

Validation for the implementation:

- `npm ci`: passed; zero reported dependency vulnerabilities.
- `npm run check`: 61 files / 372 tests, TypeScript and production build passed. Biome reports CSS-specificity and other warnings; the build retains its large-chunk warning. This is not a warning-free build.
- `npm run parity`: 9 files / 16 tests passed.
- `npm run inventory:test`: 10 tests passed; no inventory access was performed.
- `npm run native:test`: 33 tests passed, including filesystem bounds, UI/editing and callback symbol guards.
- `npm run bdd:device`: 23 scenarios / 221 steps passed. Expectations were updated for the explicitly changed control/Copy/C-major contracts.
- Production ARM session: compiled with the existing pinned ALSA/toolchain in the locked-down host container, without building or deploying a system image. Linker warnings about static glibc/ALSA remain; runtime compatibility is not newly qualified.
- Production native painter: 12 host memory captures; Chromium: all primary Device pages, expanded editing states and all six Studio workspaces, including a 1280 × 800 Device check. Native sample input is synthetic.

Evidence and scripts are in ignored `artifacts/ui-ux-implementation/`. These checks use the working tree, including the owner's pre-existing work. No hardware, port scan, device handle, flash, restart or deployment was used.

The forward-looking features in the audit are still forward-looking: background per-track project preparation/cancellation, safe native graph swaps during playback, live resampling/NAM/SDK engines, 16 tracks, external MIDI adapters and a per-track timeline. Project transfer still needs its direction and recording-data authorization resolved. The redesign supplies the relevant navigation/extension points; it does not claim those engines or undecided features have shipped. Physical touch, input recording, loading latency and musical feel still need an owner playtest.
