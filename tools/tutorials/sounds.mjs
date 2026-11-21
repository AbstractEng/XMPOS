// The current Sound page uses the same compositor and capture path as the course.
import { execFileSync } from "node:child_process";

execFileSync(process.execPath, [`${import.meta.dirname}/render.mjs`, "--sounds-only"], {
  stdio: "inherit",
});
