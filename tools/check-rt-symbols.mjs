import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { root, writeJson } from "../acceptance/lib/workspace.mjs";

const object = resolve(root, "build/native/CMakeFiles/xmp_engine_rt.dir/src/engine.cpp.o");
const symbols = execFileSync("nm", ["-u", object], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const prohibited =
  /(?:\b_?(?:malloc|calloc|realloc|free|fopen|fread|fwrite|open|read|write|socket|send|recv|connect|pthread_\w+)$|_Zn[aw]|mutex|condition_variable)/;
const forbidden = symbols.filter((symbol) => prohibited.test(symbol));
mkdirSync(resolve(root, "reports/native"), { recursive: true });
writeJson(resolve(root, "reports/native/rt-symbols.json"), {
  scope:
    "All Engine callback code is in this compiled translation unit; runtime audit is checked separately",
  symbols,
  forbidden,
});
if (forbidden.length) throw new Error(`Forbidden callback dependency: ${forbidden.join(", ")}`);
console.log("Native callback object: no allocation, lock, file or network symbol dependencies.");

const liveObject = resolve(
  root,
  "build/native/CMakeFiles/xmp_live_audio_rt.dir/src/live_callback_audit.cpp.o",
);
const liveSymbols = execFileSync("nm", ["-u", liveObject], { encoding: "utf8" })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);
const liveForbidden = liveSymbols.filter((symbol) => prohibited.test(symbol));
writeJson(resolve(root, "reports/native/live-rt-symbols.json"), {
  scope: "Live ProjectSound callback, including live rack handover and tempo retiming",
  symbols: liveSymbols,
  forbidden: liveForbidden,
});
if (liveForbidden.length)
  throw new Error(`Forbidden live callback dependency: ${liveForbidden.join(", ")}`);
console.log(
  "Live callback and handover: no allocation, lock, file or network symbol dependencies.",
);

const parityObject = resolve(root, "build/native/CMakeFiles/xmp_parity_dsp.dir/src/parity_dsp.c.o");
const paritySymbols = execFileSync("nm", ["-u", parityObject], { encoding: "utf8" })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);
const parityForbidden = paritySymbols.filter((s) => prohibited.test(s));
writeJson(resolve(root, "reports/native/parity-rt-symbols.json"), {
  scope: "Compiled declarative native DSP processor only; preparation and file I/O are separate",
  symbols: paritySymbols,
  forbidden: parityForbidden,
});
if (parityForbidden.length) throw new Error("Forbidden declarative DSP callback dependency");
console.log("Declarative DSP object: no allocation, lock, file or network symbol dependencies.");
