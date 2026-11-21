# XMP MVP 1: usable and validated without hardware

**Promise:** a musician can start, make, finish, save, move and export a song in the XMP Device workflow, on a Mac browser and inside the booted Linux device build. A contributor can build, test and package an original instrument. The owner's Akai Force is never touched.

The MVP is the narrowest release that serves the original goal: an extensible, legally distributable music production OS that others can customize. It is not a hardware release. Everything here runs on the development Mac.

## Public requirement sources

[Project requirements](../acceptance/sources/project-requirements.txt) and
[development scope](../acceptance/sources/development-scope.txt) are versioned
specifications with stable S identifiers. Private source records and external
attachments are excluded. Acceptance uses the files in this repository.

## Requirements

The machine-readable manifest is [acceptance/mvp.json](../acceptance/mvp.json). Every row maps to existing `@implemented` Gherkin scenarios. `tests/mvp.test.ts` fails if a scenario is renamed, removed or downgraded to `@planned`.

| ID     | Requirement                                                                         | Source   | Gates                         |
| ------ | ----------------------------------------------------------------------------------- | -------- | ----------------------------- |
| MVP-01 | Start making music with no hardware or setup (Device view, Live Mk1 panel)          | S2 S5 S6 | device                        |
| MVP-02 | Make a beat from samples and export it                                              | S5       | device, browser, kits         |
| MVP-03 | Layer a synth or second machine and record undoable takes                           | S1 S5    | device, browser               |
| MVP-04 | Launch clips at the bar, chain scenes into a song, render it                        | S5       | device, browser               |
| MVP-05 | Mix and export alternatives                                                         | S5       | browser                       |
| MVP-06 | Never lose work: autosave, whole-take undo, damaged-input rejection                 | S5 S6    | browser, device, kits         |
| MVP-07 | Portable `.xmpsong` files with optional samples and relinking                       | S4 S5    | songs                         |
| MVP-08 | Runs as its own OS: Device UI in booted Linux, cold-reboot persistence, ARMv7 build | S2 S7    | device-vm, songs-vm           |
| MVP-09 | Contributors build, test and package original instruments/effects with the SDK      | S1 S4    | sdk, native                   |
| MVP-10 | Only distributable content ships (original or verified CC0 sounds)                  | S3 S4    | kits                          |
| MVP-11 | The Force stays untouched                                                           | S6       | safety, foundation, inventory |
| MVP-12 | A new user can learn it from the manual and quick start, even on a phone            | S5       | manual                        |

Every requirement also depends on the `check` gate: lint, types, unit tests and the build.

## Out of scope for MVP 1

- Installing, booting or testing anything on the Live Mk1 or the Force
- Real-time timing qualification. The P12 sampler budget passes in 60-second Mac runs, and a continuous ALSA engine runs in the ARM guest, but the eight-hour run and the Live Mk1's own timing are unmeasured.
- Physical audio latency, loopback, external MIDI, CV and VST hosting
- Touch display and physical control qualification
- The eight-hour soak, signed hardware updates and public OS image redistribution
- Requirements from the unretrieved external specification

These remain in the [implementation plan](implementation-plan.md) as later gates.

## Validate it

```sh
npm run mvp:verify                     # all tiers: core, browser, VM
npm run mvp:verify -- --tier core      # host contracts only (fast)
npm run mvp:verify -- --tier browser   # core + built-browser journeys
```

The runner first audits traceability, then runs each gate's existing npm script, and writes `reports/mvp/<run>/summary.json`. A requirement is **validated** only when all of its gates ran and passed on an unchanged source build. A partial tier run reports the rest as `not-run`, never as passed. The VM tier needs QEMU and the guest inputs; see [device VM](device-vm-arm.md).

The runner refuses physical target flags and any hardware-facing script. A validated MVP report always records `hardwareQualification: false`.

## Try it as a user

```sh
npm run dev
```

Open <http://127.0.0.1:5173>. The [manual's quick start](../apps/studio/manual/index.html) walks through the first loop. For the device build: `npm run os:device:build`, then `npm run os:device`.
