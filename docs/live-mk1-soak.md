# Live playback and UI soak

Run only against the owner's authorized Live Mk1 XMP session, using the existing bridge and private per-stick token. This host harness uses fixed bridge commands; it never flashes, runs a remote shell, changes the project, arms input recording or reads internal storage. The Live needs its mains supply and the FTDI bridge cable; the Mac must stay awake.

```sh
node tools/live-mk1/live-soak.mjs 8 <verified-dynamic-template> <matching-owner-image-directory> reports/live-mk1/<new-soak-directory>
```

Duration is bounded to one minute through twelve hours. Before a long run, test one minute (`0.016666666666666666`) and inspect its result. A host `caffeinate -i` wrapper can prevent idle sleep for the process lifetime. Keep source reports private: they can include project details, screenshots and bridge logs. The report directory is new and the files grow by a bounded amount (minute samples and two-second output captures hourly). A small disk reserve is released before shutdown logging if a write fails.

The harness verifies candidate binary/library fingerprints and establishes the original **Night Shift, six tracks/five scenes** workload from the session log. It loops the current scene, rotates Clips/Mix/Song/Sound/Play/Steps once per minute through the tested menu controls and keeps the session active without changing idle settings. It records status once per minute, takes bounded original-output captures at the start/hourly/end, and checks the session log periodically. No live-input recording/export is part of the test.

Faults include lost services/recording state, changed fingerprints, stalled/reset audio counters, unexpected stop, new xruns or late notes, output above −12 dBFS, DSP processing above its 256-frame/48 kHz budget, refused navigation or an observation gap over two minutes. Thresholds are set before starting. On failure/completion it releases held modifiers, stops playback, returns to Clips, records whether the stop was confirmed and closes the bridge. A lost link can leave stop unconfirmed; that is a failed test, never a pass.

`result.json` is updated during the run and contains state, start/expected-end times, tested source/image identities, observed maxima and final outcome. `samples.jsonl` holds individual observations. The recorded audioWorstMs/audioLoad are **DSP processing metrics**, not the entire output callback or physical latency. Memory, temperature, callback p99 and active-voice/maximum-track capacity are unmeasured. A pass is an eight-hour playback/UI soak for this workload, not full R04 worst-case qualification or installation/stock recovery evidence.

To cancel a detached run, send SIGTERM to the Node PID in result.json. The harness checks cancellation between bounded commands/polls and attempts the same stop sequence. The host launcher must retain its process/log metadata; it must not leave an unbounded playback job.

After preserving a failed qualification, an explicitly labeled diagnostic continuation may append `diagnostic` to the command. It records late-note findings without aborting for that already-known scheduling issue; all other stop conditions remain. **A diagnostic continuation always has passed: false**, even if it completes, and cannot close qualification or erase the failed run. Its counters are relative to the recorded baseline; the device's worst-lateness metric remains cumulative since the session started. Use the samples' newLateNotes for interval counts.

## Observed result, 17 November 2026

The initial strict run failed after 18 minutes 39 seconds with three late scheduled notes. A separate diagnostic continuation ran for 7 hours 13 minutes 40 seconds and stopped playback cleanly at the owner's requested cutoff, 07:29:32 America/Toronto. It recorded 25 additional late notes (28 cumulative), with worst cumulative lateness of 17 ms. Both runs recorded zero new audio-driver underruns; peak output remained below −12 dBFS. Worst observed DSP processing was 1.94 ms, which is not a physical latency measurement.

These observations apply to the workload above and frozen source content hash `3b800ea50a3b9a2f1cbd53e20a81efc746caf3ab790a6971d39acb2a173c0432`, not to later source changes. Neither run passed soak qualification. The scheduling issue remains open and its cause is unconfirmed. This test does not establish installation or stock recovery.
