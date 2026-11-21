import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const sharp = require(process.env.XMP_SHARP_PATH || "sharp");
const root = import.meta.dirname;
const png = path.join(root, "assets/png");
await fs.mkdir(png, { recursive: true });
const names = ["xmp-orbit", "extensible-music-platform-orbit"];
const sources = [];
for (const name of names) {
  const source = await fs.readFile(path.join(root, "assets/svg", name + ".svg"), "utf8");
  const width = Number(source.match(/width="([\d.]+)"/)[1]);
  const height = Number(source.match(/height="([\d.]+)"/)[1]);
  sources.push({ source, width, height });
  for (const size of [2048, 4096]) {
    await sharp(Buffer.from(source), { density: 300 })
      .resize({ width: size })
      .png()
      .toFile(path.join(png, `${name}-${size}.png`));
  }
}
const boot = await fs.readFile(
  path.join(root, "boot/emerald-current-2026-11-18/mpc-live-mk1-emerald-current.svg"),
);
await sharp(boot).png().toFile(path.join(root, "boot/mpc-live-mk1-boot.png"));
await sharp(boot, { density: 144 }).png().toFile(path.join(root, "boot/mpc-live-mk1-boot-2x.png"));

// A vector composition proves the transparent counters against two surfaces.
let proof =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100" viewBox="0 0 1600 1100"><title>XMP transparent logo proof</title>';
for (const [index, bg] of ["#07110D", "#667D72"].entries()) {
  const x = index * 800;
  proof += `<rect x="${x}" width="800" height="1100" fill="${bg}"/>`;
  let y = 120;
  for (const item of sources) {
    const content = item.source.slice(
      item.source.indexOf(">") + 1,
      item.source.lastIndexOf("</svg>"),
    );
    proof += `<svg x="${x + 64}" y="${y}" width="672" height="${(672 * item.height) / item.width}" viewBox="0 0 ${item.width} ${item.height}">${content}</svg>`;
    y += 430;
  }
}
proof += "</svg>";
await fs.writeFile(path.join(root, "assets/transparency-proof.svg"), proof);
await sharp(Buffer.from(proof), { density: 100 })
  .resize({ width: 1600 })
  .png()
  .toFile(path.join(root, "assets/transparency-proof.png"));

for (const name of names) {
  const file = path.join(png, `${name}-4096.png`);
  const meta = await sharp(file).metadata();
  if (!meta.hasAlpha) throw new Error("Missing alpha: " + name);
  console.log(`${name}: ${meta.width} x ${meta.height}, transparent RGBA PNG + SVG master`);
}
console.log("Boot screen rendered at 1280 x 800 and 2560 x 1600.");
