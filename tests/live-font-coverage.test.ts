import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Live's screen font is an atlas of a fixed set of characters
// (native/tools/font_atlas.cpp); anything else draws as "?". Every string the
// Live's interface code holds must use only those characters.
const root = join(import.meta.dirname, "..");

function atlasCodepoints(): Set<number> {
  const source = readFileSync(join(root, "native/tools/font_atlas.cpp"), "utf8");
  const body = /std::vector<int> codepoints\(\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  const set = new Set<number>();
  const range = /for \(int c = (\d+); c < (\d+); \+\+c\)/.exec(body);
  if (range) for (let c = Number(range[1]); c < Number(range[2]); c++) set.add(c);
  const list = /for \(int c : \{([^}]*)\}\)/.exec(body)?.[1] ?? "";
  for (const item of list.split(",")) set.add(Number(item.trim()));
  return set;
}

// The characters of each C++ string literal, with \xHH escapes as UTF-8 bytes.
function literals(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const bytes: number[] = [];
    const body = match[1] ?? "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\") {
        const next = body[i + 1];
        if (next === "x") {
          bytes.push(Number.parseInt(body.slice(i + 2, i + 4), 16));
          i += 3;
        } else {
          bytes.push(32);
          i += 1;
        }
        continue;
      }
      bytes.push(...new TextEncoder().encode(body[i]));
    }
    out.push(new TextDecoder().decode(new Uint8Array(bytes)));
  }
  return out;
}

describe("the Live's screen font", () => {
  it("has every character the Live's interface strings use", () => {
    const have = atlasCodepoints();
    expect(have.has(0x2013)).toBe(true);
    const dir = join(root, "native/include/xmp");
    const files = [
      ...readdirSync(dir)
        .filter((f) => /^live_(ui|screen|edit|fields|text)\.hpp$/.test(f))
        .map((f) => join(dir, f)),
    ];
    const missing: string[] = [];
    for (const file of files)
      for (const text of literals(readFileSync(file, "utf8")))
        for (const ch of text) {
          const cp = ch.codePointAt(0) ?? 0;
          if (cp >= 127 && !have.has(cp))
            missing.push(
              `${file.slice(root.length + 1)}: U+${cp.toString(16).toUpperCase()} in "${text.slice(0, 40)}"`,
            );
        }
    expect(missing).toEqual([]);
  });
});
