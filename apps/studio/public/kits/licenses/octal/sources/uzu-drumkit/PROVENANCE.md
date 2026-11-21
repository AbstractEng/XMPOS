# sources/uzu-drumkit — provenance

Public-domain source material for the house-core crash and ride (the two
kit sounds that resist synthesis — real cymbals are chaotically nonlinear;
even the TR-909 shipped sampled cymbals).

- Repository: https://github.com/tidalcycles/uzu-drumkit
- Commit: `2f3e05c70ab4d73ad053a1467adec89bd27377a0`
- License: **The Unlicense** (public domain dedication) — full text in
  `LICENSE` alongside these files, copied verbatim from the repository.
- Files (sha256 of the verbatim copies in this directory):
  - `11_cr_mot4i.wav` (crash, 2.0 s, 44.1 kHz stereo PCM16)
    `0fd8dfeb7eccee5aad90154b25547ab4fa17ce09b8d187cb903fdc6a4edb6323`
  - `10_rd_switchangel.wav` (ride, 0.93 s, 44.1 kHz mono PCM16)
    `88edbf3d85659aed5a54c0863c50b76f0f5b2a38df201589a7412becaedd78a1`

These raw finds never ship as-is: `scripts/generate-kit.ts` renders the
shipped `samples/cymbals/*.wav` as deterministic owned derivatives (mono
mixdown, EQ, saturation, normalization, fades) and records the full chain in
`LICENSES.md`.
