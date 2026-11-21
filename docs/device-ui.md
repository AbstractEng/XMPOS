# Device workflow and Live Mk1 profile

Device is the browser default and opens with the MPC Live Mk1 panel. `?view=studio` opens the desktop detail editors. Show screen view (`?layout=screen`) enlarges the 1280 × 800 logical display and keeps the stacked transport and shortcuts. Show hardware layout brings back the pad grid and Q-Links. Both browser workspaces share validated projects and local persistence. Switching to Studio waits for the save.

The panel surrounds the same Device screen in both browser layouts and in the Chromium emulator. Physical controls on a future MPC model can use their own arrangement and map to the same Device actions. The Live's native touchscreen renderer follows the same Device page and action contract.

## Musical workflow

- **Clips:** four tracks by four scenes, or an eight-track overview. Focus is gold; playing and queued states have text as well as colour. The grid fills the page: scene launches on the left, track stops along the bottom, and ▲/▼ in the two corners (or the mouse wheel or a swipe) to scroll through the scenes four at a time. Touching the selected clip again opens it, or creates an empty clip. Launch timing and the 4/8-track choice live in MENU → Preferences; STOP stops everything.
- **Play:** Kit, chromatic Sampler, Synth or MIDI. Melodic pads default to **C major**, starting at C3 (MIDI 48). Chromatic and C harmonic minor remain optional in Device/Live. Changing the playing scale does not transpose saved notes.
- **Steps:** Select inspects an existing hit; Draw toggles. Delete hit is explicit. Melodic clips use an eight-row piano roll with 44 px logical rows and a note ribbon. Velocity, chance, duration, condition and locks share the focused hit. Record quantize strength is separate from launch quantize.
- **Sound:** choose the machine by a visible picker or pads 1–4. Kit sample Edit/Replace, chromatic Sampler, synth presets and parameters, and internal MIDI routing have distinct controls. Sample edits isolate the track's kit. Synth values use Hz, ms and percent.
- **Sample:** import an original WAV or edit the selected pad's sound; drag start/end or tap values; preview, Keep or Discard. Keep is one undoable project edit. The browser does not open a microphone. Native input recording remains owner-operated and bounded to ten seconds.
- **Mix:** eight touch faders, mute/solo, pan/sends and selected-track/return effects. These bars show level settings, not measured output meters.
- **Song:** scene chain with editable scenes/repeats, bar ranges, drag or button reorder, and Append/Replace jam capture. Capture is one Undo.
- **Browse:** Samples / Kits / Projects, persistent target and audition/load actions, independently scrolling results. The browser indexes WAV metadata from a chosen folder and offers bundled original kits and project opening. The native session scans bounded WAV/kit/project metadata only under its configured stick library root. Highlighting does not assign a sound.
- **Project:** save/open/new and portable export; packaging remains explicit and legacy export secondary. Loading errors retain the current project.

Tap a displayed editable value for a bounded sheet; Apply commits and Cancel preserves it. Names open rename; assignments open a picker. Read-only status opens relevant detail where available. Continuous fader changes share one Undo. Save state is inside the display. Native sound/FX changes that require graph preparation explicitly say **Pending sound change · applies on Stop**.

## Control contract

Pad numbering is bottom-left first:

```text
13 14 15 16
 9 10 11 12
 5  6  7  8
 1  2  3  4
```

| Control                | XMP action                                                                       |
| ---------------------- | -------------------------------------------------------------------------------- |
| Main / Shift+Main      | Clips / Play                                                                     |
| Menu / Shift+Menu      | Grouped page launcher / Browse                                                   |
| Menu pads 13–16        | Play, Steps, Sample, Sound                                                       |
| Menu pads 9–12         | Clips, Song, Mix, Browse                                                         |
| A–D / Shift+A–D        | Tracks 1–4 / tracks 5–8                                                          |
| Steps pads / Shift+pad | Toggle the corresponding step / select note or drum sound                        |
| Steps data dial        | Previous/next 16-step page                                                       |
| Q-Link                 | Step / New hits / Track / Sound in Steps; Track / Sound elsewhere                |
| Copy, then destination | Independent copy immediately; Undo restores                                      |
| Shift+Copy             | Unlink the slot; retained clip data, undoable                                    |
| Rec in Song            | Arm/finish jam capture                                                           |
| Note Repeat            | Native: hold Fill; browser panel: toggle Fill. Clocked repeats remain in Studio. |
| Undo / Shift+Undo      | Undo / Redo                                                                      |

The browser uses fixed pad velocity. Native physical pad velocity remains available. Sample import/recording, stopped clip launching, and file providers differ by backend; host rendering does not prove driver or touch qualification. MIDI editors here route to validated internal tracks; they do not discover or open external MIDI ports.

## Studio

Studio restores the last workspace and opens Perform on first use. The clip matrix is primary; song/macros, note/automation detail and recording are disclosures. Pattern has explicit Select/Draw tools. Editable range outputs open numeric sheets. Entering Perform or Mix prepares its model without opening audio; audio still requires the normal user action.

## Validation and boundaries

`npm run check`, `npm run parity`, `npm run inventory:test`, `npm run native:test` and `npm run bdd:device` cover the implementation. See [ui-ux-audit.md](ui-ux-audit.md) for the dated implementation evidence and limits.

No hardware was contacted for this redesign. The Force remains protected. ARM compilation and native memory rendering are host checks, not deployment or physical qualification. External project transfer, background per-track project preparation, live native graph swaps, 16 tracks, new track engines and a per-track timeline remain future work or open decisions in [future.md](future.md).
