# Manual colour and sketch studies

Eight original, transparent SVG illustrations extend the supplied Abstract Engineering Soft Resonance artwork vocabulary: loose pastel loops, pressure-like stroke variation, thin Forest pencil lines, rhythmic marks and translucent Rose/Butter/Iris fields. Grain is static and the supplied logo masters are preserved.

Rebuild with `node tools/tutorials/sketches.mjs`. Each composition has its own authored paths; the palette, asset descriptions and SHA-256 values are recorded in `apps/studio/public/manual-media/sketches/manifest.json`.

The manual uses sixteen placements: one hero drawing, six interludes between lesson pairs and nine illustrations at reference chapters. Decorative images have empty alternative text and are hidden from assistive technology. They occupy their own space, away from instructions, controls and the logo. Placement is maintained by `tools/tutorials/manual-art.mjs` and the normal manual generator.

Rose, Butter and Iris accent the quick-start steps, chapter and lesson markers, summaries, callouts and tables. Forest remains the text colour on tinted surfaces. Paper remains the page background. Mobile layouts stack naturally; the quick start remains first.

The manual-only deployment helper `tools/web-host/prepare-manual.mjs` retains a verified snapshot of the current public app and its dependency graph, then overlays the built manual and its verified course and sketch assets. It refuses a changing public app and verifies that existing course media stay unchanged. This avoids bundling unrelated app work from the shared checkout into a manual styling update.

Published as Worker version `9e92c901-a314-4a02-8af5-b8b412fbe9a1`. Live review matched all eight SVG hashes, confirmed sixteen placements, retained the public app and its eleven dependencies byte-for-byte, and passed five viewport widths with no page errors. The full course check matched eighty served files and exercised all fourteen videos.
