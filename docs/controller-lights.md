# Live Mk1 light feedback

The native Device UI computes one `PanelLights` snapshot. The browser hardware
view paints that snapshot, and the Linux session sends it through the guarded
Live controller adapter. Neither adapter independently decides musical state.

| Control                 | Light                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Play                    | On while transport plays; off after Stop                                                 |
| Record                  | On during recording or sampling; flashes while waiting for the take                      |
| Overdub                 | On while overdubbing                                                                     |
| A–D                     | Selected track 1–4 is steady; selected track 5–8 flashes on the corresponding A–D button |
| Full Level              | On while Full Level is enabled                                                           |
| 16 Level                | On in Steps, including piano roll                                                        |
| Note Repeat             | On while held (the existing Fill action)                                                 |
| Tap                     | Pulses on quarter-note beats during playback                                             |
| Q-Link page             | One of the four page lights                                                              |
| Play pads               | Strike velocity determines hue: blue → green → amber → red; release fades the light      |
| Steps / piano roll pads | The current audible step lights its matching physical pad, on the displayed bar          |
| Clip pads               | Dim amber for a clip, green while playing, flashing amber while queued                   |

Time on the step pads reads left to right from the top row: physical pad 13 is
step 1, physical pad 1 is step 13. A manually browsed bar does not show a false
playhead from another bar. Menus and numeric editors suppress the musical pad
lights while those pads act as shortcuts.

The browser chassis uses original CSS artwork: charcoal casing, rubber pads,
recessed screen, bevelled keys, rotary controls and matching coloured feedback.
It does not include vendor graphics. Pointer pressure is used when provided by
a pen or touchscreen; mouse and keyboard hits use the existing default velocity.

## Output boundary

Owner authorization 9 in `AGENTS.md` records the requested expansion. The
adapter opens only the verified internal Live controller after full startup.
Button and Q-Link feedback uses Private port CC messages; RGB pads use only the
fixed Live pad-colour display SysEx on Public. It sends changed values only,
finishes partial frames before newer snapshots and disables a failed output.
Shutdown makes a bounded attempt to clear the lights. There is no raw output
command in the bridge or browser.

Mapping source: MPC-LiveXplore-libs commit
`df1be83ec209a1e8be63759bb05fa217b4f0d0ae`, `tkgl_midimapper.h`,
`DeviceSetPadColorRGB` and `MPCSetMapButtonLed`.

Regression coverage checks actual light state in native and shipped Wasm,
matching native/browser snapshots, MIDI framing, partial writes, seven-bit RGB,
invalid output refusal and the existing controller identity restrictions.
Physical LED colour calibration and response remain hardware checks; this
change is developed and tested on the Mac without operating an instrument.
