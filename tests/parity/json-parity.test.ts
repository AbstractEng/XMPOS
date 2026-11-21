import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// XMP's C++ JSON (native/include/xmp/json.hpp) against JavaScript's JSON.parse
// and JSON.stringify: the same accept/reject decisions, and byte-identical text
// out (compact and indented), including number formatting, key order with
// array-index keys, escapes, unicode and lone surrogates.
const root = join(import.meta.dirname, "..", "..");
const haveCompiler = spawnSync("c++", ["--version"]).status === 0;

function driver() {
  const dir = mkdtempSync(join(tmpdir(), "xmp-json-")),
    binary = join(dir, "json");
  execFileSync("c++", [
    "-std=c++17",
    "-O1",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(root, "native/include")}`,
    join(root, "native/tools/json_roundtrip.cpp"),
    "-o",
    binary,
  ]);
  return (docs: string[]) => {
    const out = execFileSync(binary, {
      input: Buffer.concat(docs.map((d) => Buffer.from(`${d}\0`, "utf8"))),
      maxBuffer: 1 << 28,
    })
      .toString("utf8")
      .split("\0");
    out.pop();
    return out;
  };
}
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function randomNumber(r: () => number) {
  const roll = r();
  if (roll < 0.2) return Math.floor(r() * 1000) - 500;
  if (roll < 0.4) return Math.round(r() * 1e4) / 1e4;
  if (roll < 0.5) return (r() - 0.5) * 10 ** Math.floor(r() * 60 - 30);
  // Exact powers of two and small dyadic fractions: decimal ties, where the
  // shortest digits are not the correctly rounded ones (2^-24 is 5.960464477539063e-8).
  if (roll < 0.52) return 2 ** (Math.floor(r() * 2098) - 1074);
  if (roll < 0.54)
    return Math.floor(r() * 2 ** 20) * 2 ** -(Math.floor(r() * 60) + 1) * (r() < 0.5 ? -1 : 1);
  if (roll < 0.55)
    return [0, -0, 1e21, 1e-7, 123e-20, 2 ** 53, 5e-324, 1.7976931348623157e308][
      Math.floor(r() * 8)
    ] as number;
  // Any finite double, from random bits.
  const b = new DataView(new ArrayBuffer(8));
  b.setUint32(0, Math.floor(r() * 2 ** 32));
  b.setUint32(4, Math.floor(r() * 2 ** 32));
  const v = b.getFloat64(0);
  return Number.isFinite(v) ? v : 0;
}
function randomString(r: () => number) {
  const pieces = [
    "a",
    "Z",
    "0",
    " ",
    '"',
    "\\",
    "/",
    "\n",
    "\t",
    "\u0001",
    "\u001f",
    "é",
    "€",
    "🎛",
    "\ud800",
    "\udfff",
    "Kick 1",
  ];
  return Array.from(
    { length: Math.floor(r() * 8) },
    () => pieces[Math.floor(r() * pieces.length)],
  ).join("");
}
function randomValue(r: () => number, depth = 0): unknown {
  const roll = r();
  if (depth > 4 || roll < 0.3) return randomNumber(r);
  if (roll < 0.45) return randomString(r);
  if (roll < 0.5) return [true, false, null][Math.floor(r() * 3)];
  if (roll < 0.7)
    return Array.from({ length: Math.floor(r() * 5) }, () => randomValue(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 6); i > 0; i--) {
    // Keys without lone surrogates: Node 24's JSON.parse can return the wrong
    // name for a lone-surrogate key after earlier parses (a V8 key-cache bug,
    // found by this test on 2026-11-12); the C++ handles them (see the values).
    const key =
      r() < 0.3
        ? String(Math.floor(r() * 20))
        : r() < 0.1
          ? "01"
          : randomString(r).replace(/[\ud800-\udfff]/g, "s");
    o[key] = randomValue(r, depth + 1);
  }
  return o;
}
// What JavaScript makes of the same bytes: files are UTF-8, so a raw lone
// surrogate in a JavaScript string reaches the C++ as U+FFFD, as a file would.
const expected = (raw: string) => {
  const text = Buffer.from(raw, "utf8").toString("utf8");
  try {
    const v = JSON.parse(text);
    return `ok\n${JSON.stringify(v)}\n${JSON.stringify(v, null, 2)}`;
  } catch {
    return "error\n";
  }
};

describe.skipIf(!haveCompiler)("the C++ JSON matches JavaScript", () => {
  const run = driver();
  it("round-trips random documents byte for byte", () => {
    const r = rng(7),
      docs: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const v = randomValue(r);
      // Raw text with whitespace, escapes and duplicate keys, as files may hold.
      let text = JSON.stringify(v, null, r() < 0.5 ? 0 : 3);
      if (r() < 0.1) text = `  \n${text}\t\r\n`;
      if (r() < 0.05) text = `{"k":1,"b":2,"k":${text}}`;
      if (r() < 0.05) text = text.replace(/"/g, '"').replace(/a/g, "\\u0061");
      docs.push(text);
    }
    const got = run(docs);
    docs.forEach((d, i) => {
      expect(got[i], d).toBe(expected(d));
    });
  });
  it("formats numbers as JavaScript does", () => {
    const r = rng(11),
      nums = Array.from({ length: 20000 }, () => randomNumber(r));
    const docs = nums.map((n) => `[${JSON.stringify(n)}]`);
    const got = run(docs);
    docs.forEach((d, i) => {
      expect(got[i], d).toBe(expected(d));
    });
  });
  it("accepts and refuses what JSON.parse does", () => {
    const docs = [
      "",
      " ",
      "{",
      "}",
      "[1,]",
      "[,1]",
      '{"a":1,}',
      '{"a" 1}',
      "{a:1}",
      "01",
      "-",
      "1.",
      ".5",
      "1e",
      "1e+",
      "+1",
      "-0",
      "0.0e-0",
      "NaN",
      "Infinity",
      "true",
      "tru",
      "nul",
      "null x",
      '"\\x"',
      '"\\u12"',
      '"\\u12G4"',
      '"a\nb"',
      '"\\ud83c\\udf9b"',
      '"\\ud83c"',
      '"\\udf9b\\ud83c"',
      '"\\ud83c\\u0041"',
      "[1 2]",
      '{"__proto__":1}',
      '{"1":1,"0":0,"b":2,"a":3,"10":4,"4294967294":5,"4294967295":6}',
      "[1e400]",
      "[-1e-400]",
      '" "',
    ];
    const got = run(docs);
    docs.forEach((d, i) => {
      expect(got[i], d).toBe(expected(d));
    });
  });
});
