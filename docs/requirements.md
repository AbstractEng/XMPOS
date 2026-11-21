# Community requirements

[Versioned requirements](../acceptance/sources/project-requirements.txt) use stable
S1-S8 identifiers for acceptance traceability. [Development scope](../acceptance/sources/development-scope.txt)
defines the protected host-first workflow. These are public project specifications;
private conversation excerpts and external attachments are not build inputs.

XMP is an original music-workstation framework with a shared project model,
sequencer, instruments, audio engine, touchscreen and hardware adapters.
Contributors can extend instruments, effects, interfaces, apps and workflows.

## Music and platform scope

- Original kits/synths, bounded sample import and editing, clips, scenes and songs.
- Musical transport, velocity, step sequencing, recording review, mix and audio export.
- Validated portable projects, transactional storage, undo and explicit save status.
- A shared C++ Device touchscreen on native targets and the browser via WebAssembly.
- Host/emulator development, native/core parity and bounded declarative SDK examples.
- Guarded owner-local preparation for Live Mk1 / ACV8 on exactly MPC OS 3.10.1.
- No vendor firmware/runtime redistribution; no Force or unqualified-model operations.

## Acceptance

The [MVP manifest](../acceptance/mvp.json) maps stable requirements to executable
features and commands. `npm run baseline` hashes the public requirement sources,
records dependency metadata and emits requirement records. `npm run mvp:verify`
runs the declared acceptance gates. Source provenance, file integrity and licence
clearance are separate from physical qualification.

See the [project format](project-format.md), [instrument architecture](track-machines.md),
[SDK manual](sdk/README.md), [compatibility](compatibility.md), [known issues](known-issues.md)
and [release status](../RELEASE.md). Hardware qualification belongs to an exact
source/image/profile; a later checkout does not inherit it automatically.
