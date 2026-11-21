// Golden expectations: SHA-256 fingerprints of what the C++ engines (as
// WebAssembly, so bit-for-bit the same on every machine) produced when they
// were last checked against the original TypeScript, before that TypeScript
// was retired (docs/cpp-port.md, phase 9 part 5). A test adds every result it
// computes to a log; the log's fingerprint must match the recorded one.
//
// XMP_GOLDEN=record rewrites the fingerprints. Do that only for a deliberate
// change of behaviour, and say why in the commit.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "vitest";

const file = new URL("./golden.json", import.meta.url);
const recording = process.env.XMP_GOLDEN === "record";

function load(): Record<string, string> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// Exact text for a value: typed arrays as their bytes, numbers as JavaScript writes them.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (ArrayBuffer.isView(v))
      return `bytes:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex")}`;
    if (v instanceof ArrayBuffer) return `bytes:${Buffer.from(v).toString("hex")}`;
    if (v instanceof Map) return { map: [...v] };
    if (typeof v === "number" && !Number.isFinite(v)) return `number:${v}`;
    if (Object.is(v, -0)) return "number:-0";
    return v;
  });
}

export class GoldenLog {
  private hash = createHash("sha256");
  count = 0;
  constructor(readonly name: string) {}
  add<T>(value: T): T {
    this.hash.update(canonical(value) ?? "undefined").update("\n");
    this.count++;
    return value;
  }
  // The log matches the recorded fingerprint (or, recording, becomes it).
  check() {
    const digest = this.hash.digest("hex");
    const all = load();
    if (recording) {
      all[this.name] = digest;
      writeFileSync(file, `${JSON.stringify(all, Object.keys(all).sort(), 2)}\n`);
      return;
    }
    expect(
      all[this.name],
      `no golden fingerprint for ${this.name}: XMP_GOLDEN=record`,
    ).toBeDefined();
    expect(digest, `${this.name}: ${this.count} results differ from the recorded engine`).toBe(
      all[this.name],
    );
  }
}
