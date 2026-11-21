# P12 development reliability and release evidence

ADR-P12-001 permits Mac and generic VM development against the scoped P10/P11 software increments. Full P10/P11, exact-unit hardware and production release gates remain open. The Force remains untouched. The MPC Live Mk1 has not arrived; there is no hardware installer or partition-layout assumption.

## P12.1 measured sampler workload

`npm run bdd:step -- P12_1` runs a real 60-second native sampler workload, overload refusal and negative evidence checks. It uses 32 prepared looping sample voices at 48 kHz / 256 frames, paced virtual audio, scheduled tempo changes, hashed save checkpoints and RSS observations from the owned engine PID. No physical audio device opens. Capture is a rolling two-second buffer; callback timing uses a fixed histogram whose p99 is an upper bound. Callback audit counters, refused overload voices, control acknowledgments and trace digest are retained.

`npm run release:soak -- --seconds 28800` can measure an eight-hour **sampler-only** workload. This command is optional and has not been run for P12. The final eight-track synth/effect workload, complete native parity, real driver xruns, temperature, battery and physical timing remain unqualified. A short run cannot satisfy those gates.

The timing limits remain zero deadline misses, p99 below 80% of the block deadline (4.27 ms at 256 frames / 48 kHz) and RSS growth no more than 32 MiB after warmup. They have not been relaxed.

Early 60-second runs failed with one or two misses. The cause was scheduling, not DSP. The render thread ran at normal priority, and a single block occasionally took 13 ms while the typical p99 stayed at or below 0.52 ms: the OS had preempted the thread mid-render. Since November 10, 2026, `xmp_engine_host` promotes its audio thread before the render loop (`native/src/rt_thread.cpp`):

- **macOS:** the Mach time-constraint policy CoreAudio uses for I/O threads. Period one block, computation 40%, constraint one block.
- **Linux:** `SCHED_FIFO` priority 80 plus `mlockall`, so pages cannot fault mid-render.

If the OS refuses, the thread keeps normal priority, and the report's `realtimeScheduling` field says `none`.

Measured after the fix on the development Mac, three 60-second runs, each with 11,250 blocks:

| Condition                    | Misses | p99 (upper bound) | Worst block |
| ---------------------------- | ------ | ----------------- | ----------- |
| Idle                         | 0      | ≤ 0.26 ms         | 0.31 ms     |
| Idle, repeat                 | 0      | ≤ 0.26 ms         | 0.31 ms     |
| All 12 CPU threads saturated | 0      | ≤ 0.26 ms         | 0.18 ms     |

The development timing checks now pass. The eight-hour run, the final V1 synth/effect workload and the Live Mk1's own timing remain unmeasured.

## P12.2 committed project recovery

The guest writes and fsyncs a pending project, saves the prior validated generation, atomically renames the primary and syncs its directory. It validates bounded portable projects and their assets before use. Uncommitted pending data is never selected automatically.

The VM tests send SIGKILL to the owned QEMU process at two explicitly reported save checkpoints: after pending-file fsync and after primary-directory fsync. A cold boot must reopen the old or new committed generation respectively with exact project and asset hashes. These are actual VM power cuts, distinct from controlled application exceptions.

An invalid primary with a valid previous generation opens that generation read-only. If every existing candidate is invalid, no empty song replaces the files. Save and music export fail; recovery diagnostics preserve hashes, and an explicit `recovery-export` command creates a private archive on the virtual data disk. That archive includes project data and is excluded from CI uploads. Normal boot has no fault commands enabled; fixture corruption/checkpoint commands require a dedicated kernel flag supplied only to disposable test VMs.

## P12.3 signed VM updates

Development capsules use an Ed25519 signature and a pinned public key over a bounded canonical manifest. All six image components are hashed, including the source ledger, SBOM and notices. Signature, target, architecture, project/SDK/DSP compatibility, sequence and payload checks precede update-store writes. Tests cover untrusted signatures, incompatible targets/dependencies and substituted components. Keys are ephemeral test keys, never production credentials.

The update manager accepts only owned workspace files. It snapshots a stopped virtual data disk into an independently bootable candidate, leaving the known-good disk unchanged. Real guest boot, playable storage, an in-guest musical fixture and clean shutdown must pass before the atomic active pointer advances. A failed UI-startup health check retains the original pointer and disk hash. A controlled interruption after snapshot creation leaves a journal that a new manager instance can abandon before promotion; this case is not evidence of arbitrary host-process crash or physical power-loss update recovery. A healthy retry promotes a separately identified image variant and survives another cold boot. Both variants use the same current source and schema; they do not pretend to be different app versions.

There is no USB transport, writable hardware adapter, flash command or assumed MPC A/B partition arrangement. Stale locks after arbitrary host crashes require explicit investigation. Hardware installation/signing/recovery must be designed from exact-unit evidence and separately authorized later.

## P12.4 scoped release decision

`npm run release:inspect` recomputes a local development manifest from current-source host contracts, P10 VM evidence, P12 VM evidence and a complete sampler measurement. Stale, missing, duplicate or mismatched receipts block the preview. A ready preview supports only the generic serial console, offline rendering, recovery and owned VM update workflow. The measured sampler deadline misses remain visible in `performanceStatus`; continuous real-time capability is excluded from this preview.

The manifest always leaves hardware readiness, full-phase qualification and public binary redistribution false. Required physical tests, eight-hour final workload, graphical UI/native parity, corresponding-source/license review and hardware signing/install/rollback remain pending. Synthetic policy fixtures used in unit/Gherkin gate tests never become measured release evidence.

## Commands and CI

```sh
npm run release:images             # Build base and separately identified update variant
npm run bdd:step -- P12_1           # Mac measured sampler and overload contracts
npm run bdd:step -- P12_2           # Booted VM save/recovery contracts
npm run bdd:step -- P12_3           # Mac signature policy and booted VM updates
npm run bdd:step -- P12_4           # Mac release-evidence policy
npm run bdd:p12                    # All implemented P12 Mac and VM contracts
npm run bdd:qualify:p12:vm          # Recheck current source/image VM evidence
npm run bdd:implemented            # All implemented host contracts, including P12
npm run bdd:qualify:implemented
npm run bdd:p10                    # Separate generic OS regression evidence
npm run release:inspect            # Never publishes or deploys
```

The Mac/Linux CI matrix runs functional host tests including the 60-second measurement. A separate Ubuntu QEMU lane runs P12 recovery/update Gherkin and qualification; P10 keeps its existing independent lane. CI uploads reports, logs and original WAV fixtures, excluding virtual data disks, recovery archives, image components and private keys. CI is software evidence only. No physical audio or Akai device is accessed.
