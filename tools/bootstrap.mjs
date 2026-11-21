import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const run = (bin, args) => execFileSync(bin, args, { cwd, stdio: "inherit" });
run("npm", ["ci"]);
run("python3", ["-m", "venv", ".venv"]);
run(`${cwd}.venv/bin/python`, ["-m", "pip", "install", "-r", "tools/requirements.txt"]);
run("node", ["tools/doctor.mjs"]);
