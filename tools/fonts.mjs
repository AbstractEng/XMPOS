// The fonts XMP's Live interface draws with, and the glyph atlas made from
// them (native/include/xmp/live_text.hpp reads it). The web Device view asks
// for Inter; the Live uses the same Inter, and JetBrains Mono for the gold
// numbers the web draws in a monospace font. Both are under the SIL Open Font
// Licence; stb_truetype (public domain or MIT) rasterizes them.
//
// Nothing here is committed: each file is downloaded once into
// references/archives/fonts (git-ignored), refused unless its SHA-256 matches,
// and the atlas is generated into build/fonts/xmp_font_atlas.hpp.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archives = join(root, "references/archives/fonts");
export const fontDirectory = join(root, "build/fonts");

const DOWNLOADS = [
  {
    file: "Inter-4.1.zip",
    url: "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip",
    sha256: "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e",
    extract: {
      "extras/ttf/Inter-Regular.ttf": "Inter-Regular.ttf",
      "extras/ttf/Inter-SemiBold.ttf": "Inter-SemiBold.ttf",
      "extras/ttf/Inter-Bold.ttf": "Inter-Bold.ttf",
      "LICENSE.txt": "Inter-LICENSE.txt",
    },
  },
  {
    file: "JetBrainsMono-2.304.zip",
    url: "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip",
    sha256: "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf",
    extract: {
      "fonts/ttf/JetBrainsMono-Regular.ttf": "JetBrainsMono-Regular.ttf",
      "OFL.txt": "JetBrainsMono-OFL.txt",
    },
  },
  {
    file: "stb_truetype.h",
    url: "https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_truetype.h",
    sha256: "ecd30b05e0dd4fea3a13c26810dd9e1992dc379049482c393d5a19e6b5090aab",
  },
];

// The faces the interface uses: the web Device view's CSS sizes (px) and
// weights. A <strong> is bold (700); a weight of 550 draws as SemiBold (600),
// the face a browser picks for it.
export const FACES = [
  ["caption", "Inter-Regular.ttf", 15], // clip cell captions
  ["small", "Inter-Regular.ttf", 14], // Q-Link page labels
  ["muted", "Inter-Regular.ttf", 17], // header project name, audio state
  ["label", "Inter-Regular.ttf", 18], // Q-Link names
  ["status", "Inter-Regular.ttf", 19], // the status line
  ["body", "Inter-Regular.ttf", 20], // toolbar, column heads, the header's track
  ["base", "Inter-Regular.ttf", 22], // buttons and running text
  ["title", "Inter-Bold.ttf", 24], // clip names, the header's view
  ["heading", "Inter-SemiBold.ttf", 28], // headings
  ["large", "Inter-Bold.ttf", 34], // the knob shown large
  ["glyph", "Inter-Regular.ttf", 38], // the header's back arrow
  ["mono", "JetBrainsMono-Regular.ttf", 24], // positions, BPM and knob values
  ["monoLarge", "JetBrainsMono-Regular.ttf", 40], // a knob's value shown large
  ["bodyBold", "Inter-Bold.ttf", 20], // the header's track (an <em> inside the bold view name)
  ["card", "Inter-Bold.ttf", 25], // page menu cards
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(d) {
  const path = join(archives, d.file);
  if (!existsSync(path)) {
    mkdirSync(archives, { recursive: true });
    const response = await fetch(d.url);
    if (!response.ok) throw new Error(`Font download failed: ${d.url} (${response.status})`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const got = sha256(path);
  if (got !== d.sha256) throw new Error(`${d.file}: SHA-256 ${got} is not the pinned ${d.sha256}`);
  return path;
}

// Downloads (once), verifies and extracts the fonts, then makes the atlas
// header if it is missing or older than its inputs. Returns build/fonts.
export async function ensureFonts() {
  mkdirSync(fontDirectory, { recursive: true });
  for (const d of DOWNLOADS) {
    const path = await download(d);
    if (!d.extract) {
      const target = join(fontDirectory, d.file);
      if (!existsSync(target)) writeFileSync(target, readFileSync(path));
      continue;
    }
    for (const [inside, name] of Object.entries(d.extract)) {
      const target = join(fontDirectory, name);
      if (existsSync(target)) continue;
      writeFileSync(target, execFileSync("unzip", ["-p", path, inside], { maxBuffer: 2 ** 26 }));
    }
  }
  const header = join(fontDirectory, "xmp_font_atlas.hpp");
  const spec = FACES.map(([name, file, size]) => `${name}:${join(fontDirectory, file)}:${size}`);
  const stamp = join(fontDirectory, "atlas.spec");
  const generator = join(root, "native/tools/font_atlas.cpp");
  const wanted = `${spec.join("\n")}\n${sha256(generator)}\n`;
  // What a device image needs: the atlas and the two licences (build/fonts/image).
  const forImage = () => {
    const dir = join(fontDirectory, "image");
    mkdirSync(dir, { recursive: true });
    for (const name of ["xmp_font_atlas.hpp", "Inter-LICENSE.txt", "JetBrainsMono-OFL.txt"])
      writeFileSync(join(dir, name), readFileSync(join(fontDirectory, name)));
    return fontDirectory;
  };
  if (existsSync(header) && existsSync(stamp) && readFileSync(stamp, "utf8") === wanted)
    return forImage();
  const tool = join(fontDirectory, "font_atlas");
  execFileSync("c++", ["-std=c++17", "-O2", `-I${fontDirectory}`, generator, "-o", tool], {
    stdio: "inherit",
  });
  execFileSync(tool, [header, ...spec], { stdio: "inherit" });
  writeFileSync(stamp, wanted);
  return forImage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = await ensureFonts();
  console.log(`fonts and atlas ready in ${dir}`);
}
