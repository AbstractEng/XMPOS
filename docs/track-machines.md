# Extensible track machines

Every track has one audio or MIDI machine, independent of its clips, scenes and mixer identity. This follows the requested machine-per-track approach. The V3 project stores `machine: {id, base, version, state}` on a track. Omitted machine data preserves the old sampler behavior. Machine IDs identify implementations; a state version identifies the exact supported state schema. Audio and MIDI are base signal types, not a closed list of instruments.

The first machines are `xmp.sampler`, `xmp.subtractive` and `xmp.midi`. Studio also includes original `example.pulse` and `example.transpose` developer examples. Each track independently chooses a machine in **Sounds, machines & recording**. The built-in MIDI machine can select a synth or sampler track as its internal destination; see [internal MIDI routing](midi-routing.md). Unrouted MIDI and developer MIDI examples emit virtual traces only. No physical MIDI, CV, USB or Akai adapter is enabled.

## Add a trusted machine

1. Create a definition using the `MachineDefinition` and `MachineProcessor` exports from `packages/sdk`. [Pulse](../examples/track-machines/pulse.ts) shows an audio source; [transpose](../examples/track-machines/transpose.ts) shows a MIDI transformation with bounded voice ownership.
2. Give it a unique namespaced ID, audio/MIDI base, state version, declared capabilities, parameter IDs/units/ranges/defaults and a state validator. Keep its JSON state independent of UI controls and device handles.
3. Supply a processor factory with `noteOn`, `noteOff`, `panic` and `process`. Prepare buffers outside `process`; keep work bounded and handle every note lifetime. Processing blocks are at most 4096 frames. The example machines declare their own voice limits; the built-in voice pool is 32.
4. Register it in `apps/studio/src/track-machines.ts`. That entry is bundled into the UI and AudioWorklet. `npm run dev` rebuilds it locally; a machine change does not require rebuilding an OS image. The selector and numeric parameter editor use its metadata automatically.
5. Test sound or virtual MIDI output, note cleanup, overload and invalid state. Save a project, reopen it and verify the same machine/state. Run `npm run check` and `npm run bdd:p05`.

The registry rejects duplicate IDs and invalid parameter metadata. Machine state is bounded JSON: at most 512 nodes, five levels, 32 keys/object, 64 entries/array and 256 characters/string. Functions, prototype keys, non-finite numbers and oversized state are rejected. Processor functions exist only in trusted locally bundled source. A project cannot name a script path, load a library, fetch an executable or install a plugin.

Missing IDs, unsupported state versions or mismatched base types preserve the opaque state and render silence, with an unavailable-machine message. They never silently substitute a sampler. Installed definitions validate state before processing. Switching a machine is an undoable project edit. Deleting a track releases its owned notes; panic clears active and queued performance notes.

## Future host adapters

The common machine envelope can represent a modular-synthesis processor, MIDI utility, Eurorack/CV bridge, VST-host machine or a separately implemented instrument algorithm. That does not mean those adapters already exist. Audio input/routing, CV calibration, external port identity, native plugin hosting and OS-specific ABI/isolation need their P08/P09/P11 implementations. The current processor API provides mono output and note control; adding input buses or native execution requires a versioned host contract rather than smuggling device access into state.

Locally bundled JS factories are trusted development code, not a sandbox. Capability metadata describes their intended musical role; it does not prevent arbitrary JS from accessing ambient globals. Untrusted installs and resource isolation remain P09 gates. A custom MIDI machine's returned audio is discarded and its events reach the software trace. The built-in MIDI machine separately supports a validated, single-hop destination to a built-in audio track. No claim of VST, Eurorack hardware or proprietary instrument compatibility is made by registering a type ID.

Machine parameters keep exact units in their state and UI metadata. The existing universal normalized gain registry remains intact. P06 bridges automatable machine parameter identities to normalized automation and locks. Opt into `automation: true` and implement `setParameter(id, value)` for native-unit control updates. IDs include the machine and state version, so replacement machines never receive stale lanes. See [sequencing](sequencing.md).

P07 performance macros preserve the same parameter identities and prune assignments on track deletion. Parameter metadata may declare a native-unit `step` for discrete controls; the normalized registry exposes the corresponding virtual encoder increment. The supplied MIDI channel and transpose controls use this capability.

P08 routes trusted custom audio-machine output through the same per-track stereo strips, inserts and sends as built-ins. MIDI machines remain event generators; the built-in internal route feeds those notes to a destination instrument and its stereo strip. The mix is downstream of the machine interface; no host-specific assumption about future user track types is added. SMF export currently describes sequencer notes, rather than arbitrary custom MIDI transformations.

P09 adds optional `MachineProcessor.expression(noteId, dimension, value)` and pitch/timbre capability declarations. `VoiceRack.expression` rejects unsupported dimensions before forwarding. The community SDK supplies a trusted declarative-machine bridge with the same note/parameter contract. Package metadata does not enable VST, CV or native binary loading; see [the workbench guide](community-sdk.md).
