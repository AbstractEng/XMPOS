import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { root } from "../../acceptance/lib/workspace.mjs";
import { preflightTarget } from "../../acceptance/target-policy.mjs";
import { requireSupportedUpdater } from "./compatibility.mjs";
import { loadHardwareObservation } from "./hardware-observation.mjs";
import { stockImageFromUpdater } from "./stock-image.mjs";

export { stockImageFromUpdater } from "./stock-image.mjs";

// The only tool allowed to write to the owner's MPC Live Mk1 (see AGENTS.md,
// "Device-specific authorization"). It talks to U-Boot's fastboot update mode,
// writes the rootfs partition only, and never touches the bootloader, its
// environment or the partition table. The owner runs flashes; agents may only
// dry-run it or run `status`.

export const FLASH_CONFIRMATION = "XMPOS";
export const UNLOCK = "inmusic-unlock-magic-7de5fbc22b8c524e";
const READ_VARS = [
  "product",
  "version-bootloader",
  "partition-type:rootfs",
  "partition-size:rootfs",
];
const FORBIDDEN = /\b(format|resetenv|update-bootloader|flash-bootloader|erase|boot|set_active)\b/;

// Every fastboot argv the tool can produce. Anything else is refused.
export function fastbootArgs(step, image) {
  let args;
  if (step === "devices") args = ["devices"];
  else if (step.startsWith("getvar:") && READ_VARS.includes(step.slice(7)))
    args = ["getvar", step.slice(7)];
  else if (step === "unlock") args = ["oem", UNLOCK];
  else if (step === "flash-rootfs") {
    if (!image?.endsWith(".ext4")) throw new Error("A verified .ext4 rootfs image is required");
    args = ["flash", "rootfs", image];
  } else if (step === "reboot") args = ["reboot"];
  else throw new Error(`Fastboot step ${step} is not authorized`);
  // Belt and braces: the command words themselves must never name a forbidden operation.
  if (FORBIDDEN.test(args.slice(0, 2).join(" ")))
    throw new Error(`Refusing forbidden fastboot command: ${args.join(" ")}`);
  return args;
}

const sha256File = (path) =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });

// Platform-Tools can exit 0 even when this bootloader prints FAILED. Treat the
// protocol failure as a failure for reads AND writes, regardless of exit code.
function fastbootResult(status, output) {
  return { status: status === 0 && /\bFAILED\b/.test(output) ? 1 : status, output };
}

// All actual fastboot execution stays in this owner-only flash tool, including
// the GUI's hash-pinned, owner-downloaded Platform-Tools executable.
function executeFastboot(args, executable) {
  let approved;
  if (args[0] === "devices" || args[0] === "reboot") approved = fastbootArgs(args[0]);
  else if (args[0] === "getvar") approved = fastbootArgs(`getvar:${args[1]}`);
  else if (args[0] === "oem" && args[1] === UNLOCK) approved = fastbootArgs("unlock");
  else if (args[0] === "flash" && args[1] === "rootfs")
    approved = fastbootArgs("flash-rootfs", args[2]);
  if (!approved || JSON.stringify(approved) !== JSON.stringify(args))
    throw new Error("Fastboot arguments are outside the rootfs-only allow-list");
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 1800000 });
  if (result.error) throw new Error("Cannot start fastboot (Android SDK Platform-Tools)");
  return fastbootResult(result.status ?? 1, `${result.stdout ?? ""}${result.stderr ?? ""}`);
}
export function systemFastboot(args) {
  return executeFastboot(args, "fastboot");
}
export function verifiedSystemFastboot(args, { executable, sha256 }) {
  const info = lstatSync(executable);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    createHash("sha256").update(readFileSync(executable)).digest("hex") !== sha256
  )
    throw new Error("USB support changed; install USB support again");
  return executeFastboot(args, executable);
}

// fastboot prints "name: value" for getvar on stderr.
export function getvarValue(output, name) {
  const values = new Set(
    output
      .split("\n")
      .map((line) => line.trim().replace(/^\(bootloader\)\s*/, ""))
      .filter((line) => line.startsWith(`${name}:`))
      .map((line) => line.slice(name.length + 1).trim())
      .filter(Boolean),
  );
  return values.size === 1 ? [...values][0] : null;
}

export async function readIdentity(fastboot, record = () => {}, onUnimplemented = () => {}) {
  const query = async (step) => {
    const args = fastbootArgs(step);
    await record(`$ fastboot ${args.join(" ")}`);
    const raw = fastboot(args);
    const result = fastbootResult(raw.status, raw.output);
    await record(result.output.trim());
    return result;
  };
  const devices = await query("devices");
  if (devices.status !== 0) throw new Error("fastboot devices failed; refusing");
  // "SERIAL<tab>fastboot"; platform-tools 37 prints "SERIAL<tab> fastboot".
  const lines = devices.output.split("\n").filter((l) => /^\S+\s+fastboot\s*$/.test(l));
  if (lines.length === 0)
    throw new Error(
      "No device in update mode. Hold FULL LEVEL + ERASE + PAD BANK C/G while powering on.",
    );
  if (lines.length > 1)
    throw new Error("More than one fastboot device is connected; connect only the MPC Live");
  const serial = lines[0].trim().split(/\s+/)[0];
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial))
    throw new Error("Invalid fastboot device identity; refusing");
  const identity = { serial };
  for (const name of READ_VARS) {
    const result = await query(`getvar:${name}`);
    identity[name] = result.status === 0 ? getvarValue(result.output, name) : null;
    if (
      result.status !== 0 &&
      !result.output.split("\n").some((line) =>
        line
          .trim()
          .replace(/^\(bootloader\)\s*/, "")
          .startsWith(`${name}:`),
      ) &&
      /FAILED\s+\(remote:\s*['"]?Variable not implemented['"]?\)/.test(result.output)
    )
      onUnimplemented(name);
  }
  return identity;
}

// Image to flash: an XMP-built rootfs whose manifest hash verifies.
export async function verifiedXmpImage(directory) {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Image folder has no manifest.json");
  const info = lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("Bounded regular image manifest required");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !["xmp-live-mk1-probe-image", "xmp-live-mk1-loader-image"].includes(manifest.format) ||
    !/^[A-Za-z0-9._-]+\.ext4$/.test(manifest.output?.file ?? "") ||
    !manifest.output?.sha256
  )
    throw new Error("Not an XMP Live Mk1 root filesystem image manifest");
  if (manifest.format === "xmp-live-mk1-loader-image")
    requireSupportedUpdater(manifest.source?.imageSha256);
  const image = join(directory, manifest.output.file);
  if (!existsSync(image) || !image.endsWith(".ext4"))
    throw new Error("Manifest image file is missing");
  const imageInfo = lstatSync(image);
  if (!imageInfo.isFile() || imageInfo.isSymbolicLink())
    throw new Error("Regular image file required");
  if ((await sha256File(image)) !== manifest.output.sha256)
    throw new Error("Image does not match its manifest hash; rebuild it");
  return {
    image,
    sha256: manifest.output.sha256,
    label: `${manifest.format} ${basename(directory)}`,
  };
}

async function confirm(prompt, expected, input) {
  if (input !== undefined) return input === expected;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)) === expected;
  } finally {
    rl.close();
  }
}

export async function runFlash({
  operation,
  source,
  dryRun = true,
  fastboot = systemFastboot,
  answers = {},
  expectedIdentity,
  expectedImageSha256,
  expectedHardwareObservationSha256,
  log = console.log,
  stateDirectory = join(root, "reports/live-mk1"),
}) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  await mkdir(stateDirectory, { recursive: true });
  const logFile = join(stateDirectory, `flash-${stamp}.log`);
  const identityFile = join(stateDirectory, "fastboot-identity.json");
  const record = async (line) => {
    log(line);
    await appendFile(logFile, `${line}\n`);
  };
  const run = async (step, image) => {
    const args = fastbootArgs(step, image);
    await record(`$ fastboot ${args.join(" ")}${dryRun ? "   (dry run: not executed)" : ""}`);
    if (dryRun && !["devices"].includes(step) && !step.startsWith("getvar:"))
      return { status: 0, output: "" };
    const raw = fastboot(args);
    const result = fastbootResult(raw.status, raw.output);
    await record(result.output.trim());
    if (result.status !== 0) throw new Error(`fastboot ${args[0]} failed (${result.status})`);
    return result;
  };

  const unimplemented = new Set();
  const identity = await readIdentity(fastboot, record, (name) => unimplemented.add(name));
  if (
    expectedIdentity &&
    ["serial", ...READ_VARS].some((field) => expectedIdentity[field] !== identity[field])
  )
    throw new Error("Device changed since preview; inspect the Live again before writing");
  preflightTarget({ profile: "live-mk1-rootfs", device: identity, operation });
  const observation = await loadHardwareObservation(stateDirectory, identity);
  const hardwareObservationSha256 = observation?.receiptSha256 ?? null;
  if (
    expectedHardwareObservationSha256 !== undefined &&
    expectedHardwareObservationSha256 !== hardwareObservationSha256
  )
    throw new Error("Hardware observation changed since preview; inspect the Live again");
  if (
    identity.product !== "az01" &&
    !(identity.product === null && unimplemented.has("product") && observation)
  )
    throw new Error(
      "Unsupported fastboot product; MPC Live Mk1 required. An unimplemented product query needs a verified saved report for this unit.",
    );
  if (identity.product === null)
    await record(
      `Product query unimplemented: saved report ${observation.reportSha256} identifies this unit as ${observation.board}.`,
    );
  await record(`Device in update mode: ${JSON.stringify(identity)}`);
  // The first time, the owner confirms this is the Live; later runs must match.
  const known = existsSync(identityFile) ? JSON.parse(await readFile(identityFile, "utf8")) : null;
  const pinned = typeof known?.identity?.serial === "string";
  if (pinned && ["serial", ...READ_VARS].some((field) => known.identity[field] !== identity[field]))
    throw new Error("This device does not match the recorded MPC Live; refusing");
  if (known && !pinned)
    await record(
      "Legacy identity record has no unit serial. XMPOS confirms this Live and the write together; status/dry-run does not enrol a unit.",
    );
  if (operation === "status")
    return { identity, logFile, unitPinned: pinned, hardwareObservationSha256 };

  const chosen =
    operation === "restore-stock"
      ? await stockImageFromUpdater(source)
      : await verifiedXmpImage(source);
  if (expectedImageSha256 !== undefined && chosen.sha256 !== expectedImageSha256)
    throw new Error("Image changed since preview; inspect it again before writing");
  const sizeText = identity["partition-size:rootfs"] ?? "";
  let partitionSize;
  if (identity["partition-type:rootfs"] !== "ext4")
    throw new Error("Cannot verify the ext4 rootfs partition and its capacity; refusing");
  if (unimplemented.has("partition-size:rootfs") && observation) {
    partitionSize = observation.capacityBytes;
    await record(
      `Rootfs capacity ${partitionSize} bytes from saved measurement for this unit (${observation.reportSha256}); bootloader does not report size.`,
    );
  } else {
    if (!/^(?:0x)?[a-f0-9]{1,16}$/i.test(sizeText))
      throw new Error(
        "Cannot verify the ext4 rootfs partition and its capacity; refusing. No guessed partition size is allowed.",
      );
    partitionSize = Number(BigInt(/^0x/i.test(sizeText) ? sizeText : `0x${sizeText}`));
  }
  if (!Number.isSafeInteger(partitionSize) || partitionSize <= 0)
    throw new Error("Invalid rootfs capacity; refusing");
  const imageSize = statSync(chosen.image).size;
  if (imageSize > partitionSize)
    throw new Error(
      `Image (${imageSize} bytes) is larger than the rootfs partition (${partitionSize})`,
    );
  await record(
    `Image: ${chosen.label}\n  ${relative(root, chosen.image)}\n  sha256 ${chosen.sha256}`,
  );
  if (!dryRun) {
    const ok = await confirm(
      'This rewrites ONLY the rootfs partition of the MPC Live. Type "XMPOS" to continue: ',
      FLASH_CONFIRMATION,
      answers.flash,
    );
    if (!ok) throw new Error("Not confirmed; nothing written");
    if (!pinned)
      await writeFile(
        identityFile,
        `${JSON.stringify({ identity, confirmedAt: stamp }, null, 2)}\n`,
      );
  }
  await run("unlock");
  await run("flash-rootfs", chosen.image);
  await run("reboot");
  await record(
    dryRun ? "Dry run complete: nothing was written." : "Flash complete; the unit is rebooting.",
  );
  return {
    identity,
    image: chosen,
    dryRun,
    logFile,
    hardwareObservationSha256,
    rootfsCapacityBytes: partitionSize,
  };
}

if (process.argv[1] === import.meta.filename) {
  const [operation, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const usage =
    "Usage: npm run live:flash -- status\n" +
    "       npm run live:flash -- probe [--write]\n" +
    "       npm run live:flash -- loader [--write]\n" +
    "       npm run live:flash -- image <xmp-image-folder> [--write]\n" +
    '       npm run live:flash -- restore-stock "<Akai MPC updater.app>" [--write]\n' +
    "Without --write every command is a dry run. Only the rootfs partition can be written.";
  for (const flag of flags)
    if (flag !== "--write") throw new Error(`Unknown option ${flag}\n${usage}`);
  let source;
  let op;
  if (operation === "status" && positional.length === 0) op = "status";
  else if ((operation === "probe" || operation === "loader") && positional.length === 0) {
    op = "flash-rootfs";
    const pointer = join(root, `artifacts/live-mk1/latest-${operation}-image.json`);
    if (!existsSync(pointer))
      throw new Error(`Build the ${operation} image first: npm run live:${operation}-image`);
    source = resolve(root, JSON.parse(readFileSync(pointer, "utf8")).directory);
  } else if (operation === "image" && positional.length === 1) {
    op = "flash-rootfs";
    source = resolve(positional[0]);
  } else if (operation === "restore-stock" && positional.length === 1) {
    op = "restore-stock";
    source = positional[0];
  } else throw new Error(usage);
  const result = await runFlash({ operation: op, source, dryRun: !flags.has("--write") });
  console.log(`Log: ${result.logFile}`);
}
