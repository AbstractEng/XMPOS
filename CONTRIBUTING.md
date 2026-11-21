# Contributing to XMP OS

Contribute through a fork and a pull request. **[@sandeshm](https://github.com/sandeshm)** is the sole code owner and currently reviews and merges contributions. Direct pushes from other contributors are disabled; updated PR commits need a fresh maintainer approval.

XMP is an open-source framework and experimental community music workstation. The platform foundation is in place so contributors can concentrate on interfaces, instruments, apps and workflows. Small, reproducible improvements are welcome; you do not need an MPC to start.

## Choose your path

| Change                        | Start here                                                                                              | What it produces                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Original instrument or effect | [SDK manual](docs/sdk/README.md) and [examples](docs/sdk/examples.md)                                   | A validated declarative `.xmpkg` and offline renders                 |
| Custom interface or app       | [source setup](docs/developer-guide.md)                                                                 | A source-built browser/native app; not an installable Live UI plugin |
| Sequencing/project behavior   | `packages/core`, [project format](docs/project-format.md)                                               | Shared validated project/sequencing behavior                         |
| Native Live UI                | `native/include/xmp/live_ui.hpp`, `native/src/live_session.cpp`, [control reference](docs/device-ui.md) | A rebuilt native session, tested on the host first                   |
| Platform/port work            | [compatibility](docs/compatibility.md), [One port plan](docs/launch/mpc-one-port.md)                    | Evidence and a separately qualified model profile                    |

## Build and check

Use Node 24, Python 3 and a C/C++17 compiler. Run `npm run bootstrap` in a fresh checkout, then follow [the developer guide](docs/developer-guide.md). Required host checks are:

```sh
npm run check
npm run parity -- --maxWorkers=1
npm run inventory:test
npm run native:test
```

Run the affected SDK/browser/native contracts as well. For an SDK example or packaging change, use `npm run bdd:sdk-supported`; it installs the packed SDK offline outside the checkout. Do not weaken tolerances or replace a failing runtime test with a source-text assertion. Documentation-only changes need relevant link/content/example verification; unchanged engine evidence can be reused with its source identity stated.

Keep project/sequencing interfaces in `packages/core`, browser APIs in `apps/studio`, and allocation, locks, file/network I/O and scripting out of native processing callbacks. Validate bounded inputs before applying them. Imported SDK packages contain data, never executable code. Stable parameter IDs/units and explicit migrations matter; read the [community SDK reference](docs/community-sdk.md).

## First contributions

- Follow the offline SDK walkthrough and improve a confusing instruction, with the exact failed command and correction.
- Copy the original tone template, switch its graph to triangle, build/preview it and retain a native parity report.
- Customize the SDK sound-card UI's title/layout, preserving validation and exclusive output creation.
- Add a focused fix for a reproduced issue in the [known limits](docs/known-issues.md), or propose one small workflow improvement with an original fixture.
- Contribute read-only model documentation to the One port plan. A Live image must never be tried on a One or Force.

## Issues and pull requests

Use [issues](https://github.com/AbstractEng/XMPOS/issues) for bugs, documentation and proposed changes, and [pull requests](https://github.com/AbstractEng/XMPOS/pulls) for reviewable patches. State the checkout commit/SDK compatibility, host, expected and actual behavior, smallest original reproduction, and commands/results. For audio problems, distinguish an offline render, output tap and physical listening; do not infer hardware timing from browser or VM results.

No support SLA is promised for this community baseline. Keep device serials, network names, personal work, passwords, bridge tokens, updater/firmware bytes and owner runtime images out of commits and public reports. Use original or properly licensed fixtures; preserve licences/notices.

Read [AGENTS.md](AGENTS.md) before hardware work. The Force is protected. Physical installation/recovery and every flash remain owner-operated; contributors must not bypass guards, add arbitrary device commands or assume that a connected cable authorizes writes. Host tests and emulation are the default development route.

## Public-source privacy check

Run `npm run source:audit` before proposing source exports. Keep conversation/session logs, personal recordings, device identities, credentials, private account settings and generated owner images out of commits and release archives. Required upstream licence attribution remains intact. To check additional private terms, pass a local JSON list with `python3 tools/audit-public-source.py --private-terms-file <private-file>`; never commit that file.
