# README media

- `cover.svg`: the existing Orbit Play/Record XMP silhouette, Abstract Engineering
  gesture artwork and the website's paper/forest palette. Manrope text is outlined
  so GitHub does not need an external font. `build.py` is its editable composition;
  the underlying vectors and font inputs remain in `brand/`.
- `acid-circuit.jpg`: the website's original Acid Circuit poster, copied without
  alteration. It shows the **browser Device view**, not a physical MPC recording.
  The README links it to the existing website video player; no video or narrated
  tutorial file is copied into this repository.

- `live-loop.jpg`: a frame from the approved final 2:07 hardware recording.
  The full edited MP4 is a private release asset, kept out of Git history;
  `hardware-video.json` records its exact hash, duration and link.

Manrope's [OFL licence](../../../brand/abstract-engineering/assets/fonts/OFL.txt)
applies to its outlined glyphs. The existing brand assets retain their original
terms. The poster is XMP interface artwork and a captured original demonstration.
No private project, device identity, recording, token or firmware is included.

To regenerate the cover with the optional artwork dependency:

```sh
python3 -m pip install fonttools==4.61.1
python3 docs/assets/readme/build.py
```

GitHub Markdown embeds the image files directly. The preview is an ordinary image
link to the hosted video, so it also works where README video players are unavailable.
