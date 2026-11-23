import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import demo from "../../apps/studio/src/demo-night-shift.json" with { type: "json" };

export function checkDemo(site) {
  const bytes = readFileSync(resolve(site, "demo", demo.file));
  if (
    bytes.length !== demo.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== demo.sha256
  )
    throw new Error(
      "The hosted Night Shift starter is missing or differs from its verified source",
    );
}
