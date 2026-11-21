// Reuse the owner-supplied Abstract Engineering identity without redrawing assets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export const root = resolve(import.meta.dirname, "../..");
export const source = resolve(root, "brand/abstract-engineering");
export const destination = resolve(root, "apps/studio/public/manual-media/identity");
const files = {
  "abstract-engineering.svg": "assets/logos/svg/abstract-engineering-horizontal-forest.svg",
  "ae-mark.svg": "assets/logos/svg/ae-mark-forest.svg",
  "hero-gesture.svg": "assets/artwork/hero-gesture.svg",
  "Manrope-Regular.woff2": "assets/fonts/Manrope-Regular.woff2",
  "Manrope-Medium.woff2": "assets/fonts/Manrope-Medium.woff2",
  "Manrope-SemiBold.woff2": "assets/fonts/Manrope-SemiBold.woff2",
  "OFL.txt": "assets/fonts/OFL.txt",
};
mkdirSync(destination, { recursive: true });
const manifest = resolve(destination, "provenance.json");
const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : undefined;
const assets = Object.entries(files).map(([name, path]) => {
  const original = resolve(source, path),
    delivered = resolve(destination, name);
  if (existsSync(original)) copyFileSync(original, delivered);
  else {
    const expected = previous?.assets.find((asset) => asset.file === name);
    assert.ok(expected, `Missing approved identity asset: ${name}`);
    assert.equal(
      createHash("sha256").update(readFileSync(delivered)).digest("hex"),
      expected.sha256,
    );
  }
  return {
    file: name,
    source: `brand/abstract-engineering/${path}`,
    sha256: createHash("sha256")
      .update(readFileSync(resolve(destination, name)))
      .digest("hex"),
  };
});
writeFileSync(
  resolve(destination, "provenance.json"),
  `${JSON.stringify(
    {
      identity: "Abstract Engineering · Soft Resonance – Refined",
      version: "1.0",
      issued: "2026-11-15",
      assets,
    },
    null,
    2,
  )}\n`,
);
const data = (name, type) =>
  `data:${type};base64,${readFileSync(resolve(destination, name)).toString("base64")}`;
export const logo = data("abstract-engineering.svg", "image/svg+xml");
export const fontCSS = Object.entries({ Regular: 400, Medium: 500, SemiBold: 600 })
  .map(
    ([name, weight]) =>
      `@font-face{font-family:Manrope;font-style:normal;font-weight:${weight};src:url('${data(`Manrope-${name}.woff2`, "font/woff2")}') format('woff2');font-display:block}`,
  )
  .join("");
export const identity = {
  name: "Abstract Engineering",
  version: "1.0",
  paper: "#F2EFE9",
  forest: "#35473E",
  rose: "#C88E91",
  butter: "#E6C779",
  iris: "#5862BF",
  font: "Manrope",
};
