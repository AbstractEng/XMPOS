import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeBase64 } from "../packages/core/src/engine.ts";
import { MODULES, sourceHash } from "../tools/engine/build-wasm.mjs";

// Every committed WebAssembly module (engine, sequencer, transport, controls) was built
// from the C++ in this tree: run `npm run engine:wasm` after changing it.
describe("the committed WebAssembly modules", () => {
  for (const module of MODULES)
    it(`${module.name} matches its C++ sources`, async () => {
      const text = await readFile(join(import.meta.dirname, "..", module.output), "utf8");
      const field = (name: string) =>
        new RegExp(`${module.prefix}_${name} =\\s*"([^"]+)"`).exec(text)?.[1] ?? "";
      expect(field("SOURCE_SHA256"), "run `npm run engine:wasm`").toBe(await sourceHash(module));
      expect(
        createHash("sha256")
          .update(decodeBase64(field("WASM_BASE64")))
          .digest("hex"),
      ).toBe(field("WASM_SHA256"));
    });
});
