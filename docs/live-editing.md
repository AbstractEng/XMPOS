# Live editing and clip navigation

The Device UI is the shared C++ touchscreen in the browser, emulator and native
build. These changes do not require a transport restart:

- Choose or replace a machine or preset while another track plays.
- Add, remove or bypass a track or return effect.
- Adjust track level, pan, sends and sound parameters.

Replacement racks are prepared on the control thread and handed over at an
audio-block boundary. Compatible sounding voices are rebound to the replacement
sample storage; unchanged effect chains retain their histories. The callback
does not allocate, free storage, lock or perform I/O. Retired storage is reclaimed
on the control thread.

## Longer and custom clips

Clip length accepts whole numbers from 1 to 1024 steps. In 4/4, 16 steps make one
bar. A length such as 37 therefore includes a final partial bar. Its valid steps
remain editable, and notes, conditions, locks and automation can extend beyond
step 64. Shortening keeps the existing destructive-edit confirmation and Undo.

In Steps, turn the data wheel or hold Shift and turn Q4 to move between bars.
Q4 also selects the bar on the New Steps Q-Link page. Prev bar and Next bar are
available on screen. Follow starts enabled and follows the audible bar of the
selected playing clip. Manual browsing pauses follow so the view stays put
while editing; press Follow to resume it. The same navigation is available in
the piano roll.

## Level and tempo

Level controls have a cubic audio taper: halfway travel is approximately −18 dB,
the bottom is silence and the top is unity. Stored gains remain linear
amplitudes, preserving existing mixes. The Q-Link level readout uses decibels.

Changing the tempo entry previews it while playback continues. Apply keeps it
as one undoable edit; Cancel restores the original tempo. Scheduling is
re-anchored at the audible position and already queued timing is updated.
The displayed tempo preserves fractional values.

Tap the physical or browser TAP button on quarter notes. The second tap starts
setting tempo; subsequent taps average up to four intervals. Very short bounces
are ignored, and a gap longer than two seconds starts a new tap sequence.

## Regression coverage

- `native/tests/live_changes_test.cpp`: actual PCM, sustained-note continuity,
  live machine/effect changes, navigation, custom lengths, preview/cancel and TAP.
- `tests/native-device-audio.test.ts`: the exact shipped Wasm, silent rendering,
  live synth selection, TAP and portable reopening of custom clips and step 128.
- `tests/live-editing-surface-parity.test.ts`: identical native/Wasm pad and
  touch fixtures; control pixels and the saved portable project must match.
- `features/28-live-editing.feature`: eight production-host Gherkin cases,
  included in the implemented regression profile.
- `tools/check-rt-symbols.mjs`: audits the compiled live callback and handover
  independently from preparation and filesystem code.

Validation runs on the Mac in software hosts. These checks do not constitute
physical hardware latency qualification.
