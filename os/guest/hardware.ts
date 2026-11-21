import { readdirSync, readFileSync } from "node:fs";
import lock from "../live-mk1/kernel.lock.json" with { type: "json" };

// Read-only hardware discovery for XMP's device OS. The reader can only read
// files and list directories under /proc and /sys; there is no write, ioctl,
// device open, mount or USB path. A protected identity stops discovery at once.

export interface HardwareReader {
  read(path: string): string | null;
  list(path: string): string[];
}

export type Role = "target" | "protected" | "not-target" | "unknown";
export type Presence = "present" | "absent";

export interface HardwareProfile {
  identity: { model: string | null; compatible: string[]; role: Role; product: string | null };
  status: "live-mk1-unverified" | "refused-protected" | "unsupported-device" | "development-host";
  kernel?: { release: string | null; realtime: boolean; officialAz01: boolean };
  power?: {
    battery: { name: string; capacity: number | null; status: string | null } | null;
    mains: { name: string; online: boolean } | null;
  };
  audio?: { cards: { index: number; driver: string; name: string }[]; usbAudio: Presence };
  display?: { connectors: { name: string; status: string | null }[]; dsi: Presence };
  input?: { devices: string[]; touch: Presence };
  missing: string[];
  hardwareQualified: false;
}

const ALLOWED = /^\/(proc|sys)(\/[A-Za-z0-9_.:@+-]+)*$/;

export function classify(compatible: string[]): { role: Role; product: string | null } {
  const protectedHit = lock.protected.find((entry) => compatible.includes(entry.compatible));
  if (protectedHit) return { role: "protected", product: protectedHit.product };
  if (compatible.includes(lock.target.compatible))
    return { role: "target", product: lock.target.product };
  const other = lock.notTarget.find((entry) => compatible.includes(entry.compatible));
  return other
    ? { role: "not-target", product: other.product }
    : { role: "unknown", product: null };
}

function guarded(reader: HardwareReader): HardwareReader {
  const check = (path: string) => {
    if (!ALLOWED.test(path) || path.includes("..")) throw new Error(`Probe path refused: ${path}`);
  };
  return {
    read: (path) => {
      check(path);
      return reader.read(path);
    },
    list: (path) => {
      check(path);
      return reader.list(path);
    },
  };
}

const clean = (value: string | null) => (value === null ? null : value.replace(/\0+$/g, "").trim());

export function parseSoundCards(text: string | null) {
  const cards: { index: number; driver: string; name: string }[] = [];
  for (const line of (text ?? "").split("\n")) {
    const match = /^\s*(\d+) \[[^\]]*\]: (\S+) - (.+)$/.exec(line);
    if (match)
      cards.push({
        index: Number(match[1]),
        driver: match[2] ?? "",
        name: (match[3] ?? "").trim(),
      });
  }
  return cards;
}

export function probeHardware(source: HardwareReader): HardwareProfile {
  const reader = guarded(source);
  const compatible = (reader.read("/proc/device-tree/compatible") ?? "")
    .split("\0")
    .filter(Boolean);
  const identity = {
    model: clean(reader.read("/proc/device-tree/model")),
    compatible,
    ...classify(compatible),
  };
  if (identity.role === "protected")
    return { identity, status: "refused-protected", missing: [], hardwareQualified: false };

  const release = clean(reader.read("/proc/sys/kernel/osrelease"));
  const kernel = {
    release,
    realtime: clean(reader.read("/sys/kernel/realtime")) === "1",
    officialAz01: Boolean(release?.includes("-az01")),
  };

  let battery: NonNullable<HardwareProfile["power"]>["battery"] = null;
  let mains: NonNullable<HardwareProfile["power"]>["mains"] = null;
  for (const name of reader.list("/sys/class/power_supply")) {
    const base = `/sys/class/power_supply/${name}`;
    const type = clean(reader.read(`${base}/type`));
    if (type === "Battery" && !battery) {
      const capacity = Number(clean(reader.read(`${base}/capacity`)));
      battery = {
        name,
        capacity: Number.isFinite(capacity) ? capacity : null,
        status: clean(reader.read(`${base}/status`)),
      };
    }
    if (type === "Mains" && !mains)
      mains = { name, online: clean(reader.read(`${base}/online`)) === "1" };
  }

  const cards = parseSoundCards(reader.read("/proc/asound/cards"));
  const connectors = reader
    .list("/sys/class/drm")
    .filter((name) => /^card\d+-/.test(name))
    .map((name) => ({ name, status: clean(reader.read(`/sys/class/drm/${name}/status`)) }));
  const devices = reader
    .list("/sys/class/input")
    .filter((name) => /^input\d+$/.test(name))
    .map((name) => clean(reader.read(`/sys/class/input/${name}/name`)) ?? name);

  const profile: HardwareProfile = {
    identity,
    status:
      identity.role === "target"
        ? "live-mk1-unverified"
        : identity.role === "not-target"
          ? "unsupported-device"
          : "development-host",
    kernel,
    power: { battery, mains },
    audio: { cards, usbAudio: cards.some((c) => c.driver === "USB-Audio") ? "present" : "absent" },
    display: {
      connectors,
      dsi: connectors.some((c) => /-DSI-/.test(c.name)) ? "present" : "absent",
    },
    input: {
      devices,
      touch: devices.some((d) => /ili21|st1727|touch/i.test(d)) ? "present" : "absent",
    },
    missing: [],
    hardwareQualified: false,
  };
  // What the official ACV8 device tree says a Live Mk1 must expose.
  if (identity.role === "target") {
    if (!kernel.officialAz01) profile.missing.push("official az01 kernel");
    if (!kernel.realtime) profile.missing.push("PREEMPT_RT kernel");
    if (!battery) profile.missing.push("SBS battery");
    if (!mains) profile.missing.push("az01 mains supply");
    if (profile.audio?.usbAudio !== "present") profile.missing.push("USB audio interface");
    if (profile.display?.dsi !== "present") profile.missing.push("DSI panel");
    if (profile.input?.touch !== "present") profile.missing.push("touch controller");
  }
  return profile;
}

// Node adapter for the guest. Only reads; errors become "absent".
export function systemReader(prefix = ""): HardwareReader {
  return {
    read(path) {
      try {
        return readFileSync(`${prefix}${path}`, "latin1");
      } catch {
        return null;
      }
    },
    list(path) {
      try {
        return readdirSync(`${prefix}${path}`).sort();
      } catch {
        return [];
      }
    },
  };
}
