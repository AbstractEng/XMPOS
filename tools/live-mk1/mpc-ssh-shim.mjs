#!/usr/bin/env node
// The `ssh` that Akai's mpc_remote.py runs when XMP's wrapper starts it
// (tools/live-mk1/mpc-remote.mjs, AGENTS.md authorization 6). mpc_remote.py turns
// host-key checking off; this puts the pinned host key back, refuses any host
// other than the one the wrapper identified, and logs every remote command.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export function rewrite(argv, env) {
  const host = env.XMP_MPC_HOST,
    port = env.XMP_MPC_PORT ?? "22",
    knownHosts = env.XMP_MPC_KNOWN_HOSTS;
  if (!host || !knownHosts) throw new Error("mpc-ssh-shim runs only under npm run live:mpc.");
  const out = [];
  let destination = null,
    command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") {
      const value = argv[++i] ?? "";
      const key = value.split("=")[0].toLowerCase();
      if (key === "stricthostkeychecking") out.push("-o", "StrictHostKeyChecking=yes");
      else if (key === "userknownhostsfile") out.push("-o", `UserKnownHostsFile="${knownHosts}"`);
      else if (
        [
          "loglevel",
          "connecttimeout",
          "serveraliveinterval",
          "serveralivecountmax",
          "numberofpasswordprompts",
          "batchmode",
        ].includes(key)
      )
        out.push("-o", value);
      else throw new Error(`ssh option ${value} refused`);
    } else if (a === "-p") {
      if (argv[++i] !== port) throw new Error("ssh port differs from the identified one");
      out.push("-p", port);
    } else if (a.startsWith("-")) throw new Error(`ssh flag ${a} refused`);
    else if (destination === null) destination = a;
    else if (command === null) command = a;
    else throw new Error("unexpected ssh arguments");
  }
  if (destination !== `root@${host}`)
    throw new Error(`ssh to ${destination} refused (only root@${host})`);
  if (command === null) throw new Error("interactive ssh refused");
  const identity = env.XMP_MPC_IDENTITY
    ? ["-i", env.XMP_MPC_IDENTITY, "-o", "IdentitiesOnly=yes"]
    : [];
  return { args: [...out, ...identity, destination, command], command };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  try {
    const { args, command } = rewrite(process.argv.slice(2), process.env);
    if (process.env.XMP_MPC_LOG)
      appendFileSync(
        process.env.XMP_MPC_LOG,
        `${new Date().toISOString()} mpc_remote ssh: ${command.replace(/\s+/g, " ").slice(0, 300)}\n`,
      );
    const r = spawnSync("/usr/bin/ssh", args, { stdio: "inherit" });
    process.exitCode = r.status ?? 255;
  } catch (error) {
    if (process.env.XMP_MPC_LOG)
      appendFileSync(
        process.env.XMP_MPC_LOG,
        `${new Date().toISOString()} shim refused: ${error.message}\n`,
      );
    console.error(`mpc-ssh-shim: ${error.message}`);
    process.exitCode = 255;
  }
}
