import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "../../acceptance/lib/workspace.mjs";
import {
  parseStockInstallReport,
  STOCK_INSTALL_PROBE,
  stockInstallReceipt,
} from "./stock-install-report.mjs";

// Akai's MPC OS on the owner's MPC Live Mk1, over SSH (AGENTS.md authorization 6).
// The only route: this wrapper around Akai's own `mpc_remote.py` from the plugin
// SDK, pinned by commit and file hash. Before every command it reads the unit's
// identity over SSH with a pinned host key and refuses anything that is not the
// recorded Live (board inmusic,acv8, MPC OS 3.10.1 or later) and anything that
// names the Force. Plugins go only to a USB stick (/dev/sd*), only XMP's own
// plugins are installed or removed, and every command is logged in reports/.
//
//   npm run live:mpc -- setup
//   npm run live:mpc -- <address> identify | info | drives | list | doctor | diag
//   npm run live:mpc -- <address> add|update <plugin folder>... --drive <stick> [--yes]
//   npm run live:mpc -- <address> remove "XMP - VST - <name>"... --drive <stick> [--yes]
//   npm run live:mpc -- <address> export "XMP - VST - <name>"... --drive <stick> [--out DIR]
//   npm run live:mpc -- <address> restart [--yes]
//
// Passwords are the owner's: set MPC_SSH_PASSWORD in your own terminal, or use a
// key. This tool never takes one on the command line.

export const SDK = {
  url: "https://github.com/inmusic-software/mpc-plugin-builder-sdk.git",
  commit: "febd2ca5bd9eb16c4a412837196e145566bc981b",
  remoteSha256: "1643e789af4935adcc7e31c969c45a85fa7fa4525f920e3a336912505b22f551",
  dir: join(root, "references/repos/mpc-plugin-builder-sdk"),
};
export const MIN_VERSION = [3, 10, 1];
export const XMP_FOLDER_PREFIX = "XMP - VST - ";
const KNOWN_HOSTS = join(root, "artifacts/live-mk1/mpc-known-hosts");
// The key the owner installs on the Live (ssh-copy-id, typing the password themselves).
export const SSH_KEY = join(root, "artifacts/live-mk1/mpc-ssh-key");
const IDENTITY_FILE = join(root, "artifacts/live-mk1/mpc-identity.json");
const SHIM = fileURLToPath(new URL("./mpc-ssh-shim.mjs", import.meta.url));

// Commands of mpc_remote.py that may run, and whether they need a drive.
export const COMMANDS = {
  info: { drive: false, write: false },
  drives: { drive: false, write: false },
  list: { drive: false, write: false },
  doctor: { drive: false, write: false },
  export: { drive: true, write: false },
  add: { drive: true, write: true },
  update: { drive: true, write: true },
  remove: { drive: true, write: true },
  restart: { drive: false, write: true },
};
// Read-only diagnostics, fixed; nothing received or typed becomes a command.
export const DIAG = [
  "journalctl -u acvs -n 200 --no-pager 2>/dev/null || tail -n 200 /var/log/messages 2>/dev/null",
  "top -b -n 1 2>/dev/null | head -n 25",
  "free 2>/dev/null",
  "df -h 2>/dev/null",
];

export const PROBE = [
  "B=/sys/firmware/devicetree/base",
  "printf 'compatible='; tr '\\000' ',' < $B/compatible 2>/dev/null; echo",
  "printf 'model='; tr '\\000' ' ' < $B/model 2>/dev/null; echo",
  "printf 'serial='; tr '\\000' ' ' < $B/serial-number 2>/dev/null; echo",
  "printf 'app='; head -n 1 /tmp/com.akaipro.mpc.version 2>/dev/null; echo",
  "echo @@MOUNTS; cat /proc/mounts",
].join("\n");

export function stockVerificationAddress(address) {
  if (typeof address !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))
    throw new Error("Enter the Live's IPv4 address from its own network settings");
  const p = address.split(".").map(Number);
  if (
    p.some((n) => n > 255) ||
    !(
      p[0] === 10 ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 169 && p[1] === 254)
    )
  )
    throw new Error(
      "Use the owner-selected Live's local network address; no discovery or public hosts",
    );
  return address;
}

// Host-only stock verification. This is the sole SSH route used by the GUI.
// The repository owner must explicitly authorize these additional metadata
// reads in AGENTS.md before an agent runs it against their real Live.
export function collectStockInstallProfile(
  address,
  {
    ownerReadOnlyConfirmed = false,
    stateDirectory = join(root, "reports/live-mk1"),
    askpass = null,
    transport = null,
    record = () => {},
  } = {},
) {
  stockVerificationAddress(address);
  if (ownerReadOnlyConfirmed !== true)
    throw new Error("Confirm the stock Live and read-only verification first");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(stateDirectory).isSymbolicLink())
    throw new Error("Regular private verification directory required");
  const audit = join(
    stateDirectory,
    `stock-verify-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  const writeLog = (line) => {
    appendFileSync(audit, `${line}\n`, { mode: 0o600 });
    record(line);
  };
  const execute = (script) => {
    if (script !== STOCK_INSTALL_PROBE)
      throw new Error("Only the fixed stock verification reads are allowed");
    writeLog(`Fixed read-only stock probe:\n${script}`);
    if (transport) return transport(script);
    const executable =
      process.platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "System32/OpenSSH/ssh.exe")
        : "/usr/bin/ssh";
    if (!existsSync(executable))
      throw new Error(
        "The system OpenSSH client is required; enable Windows OpenSSH Client in Optional Features",
      );
    if (askpass && (!lstatSync(askpass).isFile() || lstatSync(askpass).isSymbolicLink()))
      throw new Error("Verified native SSH password prompt required");
    const key = existsSync(SSH_KEY) ? SSH_KEY : null;
    const env = askpass
      ? {
          ...process.env,
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: process.env.DISPLAY || "xmp-installer",
          XMP_STOCK_TARGET: address,
        }
      : sshEnv();
    const args = [
      "-F",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "-p",
      "22",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile="${join(stateDirectory, "stock-known-hosts").replaceAll("\\", "/")}"`,
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ProxyCommand=none",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      `PubkeyAuthentication=${key ? "yes" : "no"}`,
      ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []),
      `root@${address}`,
      script,
    ];
    if (askpass) delete env.MPC_SSH_PASSWORD;
    const r = spawnSync(executable, args, {
      env,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 65536,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) {
      const diagnostic =
        r.error?.code === "ETIMEDOUT"
          ? "SSH/password prompt timed out"
          : /Permission denied/i.test(r.stderr || "")
            ? "SSH authentication did not complete"
            : /Connection refused|connect to host/i.test(r.stderr || "")
              ? "SSH connection unavailable; check Developer Mode and the address"
              : "The fixed stock metadata read did not complete";
      writeLog(`SSH exit ${r.status}; ${diagnostic}`);
      if (r.stdout)
        writeFileSync(join(stateDirectory, "incomplete-stock-report.txt"), r.stdout, {
          mode: 0o600,
        });
      if (r.stderr)
        writeFileSync(join(stateDirectory, "stock-ssh-diagnostic.txt"), r.stderr, { mode: 0o600 });
      throw new Error(`${diagnostic}. No device storage was changed.`);
    }
    return r.stdout;
  };
  const identityFile = join(stateDirectory, "stock-device-identity.json");
  const known = existsSync(identityFile)
    ? JSON.parse(readFileSync(identityFile, "utf8")).serialHash
    : null;
  const report = execute(STOCK_INSTALL_PROBE);
  const facts = parseStockInstallReport(report);
  const checked = checkIdentity(
    {
      compatible: facts.compatible,
      model: facts.model,
      serial: facts.deviceTreeSerial,
      app: facts.mpcOsVersion,
      mounts: [],
    },
    known,
  );
  const fastbootPin = join(stateDirectory, "fastboot-identity.json");
  if (existsSync(fastbootPin)) {
    const pin = JSON.parse(readFileSync(fastbootPin, "utf8"));
    if (
      pin.identity?.serial &&
      !facts.serialHashes.includes(createHash("sha256").update(pin.identity.serial).digest("hex"))
    )
      throw new Error("Stock unit differs from the recorded fastboot Live");
  }
  const receipt = stockInstallReceipt(report);
  receipt.probeSha256 = createHash("sha256").update(STOCK_INSTALL_PROBE).digest("hex");
  for (const [name, bytes] of [
    [receipt.report.file, report],
    ["hardware-observation.json", JSON.stringify(receipt, null, 2) + "\n"],
    [
      "stock-device-identity.json",
      JSON.stringify({
        version: 1,
        serialHash: checked.hash,
        serialHashes: facts.serialHashes,
        recordedAt: receipt.collectedAt,
      }) + "\n",
    ],
  ]) {
    const temp = join(stateDirectory, `${name}.${process.pid}.new`);
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, join(stateDirectory, name));
  }
  writeLog(
    `Verified stock MPC OS 3.10.1 / ACV8, measured rootfs ${facts.capacityBytes} bytes; no remote writes.`,
  );
  return {
    board: facts.board,
    mpcOsVersion: facts.mpcOsVersion,
    capacityBytes: facts.capacityBytes,
    reportSha256: receipt.report.sha256,
    receiptSha256: createHash("sha256")
      .update(readFileSync(join(stateDirectory, "hardware-observation.json")))
      .digest("hex"),
    hardwareReadOnly: true,
  };
}

export function parseProbe(text) {
  const [head = "", mounts = ""] = text.split("@@MOUNTS");
  const info = { compatible: "", model: "", serial: "", app: "", mounts: [] };
  for (const line of head.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    if (key in info && key !== "mounts")
      info[key] = line
        .slice(at + 1)
        .trim()
        .replace(/,+$/, "");
  }
  for (const line of mounts.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const mount = p[1].replace(/\\([0-7]{3})/g, (_, o) =>
      String.fromCharCode(Number.parseInt(o, 8)),
    );
    info.mounts.push({ device: p[0], mount, fstype: p[2], options: p[3].split(",") });
  }
  return info;
}

export function parseVersion(app) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(app ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const atLeast = (v, min) => {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
};

export const serialHash = (serial) =>
  createHash("sha256").update(`xmp-mpc:${serial}`).digest("hex");

// Throws unless this is the owner's Live Mk1 on MPC OS 3.10.1 or later.
// `recorded` is the serial hash of the first Live seen (null on first use).
export function checkIdentity(info, recorded) {
  const names = `${info.compatible} ${info.model}`.toLowerCase();
  if (/force|ada2/.test(names))
    throw new Error("This is the Akai Force. Refusing: XMP never touches the Force.");
  if (!info.compatible.split(",").some((c, i, all) => c === "inmusic" && all[i + 1] === "acv8"))
    throw new Error(`Not an MPC Live Mk1 (board "${info.compatible || "unknown"}"). Refusing.`);
  const version = parseVersion(info.app);
  if (!version) throw new Error("Could not read the MPC OS version. Refusing.");
  if (!atLeast(version, MIN_VERSION))
    throw new Error(
      `MPC OS ${version.join(".")} is older than ${MIN_VERSION.join(".")}. Refusing.`,
    );
  if (!info.serial)
    throw new Error(
      "The unit reported no serial number, so it cannot be matched to the recorded Live. Refusing.",
    );
  const hash = serialHash(info.serial);
  if (recorded && recorded !== hash)
    throw new Error("This is not the Live recorded on first use. Refusing.");
  return { hash, version: version.join(".") };
}

// The named drive must be a USB stick under /media (a /dev/sd* device), never the
// internal eMMC or SD card (mmcblk*) or Akai's internal mounts.
export function checkDrive(mounts, wanted) {
  if (!wanted) throw new Error("Name the USB stick with --drive (its name or mount point).");
  const found = mounts.filter(
    (m) => m.mount.startsWith("/media/") && (m.mount === wanted || basename(m.mount) === wanted),
  );
  if (found.length !== 1) throw new Error(`No single drive under /media named "${wanted}".`);
  const [drive] = found;
  const name = basename(drive.mount);
  if (
    /^(az01-internal|acvs-synths|acvs-content|nvme)/.test(name) ||
    drive.device.includes("mmcblk")
  )
    throw new Error(`"${name}" is internal storage. Refusing: plugins go on the USB stick only.`);
  if (!/^\/dev\/sd[a-z]+\d*$/.test(drive.device))
    throw new Error(`"${name}" (${drive.device}) is not a USB stick. Refusing.`);
  if (!drive.options.includes("rw")) throw new Error(`"${name}" is mounted read-only.`);
  return drive.mount;
}

// add/update: only XMP-built plugin folders (manufacturer "XMP").
export function checkPluginSource(dir) {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) throw new Error(`${dir} has no plugin.json (give a built plugin folder).`);
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (json.manufacturer !== "XMP")
    throw new Error(`${dir} is not an XMP plugin (manufacturer "${json.manufacturer}").`);
  return `${XMP_FOLDER_PREFIX}${json.name}`;
}

export function checkInstalledName(name) {
  if (
    !name.startsWith(XMP_FOLDER_PREFIX) ||
    name.length <= XMP_FOLDER_PREFIX.length ||
    /[/\0]/.test(name)
  )
    throw new Error(
      `"${name}" is not an XMP plugin folder ("${XMP_FOLDER_PREFIX}<name>"). Refusing.`,
    );
  return name;
}

// Splits `<address> <command> [args] [--drive D] [--out DIR] [--yes] [--port N]`.
export function parseArgs(argv) {
  const out = {
    address: null,
    command: null,
    items: [],
    drive: null,
    outDir: null,
    yes: false,
    port: 22,
  };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--drive") out.drive = rest.shift() ?? null;
    else if (a === "--out") out.outDir = rest.shift() ?? null;
    else if (a === "--port") out.port = Number(rest.shift());
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--password" || a === "--user" || a.startsWith("--"))
      throw new Error(
        `${a} is not accepted (passwords stay in MPC_SSH_PASSWORD; the user is root).`,
      );
    else if (out.command === null && a === "setup") out.command = a;
    else if (out.address === null) out.address = a;
    else if (out.command === null) out.command = a;
    else out.items.push(a);
  }
  if (out.command !== "setup") {
    if (!out.address || !/^[A-Za-z0-9.:_-]+$/.test(out.address))
      throw new Error("Give the Live's address first.");
    if (!out.command) throw new Error("Give a command.");
    if (
      out.command !== "identify" &&
      out.command !== "diag" &&
      out.command !== "verify-install" &&
      !(out.command in COMMANDS)
    )
      throw new Error(`"${out.command}" is not allowed (import and other commands are refused).`);
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)
      throw new Error("Bad --port.");
    if (["add", "update", "remove", "export"].includes(out.command) && out.items.length === 0)
      throw new Error(`${out.command} needs at least one plugin.`);
  }
  return out;
}

// ---- running ----

let logFile = null;
function log(line) {
  if (!logFile) {
    const dir = join(root, "reports/live-mk1");
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, `mpc-remote-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  }
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}

function sshEnv() {
  const env = { ...process.env };
  if (env.MPC_SSH_PASSWORD) {
    const dir = mkdtempSync(join(tmpdir(), "xmp-mpc-"));
    const askpass = join(dir, "askpass");
    writeFileSync(askpass, "#!/bin/sh\nprintf '%s\\n' \"$MPC_SSH_PASSWORD\"\n");
    chmodSync(askpass, 0o700);
    Object.assign(env, {
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: env.DISPLAY ?? ":0",
    });
  }
  return env;
}

export function sshArgs(address, port, hostKeyPolicy, password) {
  return [
    "-p",
    String(port),
    "-o",
    `StrictHostKeyChecking=${hostKeyPolicy}`,
    "-o",
    `UserKnownHostsFile="${KNOWN_HOSTS}"`,
    "-o",
    "ConnectTimeout=8",
    "-o",
    "NumberOfPasswordPrompts=1",
    ...(existsSync(SSH_KEY) ? ["-i", SSH_KEY, "-o", "IdentitiesOnly=yes"] : []),
    ...(password ? [] : ["-o", "BatchMode=yes"]),
    `root@${address}`,
  ];
}

function remote(opts, script, policy = "yes") {
  mkdirSync(join(root, "artifacts/live-mk1"), { recursive: true });
  log(`ssh ${opts.address}: ${script.split("\n")[0].slice(0, 200)}`);
  const r = spawnSync(
    "ssh",
    [...sshArgs(opts.address, opts.port, policy, !!process.env.MPC_SSH_PASSWORD), script],
    {
      env: sshEnv(),
      encoding: "utf8",
      maxBuffer: 1 << 24,
    },
  );
  log(`  exit ${r.status}`);
  if (r.status !== 0)
    throw new Error(`SSH to ${opts.address} failed: ${(r.stderr || "").trim() || r.status}`);
  return r.stdout;
}

function identify(opts) {
  // First contact records the host key (accept-new); after that it must match.
  const info = parseProbe(remote(opts, PROBE, "accept-new"));
  const recorded = existsSync(IDENTITY_FILE)
    ? JSON.parse(readFileSync(IDENTITY_FILE, "utf8")).serialHash
    : null;
  const id = checkIdentity(info, recorded);
  if (!recorded) {
    writeFileSync(
      IDENTITY_FILE,
      `${JSON.stringify({ serialHash: id.hash, recorded: new Date().toISOString() }, null, 2)}\n`,
    );
    log("recorded this Live as the authorized unit");
  }
  log(`identity ok: ${info.model} (inmusic,acv8), MPC OS ${id.version}`);
  return { info, ...id };
}

export function verifySdk(dir = SDK.dir) {
  const file = join(dir, "tools/mpc_remote.py");
  if (!existsSync(file))
    throw new Error("Akai's SDK is not fetched: run `npm run live:mpc -- setup`.");
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (sha !== SDK.remoteSha256)
    throw new Error(`mpc_remote.py does not match the reviewed copy (${sha}). Refusing.`);
  return file;
}

function setup() {
  if (!existsSync(SDK.dir)) {
    mkdirSync(join(SDK.dir, ".."), { recursive: true });
    spawnSync("git", ["clone", "-q", SDK.url, SDK.dir], { stdio: "inherit" });
  }
  spawnSync("git", ["-C", SDK.dir, "fetch", "-q", "origin", SDK.commit], { stdio: "inherit" });
  const r = spawnSync("git", ["-C", SDK.dir, "checkout", "-q", "--detach", SDK.commit], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("Could not check out the pinned SDK commit.");
  verifySdk();
  console.log(
    `Akai's plugin SDK is at ${SDK.dir} (commit ${SDK.commit.slice(0, 12)}, mpc_remote.py verified).`,
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === "setup") return setup();
  log(`command: ${opts.command} ${opts.items.join(" ")}`);
  if (opts.command === "verify-install") {
    if (opts.port !== 22 || opts.items.length || opts.drive || opts.outDir)
      throw new Error(
        "Stock verification accepts only the owner-selected address, with no extra commands or paths",
      );
    console.log(
      JSON.stringify(
        collectStockInstallProfile(opts.address, { ownerReadOnlyConfirmed: true, record: log }),
        null,
        2,
      ),
    );
    return;
  }
  const tool = verifySdk();
  const { info, version } = identify(opts);
  if (opts.command === "identify") {
    console.log(
      `${info.model}: MPC Live Mk1 (inmusic,acv8), MPC OS ${version}. This is the recorded Live.`,
    );
    return;
  }
  if (opts.command === "diag") {
    for (const cmd of DIAG) console.log(`$ ${cmd}\n${remote(opts, cmd)}`);
    return;
  }
  // --address belongs to the top-level parser, before the command.
  const args = [
    tool,
    "--address",
    opts.address,
    opts.command,
    "--port",
    String(opts.port),
    "--no-color",
  ];
  if (COMMANDS[opts.command].drive) args.push("--drive", checkDrive(info.mounts, opts.drive));
  if (opts.command === "add" || opts.command === "update")
    for (const dir of opts.items) {
      checkPluginSource(resolve(dir));
      args.push(resolve(dir));
    }
  if (opts.command === "remove" || opts.command === "export")
    for (const n of opts.items) args.push(checkInstalledName(n));
  if (opts.command === "export" && opts.outDir) args.push("--out", resolve(opts.outDir));
  if (opts.yes) args.push("--yes");
  // mpc_remote.py turns host-key checking off; the shim puts the pinned key back
  // and refuses any other host.
  const env = {
    ...sshEnv(),
    MPC_SSH_BIN: SHIM,
    XMP_MPC_HOST: opts.address,
    XMP_MPC_PORT: String(opts.port),
    XMP_MPC_KNOWN_HOSTS: KNOWN_HOSTS,
    ...(existsSync(SSH_KEY) ? { XMP_MPC_IDENTITY: SSH_KEY } : {}),
    XMP_MPC_LOG: logFile,
  };
  log(`run: mpc_remote.py ${args.slice(1).join(" ")}`);
  const r = spawnSync("python3", ["-I", ...args], { stdio: "inherit", env });
  log(`mpc_remote.py exit ${r.status}`);
  process.exitCode = r.status ?? 1;
}

if (process.argv[1] === import.meta.filename) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (logFile) log(`refused: ${error.message}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}
