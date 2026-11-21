# Portable XMP songs

Save portable project (Device view) and Save project (Advanced Studio) now write
`song.xmpsong` / `project.xmpsong`. Both use the same version-2 reader and writer
as the Linux Device image. The musical model is project schema version 8.

## Move a song

1. Open MENU → Project and keep **Package samples with song** checked.
2. Choose **Save portable project** and keep the downloaded `.xmpsong` file.
3. Copy that file using your normal file-transfer method. Open it with **Open
   project** in another XMP browser, Device installation or the Linux VM viewer.
4. Edit and save there; the resulting file opens back in the desktop browser.

The packaged file includes the project's sample pool, settings, slices, clips,
scenes, arrangement, MIDI destinations and machine state. Identical audio is
stored once while individual sample IDs and names remain intact. The exporter
does not collect the installation's entire library or inspect paths in custom
machine state. All project-pool samples are retained, including draft sounds that
an unavailable custom machine might reference. Instrument/plugin executables are
separate from the song; unavailable machines retain their state and stay silent.

### Save without audio

Uncheck **Package samples with song** for a smaller file that references sounds
by content hash. The saving browser retains those sounds in its local sample
cache. A destination can open it if the same audio is already available there;
its folder names and drive letters do not matter. Clearing site data can remove
that cache, so a referenced file alone is not a complete backup.

Missing samples are listed when opening a referenced song. The active song stays
open until every required sound resolves. Use **Locate missing samples (WAV)**
and choose the original WAVs, even if they have been renamed or moved. Matching
uses decoded sample content and sample rate, not the file name. A wrong sound
with the right name is rejected. For generated or edited sounds without an
original matching WAV, obtain a packaged copy of the song instead. Editing the
active project while locating files cancels the pending replacement.

Older `.xmp.json` bundles and supported raw project JSON remain readable. **Save
legacy copy** exports a version-1 bundle with samples for older XMP previews.
Older previews that only understand bundle version 1 cannot read `.xmpsong`
version 2; use the legacy option or update those previews.
Legacy copies retain project model version 8 and all extensions; they do not discard newer musical
features to target older project models. The destination must support the
saved musical model as well as its bundle version.

## Forward-compatible features

### Shared save/load paths

Normal saves on every platform are version-2 `.xmpsong` data, decoded and encoded
by the same C++ portable codec (WebAssembly on browser/Node hosts):

| Path                                 | Storage                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Native MPC Live and its ARM emulator | Packaged `xmp/project.xmpsong`; `project.edits` contains the same song in referenced mode, bound to that exact base file |
| Browser Device and Studio            | Packaged downloads and IndexedDB autosaves; referenced downloads resolve exact content hashes                            |
| Browser Device running in Linux VM   | The browser paths above, with bounded VM file transfer                                                                   |
| Console/emulator journal             | Version-2 songs in the existing journal filenames, including `project.xmp.json`; old version-1 contents remain readable  |
| `live:song` host file transfer       | Full `.xmpsong` in both directions; export applies the Live's latest matching autosave first                             |

The native session and host transfer share `song_snapshot.hpp` for reading the
whole song plus autosave. A matching unreadable/newer autosave stops loading;
it is never silently replaced by the older base. Browser and emulator recovery
also preserve incompatible future files and block writes over them.

Legacy `pattern.txt` is a one-way import in the native session. Its actual
resolved kit/sample banks, notes and available layering are imported into the
shared project; subsequent saves use `project.xmpsong`. Original legacy files
are retained. Imports exceeding current portable budgets are refused rather
than truncated. `live:song` no longer reduces songs to text patterns. Explicit
legacy-copy exports still use the version-1 container with the same project and
extension contract; they are not ordinary saves or a lossy downgrade.

### Extension contract

The stable foundation has two independent versions: bundle **2** describes the
container and audio encoding; project **8** describes the base musical model.
Feature and machine versions are independent of both. Additive features use the
optional project-level `extensions` object:

```json
{
  "extensions": {
    "com.example.motion": {
      "version": 1,
      "required": false,
      "data": {
        "tracks": {
          "drums": { "curve": [0, 0.5, 1] }
        }
      }
    }
  }
}
```

This is a fragment of the project, not a complete song. Each extension ID is a
stable namespace of lowercase dotted segments, up to 64 characters (for example
`xmp.motion` or `com.example.motion`). Each segment starts with a letter and may
contain letters, digits and hyphens. `version` is an integer from 1 to 65535.
`data` is a plain JSON object whose contents belong to that extension. Omitted
`required` means false. These descriptor fields are fixed; evolve the contents
of `data` with the extension's own version.

The reader/writer rules are:

- **Unknown optional extension:** retain its complete descriptor and data,
  including unfamiliar nested fields. Do not execute, reinterpret, reset or
  remove it. The base song remains usable with this feature inactive. Only mark
  a feature optional when that fallback is intentional and musically safe.
- **Unknown required extension or version:** refuse the load with the extension
  ID/version before resolver I/O or session replacement. Do not silently play a
  partial interpretation. This build implements `xmp.extended-samples` v1 and
  `xmp.sampler-input` v1; unfamiliar required capabilities remain unsupported.
- **Supported extension:** validate its own data and references before use.
  Advertise support only for versions actually implemented by the reader.
  File contents cannot register capabilities or execute imported code.
- **Edits and saves:** carry unknown extension data unchanged, even when the
  current editor changes tracks, clips or samples. Use stable project/track/
  clip/sample IDs inside extension data, never array indexes or host paths.
  An extension's future implementation owns reference repair and migration;
  an older reader cannot infer those semantics. Preserve project-pool samples,
  including assets referenced only by unavailable machines or extensions.
- **Integrity:** extension data participates in the existing project descriptor
  checksum. Packaged songs, referenced songs, raw JSON and legacy bundles all
  preserve it. Legacy export changes the container; it is not a lossy downgrade.
- **Core changes:** keep existing field meanings and strict validation. Do not
  put new fields directly into the core or change a base enum in an additive
  release. A truly incompatible core/container change requires a major version
  change and a reader migration, with a clear refusal by older readers.

`preservedProjectExtensions(project)` and `inspectSong(text).preservedExtensions`
list the ID/version pairs preserved but inactive in this build. Preservation is
of JSON values, not original whitespace or object-key formatting. Existing
project versions 1–8 and bundle versions 1–2 remain readable. Builds released
before this contract cannot gain it retroactively: they may reject extended
projects. Forward preservation applies to readers implementing this contract,
within their documented bounds.

### Adding a machine or capability

Keep a machine's stable `id` and its `audio` or `midi` base, and version its
bounded `state` independently. Change its version when a state change would be
incompatible with a previous validator. Unavailable IDs/versions retain their
state, parameter assignments and samples and remain silent; they are not
substituted with a different machine. Store broader capabilities (new editor
state, modulation systems, track metadata) in a namespaced extension, using the
stable IDs of the entities they describe. Changes that cannot have a safe
fallback need a required extension, or a new incompatible core version.

Implement the feature and its data validator in the shared native core first,
then update `extensions::supported` in `project_extensions.hpp` and
`supportsProjectExtension` in `project-extensions.ts` for the exact versions
implemented. Rebuild the project WebAssembly module with `npm run engine:wasm`.
Test the same fixtures through TypeScript, native C++ and WebAssembly: an older
reader's load/edit/save must preserve unknown data, while a newer reader must
recover it. Include unavailable machines, assets used only by extensions,
referenced audio, checksums and required-feature refusal. Screen/workflow
changes still follow the shared C++ touchscreen contract in `AGENTS.md`.

### Extension bounds

At most 32 extensions share an 8192-node, 256 KiB serialized UTF-8 budget.
Depth is at most 10 from the `extensions` object, counting each object/array
level; arrays hold at most 256 entries, objects at most 64 keys, keys at most
64 UTF-16 units and string values at most 512 UTF-16 units. Only finite JSON
numbers are allowed, using the existing IEEE-754 double precision contract;
store precision-sensitive large integers or decimals as strings.
Prototype-related keys (`__proto__`, `constructor`,
`prototype`) and executable/non-JSON values are refused. Existing whole-file
preflight limits also apply, including the raw encoded string budget. Larger
opaque/binary plugin payloads need a separately specified asset contract; this
area does not collect arbitrary files or plugin binaries.

## Linux VM viewer

Run `npm run os:device:build`, then `npm run os:device` on the Mac. The viewer's
**Open song** button transfers a selected local file into the owned VM and opens
it through the normal guest file input. **Save song** downloads the guest song
to the Mac, with a separate **Package samples** checkbox. **Locate WAV samples**
transfers matching audio for a pending referenced song. The guest's Project page
offers the same file options.

The bridge uses bounded, sequential, SHA-256-checked chunks. Uploads go to a
temporary, fixed guest directory and are removed after the file-input operation.
Clients never provide a filesystem path. The VM has no host shares, NIC or USB
passthrough. This is a generic VM transport, not a writable instrument adapter.
Physical MPC boot/driver qualification remains pending and the Force is untouched.

## Wire specification: bundle version 2

The file is UTF-8 JSON. Its envelope and audio references contain no filesystem
paths. Custom-machine state stays bounded JSON and is never executed during
import; extension authors should reference project sample IDs instead of host paths.
It is not a ZIP archive. The strict envelope has these fields:

| Field         | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `format`      | `xmp-bundle`                                                           |
| `version`     | `2`, independently versioned from the project model                    |
| `sampleMode`  | `embedded` or `referenced`                                             |
| `projectHash` | SHA-256 of canonical project-descriptor JSON                           |
| `project`     | Validated musical model; `samples` contains descriptors instead of PCM |
| `assets`      | Unique embedded audio records; empty for referenced songs              |

A sample descriptor contains `id`, `name`, `assetHash`, `sampleRate` and `frames`.
An embedded record contains `hash`, `sampleRate`, `frames`, `encoding` and
`chunks`. Encodings are `pcm-f32le` and `pcm-f64le`: IEEE-754 mono PCM, explicitly
little endian. Float32 is selected only when every value is exactly representable;
otherwise float64 preserves the authored values. No resampling or lossy
quantization occurs. Negative zero is normalized to zero, as in legacy hashing.

Chunks are canonical base64, at most 960 characters each. Every decoded chunk
except the last is exactly 720 bytes. The total byte count must equal
`frames * bytesPerSample`; trailing bytes, extra chunks and noncanonical padding
are invalid. Chunking retains the existing 1024-character parser string budget.

Audio hashes use the existing `sha256-<64 lowercase hex>` identity: uint32 LE
sample rate, uint32 LE frame count, then every finite amplitude as float64 LE,
with negative zero normalized. The identity is independent of payload precision,
sample ID, name and source location. Asset hashes are always recomputed.

Interchange vectors (one frame at 48,000 Hz): `1.0` uses `pcm-f32le` chunk
`AACAPw==` and hash `sha256-61deb4deb19120f57491c61a1e86102035c9313ab7cb42827e8c3e46df9866a8`.
`0.1` uses `pcm-f64le` chunk `mpmZmZmZuT8=` and hash
`sha256-1de5d7eb33c0f11480db42df1917b1385ee66f76765a020468e4d572b46b22fe`.

Canonical descriptor JSON recursively sorts object keys by JavaScript UTF-16
code-unit order, preserves array order, and uses ECMAScript JSON string/number
serialization without whitespace. Undefined fields are omitted by normal JSON
serialization before hashing. Hash its UTF-8 bytes. This is an integrity check,
not an authentication signature.

The original profile allows 24 MiB, 256 sample descriptors, 480,000 frames per
sample and 2,000,000 total project frames. `xmp.extended-samples` v1 uses
`required: true` and empty `data: {}`. It permits 1,536,000 frames per sample,
8,000,000 total frames and a 96 MiB portable song. Sample installers opt into
this profile when needed. Readers that lack it refuse the song explicitly.
Structural amplification limits still apply; use the portable container for
large pools rather than raw PCM JSON. Structural limits are checked before
schema traversal, payload allocation and resolver calls. Packaged songs must
contain every referenced asset and no surplus assets. Referenced songs contain
no audio; a supplied local resolver must return matching, hash-verified content.
Unknown versions, invalid references, damaged metadata/audio and incomplete
transfers fail before session replacement. Autosave and recovery snapshots use the same version-2 song container as
ordinary saves. Legacy version-1 snapshots remain readable. The existing
transaction and recovery rules are retained.

## Verification

`features/24-portable-songs.feature` covers Device ↔ Advanced Studio transfer,
clean profiles, packaging on/off, persistent local resolution, renamed WAV
relinking, corruption and legacy export. Its VM scenario saves in a real desktop
browser, opens that file in the Linux guest, edits a clip, and brings the result
back to another clean browser while comparing complete musical state and PCM.

- `npm run bdd:songs`: browser file-format journeys.
- `npm run bdd:songs:vm`: actual browser ↔ Linux VM journey.
- `npm run regression`: existing host/browser/VM suites plus these cases.

CI runs browser cases in the production-browser job and the VM transfer case in
the Device/ARM job. Reports contain only generated original test audio. Hardware
and formal physical loopback qualification remain pending.

## Sampler input settings

`xmp.sampler-input` v1 is optional. Its data is `{ "tracks": { "track-id":
{ "monitor": true, "bars": 4 } } }`, with at most eight track entries. Monitor is
a boolean; bars is 1, 2 or 4. Missing settings default to monitoring on and four
bars. Recordings themselves use ordinary sample assets, pad assignments and
clips, so they remain playable when input controls are unavailable. Unknown
versions of the settings are preserved; this build will not overwrite them.
The native Live, browser and emulator readers use the same validators.
