# XMP developer setup and automated tests

XMP has two development paths: the standalone instrument/effect SDK, and the source repository for custom apps, interfaces and native workflows. Start with the path matching your change. The standalone SDK does not contain the full OS build environment.

Use the source and SDK compatibility from the selected release; do not mix a moving repository checkout with an older hardware image. The standalone SDK now bundles its offline manual and runnable examples. Candidate-specific clean-checkout verification and any remaining infrastructure limits are tracked in [launch readiness R17](launch/readiness.md#r17--deliver-and-qualify-the-complete-developer-kit).

The [architecture](architecture.md), [implementation plan](implementation-plan.md), [C++ port notes](cpp-port.md), [MVP scope](mvp.md) and [production-regression guide](production-regression.md) retain the broader design and historical test lanes. For this release, use the [minimum community gates](launch/baseline-release.md) and candidate-specific receipts.

## Choose a starting point

- **Original instrument or effect:** [supported SDK](supported-sdk.md) for install, scaffold, build, preview and native parity; [community SDK](community-sdk.md) for graph definitions, capabilities, parameter units, packaging, migrations and rollback.
- **Custom browser interface or app workflow:** the full repository, `apps/studio/src/device/` for Device UI, `apps/studio/src/` for Studio, and `packages/core` for the public project/sequencing interfaces. [C++ port notes](cpp-port.md) describe which core operations now use native/WebAssembly code.
- **Custom native Live interface or workflow:** the full repository, `native/include/xmp/live_ui.hpp` and related `live_*` headers, plus `native/src/live_session.cpp`. Use native tests and the Live session emulator. Native UI customization is source development; the current SDK does not install arbitrary third-party UI code into the Live session.
- **Boot/kernel/platform work:** the repository's `os/live-mk1/` and `tools/live-mk1/` build/test tools. Follow the repository hardware boundaries. Ordinary SDK/UI development needs no connected instrument.

For project files and bounded inputs, read [project format](project-format.md), [portable songs](song-files.md) and [track machines](track-machines.md). These documents include historical increments; check the candidate's current compatibility manifest before relying on a version claim.

## Standalone SDK development

The supported tarball targets Node 24 on macOS/Linux, with a C99 compiler for its offline native parity renderer. Docker and an MPC are not required for this path. The tarball is built from source; it is not currently published to the public npm registry.

A maintainer creates a new distribution:

```sh
npm ci
npm run sdk:pack -- artifacts/sdk/developer-001
```

A contributor installs that tarball in a separate directory and follows the complete command sequence in [supported-sdk.md](supported-sdk.md). The main loop is `new` → edit → `build` → `test` → `preview` → `parity`. Use new output filenames/directories; tools preserve existing destinations.

Scaffolding produces `module.json`, `program.json`, `LICENSE`, `PARAMETERS.md` and coding guidance. Edit the manifest for identity, capabilities and parameter metadata; edit the bounded declarative graph for the supported sound/effect behavior. Instrument/effect examples are in `examples/community-tone` and `examples/community-filter` in the repository. The [community guide](community-sdk.md) explains the supported sine/triangle/virtual-input/gain/filter graph, parameter ranges, dependencies, versioning and project/store transactions.

`xmp test` and `preview` are software checks/renders. `xmp parity` compiles the SDK's fixed C processor and compares output against the reference. It does not compile or execute arbitrary code received in a package. A `.xmpkg` is a bounded data package, not a shell script, VST, native binary installer or custom app bundle.

The shipped `tools/sdk/compatibility.json` declares module API 2, DSP ABI 1 and its supported project schema. Offline-install acceptance binds a package into a store and checks the actual emitted project version against that manifest. Native SDK module loading on the Live remains separate from source-built app development.

## Repository prerequisites

Use Node 24, npm, Python 3, a C/C++17 compiler and the repository's CMake/Ninja setup. `npm run bootstrap` installs JavaScript dependencies with `npm ci`, creates `.venv`, installs the pinned tools in `tools/requirements.txt`, and runs the host doctor. It does not install or start Docker Desktop.

On the Mac, QEMU's source-build path also uses host build dependencies. `tools/os/bootstrap-emulator.mjs` checks `pkg-config`, `glib-2.0` and `pixman-1` and installs the Meson version from the emulator lock into `.venv`. The Live ARM emulator shares the host toolchain; it is not built inside the ARM Docker image. The ARM bootstrap checks those libraries, prepares its own input directory and installs the pinned Meson version. Linux CI declares the matching development packages; actual host support remains scoped by the candidate verification report.

From the repository root:

```sh
nvm use                    # when using nvm; otherwise select Node 24 explicitly
npm run bootstrap
npm run doctor
npm run sdk -- doctor
```

The two doctors have different scopes: the repository doctor checks host tools and C++17 compilation; the SDK doctor checks the supported SDK host/compiler profile. Neither proves Docker readiness or boots a guest.

## Native session with the owner's 3.10.1 runtime

Use [the dynamic build and local USB assembly guide](live-mk1-owner-runtime.md) for the launch route: `live:prepare-runtime` → `live:dynamic-image` → `live:assemble` → `live:runtime-vm`. The session can be cross-built directly on the Mac with `--host`, using pinned development inputs and the owner's verified shared libraries. Local assembly uses `mke2fs` and does not contact a device. Kernel/loader builds and the full session VM's FAT-media harness still use Docker. `live:session-image` below remains a legacy static development lane, excluded from public packaging.

## Fast development and tests

For browser work, start `npm run dev` and open the printed local URL. Keep browser APIs and UI in `apps/studio`; put shared project/sequencing behavior behind the core interfaces. Native audio processing must not allocate, lock, do file/network I/O or invoke scripting runtimes; prepare data outside callbacks.

Run the required host checks on stable source:

```sh
npm ci
npm run check
npm run parity -- --maxWorkers=1
npm run inventory:test
npm run native:test
```

Use `npm run bdd:sdk-supported` for the standalone contributor SDK workflow, `npm run bdd:p09` for the community workbench contracts, `npm run bdd:e2e` for built browser journeys and `npm run bdd:live-mk1:host` for the Live contracts that need no container or instrument (run `npm run refs:sources` first). Browser acceptance setup also needs the pinned Playwright browser; the CI recipe uses `npx --no-install playwright install --with-deps chromium`.

Host checks, browser journeys, generic VM conformance and the Live session emulator cover different behavior. Keep their results distinct. Do not edit source while a build or evidence-producing suite runs: the runners record source identities and can reject changed-source results.

## Docker build environment

The Docker recipes and orchestration are in the repository:

- `os/live-mk1/builder.Dockerfile`: Debian base pinned by digest, ARM compiler and kernel build tools; tag `xmp-live-mk1-builder:1` from `kernel.lock.json`.
- `os/live-mk1/userspace.Dockerfile`: builds on that tag with ARM C/C++ userspace/static-library tools; tag `xmp-live-mk1-userspace:1`.
- `os/live-mk1/probe.Dockerfile`: builds on the userspace tag with offline filesystem/U-Boot image tooling; tag `xmp-live-mk1-probe:1`.
- `tools/live-mk1/container.mjs`: `ensureBuilder` builds the requested image; `runContainer` creates a throwaway build container, copies in inputs, runs the build and copies out artifacts/logs before removing the container.

Start your Docker daemon separately. Run `npm run live:setup -- doctor`, then `npm run live:setup -- build` (optionally `build --no-cache`). Readiness is bounded to ten seconds and requires Linux containers. The setup tool and individual artifact builders prepare the complete base → userspace → image-tooling parent chain automatically. Setup records its source identity and resulting image ID under `reports/developer-setup/`. This is the full OS build environment; SDK-only work does not need Docker.

The artifact build containers use `--network none`, `--cap-drop ALL`, `no-new-privileges` and a PID limit. They receive no physical devices or host-directory mounts. Kernel work can use the single allowlisted Docker volume `xmp-live-mk1-work`; inputs/outputs otherwise move with `docker cp`.

Initial Docker image construction is different: `docker build` fetches the base image and runs `apt-get`, so it needs network access. The Debian base is digest-pinned and apt uses the fixed 20261101T000000Z Debian/security archive snapshot. Normal repository/package signature verification remains enabled; historical Release expiry checks are disabled for that snapshot. See [Debian snapshot usage](https://snapshot.debian.org/). Retain image IDs/package versions; this locks dependency selection, not every source of bit-for-bit filesystem timestamps.

## ARM build and emulation dependency order

The following is local build/test setup, with no device connection. Use a development checkout and sufficient space for compiler archives, Docker layers, image outputs and test captures.

```sh
npm run bootstrap
npm run refs:sources
npm run live:kernel -- verify-source
npm run live:kernel -- build
```

`refs:sources` fetches the source commit pinned in `kernel.lock.json` when missing (without requiring `refs:pull` or moving an existing reference branch), then downloads and hash-verifies the catalogued official open-source archives; it does not obtain a proprietary MPC updater. The kernel build verifies its archive, builds the base Docker layer and writes kernel/DTB manifests under ignored `artifacts/live-mk1/`.

Prepare QEMU inputs and host build tools before building the patched ARM emulator. On the supported Mac path:

```sh
npm run live:emulator
```

The ARM bootstrap prepares its own input directory, pinned Meson and verified archive, then builds the pinned QEMU source with XMP's USB-audio identity patch. Networking, physical host audio and USB passthrough backends are disabled by that build recipe. Do not substitute a system QEMU for this Live-session profile without checking the patch and manifest requirements.

Then build the userspace and payload:

```sh
npm run live:g1-userspace
npm run live:alsa-engine
npm run os:arm:build
npm run live:kernel -- boot
npm run live:session-image
```

The kernel boot test stages the ARM test binaries, G1 tools and ALSA engine, so prepare all of those first. `live:session-image` builds the native XMP session and its emulator variant, including the font atlas. Font downloads are hash-checked; the atlas generator uses the host C++ compiler and `unzip`. Docker builds the ARM payload, while the patched QEMU executable runs on the host.

The full Live session emulator additionally requires a locally generated stick-loader artifact. Its builder consumes an owner-obtained Akai updater, verifies its signature and payload hash, and creates local-only output. Building it is not flashing:

```sh
npm run live:loader-image -- "/absolute/path/to/the/reviewed/official/Updater.app"
npm run live:session-vm -- --only project
```

Use the updater version accepted by the current kernel/image checks; this is not an invitation to pass any stock release. This local image contains Akai material and must not be committed or redistributed. The session emulator does not yet have a complete updater-free clean-checkout setup. Contributors without that prerequisite can still use the SDK, browser, host/native tests and generic VM path.

This updater-processing route uses a macOS `.app` and `codesign`; do not infer full Linux support from the SDK's macOS/Linux host profile. Document and qualify any alternative host route separately before advertising it.

`live:session-vm` accepts `--only` with `pads`, `seq`, `tracks`, `project` or `bridge`; omit it to collect the full session run. `--realtime` changes QEMU timing mode, not the qualification status. The session runner writes `verification` alongside the diagnostic booleans in `result.json`. Missing or false required results fail the command. Partial runs explicitly name unexecuted sessions and cannot count as complete. The Gherkin contracts assert the current result schema as well.

```sh
npm run bdd:live-mk1:host
npm run bdd:live-mk1
```

The second command runs implemented host and emulated Live contracts; it can take a long time and has additional per-scenario prerequisites, including locally supplied updater material. Its updater-dependent acceptance steps read `XMP_MPC_UPDATER` or their documented local default; the image-builder CLI above takes an explicit path. No hardware target option is accepted. Failures and source changes fail the acceptance runner, which records `physicalAccess: false` and `hardwareQualified: false`.

## Generic SDK VM tests

For the SDK's generic Linux conformance lane:

```sh
npm run os:emulator          # Mac; on Linux install QEMU >= 8.2 separately
npm run sdk:toolchain
npm run sdk:parity:vm
npm run bdd:sdk-supported:vm
```

This uses the pinned Zig toolchain and generic x86_64 Linux VM; it is not the ARM Live session or a test of its touchscreen/controllers. Follow [supported-sdk.md](supported-sdk.md) for comparison tolerances and evidence. For the separate Linux Device browser viewer/ARM userspace profile, follow [device-vm-arm.md](device-vm-arm.md); it is another test lane, not a replacement for native Live UI tests.

## Evidence and troubleshooting

- **SDK native parity:** the output directory you supplied contains the report, renderer receipt and WAV fixtures. Inspect refusals, event frames and PCM comparisons, not just the file's existence.
- **Generic SDK VM:** `reports/parity-vm/` and `reports/acceptance/sdk-supported-vm/` contain source/image/binary identities and guest comparison evidence.
- **Live builds:** `artifacts/live-mk1/latest-*.json` points to generated artifacts/manifests. A pointer alone is not a test pass.
- **Live session emulator:** its printed directory under `artifacts/live-mk1/session-vm-*` contains logs, captures and `result.json`. A focused run leaves other sessions unexecuted.
- **Live acceptance:** `reports/acceptance/live-mk1/run-*` holds Cucumber JSON/HTML/JUnit, evidence and source/exit metadata.
- **Docker unavailable:** start the daemon; the repository bootstrap does not start it.
- **Missing parent image tag:** run `live:setup build`; it prepares all three layers in order.
- **Missing kernel/G1/session/loader pointer:** follow dependency order; do not copy another developer's private artifacts to hide a missing build step.
- **Missing QEMU tools or archive directory:** install the declared host prerequisites, run bootstrap, then the matching emulator bootstrap. Each prepares its own input directory; QEMU container probes are disabled.
- **Stale/source-changed receipts:** freeze the intended checkout and rebuild/rerun. Do not reuse the report as current evidence.
- **Timeout/resource failure:** keep the failing log and workload visible; reduce concurrent compiler/emulator jobs. Full emulation is much slower than native tests. See the [performance audit](performance-audit.md) for measured development-loop limits.

Do not run broad Docker/system prune commands to resolve disk pressure. Review XMP's own cleanup tool and referenced-evidence retention first. Do not upload raw reports, proprietary loader images, bridge tokens, serials or personal songs with a bug report; provide a redacted failure and an original minimal fixture.

## CI coverage and limits

`.github/workflows/check.yml` currently triggers through `workflow_dispatch` only. It includes host/native checks, browser regression, generic OS/device VM checks, SDK native/VM conformance and a Live **host-only** job. The `developer-arm` job declares the three Docker layers, patched ARM QEMU, ARM payload build and updater-free emulated acceptance suite. Updater-dependent probe/loader/session tests remain a separate local Mac lane.

Use `npm run bdd:live-mk1:emulated` for the updater-free asserted lane, or `npm run bdd:live-mk1` for all implemented Live contracts with the local updater prerequisite. The workflow remains manual-only; a defined job is not evidence it ran. Hardware testing remains separate and subject to `AGENTS.md`; passing Docker or QEMU tests does not qualify the physical Live.

## Developer documentation release checklist

The SDK/developer kit is ready only when an unfamiliar contributor can complete the documented loop using the delivered package and declared prerequisites:

- Install the standalone SDK offline, inspect versions, build an instrument and effect, render/compare them, and read the graph/parameter/error/migration reference without needing missing repository documentation.
- Find a tested example for a custom UI and workflow, the core API entry points, source-build integration and ownership/threading rules.
- Set up each supported host, build Docker images in the correct order, produce ARM artifacts and run asserted emulation tests without undisclosed local state. List vendor-updater-dependent tests separately.
- Understand module API/DSP ABI/project-version compatibility, resource bounds, units, state migration, storage, real-time restrictions and supported extension/loading paths.
- Read troubleshooting, report locations, CI instructions, licences and contribution/security/support guidance from the installed kit or its matching versioned docs.
- Repeat the walkthrough for the release candidate with retained reports. Missing guide chapters or successful historical workspace runs do not close that requirement.

The tarball includes a package-root index, supported-SDK and community references, the offline `docs/sdk/` manual, API/type declarations, instrument/effect and custom UI examples, fixed native sources, compatibility data, licences and the pinned dependency. Offline acceptance validates delivered links, builds/renders both packaged modules, exercises the UI example and checks project compatibility. Full OS source/Docker tooling is supplied by the separate repository checkout; its setup instructions are also included in the SDK manual.
