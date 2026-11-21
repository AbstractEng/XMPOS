import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { licenceLedger, requirementsBaseline } from "../acceptance/lib/provenance.mjs";
import { root, writeJson } from "../acceptance/lib/workspace.mjs";

mkdirSync(resolve(root, "reports/baseline"), { recursive: true });
writeJson(resolve(root, "reports/baseline/requirements.json"), requirementsBaseline());
writeJson(resolve(root, "reports/baseline/licences.json"), licenceLedger());
console.log(
  "Requirements/source hashes and component licence metadata: reports/baseline. External specification pending; reference redistribution review pending.",
);
