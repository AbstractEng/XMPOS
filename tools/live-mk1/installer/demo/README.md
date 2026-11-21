# Acid Circuit — first-start project

Original XMP music and synthesized sounds, distributed with XMP under Apache-2.0.
No Akai samples, firmware, narration or third-party recordings are included.

This is the four-part, 128 BPM acid-house song from the published Acid Circuit
demonstration: 909-style drums, acid bass, C minor seventh stabs and 808-style
percussion. Its six-block, 22-bar arrangement ends in Stop. Press PLAY to hear
the song; the clips, instruments and mix remain editable.

The original UI export has SHA-256
`019340dff83bf630010f8ee98b73264fb9925cb05aa88a0c8a6fe2dbb770e906`.
The bundled copy was opened and saved with the shared project core. Only the
project identity/title, four track labels and first four scene labels changed.
Notes, sounds, arrangement, swing and mix are retained.
`first-project.mjs` pins the bundled file's size and SHA-256.

The installer seeds `xmp/project.xmpsong` only when no startup project, legacy
pattern, edit journal or recovery save exists. Exclusive creation never replaces
an existing file. Named projects, samples, settings and previous images remain
untouched. Reinstalling does not reset the song after someone has edited it.
