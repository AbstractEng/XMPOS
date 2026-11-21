# XMP OS contributor and agent guidance

Develop on the host, in the browser or in the emulator by default. This public
repository grants no permission to operate anyone's instrument. Keep credentials,
serial numbers, private projects, recordings, firmware and conversation/session
logs outside source control.

## Hardware boundaries

- Akai Force is excluded: no connections, commands, MIDI output, installations,
  mode changes, storage access or firmware operations. Passive host inventory
  must remain metadata-only and redact device identifiers.
- Live Mk1 / ACV8, exactly MPC OS 3.10.1, is the initial qualified profile.
  Other models and firmware require separate qualification and owner authorization.
- Only `tools/live-mk1/flash.mjs` may perform the documented rootfs-only update.
  The owner performs every flash with the typed XMPOS confirmation. Agents may
  build, test, inspect and dry-run; never flash. Preserve exact-one-device,
  Force refusal, per-unit identity, image/hash/capacity and command-log guards.
- Never erase, format, reset environment, alter a bootloader/partition table or
  write any partition other than the owner-confirmed rootfs through that tool.
- XMP sessions write only to the owner's USB key. Internal eMMC and SD storage
  are excluded except the documented read-only, no-journal stock handover.
- Agent session tests use only the guarded `tools/live-mk1/bridge.mjs`, after
  owner authorization. No arbitrary shell, raw controller output, unbounded
  commands or network exposure. Preserve per-stick tokens and exact ACV8 handshake.
- Stock SSH checks and original XMP plugin operations use only
  `tools/live-mk1/mpc-remote.mjs` and its fixed allowlisted operations. Require
  explicit owner permission and the exact unit. Credentials are entered by the
  owner or supplied in their environment; never ask for or record passwords.
- Audio/controller adapters retain their board, USB ID, topology and message
  allowlists. Playback/monitoring stays below the documented -12 dBFS peak.
  Do not add controller messages, recording, services, external MIDI or wireless
  operations without a separately documented owner-approved profile.
- Never redistribute Akai updater/rootfs/loader files or an owner-assembled
  runtime image. Each owner supplies their signed, pinned 3.10.1 updater locally.

## Shared implementation and checks

The native C++ touchscreen is shared by Live, emulator and browser via WebAssembly.
Make Device UI behavior changes in the shared C++ code, then verify the same
fixtures/actions and project outcomes in native and browser builds. Platform
adapters handle I/O, display, audio and storage. Browser results do not qualify
physical latency, drivers or input sampling.

Keep project/sequencing logic in `packages/core` and browser APIs in `apps/studio`.
Processing callbacks must not allocate, lock, perform file/network I/O or invoke
scripting runtimes. Validate and bound every imported project/module input; do
not execute imported module code. Demo sounds must be original or properly licensed.

Use `npm ci`, `npm run check`, `npm run parity -- --maxWorkers=1`,
`npm run inventory:test` and `npm run native:test`, plus affected SDK, browser
and native contracts. See CONTRIBUTING.md and the versioned requirements.

Device pages show primary information and controls, fill available space and
use visible wheel focus. Secondary settings belong behind a key or Preferences.
Label menu actions with pad shortcuts; preserve musical pads on performance pages.
Render changed pages and check overflow, touch targets and unused space.
