# Drum kits

In Studio's **Play** view, open **Drum kits**. Enter a name and choose **Import WAV kit**, then select 1–16 WAV one-shots from an unzipped sample pack. The importer saves the complete validated kit to this browser's local library and loads it as one undoable project edit. Choose an existing library entry and **Load kit** to compare sounds, or choose **Original demo kit** to restore the original sounds. **Close** or Escape dismisses the kit controls.

The first kick, snare, closed hat and open hat are placed first, when recognizable from their filenames. Additional sounds follow in filename order within their category. Check the visible pad names after loading. Unused pads are silent. This increment does not interpret SFZ, velocity layers, round robins, preset/plugin executables or archive contents.

The pad bank is shared across sampler tracks. Loading a kit changes that bank and resets its sample slicing, reverse/normalize edits and pad playback modes to one-shot. It preserves the song's patterns, notes, scenes, tempo, mix, track machines and automation. Undo restores the entire previous bank. A synth or MIDI track retains its machine; choose a sampler track to hear the drum kit. Active project sounds survive autosave and portable project export independently of the kit library.

Kits remain in IndexedDB on this browser origin, with a maximum of eight imported kits. No samples are uploaded. Another browser, port or public deployment has a separate library. Import failure, malformed WAV, storage failure and concurrent project edits cannot partially replace the pad bank. If an edit occurs while the library write finishes, the kit may be saved, but loading it requires a new explicit **Load kit** action.

Limits: PCM16/24/32 or float32 mono/stereo WAV, 8–96 kHz, at most ten seconds / 480,000 frames per sound, 4 MiB per file, 16 MiB per import and one million total sample frames per kit (including the shared silent pad asset). Stereo inputs are averaged to mono by the current sampler import path. Imported sounds are neither silently trimmed nor resampled to fit these limits.

## XMP original kits

**XMP 808 style** and **XMP 909 style** are XMP's own kits, synthesized in the browser from formulas in the manner of classic analog drum machines (tuned sines with pitch drops, a metallic six-square cluster, filtered noise). No recordings are used; the names describe a style. They are the same sounds as the MPC Live session's kits (`packages/core/src/drum-machines.ts` is a port of `native/include/xmp/live_kits.hpp`, and `tests/drum-machines.test.ts` checks all 32 sounds against the C++). The closed hat chokes the open hat: kits may now give each sound a choke group.

**XMP Velvet · multi-sampled** is XMP's groove kit: a dry, warm, deadened soul and psych-funk kit in the spirit of the close-miked 1970s sound that bands such as Khruangbin and Glass Beams play with. Like the others it is original and synthesized from formulas (decaying modes, filtered noise, metallic clusters, light tape saturation and a small dry room); no recording of any instrument is used. Pads 1–16, bottom left first: kick, snare, closed hat, open hat, side stick, pedal hat, low tom, high tom, ride, shaker, tambourine, finger cymbal, low bongo, high bongo, conga, conga slap. The three hats share a choke group.

It is built for playing with dynamics. Every pad has two or three **velocity layers** that change the tone as well as the level: soft hits are darker, with less attack (ghost notes on the snare are mostly wires), and hard hits bring the felt beater, the rim and the slap. Inside each layer, **round-robin takes** (up to three; 66 takes in all) differ slightly in pitch, decay and noise, so a run of hats or ghost notes never repeats one copy. The low drums are made at 24 or 32 kHz, so the whole kit is 583,518 frames, inside a project's one-million-frame budget.

The kit is the file `apps/studio/public/kits/xmp/xmp-velvet.xmpkit` (drum-kit JSON), written from `native/include/xmp/velvet_kit.hpp` by `npm run kits:velvet`, which also records the file's size and SHA-256 that the browser checks before loading it. Choose it in **Play → Drum kits** or in the Device view's kit list. The dynamic Live Mk1 build and the WebAssembly touchscreen include it in **Browse → Kits**. **Load kit** puts it on the selected track with all its layers. `tests/velvet-kit.test.ts` checks the file, both cores' loading, the layers and the takes.

### Multi-sampled pads (project format 8)

A pad may hold `layers`: up to eight velocity layers, softest first, each covering velocities up to its `upTo` (the last reaching 1) with one to eight round-robin `samples` from the project's sample pool. The engine picks the layer from the hit's velocity, plays its takes in turn, and, since the takes carry the dynamics, scales the level only gently inside a layer (0.6 + 0.4 × velocity). The pad's own `sampleId` stays the sound that editors show. Replacing, recording over, cropping or slicing a pad's sound plays one sound again and drops its layers; a layered pad has no slice. A kit sound may bring its layers in a drum-kit file (`layers: [{ upTo, takes: [{ sampleRate, pcm }] }]`; a take equal to the sound's own `pcm` shares its sample), up to 120 sounds per kit. The WAV importer still reads one sound per pad.

## Included CC0 test selections

The owner authorized CC0 alternatives on 2026-11-09. These selections are available in **Browse → Kits** on the Live Mk1 and the web device, and in **Play → Drum kits** in Advanced Studio. Choose one and select **Load kit**. They do not use the eight imported-library slots. The original XMP kit stays the default.

- **Octal Deep · CC0**: 12 deep electronic house one-shots.
- **Octal Punch · CC0**: 12 punchy electronic one-shots, including a sub kick, noise and riser.
- **Virtuosity Acoustic · CC0**: eight acoustic hits from Versilian Studios and Karoryfer Samples, performed by Austin McMahon. This is a single-layer test selection, not the full SFZ instrument.

The two Octal selections use [Octal's CC0 house-core pack](https://github.com/octalmusic/octal-samples/tree/22d222ce36e290ba3792c776811aa9c69dcc8776). Its crash and ride derive from the public-domain uzu-drumkit; upstream provenance and license notices are retained. Octal WAVs are unmodified apart from filenames. The acoustic selection comes from [Virtuosity Drums](https://github.com/sfzinstruments/virtuosity_drums/tree/9f04cf9a734527edfbb0a4eee1f674e45bbf71bc). It is decoded from FLAC into mono PCM16 at 24 kHz; tails longer than three seconds are capped with a 20 ms fade. Levels are not normalized. Full velocity layers, microphone mixing and round robins are not imported.

`references/drum-kits.json` pins each source commit, Git blob and file length. `python3 tools/prepare-cc0-kits.py` downloads only those data files, verifies them, and prepares the WAVs using installed curl/ffmpeg. It runs no upstream code. Source downloads stay in ignored `references/archives/cc0-kits/`. Prepared WAVs and license notices are committed under `apps/studio/public/kits/`, along with per-file source/processed SHA-256 hashes and processing notes in `catalog.json`. Builds and tests use the committed files and require no upstream access.

Kit audio loads from this application's own origin only when selected. Each response is bounded and SHA-256 verified before the single project edit. Failed, corrupt, oversized or stale downloads leave the current song untouched. The files can accompany the browser preview under CC0; these selections are explicitly separate from the original built-in demo and include no Akai factory content. They do not establish hardware playback qualification.

## Reverb retrieval status — 2026-11-09

The [requested collection](https://reverb.com/featured/free-sample-packs-for-music-production) describes its drum packs as royalty-free for music production. The checked official listings for [Sublime-style drums](https://reverb.com/item/82315625-drums-in-the-style-of-sublime-s-what-i-got), [Al Green-style drums](https://reverb.com/item/68454147-drums-in-the-style-of-al-green-s-let-s-stay-together), [acoustic 808 hits](https://reverb.com/item/60435621-808-hits-created-with-acoustic-drums) and [the drum-machine collection](https://reverb.com/item/15980096-reverb-drum-machines-the-complete-collection) currently offer no working download to this session: Coming Soon or seller away. No Reverb audio has been downloaded, bundled or committed. The page's music-production permission does not establish permission to redistribute its raw samples in an OS or public web build.

If those packs are available in the owner's Reverb account or existing downloads, unzip them and use the local importer. The owner selected the CC0 alternatives above while Reverb retrieval remains unavailable. The original built-in demo remains unchanged. The automated WAV fixtures are generated test signals, not Reverb samples.

## Verification

`npm run bdd:kits` runs the Gherkin journeys in `features/17-drum-kits.feature`: whole-bank replacement and Undo, finite rendered audio and silent unused pads, portable persistence, invalid input rejection, Studio library switching and stale asynchronous import protection. `tests/drum-kits.test.ts` also verifies the eight-kit storage bound. These are Mac/host checks and do not qualify physical audio or an Akai device.
