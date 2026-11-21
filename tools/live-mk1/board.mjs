import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import {
  findByCompatible,
  findByPrefix,
  hubStrings,
  parseDtb,
  strings,
  text,
  u32,
} from "./fdt.mjs";

export const kernelLock = () =>
  JSON.parse(readFileSync(resolve(root, "os/live-mk1/kernel.lock.json"), "utf8"));

// Classify a device by its device-tree compatible list. The protected Force
// always wins, whatever else the list claims.
export function classifyCompatible(compatible, lock = kernelLock()) {
  const list = Array.isArray(compatible) ? compatible : strings(compatible);
  const protectedHit = lock.protected.find((entry) => list.includes(entry.compatible));
  if (protectedHit) return { role: "protected", product: protectedHit.product };
  if (list.includes(lock.target.compatible))
    return { role: "target", product: lock.target.product };
  const other = lock.notTarget.find((entry) => list.includes(entry.compatible));
  if (other) return { role: "not-target", product: other.product };
  return { role: "unknown", product: null };
}

export function describeBoard(dtbBytes, lock = kernelLock()) {
  const tree = parseDtb(dtbBytes);
  const props = tree.properties;
  const compatible = strings(props.get("compatible"));
  const panel = findByPrefix(tree, "panel").find((entry) =>
    strings(entry.node.properties.get("compatible")).some((c) => c.startsWith("urt,")),
  );
  const battery = findByPrefix(tree, "battery")[0];
  const hub = [...findByPrefix(tree, "usb5537"), ...findByPrefix(tree, "hub")].find((entry) =>
    entry.node.properties.has("smsc,config-file"),
  );
  const chosen = tree.children.find((child) => child.name === "chosen");
  const touch = ["ilitek,ili2116", "ilitek,ili2117", "sitronix,st1727"].filter(
    (c) => findByCompatible(tree, c).length > 0,
  );
  return {
    model: text(props.get("model")),
    compatible,
    ...classifyCompatible(compatible, lock),
    productCode: text(props.get("inmusic,product-code")),
    soc: compatible.find((c) => c.startsWith("rockchip,")) ?? null,
    display: {
      panel: panel ? text(panel.node.properties.get("compatible")) : null,
      rotation: panel ? u32(panel.node.properties.get("rotation")) : null,
      boardRotation: u32(props.get("inmusic,panel-rotation")),
      touchControllers: touch,
    },
    power: {
      battery: battery ? strings(battery.node.properties.get("compatible")) : [],
      mains: findByCompatible(tree, "inmusic,az01-power").length > 0,
    },
    usbHub: hub ? hubStrings(hub.node.properties.get("smsc,config-file")) : [],
    gpioKeys: findByCompatible(tree, "gpio-keys").length > 0,
    leds: findByCompatible(tree, "gpio-leds").length > 0,
    internalSd: Boolean(chosen?.properties.has("inmusic,internal-sd-fitted")),
    rtc: findByCompatible(tree, "haoyu,hym8563").length > 0,
  };
}

// Throws unless the description is the Live Mk1 build target.
export function assertLiveTarget(board) {
  if (board.role === "protected")
    throw new Error(`${board.product} is protected: XMP never builds or boots for it`);
  if (board.role !== "target")
    throw new Error(`${board.model ?? "Unknown board"} is not the MPC Live Mk1 target`);
  const problems = [];
  if (board.productCode !== "ACV8") problems.push("product code is not ACV8");
  if (!board.usbHub.includes("MPC Live Hub")) problems.push("hub is not the MPC Live Hub");
  if (!board.power.battery.includes("sbs,sbs-battery")) problems.push("no SBS battery node");
  if (board.display.rotation !== 270) problems.push("panel rotation is not 270");
  if (problems.length) throw new Error(`Live Mk1 device tree mismatch: ${problems.join("; ")}`);
  return board;
}

// Parses a merged kernel .config into a Map of option -> value ("n" when unset).
export function parseKernelConfig(textValue) {
  const options = new Map();
  for (const line of textValue.split("\n")) {
    const set = /^(CONFIG_[A-Za-z0-9_]+)=(.*)$/.exec(line);
    const unset = /^# (CONFIG_[A-Za-z0-9_]+) is not set$/.exec(line);
    if (set) options.set(set[1], set[2]);
    else if (unset) options.set(unset[1], "n");
  }
  return options;
}

// The fragment is add-only: every option the official configuration enables
// keeps its exact value, every option az01_defconfig explicitly disables stays
// disabled, and only default-off options may be switched on. Returns violations.
export function auditFragment(official, merged, required, explicitlyDisabled = new Set()) {
  const problems = [];
  for (const [option, value] of official)
    if (value !== "n" && merged.get(option) !== value)
      problems.push(`${option} changed from ${value} to ${merged.get(option) ?? "n"}`);
  for (const option of explicitlyDisabled)
    if ((merged.get(option) ?? "n") !== "n")
      problems.push(`${option} is disabled by the official defconfig but was enabled`);
  for (const [option, value] of Object.entries(required))
    if (merged.get(option) !== value) problems.push(`${option} must be ${value}`);
  return problems;
}

// Options a defconfig file explicitly turns off ("# CONFIG_X is not set").
export function explicitlyDisabled(defconfigText) {
  return new Set(
    [...defconfigText.matchAll(/^# (CONFIG_[A-Za-z0-9_]+) is not set$/gm)].map((m) => m[1]),
  );
}
