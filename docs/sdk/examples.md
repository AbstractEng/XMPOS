# SDK examples and customization loop

Run these from the new contributor project containing the installed tarball. All examples operate on data or produce local files; none opens an audio device or contacts hardware. New destinations must not already exist.

## Original instrument

The installed `examples/community-tone/` contains a complete MIT-licensed instrument: manifest, graph, parameter reference and coding guidance. Build it directly:

```sh
./node_modules/.bin/xmp build node_modules/@xmp/sdk/examples/community-tone tone.xmpkg
./node_modules/.bin/xmp test tone.xmpkg
./node_modules/.bin/xmp preview tone.xmpkg tone.wav
./node_modules/.bin/xmp parity tone.xmpkg tone-parity
```

For your own editable copy, use `xmp new instrument my-tone my-tone`. Change the graph's `source` from `sine` to `triangle` or adjust the `level`/`cutoff` defaults in `module.json`, then build to a new output package. Keep parameter IDs/units stable. Read [the graph reference](../community-sdk.md) for bounds and migrations.

## Original effect

```sh
./node_modules/.bin/xmp build node_modules/@xmp/sdk/examples/community-filter filter.xmpkg
./node_modules/.bin/xmp test filter.xmpkg
./node_modules/.bin/xmp preview filter.xmpkg filter.wav
./node_modules/.bin/xmp parity filter.xmpkg filter-parity
```

The effect uses an in-memory virtual-input impulse, gain and one-pole filter. This proves its declared processing on that fixture, not access to a microphone or Live input. Scaffold a separate copy with `xmp new effect my-filter my-filter`.

## Custom UI and workflow

The installed `examples/sdk-ui/render.mjs` shows an original source-built presentation using the public package API. It loads the included declarative instrument as data, builds/verifies it, renders a bounded reference take, and writes a self-contained HTML sound card with embedded WAV. It starts no server and executes no imported module code.

```sh
node node_modules/@xmp/sdk/examples/sdk-ui/render.mjs sound-card.html
cp node_modules/@xmp/sdk/examples/sdk-ui/render.mjs my-sound-card.mjs
# Edit the title, markup or styles in my-sound-card.mjs, then:
node my-sound-card.mjs custom-sound-card.html
```

To present your own scaffolded instrument, edit the trusted copy’s `example` line to `const example = new URL("./my-tone/", import.meta.url);` and keep that `my-tone` directory beside the script. It must contain your validated `module.json`, `program.json` and `LICENSE`. Run build/test/parity on the same instrument first; changing only the UI title does not change the sound.

Open the generated HTML in a browser. Playback requires the user's explicit play action and uses the browser's selected host output. You can inspect the rendered waveform, play/download the original fixture and see its module/API information. Change the markup/styles in a trusted source copy to make your own interface; change the graph/manifest through the supported package path to change its sound. This demonstrates customization without promising a native UI plugin loader.

The HTML generator preserves existing output files. Its built-in title/labels are fixed trusted source, and the instrument comes from the included allowlisted example. The acceptance suite runs the example from an offline-installed SDK, copies/customizes its source into the contributor project, and verifies a nonempty PCM payload and visible controls. Use the [repository setup guide](repository-setup.md) for editing XMP's full browser/native interface and compiling a custom OS app.

## Store, bind and rollback

```sh
./node_modules/.bin/xmp store-init my-store
./node_modules/.bin/xmp install my-store tone.xmpkg
./node_modules/.bin/xmp bind my-store tone.xmpkg
./node_modules/.bin/xmp store-status my-store
```

For an upgrade, build a new immutable package version with an explicit consecutive state migration where needed, then install it into the store. `xmp rollback my-store` restores the stored prior package/project snapshot when a rollback is available. Editing/replacing a project clears rollback. These are local workbench transactions, not installation into the Live session.

Keep the failed command's exit status and parity report when diagnosing problems. Re-running a successful command at the same output path intentionally fails; choose a fresh destination instead of deleting unrelated work.
