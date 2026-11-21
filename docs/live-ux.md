# XMP on the Live: interface design (draft 2, 2026-11-13)

The owner's brief, 2026-11-13. Now that MPC OS runs plugins, XMP has to be a different kind of instrument, not MPC OS with fewer features:

- **Speed and efficiency** first. Editing is deliberately less deep than MPC OS.
- **Clip-based multitrack songwriting** at the centre. One of the track types is samples, built on sampled drum kits.
- **Keep the basics of sampling and editing** from the MPC tradition.
- **An arrangement view**, secondary to the clip view.
- **A ground-up design.** It is not an iteration of the MPC60 lineage (programs, sequences and tracks inside sequences).
- **A modern interface** that uses the touchscreen and buttons efficiently, with hardware buttons wherever possible.

This document turns that brief into a design for phase 8 of [cpp-port.md](cpp-port.md). Items marked **Open** are the owner's decisions.

For the community hardware baseline, [Gate 2](launch/gate-2.md) records the tested candidate and remaining checks. Native autosave waits until playback stops: wait for **Saved on stick** before restarting. Input sampling remains **experimental and physically unverified**; output-tap captures and browser demonstrations do not qualify the physical inputs.

## Implemented interaction revision · 2026-11-15

The UI audit implementation adds direct numeric/rename/assignment sheets, complete touch down/move/up/cancel gestures, sample-boundary dragging, song reordering, Select/Draw step tools, expression/condition/lock editing, 44 px melodic rows, an eight-track Clips overview, project launch grids, touch mixer/effect editors, and a bounded stick library for samples/kits/projects. The machine picker distinguishes Kit, chromatic Sampler, Synth and MIDI; a track with no machine chosen yet (no machine, no kit of its own and no notes, such as a new song's tracks 2–8) opens its Sound page on that choice, pads 13–16 or touch; melodic playing defaults to C major without rewriting stored pitches. Sampler replacement keeps its one-sound note layout. Song capture has explicit Append/Replace choices and bar ranges. Header save state distinguishes queued writes, completed writes and failures; health dots open labelled detail.

The browser Device adopts the same page groups, track banks, Q-Link column and undoable Copy contract. It opens with the Live Mk1 panel around the Device screen. [device-ui.md](device-ui.md) is the current control reference; older prose below remains the original design rationale where not explicitly marked implemented.

Sound/effect graph changes still apply when playback stops and display that pending state. Stick file reads are bounded main-thread operations; background preparation/cancellation and physical loading latency are not qualified. MIDI Sound currently exposes internal destinations rather than opening external ports. Resampling, native NAM/SDK, 16 tracks and per-track arrangements remain later work. These changes were tested on the host and compiled for ARM, without running or modifying any instrument. See [ui-ux-audit.md](ui-ux-audit.md).

## How XMP differs from MPC OS

|               | MPC OS                                                            | XMP                                                                   |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit of music | A sequence: one timeline holding every track                      | A clip: one track's loop. Scenes group clips                          |
| Sound sources | Programs (drum, keygroup, plugin) assigned to tracks              | Every track _is_ its instrument: Kit, Sampler, Synth or MIDI          |
| Song          | Song mode: a list of sequences                                    | Song: a chain of scenes, built by playing                             |
| Editing       | Deep: event lists, many sample-edit modes, effects in many places | Shallow and fast: the handful of edits that matter, all undoable      |
| Navigation    | Menus of modes                                                    | Six views, one button or Menu+pad away. The screen shows; buttons act |

## Principles

1. **One press for the common thing.** Record into an empty slot, launch, duplicate, undo: each is one button, or Shift and one button. No confirmation dialogs; everything is undoable.
2. **Hardware first, touch second.** Buttons and knobs do everything you do while playing. The screen is for overview and for direct manipulation that a knob can't express (dragging a sample's start, reordering the song).
3. **The four knobs always mean the four most useful things** for whatever has focus: a pad, a track, a clip, the mix. Touching a knob shows its name and value large on screen. No paging through banks for the basics.
4. **Never stop the music.** Every view can be entered while playing, and changes land on the next bar or step, as the transport already quantizes launches.
5. **Defaults that finish the work.** A new clip takes its length from what you played. Recordings are trimmed and normalized. Slices land on pads. A kit's hats choke each other.
6. **Shallow but honest.** Where XMP has fewer options than MPC OS, the options it has are complete: undo, duplicate and quantize work the same everywhere.

## Track types

Eight tracks (decided 2026-11-13), each one instrument with up to 16 clips. More track types will come later ([future.md](future.md)); these four are the start:

- **Kit:** 16 pads, each with its own sample, level, tune, decay and choke group. The 808 and 909 kits are built in; WAV kits load from the stick.
- **Sampler:** one sample played chromatically or sliced across the pads (by transient or by grid).
- **Synth:** XMP's subtractive synth with its presets.
- **MIDI:** notes to an external instrument (authorization 5).

**Format change (done, project format 7):** a track may hold its own kit of 16 pads (`track.pads`); tracks without one play the project's shared 16 pads, as every track did before. Older projects open unchanged and sound the same, since no track has a kit of its own until one is given (the Device view's Track page, or `ownKit`). Samples stay one pool shared by every kit (up to 256 samples and two million mono frames), so a sound several kits use is stored once. Sound and kit loads go to the selected track's own kit when it has one; a MIDI track routed to a kit plays that kit's pads.

## Views

Clips, Play and Steps have their own buttons (Main, Shift+Main, 16 Level); every view is also Menu and a pad away (see the control table). The screen has no navigation buttons of its own: the Live's buttons move between views, and touch is for what a view shows.

1. **Clips** (home): the grid of 8 tracks by 16 scenes on screen. Scenes may share a clip; a track plays one clip, and only the slot it was launched from lights (pressing another slot holding the same clip launches from there). The pads show a 4×4 window of it: the four tracks of the selected track's half (1–4 or 5–8) by four scenes; – and + move the window four scenes. Selecting a track with no machine opens its machine chooser first; returning to a configured track keeps its machine. Tap an empty slot to create a 16-step clip in that track and scene. Clip creation is undoable and keeps other tracks playing. Pads launch clips; an empty-slot pad stops that track or selects the empty slot for REC. Pressing the data wheel on a scene's row launches the whole scene.
2. **Play**: the pads play the selected track (a kit's 16 sounds, or notes for Sampler, Synth and MIDI). The knobs control the selected pad or the sound. Record overdubs into the playing clip. Note repeat and full level are one button each.
3. **Steps** is a 16-step view of the selected clip and pad (built 2026-11-13). In an empty slot, tap **Create clip**, press pad **13**, or press the data dial to create a 16-step clip in that track and scene. Undo removes the newly created clip. Clip length opens a page-filling numeric editor with matching touch and pad shortcuts. The pads toggle steps, with steps 1–4 on the top row. Shift + pad chooses the pad (kit) or note (synth). Erase + pad clears it. The data wheel pages through 16, 32 or 64 steps. Edits save to the stick once the music stops. The knobs set velocity, chance, length (synths) and position (Move, in whole steps) for the selected step (built 2026-11-14). On synth and MIDI tracks Steps is a piano roll with twelve pitches by sixteen steps. Use − / + to move the edited note (Shift moves by an octave) or touch the roll to add or remove a note (built 2026-11-14).
4. **Song** (arrangement, secondary): the scene chain as a list on screen (built 2026-11-14). Press a scene's pad to add it after the selected block. Knobs set repeats, move the block, set the end and change its scene. Play the song from any block. Capture (built 2026-11-15): REC in the Song view arms it; play and launch scenes or clips from any view, and every change in the clips heard becomes a block of the scene that holds them (a new "Jam" scene when none does), repeated for as long as it played; Stop, or REC in the Song view, writes the blocks after the selected one, and one Undo takes them back. **Open:** a scene chain only, or also a per-track timeline later.
5. **Sample**: the shared native touchscreen records and edits a take. With a constant tempo during playback, REC queues a fixed-length take for the next bar; four bars is the default, with one- and two-bar options. The take replaces the selected sample and clip in one undoable edit, and loops while the prepared engine enters playback at a matching loop boundary. Other tracks keep playing. Stopped recording retains the threshold-start, ten-second workflow. Monitoring defaults on, including between takes on sampler tracks; the Sample page has a Monitor toggle. Input loss, cancellation or tempo changes cancel an unfinished timed take and preserve the previous sample. Start/end, fades, tune, reverse and level remain available. Equal, beat-grid, transient and manual markers define the exact pad previews. **Chop to drum kit** creates this track’s own one-shot slice kit and silences unused pads; Undo restores it. Keep assigns only the selected pad or the marked slices that fit after it. The browser uses this C++ screen through WebAssembly, with browser audio/file adapters. Synthetic tests qualify musical timing and persistence; physical Live input latency and acoustic monitoring still require hardware verification.
6. **Mix**: 8 strips with level, pan, two sends, mute and solo; the knobs are the selected strip's (built 2026-11-14; the top pads select tracks, the bottom pads mute them, Shift + a bottom pad solos). Effects are two per track and two per return, with the existing six effects.
7. **Sound** (Menu + pad 16, built 2026-11-15) shows the selected track's sound. A synth shows a 4×4 grid of 16 presets, with pads 13–16 on top. Tap a preset or press its pad to select it. Use **Next presets** or − / + to switch banks. Hold **Shift** while pressing a pad to play the current sound. The knobs set tone, attack, decay and release. Undo restores any knob changes that selecting a preset replaced. For a kit, Sound shows the 16 pad names and the pads play their samples. The Live applies sound changes when playback is stopped.

**Browse** lists samples, kits and projects. Hold **Shift**, tap **Menu**, then release both to open it. On Kits and Projects, the visible rows are selectable starting on pads **13–16**. Pad **8** loads the selected item. Open another set of rows with the data dial. On Samples, hold **Shift** to use the labelled list shortcuts. Plain pads still choose the target pad.

**Project** (hold Menu and press pad **5**) maps **New**, **Open**, **Save** and **Save As** to pads **13–16**. Confirm or cancel using the pad labels in the dialog. Menus begin with the top pad row and continue downward. On the playing and editing pages, hold **Shift + Menu** to see the shortcut labels for the footer buttons. Release that combination without choosing a button to toggle Browse. The machine picker uses pads **13–16** for Kit, Sampler, Synth and MIDI.

**The screen** (2026-11-15): the header across the top, the page on the left, its status line along the bottom, and the four Q-Link knobs' names and values in a narrow column on the right, beside the knobs themselves, Q1 at the top.

## Using the Live's controls

The labels are the ones printed on the Live Mk1, from Akai's MPC Live user guide (top panel, items 1–22). Each button keeps its usual MPC meaning where XMP has one; the screen shows what a button will do whenever it differs.

| Control                        | XMP                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pad bank A–D                   | Select track 1–4 (owner, 2026-11-13)                                                                                                                                                                                                                                                                                                           |
| Shift + pad bank A–D           | Select track 5–8                                                                                                                                                                                                                                                                                                                               |
| Main (Shift: Track)            | The Clips view (Shift: the Play view of the selected track)                                                                                                                                                                                                                                                                                    |
| Menu (Shift: Browse)           | Hold Menu and press a pad to open a page. Hold for three seconds and release to keep Menu open. Choose by touch or pad, or tap Menu to close it. The top pad row opens Play, Steps, Sample and Sound. The second opens Clips, Song, Mix and Browse. Pad 5 opens Project. Shift + Menu toggles Browse.                                          |
| 16 Level                       | The Steps view: XMP's 16 steps on the 16 pads                                                                                                                                                                                                                                                                                                  |
| Note Repeat (Shift: Latch)     | Note repeat, as on the MPC                                                                                                                                                                                                                                                                                                                     |
| Full Level (Shift: Half Level) | Fixed velocity, as on the MPC                                                                                                                                                                                                                                                                                                                  |
| Erase                          | Hold and press a pad: in Play and Steps, erase that pad's notes from the playing clip; in Clips, erase that clip                                                                                                                                                                                                                               |
| Copy (Shift: Delete)           | In Clips, press and release Copy to copy the focused clip to the next pad pressed, or hold Copy and press source then target. Copies are independent and undoable; other scenes keep their clips. Shift+Copy unlinks the selected slot and immediately stops its audio if that slot is playing. Copying pad sounds remains pending             |
| Undo (Shift: Redo)             | Undo and redo, everywhere                                                                                                                                                                                                                                                                                                                      |
| Tap Tempo                      | Tap the tempo. Shift+Tap Tempo turns the metronome on or off (proposal)                                                                                                                                                                                                                                                                        |
| Q-Link button (Shift: back)    | Cycle the knob pages, named in the strip: in Steps, STEP (the selected step), NEW STEPS (the velocity, chance and length new steps get), TRACK (level, pan, sends) and SOUND (the machine's parameters: a synth's tone, attack, decay and release); elsewhere TRACK and SOUND. Song, Sample and Browse keep their own knobs (built 2026-11-15) |
| Q-Link knobs 1–4 (touch)       | The focus's four parameters; touching one shows its name and value large on screen                                                                                                                                                                                                                                                             |
| – / +                          | In Clips, the previous or next four scenes; elsewhere, step the selected value                                                                                                                                                                                                                                                                 |
| Data wheel                     | Turn to select (clip, step, sample position); press to confirm or open (Clips: open the clip in Steps; Song: append the selected scene; Sample: set the point under the cursor); Shift+turn for fine steps                                                                                                                                     |
| Play / Play Start / Stop       | Play from the playhead, from the scene's start, stop (twice: silence everything)                                                                                                                                                                                                                                                               |
| Rec                            | Record into the selected empty slot with a one-bar count-in; the clip's length comes from what you play (built 2026-11-14: one, two or four bars, ended by Rec)                                                                                                                                                                                |
| Overdub                        | Record onto the playing clip                                                                                                                                                                                                                                                                                                                   |
| Touchscreen                    | Select anything visible, drag sample boundaries and song blocks, long-press for an item's options                                                                                                                                                                                                                                              |

**Button codes:** every labelled button has its code (2026-11-13). The codes from the owner's session 4 match, code for code, the MPC button numbers the open MPC mapper publishes, so the labels in `os/live-mk1/hardware.json` (`controller.map.labels`) need no press-through. Only the data wheel's press (6F) is still to be seen in a session.

The four red Q-Link page LEDs follow the active group. Steps uses all four, and Track and Sound use the first two elsewhere. Pages with dedicated knobs use the first LED. Native feedback uses the Live Mk1's internal Private controller port under the Q-Link LED amendment in `AGENTS.md`.

On 2026-11-19 the owner verified on their MPC Live Mk1 that the two Clips pages light LEDs 1 and 2, and that cycling Q-Link in Steps lights LEDs 1 through 4 in order. The fourth red LED lit on Sound.

## Not in XMP, by design

- Event-list editing, MIDI CC lanes beyond the existing automation, and per-note articulations.
- Sample time-stretching modes, multi-sample keygroups beyond velocity layers, and resampling chains. Resampling (recording the master output to a new sample) is not in the first version ([future.md](future.md)).
- Programs as separate objects, and nested menus deeper than one level.
- Third-party plugins on the Live. Akai's MPC OS has them now; on the Live, XMP stays self-contained (the browser keeps its SDK machines).

## What exists today, and what is new

- **Already in the core:** tracks with clips and scenes, the song chain with repeats and resume, kits, the sampler and synth engine, launches quantized to the bar, mute, solo and macros, automation and step locks, the mix and its effects, and undo-able edits. All of it now runs in C++ on the Live (phases 0 to 5).
- **New:**
  - per-track kits (project format 7);
  - recording from the inputs (authorized on 2026-11-13: AGENTS.md authorization 7);
  - the views and controls above, drawn on the Live's 1280×800 screen by the session.
- **Browser (proposal):** the browser studio stays the editor for deep work, and the Live is the instrument. Both open the same projects.

## Decisions

Made by the owner on 2026-11-13:

1. **Tracks:** eight, with the pad bank buttons selecting tracks 1–4 and Shift with them tracks 5–8. More track types come later.
2. **Sampling:** authorized (AGENTS.md authorization 7).
3. **Controls:** the data wheel presses; the labels are the Live Mk1's printed ones (above).
4. **Resampling:** not yet; tracked in [future.md](future.md).

Still open:

- **Song:** a scene chain only, or also a per-track timeline later?
- **Clip pads** (built 2026-11-13, open to change): while stopped a clip pad plays that clip alone; while playing, pressing the clip that plays stops its track at the next bar.
