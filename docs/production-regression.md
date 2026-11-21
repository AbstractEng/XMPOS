# Music production end-to-end regression

The default `npm run bdd:e2e` gate exercises the shipped C++ Device workspace. It builds the native fixture runner, replays 63 identical project actions in native and browser builds, compares 12 screenshots and the saved project, checks all seven factory kits and 32 synth presets, then verifies four sampler input/chopping journeys and the mobile manual. The sampler cases use Chromium's synthetic microphone, isolated IndexedDB, the real input worklet and C++ recording engine; no physical audio or instrument is accessed. Playback continues through the four-bar take, other tracks and optional extension data survive, and the resulting song reopens through the shared codec.

`npm run check` also replays all sixteen written tutorial lessons and checks their saved music. `npm run parity` includes the same next-bar recording fixture through the native and browser workspaces. `npm run bdd:sampler` reruns the sampler browser cases against an existing production build.

The old DOM Device app was removed when the native touchscreen became the source of truth. Its Gherkin bindings below still name retired controls such as “Project & files” and `#device-project-file`; they cannot qualify the canvas UI. They are retained under `npm run bdd:legacy:e2e` as migration references, and currently fail against the shipped interface. They are not reported as passing or included in the current Device gate. Advanced routing/export backend contracts remain in the core/native suites; their former DOM journeys do not establish equivalent visible controls on the native touchscreen.

## Historical DOM journeys

The historical use cases are in [features/20-production-e2e.feature](../features/20-production-e2e.feature) and [features/21-internal-midi-routing.feature](../features/21-internal-midi-routing.feature). They exercise the built Device view in Chromium through its visible controls, using real IndexedDB, real project imports/downloads, and the production Web Audio and AudioWorklet code. No controller, storage or audio mocks replace the app. MIDI journeys attach an analyser to the real worklet output and inspect paired internal MIDI events. Chromium's physical audio output is disabled; these runs do not measure audible output, physical latency, drivers or hardware support.

| Use case                              | User journey and acceptance evidence                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01: Make a drum loop                 | New song → index an original WAV folder → load kick/snare/hat → program a 120 BPM beat → play/stop → download project and stereo WAV. Check exact steps, embedded sample lengths, sample rate, duration and nonzero audio. |
| E02: Layer a bass and vary the chorus | Add a synth to track 2 → enter pitched notes → copy to scene 2 → add a higher note → undo/redo. Check original notes, destination variation, machine identity and unchanged drums in downloaded projects.                  |
| E03: Build a song                     | Arrange verse → chorus → verse as distinct occurrences → play to completion. Observe all three bars and automatic stop; verify saved occurrence order and identities.                                                      |
| E04: Balance and mute                 | Bounce at full and half track level → mute → bounce → unmute. Verify half amplitude, equal duration, silent muted output and restored mix.                                                                                 |
| E05: Continue and transfer work       | Wait for autosave → reload → download → open in a separate empty browser context. Verify identical samples, machine state and notes, playback/export, and no dependency on the original sample folder.                     |
| E06: Protect an existing idea         | Cancel clip removal → attempt a hash-damaged import → confirm removal → undo. Verify visible error/confirmation and preservation/restoration of the entire project.                                                        |
| E07: Capture a performance            | REC → PLAY START → finger-drum two sounds → STOP → undo/redo. Verify both sounds are captured and the entire take is a single undoable edit.                                                                               |

MR01–MR04 add MIDI synth composition, sampler drum playback and destination mute, autosave/portable transfer and undo, plus unavailable/cyclic route rejection. These four journeys verify nonzero real-worklet output, exported audio and silence after disconnecting or muting; see [routing behavior](midi-routing.md).

The [mobile manual scenarios](../features/22-manual-mobile.feature) add eight cases: quick-start reading at 320, 390, 768, 844 (phone landscape) and 1280 pixels; phone navigation/search and local table scrolling; enlarged text; and a JavaScript-disabled fallback. They check page overflow, anchor visibility under the sticky header, readable search controls and touch targets, and retain viewport screenshots. Run `npm run bdd:manual` for the manual checks, including the hardware setup guide. The full `npm run bdd:e2e` suite also covers portable songs, full-song workflows, machine pages, the data dial, and clip length. [Portable songs](../features/24-portable-songs.feature) · [Full-song workflows](../features/25-full-song-e2e.feature) · [Machine pages and editing](../features/26-machine-pages.feature)

Run on the Mac or a Linux development host with Node 24:

```sh
npm ci
npx --no-install playwright install chromium
npm run bdd:e2e
```

Playwright is pinned to 1.56.1 for the development Mac's macOS 13 compatibility. Use its matching downloaded Chromium, not a personal Chrome profile. All browser requests are restricted to the runner's ephemeral loopback origin. Device, capture and MIDI APIs are guarded and must have zero calls. The production Permissions-Policy also denies those APIs. No Force or MPC is used, and existing browser songs are isolated from these disposable contexts.

`npm run regression:desktop` runs the implemented host Gherkin contracts and the built-browser journeys. `npm run regression` adds the Device VM and portable-song VM suites. GitHub checks run on manual dispatch. Use `npm run ci:local` to run the workflow’s npm checks on a prepared host and keep the results for the exact candidate. The Linux CI job installs Chromium and its dependencies with `npx --no-install playwright install --with-deps chromium`. [GitHub checks workflow](../.github/workflows/check.yml)

Each run writes Cucumber HTML, JSON and JUnit reports, source identity, downloaded project/WAV evidence and per-scenario browser audits under ignored `reports/acceptance/production-e2e/run-*`. Failures retain screenshots and Playwright traces. `latest.json` points to the latest run. Missing Chromium, build errors, browser errors, failed requests, forbidden API calls and source changes fail the run; cases are not silently skipped or retried. VM and physical qualification remain separate evidence.
