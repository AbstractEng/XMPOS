import { readFileSync, writeFileSync } from "node:fs";
import { firstNonzero } from "../acceptance/lib/fixtures.mjs";

const actualFrame = firstNonzero(readFileSync(process.argv[2]));
const expectedFrame = Number(process.argv[3]);
const result = {
  expectedFrame,
  actualFrame,
  deltaFrames: actualFrame === null ? null : actualFrame - expectedFrame,
  outcome: actualFrame === expectedFrame ? "passed" : "failed",
};
writeFileSync(process.argv[4], JSON.stringify(result));
console.log(JSON.stringify(result));
process.exitCode = result.outcome === "passed" ? 0 : 1;
